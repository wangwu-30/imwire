import { createStreamingDraft, type DraftSink, type StreamContext } from "../draft.js";
import { AdapterRuntime } from "../runtime.js";
import type {
  Adapter,
  Capabilities,
  ChatRef,
  DraftHandle,
  Inbound,
  MediaRef,
  MsgRef,
  OutMessage,
  Platform,
} from "../types.js";

export interface OutboundCall {
  op: "send" | "edit" | "typing" | "react" | "download" | "streamStart" | "streamUpdate" | "streamFinish" | "streamAbort";
  args: unknown;
}

export interface FakeAdapterOptions {
  platform?: Platform;
  accountId?: string;
  capabilities: Capabilities;
  streamingCard?: boolean;
}

/**
 * In-memory adapter used by the core contract suite and as a reference
 * implementation. Adapters under test wrap a similar fake transport.
 */
export class FakeAdapter implements Adapter {
  readonly platform: Platform;
  readonly accountId: string;
  readonly capabilities: Capabilities;
  readonly calls: OutboundCall[] = [];
  readonly inbound: Inbound[] = [];
  private readonly runtime: AdapterRuntime;
  private seq = 0;
  private started = false;
  private alive = false;

  constructor(opts: FakeAdapterOptions) {
    this.platform = opts.platform ?? "fake";
    this.accountId = opts.accountId ?? "acct";
    this.capabilities = opts.capabilities;
    this.runtime = new AdapterRuntime({
      platform: this.platform,
      accountId: this.accountId,
      capabilities: this.capabilities,
      ratePerSec: 100,
      burst: 100,
    });
  }

  on(handler: (e: Inbound) => Promise<void>): void {
    this.runtime.on(async (e) => {
      this.inbound.push(e);
      await handler(e);
    });
  }

  async ingest(event: Inbound): Promise<boolean> {
    return this.runtime.dispatch(event);
  }

  async start(signal: AbortSignal): Promise<void> {
    this.started = true;
    this.alive = true;
    await this.runtime.start(
      {
        connect: async (inner) => {
          this.alive = true;
          await new Promise<void>((resolve, reject) => {
            const onAbort = (): void => {
              this.alive = false;
              resolve();
            };
            if (inner.aborted) {
              onAbort();
              return;
            }
            inner.addEventListener("abort", onAbort, { once: true });
            if (signal !== inner) {
              signal.addEventListener(
                "abort",
                () => {
                  this.alive = false;
                  reject(new Error("outer abort"));
                },
                { once: true },
              );
            }
          });
        },
        isAlive: () => this.alive,
        disconnect: () => {
          this.alive = false;
        },
      },
      signal,
    );
    this.started = false;
  }

  get isStarted(): boolean {
    return this.started;
  }

  async send(chat: ChatRef, msg: OutMessage): Promise<MsgRef[]> {
    return this.runtime.outbound(chat, async () => {
      this.seq += 1;
      const ref: MsgRef = { chat, messageId: `fake-${this.seq}` };
      this.calls.push({ op: "send", args: { chat, msg, ref } });
      return [ref];
    });
  }

  async edit(ref: MsgRef, msg: OutMessage): Promise<void> {
    await this.runtime.outbound(ref.chat, async () => {
      this.calls.push({ op: "edit", args: { ref, msg } });
    });
  }

  async draft(chat: ChatRef, opts?: { replyTo?: MsgRef }): Promise<DraftHandle> {
    const sink: DraftSink = {
      send: (c, m) => this.send(c, m),
      edit: this.capabilities.edit ? (r, m) => this.edit(r, m) : undefined,
      streamStart: this.capabilities.streamingCard
        ? async (c) => {
            this.seq += 1;
            const ctx: StreamContext = {
              refs: [{ chat: c, messageId: `card-${this.seq}` }],
              token: { card: this.seq },
            };
            this.calls.push({ op: "streamStart", args: { chat: c, ctx } });
            return ctx;
          }
        : undefined,
      streamUpdate: this.capabilities.streamingCard
        ? async (ctx, text, status) => {
            this.calls.push({ op: "streamUpdate", args: { ctx, text, status } });
          }
        : undefined,
      streamFinish: this.capabilities.streamingCard
        ? async (ctx, msg, text) => {
            this.calls.push({ op: "streamFinish", args: { ctx, msg, text } });
            return ctx.refs;
          }
        : undefined,
      streamAbort: this.capabilities.streamingCard
        ? async (ctx, note) => {
            this.calls.push({ op: "streamAbort", args: { ctx, note } });
          }
        : undefined,
    };
    return createStreamingDraft({
      mode: this.capabilities.streaming,
      maxTextLength: this.capabilities.maxTextLength,
      throttleMs: 0,
      chat,
      replyTo: opts?.replyTo,
      sink,
    });
  }

  async typing(chat: ChatRef): Promise<void> {
    if (!this.capabilities.typing) return;
    this.calls.push({ op: "typing", args: { chat } });
  }

  async react(ref: MsgRef, emoji: string): Promise<void> {
    if (!this.capabilities.reactions) return;
    this.calls.push({ op: "react", args: { ref, emoji } });
  }

  async download(media: MediaRef): Promise<ReadableStream<Uint8Array>> {
    this.calls.push({ op: "download", args: { media } });
    return new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`fake:${media.id}`));
        controller.close();
      },
    });
  }
}
