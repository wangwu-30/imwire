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
  type StreamContext,
} from "@imwire/core";
import { cardDataFromOut, cardParamMap, DEFAULT_STREAM_KEY, webhookMarkdown } from "./cards.js";
import { DINGTALK_STREAM_CONTENT_LIMIT, dingtalkCapabilities } from "./capabilities.js";
import { createDingTalkHttp, type DingTalkHttp } from "./http.js";
import { mapDingTalkEvent, robotSessionOf } from "./map.js";
import { createRawDingTalkStream, type DingTalkStream } from "./stream.js";
import { asRecord, asString, newId } from "./util.js";

export interface DingTalkAdapterOptions {
  clientId: string;
  clientSecret: string;
  accountId?: string;
  robotCode?: string;
  /** AI card template id for createAndDeliver + streaming. */
  cardTemplateId?: string;
  streamKey?: string;
  http?: DingTalkHttp;
  stream?: DingTalkStream;
  draftThrottleMs?: number;
  logger?: Logger;
}

interface CardToken {
  outTrackId: string;
  seq: number;
}

interface SessionHook {
  webhook?: string;
  expiresAt?: number;
  senderStaffId?: string;
}

export class DingTalkAdapter implements Adapter, Connectable {
  readonly platform = "dingtalk" as const;
  readonly capabilities: Capabilities;
  readonly accountId: string;
  private readonly runtime: AdapterRuntime;
  private readonly http: DingTalkHttp;
  private readonly draftThrottleMs: number;
  private readonly robotCode: string;
  private readonly cardTemplateId?: string;
  private readonly streamKey: string;
  private readonly createStream: () => DingTalkStream;
  private stream?: DingTalkStream;
  private readonly sessions = new Map<string, SessionHook>();
  private readonly cardChats = new Map<string, ChatRef>();

  constructor(opts: DingTalkAdapterOptions) {
    this.accountId = opts.accountId ?? opts.clientId;
    this.robotCode = opts.robotCode ?? opts.clientId;
    this.cardTemplateId = opts.cardTemplateId;
    this.capabilities = {
      ...dingtalkCapabilities,
      buttons: Boolean(opts.cardTemplateId),
      streamingCard: Boolean(opts.cardTemplateId),
      streaming: opts.cardTemplateId ? "card" : "buffer",
    };
    this.streamKey = opts.streamKey ?? DEFAULT_STREAM_KEY;
    this.http = opts.http ?? createDingTalkHttp(opts);
    this.draftThrottleMs = opts.draftThrottleMs ?? 200;
    this.createStream = () =>
      opts.stream ??
      createRawDingTalkStream({
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
        http: this.http,
      });
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
    return this.stream?.isAlive() ?? false;
  }

  async connect(signal: AbortSignal): Promise<void> {
    this.stream?.stop();
    this.stream = this.createStream();
    await this.stream.start(
      {
        onEvent: (raw) => this.ingest(raw, { wait: false }),
      },
      signal,
    );
  }

  async disconnect(): Promise<void> {
    this.stream?.stop();
  }

  async ingest(raw: unknown, opts?: { wait?: boolean }): Promise<void> {
    const session = robotSessionOf(raw);
    if (session) {
      this.sessions.set(session.chatId, {
        webhook: session.webhook,
        expiresAt: session.webhookExpiresAt,
        senderStaffId: session.senderStaffId,
      });
    }
    const events = mapDingTalkEvent(raw, {
      accountId: this.accountId,
      chatForTrack: (id) => this.cardChats.get(id),
    });
    for (const event of events) {
      if (event.type === "action") {
        const known = this.sessions.get(event.target.chat.chatId);
        if (!known && event.target.chat.chatId && event.target.chat.chatId !== "unknown") {
          this.sessions.set(event.target.chat.chatId, {});
        }
      }
      await this.runtime.enqueue(event);
    }
    if (opts?.wait !== false) await this.runtime.flush();
  }

  async flush(): Promise<void> {
    await this.runtime.flush();
  }

