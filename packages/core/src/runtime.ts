import { MemoryDedupStore, dedupKey, type DedupStore } from "./dedup.js";
import { TokenBucketLimiter } from "./rate-limit.js";
import { runReconnectSupervisor, type Connectable, type ReconnectOptions } from "./reconnect.js";
import { withRetry, type RetryOptions } from "./retry.js";
import {
  chatKey,
  noopLogger,
  systemClock,
  type Adapter,
  type Capabilities,
  type ChatRef,
  type Clock,
  type Inbound,
  type InboundHandler,
  type Logger,
  type Platform,
} from "./types.js";

export interface AdapterRuntimeOptions {
  platform: Platform;
  accountId: string;
  capabilities: Capabilities;
  dedup?: DedupStore;
  limiter?: TokenBucketLimiter;
  ratePerSec?: number;
  burst?: number;
  retry?: RetryOptions;
  reconnect?: ReconnectOptions;
  clock?: Clock;
  logger?: Logger;
}

export class AdapterRuntime {
  readonly platform: Platform;
  accountId: string;
  readonly capabilities: Capabilities;
  readonly dedup: DedupStore;
  readonly limiter: TokenBucketLimiter;
  readonly logger: Logger;
  readonly clock: Clock;
  private readonly retry: RetryOptions;
  private readonly reconnect: ReconnectOptions;
  private readonly handlers: InboundHandler[] = [];

  constructor(opts: AdapterRuntimeOptions) {
    this.platform = opts.platform;
    this.accountId = opts.accountId;
    this.capabilities = opts.capabilities;
    this.clock = opts.clock ?? systemClock();
    this.logger = opts.logger ?? noopLogger;
    this.dedup = opts.dedup ?? new MemoryDedupStore({ now: () => this.clock.now() });
    this.limiter =
      opts.limiter ??
      new TokenBucketLimiter({
        ratePerSec: opts.ratePerSec ?? 1,
        burst: opts.burst ?? 3,
        clock: this.clock,
      });
    this.retry = { clock: this.clock, ...opts.retry };
    this.reconnect = { clock: this.clock, logger: this.logger, ...opts.reconnect };
  }

  on(handler: InboundHandler): void {
    this.handlers.push(handler);
  }

  async dispatch(event: Inbound): Promise<boolean> {
    const key = dedupKey(this.platform, this.accountId, event.id);
    if (await this.dedup.seen(key)) {
      this.logger.debug("drop duplicate inbound", { key, type: event.type });
      return false;
    }
    for (const handler of this.handlers) {
      await handler(event);
    }
    return true;
  }

  async outbound<T>(chat: ChatRef, fn: () => Promise<T>): Promise<T> {
    await this.limiter.take(chatKey(chat));
    return withRetry(fn, this.retry);
  }

  start(conn: Connectable, signal: AbortSignal): Promise<void> {
    return runReconnectSupervisor(conn, signal, this.reconnect);
  }
}

export function assertChatPlatform(adapter: Pick<Adapter, "platform">, chat: ChatRef): void {
  if (chat.platform !== adapter.platform) {
    throw new Error(`chat.platform ${chat.platform} does not match adapter ${adapter.platform}`);
  }
}
