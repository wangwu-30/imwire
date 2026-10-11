import {
  AdapterRuntime,
  assertChatPlatform,
  chunkText,
  collectButtons,
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
import { wecomCapabilities } from "./capabilities.js";
import { respondBody, streamBody } from "./cards.js";
import { mapWecomEvent, replyContextOf } from "./map.js";
import { createRawWecomTransport, type WecomFrame, type WecomTransport } from "./transport.js";
import { asRecord, asString, newId } from "./util.js";

export interface WecomAdapterOptions {
  botId: string;
  secret: string;
  accountId?: string;
  transport?: WecomTransport;
  draftThrottleMs?: number;
  logger?: Logger;
}

interface ReplySlot {
  reqId: string;
  msgid: string;
}

interface StreamToken {
  streamId: string;
  reqId: string;
}

/**
 * Reply-only WeCom 智能机器人 adapter.
 * Outbound always uses `aibot_respond_msg` with the last inbound `req_id`
 * for that chat — never `aibot_send_msg` (docs have it; we map the
 * constraint as `proactiveSend: false`).
 * https://developer.work.weixin.qq.com/document/path/101463
 */
export class WecomAdapter implements Adapter, Connectable {
  readonly platform = "wecom" as const;
  readonly capabilities: Capabilities = wecomCapabilities;
  readonly accountId: string;
  private readonly runtime: AdapterRuntime;
  private readonly draftThrottleMs: number;
  private readonly createTransport: () => WecomTransport;
  private transport?: WecomTransport;
  private readonly replies = new Map<string, ReplySlot>();

  constructor(opts: WecomAdapterOptions) {
    this.accountId = opts.accountId ?? opts.botId;
    this.draftThrottleMs = opts.draftThrottleMs ?? 200;
    this.createTransport = () =>
      opts.transport ??
      createRawWecomTransport({
        botId: opts.botId,
        secret: opts.secret,
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
    return this.transport?.isAlive() ?? false;
  }

  async connect(signal: AbortSignal): Promise<void> {
    this.transport?.stop();
    this.transport = this.createTransport();
    await this.transport.start((frame) => this.ingest(frame, { wait: false }), signal);
  }

  async disconnect(): Promise<void> {
    this.transport?.stop();
  }

  rememberReply(chatId: string, reqId: string, msgid?: string): void {
    this.replies.set(chatId, { reqId, msgid: msgid ?? reqId });
  }

  async ingest(raw: unknown, opts?: { wait?: boolean }): Promise<void> {
    const slot = replyContextOf(raw);
    if (slot) this.replies.set(slot.chatId, { reqId: slot.reqId, msgid: slot.msgid });
    const events = mapWecomEvent(raw, { accountId: this.accountId });
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
    const buttons = collectButtons(msg);
    const refs: MsgRef[] = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const isLast = i === chunks.length - 1;
      const body = respondBody(
        {
          blocks: [
            { kind: "markdown", text: chunks[i] ?? "…" },
            ...(isLast && buttons.length > 0 ? ([{ kind: "buttons" as const, buttons }] as const) : []),
          ],
        },
        newId("task"),
      );
      const messageId = await this.runtime.outbound(chat, () => this.respond(chat, body));
      refs.push({ chat, messageId });
    }
    return refs;
  }

  async edit(ref: MsgRef, msg: OutMessage): Promise<void> {
    assertChatPlatform(this, ref.chat);
    await this.runtime.outbound(ref.chat, () =>
      this.push({
        cmd: "aibot_respond_update_msg",
        headers: { req_id: this.reqId(ref.chat.chatId) },
        body: {
          response_type: "update_template_card",
          template_card: respondBody(msg, ref.messageId).template_card ?? {
            card_type: "text_notice",
            main_title: { title: markdownText(msg) || "…" },
            task_id: ref.messageId,
          },
        },
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
        streamStart: async (c) => {
          const streamId = newId("stream");
          const reqId = this.reqId(c.chatId);
          await this.push({
            cmd: "aibot_respond_msg",
            headers: { req_id: reqId },
            body: streamBody(streamId, "…", false),
          });
          return { refs: [{ chat: c, messageId: streamId }], token: { streamId, reqId } satisfies StreamToken };
        },
        streamUpdate: async (ctx, text, status) => {
          const token = asStreamToken(ctx.token);
          if (!token) throw new Error("missing wecom stream token");
          await this.push({
            cmd: "aibot_respond_msg",
            headers: { req_id: token.reqId },
            body: streamBody(token.streamId, render(text, status), false),
          });
        },
        streamFinish: async (ctx, msg) => {
          const token = asStreamToken(ctx.token);
          if (!token) return ctx.refs;
          const buttons = collectButtons(msg);
          if (buttons.length > 0) {
            await this.push({
              cmd: "aibot_respond_msg",
              headers: { req_id: token.reqId },
              body: streamBody(token.streamId, markdownText(msg) || "…", true),
            });
            const messageId = await this.respond(ctx.refs[0]?.chat ?? chat, respondBody(msg, token.streamId));
            return [{ chat, messageId }];
          }
          await this.push({
            cmd: "aibot_respond_msg",
            headers: { req_id: token.reqId },
            body: streamBody(token.streamId, markdownText(msg) || "…", true),
          });
          return ctx.refs;
        },
        streamAbort: async (ctx, note) => {
          const token = asStreamToken(ctx.token);
          if (!token) return;
          await this.push({
            cmd: "aibot_respond_msg",
            headers: { req_id: token.reqId },
            body: streamBody(token.streamId, note ?? "…", true),
          });
        },
      },
    });
  }

  async typing(_chat: ChatRef): Promise<void> {
    return;
  }

  async delete(_ref: MsgRef): Promise<void> {
    return;
  }

  async download(_media: MediaRef): Promise<ReadableStream<Uint8Array>> {
    throw new Error("wecom media download is not implemented");
  }

  private reqId(chatId: string): string {
    return this.replies.get(chatId)?.reqId ?? newId("req");
  }

  private async respond(chat: ChatRef, body: Record<string, unknown>): Promise<string> {
    const reqId = this.reqId(chat.chatId);
    await this.push({
      cmd: "aibot_respond_msg",
      headers: { req_id: reqId },
      body,
    });
    return asString(asRecord(body.stream)?.id) ?? this.replies.get(chat.chatId)?.msgid ?? newId("msg");
  }

  private async push(frame: WecomFrame): Promise<void> {
    const transport = this.transport ?? this.createTransport();
    this.transport = transport;
    await transport.send(frame);
  }
}

function asStreamToken(token: unknown): StreamToken | undefined {
  const rec = asRecord(token);
  const streamId = asString(rec?.streamId);
  const reqId = asString(rec?.reqId);
  if (!streamId || !reqId) return undefined;
  return { streamId, reqId };
}

function render(text: string, status?: string): string {
  if (status && text) return `${text}\n\n_${status}_`;
  if (status) return `_${status}_`;
  return text || "…";
}