  async send(chat: ChatRef, msg: OutMessage): Promise<MsgRef[]> {
    assertChatPlatform(this, chat);
    const buttons = collectButtons(msg);
    const text = [markdownText(msg), statusText(msg)].filter(Boolean).join("\n\n") || "…";
    const chunks = chunkText(text, this.capabilities.maxTextLength);
    const refs: MsgRef[] = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const isLast = i === chunks.length - 1;
      const chunkButtons = isLast ? buttons : [];
      const created = await this.runtime.outbound(chat, () =>
        this.deliver(chat, chunks[i] ?? "…", chunkButtons, i === 0 ? msg.replyTo : undefined),
      );
      refs.push(created);
    }
    return refs;
  }

  async edit(ref: MsgRef, msg: OutMessage): Promise<void> {
    assertChatPlatform(this, ref.chat);
    await this.runtime.outbound(ref.chat, () =>
      this.streamCard(ref.messageId, cardDataFromOut(msg)[this.streamKey] ?? (markdownText(msg) || "…"), true),
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
        streamStart: async (c) => this.startCard(c),
        streamUpdate: async (ctx, text, status) => {
          const token = asCardToken(ctx.token);
          if (!token) throw new Error("missing dingtalk card token");
          await this.streamCard(token.outTrackId, render(text, status), false);
        },
        streamFinish: async (ctx, msg) => {
          const token = asCardToken(ctx.token);
          if (!token) return ctx.refs;
          await this.streamCard(token.outTrackId, markdownText(msg) || "…", true);
          return ctx.refs;
        },
        streamAbort: async (ctx, note) => {
          const token = asCardToken(ctx.token);
          if (!token) return;
          await this.streamCard(token.outTrackId, note ?? "…", true, true);
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
    throw new Error("dingtalk media download is not implemented");
  }

  /** Test / serve hook: remember a sessionWebhook so send() can reply. */
  rememberSession(chatId: string, webhook?: string, senderStaffId?: string): void {
    this.sessions.set(chatId, { webhook, senderStaffId });
  }

  private async startCard(chat: ChatRef): Promise<StreamContext | undefined> {
    if (!this.cardTemplateId) return undefined;
    const outTrackId = newId("card");
    try {
      await this.createAndDeliver(chat, outTrackId, cardParamMap("…"), false);
      return { refs: [{ chat, messageId: outTrackId }], token: { outTrackId, seq: 0 } satisfies CardToken };
    } catch {
      return undefined;
    }
  }

  private async deliver(chat: ChatRef, text: string, buttons: ReturnType<typeof collectButtons>, _replyTo?: MsgRef): Promise<MsgRef> {
    if (this.cardTemplateId) {
      const outTrackId = newId("card");
      await this.createAndDeliver(chat, outTrackId, cardParamMap(text, undefined, buttons), true);
      return { chat, messageId: outTrackId };
    }
    const session = this.sessions.get(chat.chatId);
    const webhookFresh = session?.webhook && (!session.expiresAt || session.expiresAt > Date.now());
    if (webhookFresh && session?.webhook) {
      const body = webhookMarkdown(text);
      await this.http.request({
        method: "POST",
        path: session.webhook,
        body,
        anonymous: true,
      });
      return { chat, messageId: newId("msg") };
    }
    if (chat.kind === "dm") {
      await this.http.request({
        method: "POST",
        path: "/v1.0/robot/oToMessages/batchSend",
        body: {
          robotCode: this.robotCode,
          userIds: [chat.chatId],
          msgKey: "sampleMarkdown",
          msgParam: JSON.stringify({ title: "imwire", text }),
        },
      });
      return { chat, messageId: newId("msg") };
    }
    await this.http.request({
      method: "POST",
      path: "/v1.0/robot/groupMessages/send",
      body: {
        robotCode: this.robotCode,
        openConversationId: chat.chatId,
        msgKey: "sampleMarkdown",
        msgParam: JSON.stringify({ title: "imwire", text }),
      },
    });
    return { chat, messageId: newId("msg") };
  }

  private async createAndDeliver(
    chat: ChatRef,
    outTrackId: string,
    cardParam: Record<string, string>,
    finalize: boolean,
  ): Promise<void> {
    if (!this.cardTemplateId) throw new Error("dingtalk AI card requires cardTemplateId");
    // https://open.dingtalk.com/document/development/create-and-deliver-cards.md
    const openSpaceId =
      chat.kind === "group" ? `dtv1.card//IM_GROUP.${chat.chatId}` : `dtv1.card//IM_ROBOT.${chat.chatId}`;
    await this.http.request({
      method: "POST",
      path: "/v1.0/card/instances/createAndDeliver",
      body: {
        cardTemplateId: this.cardTemplateId,
        outTrackId,
        cardData: { cardParamMap: cardParam },
        callbackType: "STREAM",
        openSpaceId,
        imRobotOpenDeliverModel:
          chat.kind === "dm" ? { spaceType: "IM_ROBOT", robotCode: this.robotCode } : undefined,
        imGroupOpenDeliverModel: chat.kind === "group" ? { robotCode: this.robotCode } : undefined,
      },
    });
    this.cardChats.set(outTrackId, chat);
    if (finalize) {
      await this.streamCard(outTrackId, cardParam.content ?? "…", true);
    }
  }

  /**
   * PUT /v1.0/card/streaming
   * https://open.dingtalk.com/document/orgapp/api-streamingupdate
   */
  private async streamCard(outTrackId: string, content: string, isFinalize: boolean, isError = false): Promise<void> {
    await this.http.request({
      method: "PUT",
      path: "/v1.0/card/streaming",
      body: {
        outTrackId,
        guid: newId("guid"),
        key: this.streamKey,
        content: clipStreamContent(content),
        isFull: true,
        isFinalize,
        isError,
      },
    });
  }
}

function asCardToken(token: unknown): CardToken | undefined {
  const rec = asRecord(token);
  const outTrackId = asString(rec?.outTrackId);
  if (!outTrackId) return undefined;
  return { outTrackId, seq: 0 };
}

function clipStreamContent(content: string): string {
  if (Buffer.byteLength(content, "utf8") <= DINGTALK_STREAM_CONTENT_LIMIT) return content;
  let out = content;
  while (out.length > 0 && Buffer.byteLength(out, "utf8") > DINGTALK_STREAM_CONTENT_LIMIT) {
    out = out.slice(0, -1);
  }
  return out;
}

function render(text: string, status?: string): string {
  if (status && text) return `${text}\n\n_${status}_`;
  if (status) return `_${status}_`;
  return text || "…";
}
