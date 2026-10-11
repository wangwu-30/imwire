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
  type StreamContext,
} from "imwire";
import { feishuCapabilities } from "./capabilities.js";
import {
  STREAM_ELEMENT_ID,
  buildCardJson,
  cardFromOutMessage,
  cardkitRefContent,
  interactiveContent,
  textContent,
} from "./cards.js";
import { createFeishuHttp, type FeishuHttp } from "./http.js";
import { mapFeishuEvent } from "./map.js";
import { createSdkRealtime, type FeishuRealtime } from "./realtime.js";
import { asString } from "./util.js";

export interface FeishuAdapterOptions {
  appId: string;
  appSecret: string;
  accountId?: string;
  domain?: "feishu" | "lark";
  http?: FeishuHttp;
  realtime?: FeishuRealtime;
  draftThrottleMs?: number;
  logger?: Logger;
}

interface CreatedMessage {
  message_id?: string;
}

interface CreatedCard {
  card_id?: string;
}

export class FeishuAdapter implements Adapter, Connectable {
  readonly platform = "feishu" as const;
  readonly capabilities: Capabilities = feishuCapabilities;
  readonly accountId: string;
  private readonly runtime: AdapterRuntime;
  private readonly http: FeishuHttp;
  private readonly draftThrottleMs: number;
  private readonly createRealtime: () => Promise<FeishuRealtime>;
  private realtime?: FeishuRealtime;
  private seq = 0;

