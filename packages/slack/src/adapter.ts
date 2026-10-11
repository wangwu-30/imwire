import {
  AdapterRuntime,
  assertChatPlatform,
  chunkText,
  createStreamingDraft,
  markdownText,
  statusText,
  type Adapter,
  type Capabilities,
  type ChatRef,
  type Connectable,
  type DraftHandle,
  type InboundHandler,
  type Logger,
  type MediaRef,
  type MsgRef,
  type OutMessage,
} from "@imwire/core";
import { createSlackWeb, type SlackWeb } from "./api.js";
import { blocksFromOut, fallbackText } from "./blocks.js";
import { slackCapabilities } from "./capabilities.js";
import { envelopeIdOf, mapSlackEvent } from "./map.js";
import { createRawSlackSocket, type SlackSocket } from "./socket.js";
import { asString } from "./util.js";

export interface SlackAdapterOptions {
  botToken: string;
  appToken?: string;
  accountId?: string;
  botUserId?: string;
  web?: SlackWeb;
  socket?: SlackSocket;
  draftThrottleMs?: number;
  logger?: Logger;
}

export class SlackAdapter implements Adapter, Connectable {
  readonly platform = "slack" as const;
  readonly capabilities: Capabilities = slackCapabilities;
  readonly accountId: string;
  private readonly runtime: AdapterRuntime;
  private readonly web: SlackWeb;
  private readonly draftThrottleMs: number;
  private readonly createSocket: () => SlackSocket;
  private socket?: SlackSocket;
  private botUserId?: string;

  constructor(opts: SlackAdapterOptions) {
    this.accountId = opts.accountId ?? "slack";
    this.botUserId = opts.botUserId;
    this.web = opts.web ?? createSlackWeb(opts);
    this.draftThrottleMs = opts.draftThrottleMs ?? 400;
    this.createSocket = () =>
      opts.socket ??
      createRawSlackSocket({
        web: this.web,
      });
    this.runtime = new AdapterRuntime({
      platform: this.platform,
      accountId: this.accountId,
      capabilities: this.capabilities,
      ratePerSec: 1,
      burst: 3,
      logger: opts.logger,
    });
  }

  on(handler: InboundHandler): void {
    this.runtime.on(handler);
  }

  async start(signal: AbortSignal): Promise<void> {
    await this.runtime.start(this, signal);
  }

  isAlive(): boolean {
    return this.socket?.isAlive() ?? false;
  }

  async connect(signal: AbortSignal): Promise<void> {
    const me = await this.web.call<{ user_id?: string; user?: string; bot_id?: string }>("auth.test");
    this.botUserId = asString(me.user_id) ?? asString(me.user) ?? this.botUserId;
    this.socket?.stop();
    this.socket = this.createSocket();
    await this.socket.start(
      {
        onEnvelope: async (raw) => {
          const id = envelopeIdOf(raw);
          if (id) await this.socket?.ack(id);
          await this.ingest(raw, { wait: false });
        },
      },
      signal,
    );
  }

  async disconnect(): Promise<void> {
    this.socket?.stop();
  }

  async ingest(raw: unknown, opts?: { wait?: boolean }): Promise<void> {
    const events = mapSlackEvent(raw, { accountId: this.accountId, botUserId: this.botUserId });
    for (const event of events) {
      await this.runtime.enqueue(event);
    }
    if (opts?.wait !== false) await this.runtime.flush();
  }

  async flush(): Promise<void> {
    await this.runtime.flush();
  }

  async send(chat: ChatRef, msg: OutMessage): Promise<MsgRef[]> {
    assertChatPlatform(this, chat);
    const text = [markdownText(msg), statusText(msg)].filter(Boolean).join("\n\n") || "…";
    const chunks = chunkText(text, this.capabilities.maxTextLength);
    const refs: MsgRef[] = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const isLast = i === chunks.length - 1;
      const posted = await this.runtime.outbound(chat, () =>
        this.web.call<{ ts?: string }>("chat.postMessage", {
          channel: chat.chatId,
          text: chunks[i],
          thread_ts: chat.threadId ?? (i === 0 ? msg.replyTo?.messageId : undefined),
          blocks: isLast
            ? blocksFromOut({
                ...msg,
                blocks: [{ kind: "markdown", text: chunks[i] ?? "…" }, ...msg.blocks.filter((b) => b.kind !== "markdown")],
              })
            : undefined,
        }),
      );
      refs.push({ chat, messageId: asString(posted.ts) ?? "unknown" });
    }
    return refs;
  }

  async edit(ref: MsgRef, msg: OutMessage): Promise<void> {
    assertChatPlatform(this, ref.chat);
    await this.runtime.outbound(ref.chat, () =>
      this.web.call("chat.update", {
        channel: ref.chat.chatId,
        ts: ref.messageId,
        text: fallbackText(msg),
        blocks: blocksFromOut(msg),
      }),
    );
  }

  async draft(chat: ChatRef, opts?: { replyTo?: MsgRef }): Promise<DraftHandle> {
    assertChatPlatform(this, chat);
    return createStreamingDraft({
      mode: this.capabilities.streaming,
      maxTextLength: this.capabilities.maxTextLength,
      throttleMs: this.draftThrottleMs,
      chat,
      replyTo: opts?.replyTo,
      sink: {
        send: (c, m) => this.send(c, m),
        edit: (r, m) => this.edit(r, m),
      },
    });
  }

  async typing(_chat: ChatRef): Promise<void> {
    return;
  }

  async delete(ref: MsgRef): Promise<void> {
    assertChatPlatform(this, ref.chat);
    await this.runtime.outbound(ref.chat, () =>
      this.web.call("chat.delete", { channel: ref.chat.chatId, ts: ref.messageId }),
    );
  }

  async react(ref: MsgRef, emoji: string): Promise<void> {
    assertChatPlatform(this, ref.chat);
    await this.runtime.outbound(ref.chat, () =>
      this.web.call("reactions.add", { channel: ref.chat.chatId, timestamp: ref.messageId, name: emoji.replace(/:/g, "") }),
    );
  }

  async download(_media: MediaRef): Promise<ReadableStream<Uint8Array>> {
    throw new Error("slack media download is not implemented");
  }
}
