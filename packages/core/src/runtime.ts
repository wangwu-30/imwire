import { MemoryDedupStore, dedupKey, type DedupStore } from "./dedup.js";
import { TokenBucketLimiter } from "./rate-limit.js";
import { runReconnectSupervisor, type Connectable, type ReconnectOptions } from "./reconnect.js";
import { retryAfterMs, withRetry, type RetryOptions } from "./retry.js";
import {
  chatKey,
  inboundChat,
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

/**
 * Shared inbound/outbound machinery. Ack/receive loops must call `enqueue`
 * (or `dispatch`) and **not** await the user handler — that is the week-2
 * approval pattern (handler waits for a later action event).
 */
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
  private readonly queues = new Map<string, Promise<void>>();

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
    this.retry = {
      clock: this.clock,
      retryAfterMs,
      ...opts.retry,
    };
    this.reconnect = { clock: this.clock, logger: this.logger, ...opts.reconnect };
  }

  on(handler: InboundHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Dedup + enqueue. Resolves as soon as the event is accepted; handlers run
   * later on a per-conversation queue (cross-conversation parallel).
   */
  async dispatch(event: Inbound): Promise<boolean> {
    return this.enqueue(event);
  }

  async enqueue(event: Inbound): Promise<boolean> {
    const key = dedupKey(this.platform, this.accountId, event.id);
    if (await this.dedup.seen(key)) {
      this.logger.debug("drop duplicate inbound", { key, type: event.type });
      return false;
    }
    // Actions/edits/reactions must not wait behind a handler that is itself
    // awaiting an approval click on the same chat (week-2 agent turn).
    if (event.type === "action" || event.type === "edit" || event.type === "reaction") {
      const run = this.runHandlers(event);
      this.queues.set(`${event.type}:${event.id}`, run);
      void run.finally(() => this.queues.delete(`${event.type}:${event.id}`));
      return true;
    }
    const lane = chatKey(inboundChat(event));
    const prev = this.queues.get(lane) ?? Promise.resolve();
    const next = prev.then(
      () => this.runHandlers(event),
      () => this.runHandlers(event),
    );
    this.queues.set(
      lane,
      next.finally(() => {
        if (this.queues.get(lane) === next) this.queues.delete(lane);
      }),
    );
    return true;
  }

  async flush(): Promise<void> {
    await Promise.all([...this.queues.values()]);
  }

  async outbound<T>(chat: ChatRef, fn: () => Promise<T>): Promise<T> {
    await this.limiter.take(chatKey(chat));
    try {
      return await withRetry(fn, this.retry);
    } catch (err) {
      const wait = (this.retry.retryAfterMs ?? retryAfterMs)(err);
      if (wait && wait > 0) this.limiter.cooldown(chatKey(chat), wait);
      throw err;
    }
  }

  start(conn: Connectable, signal: AbortSignal): Promise<void> {
    return runReconnectSupervisor(conn, signal, this.reconnect);
  }

  private async runHandlers(event: Inbound): Promise<void> {
    for (const handler of this.handlers) {
      try {
        await handler(event);
      } catch (err) {
        this.logger.error("inbound handler failed", { type: event.type, id: event.id, err: String(err) });
      }
    }
  }
}

export function assertChatPlatform(adapter: Pick<Adapter, "platform">, chat: ChatRef): void {
  if (chat.platform !== adapter.platform) {
    throw new Error(`chat.platform ${chat.platform} does not match adapter ${adapter.platform}`);
  }
}