  constructor(opts: FeishuAdapterOptions) {
    this.accountId = opts.accountId ?? opts.appId;
    this.http = opts.http ?? createFeishuHttp(opts);
    this.draftThrottleMs = opts.draftThrottleMs ?? 200;
    this.createRealtime = async () =>
      opts.realtime ??
      (await createSdkRealtime({
        appId: opts.appId,
        appSecret: opts.appSecret,
        domain: opts.domain,
      }));
    this.runtime = new AdapterRuntime({
      platform: this.platform,
      accountId: this.accountId,
      capabilities: this.capabilities,
      ratePerSec: 5,
      burst: 5,
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
    return this.realtime?.isAlive() ?? false;
  }

  async connect(signal: AbortSignal): Promise<void> {
    this.realtime = await this.createRealtime();
    await this.realtime.start(
      {
        onEvent: (raw, type) => this.ingest(raw, type),
      },
      signal,
    );
  }

  async disconnect(): Promise<void> {
    this.realtime?.stop();
  }

  async ingest(raw: unknown, eventType?: string): Promise<void> {
    const events = mapFeishuEvent(raw, { accountId: this.accountId }, eventType);
    for (const event of events) {
      await this.runtime.dispatch(event);
    }
  }

  async send(chat: ChatRef, msg: OutMessage): Promise<MsgRef[]> {
    assertChatPlatform(this, chat);
    const buttons = msg.blocks.some((b) => b.kind === "buttons");
    if (buttons || msg.blocks.some((b) => b.kind === "status")) {
      const created = await this.runtime.outbound(chat, () =>
        this.createMessage(chat, "interactive", interactiveContent(cardFromOutMessage(msg)), msg.replyTo),
      );
      return [toRef(chat, created)];
    }
    const text = [markdownText(msg), statusText(msg)].filter(Boolean).join("\n\n") || "…";
    const chunks = chunkText(text, this.capabilities.maxTextLength);
    const refs: MsgRef[] = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const created = await this.runtime.outbound(chat, () =>
        this.createMessage(chat, "text", textContent(chunks[i] ?? ""), i === 0 ? msg.replyTo : undefined),
      );
      refs.push(toRef(chat, created));
    }
    return refs;
  }

  async edit(ref: MsgRef, msg: OutMessage): Promise<void> {
    assertChatPlatform(this, ref.chat);
    await this.runtime.outbound(ref.chat, () =>
      this.http.request({
        method: "PATCH",
        path: `/open-apis/im/v1/messages/${encodeURIComponent(ref.messageId)}`,
        body: { content: interactiveContent(cardFromOutMessage(msg)) },
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
        streamStart: async (c, startOpts) => this.startCard(c, startOpts.replyTo),
        streamUpdate: async (ctx, text, status) => this.updateCard(ctx, text, status),
        streamFinish: async (ctx, msg) => this.finishCard(ctx, msg),
        streamAbort: async (ctx, note) => {
          await this.updateCard(ctx, note ?? "…");
          try {
            await this.patchCardSettings(ctx, false);
          } catch {
            // ignore
          }
        },
      },
    });
  }

  async typing(_chat: ChatRef): Promise<void> {
    return;
  }

  async download(media: MediaRef): Promise<ReadableStream<Uint8Array>> {
    const type = media.kind === "image" ? "image" : "file";
    const [messageId, fileKey] = splitMediaId(media.id);
    const data = await this.http.request<{ file?: Uint8Array } | ArrayBuffer>({
      method: "GET",
      path: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}`,
      query: { type },
    });
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new TextEncoder().encode(JSON.stringify(data));
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  private async createMessage(
    chat: ChatRef,
    msgType: string,
    content: string,
    replyTo?: MsgRef,
  ): Promise<CreatedMessage> {
    if (replyTo) {
      return this.http.request<CreatedMessage>({
        method: "POST",
        path: `/open-apis/im/v1/messages/${encodeURIComponent(replyTo.messageId)}/reply`,
        body: { content, msg_type: msgType },
      });
    }
    return this.http.request<CreatedMessage>({
      method: "POST",
      path: "/open-apis/im/v1/messages",
      query: { receive_id_type: "chat_id" },
      body: { receive_id: chat.chatId, content, msg_type: msgType },
    });
  }

  private async startCard(chat: ChatRef, replyTo?: MsgRef): Promise<StreamContext | undefined> {
    try {
      const card = await this.http.request<CreatedCard>({
        method: "POST",
        path: "/open-apis/cardkit/v1/cards",
        body: {
          type: "card_json",
          data: JSON.stringify(buildCardJson({ text: "…", streaming: true })),
        },
      });
      const cardId = asString(card.card_id);
      if (!cardId) return undefined;
      const created = await this.createMessage(chat, "interactive", cardkitRefContent(cardId), replyTo);
      const messageId = asString(created.message_id);
      if (!messageId) return undefined;
      this.seq = 0;
      return { refs: [{ chat, messageId }], token: { cardId, messageId } };
    } catch {
      const created = await this.createMessage(
        chat,
        "interactive",
        interactiveContent(buildCardJson({ text: "…", streaming: false })),
        replyTo,
      );
      const messageId = asString(created.message_id);
      if (!messageId) return undefined;
      return { refs: [{ chat, messageId }], token: { messageId, patch: true } };
    }
  }

  private async updateCard(ctx: StreamContext, text: string, status?: string): Promise<void> {
    const token = asCardToken(ctx.token);
    if (!token) throw new Error("missing card token");
    if (token.cardId && !token.patch) {
      this.seq += 1;
      await this.http.request({
        method: "PUT",
        path: `/open-apis/cardkit/v1/cards/${encodeURIComponent(token.cardId)}/elements/${STREAM_ELEMENT_ID}/content`,
        body: { content: renderPlain(text, status), sequence: this.seq },
      });
      return;
    }
    if (token.messageId) {
      await this.http.request({
        method: "PATCH",
        path: `/open-apis/im/v1/messages/${encodeURIComponent(token.messageId)}`,
        body: { content: interactiveContent(buildCardJson({ text, status, streaming: false })) },
      });
      return;
    }
    throw new Error("cannot update card");
  }

  private async finishCard(ctx: StreamContext, msg: OutMessage): Promise<MsgRef[]> {
    const token = asCardToken(ctx.token);
    if (token?.cardId && !token.patch) {
      try {
        await this.patchCardSettings(ctx, false);
        this.seq += 1;
        await this.http.request({
          method: "PUT",
          path: `/open-apis/cardkit/v1/cards/${encodeURIComponent(token.cardId)}/elements/${STREAM_ELEMENT_ID}/content`,
          body: { content: markdownText(msg) || "…", sequence: this.seq },
        });
      } catch {
        const fallback = ctx.refs[0];
        if (fallback) await this.edit(fallback, msg);
      }
      const existing = ctx.refs[0];
      if (msg.blocks.some((b) => b.kind === "buttons") && existing) {
        await this.edit(existing, msg);
      }
      return ctx.refs;
    }
    if (ctx.refs[0]) await this.edit(ctx.refs[0], msg);
    return ctx.refs;
  }

  private async patchCardSettings(ctx: StreamContext, streaming: boolean): Promise<void> {
    const token = asCardToken(ctx.token);
    if (!token?.cardId) return;
    this.seq += 1;
    await this.http.request({
      method: "PATCH",
      path: `/open-apis/cardkit/v1/cards/${encodeURIComponent(token.cardId)}/settings`,
      body: {
        settings: JSON.stringify({ config: { streaming_mode: streaming, update_multi: true } }),
        sequence: this.seq,
      },
    });
  }
}

function splitMediaId(id: string): [string, string] {
  const idx = id.indexOf("/");
  if (idx === -1) return ["unknown", id];
  return [id.slice(0, idx), id.slice(idx + 1)];
}

function toRef(chat: ChatRef, created: CreatedMessage): MsgRef {
  return { chat, messageId: asString(created.message_id) ?? "unknown" };
}

function asCardToken(token: unknown): { cardId?: string; messageId?: string; patch?: boolean } | undefined {
  if (!token || typeof token !== "object") return undefined;
  const rec = token as { cardId?: string; messageId?: string; patch?: boolean };
  return rec;
}

function renderPlain(text: string, status?: string): string {
  if (status && text) return `${text}\n\n_${status}_`;
  if (status) return `_${status}_`;
  return text || "…";
}
