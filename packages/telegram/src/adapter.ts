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
} from "imwire";
import { TelegramApi, type TelegramFetch, type TelegramMessage, type TelegramUser } from "./api.js";
import { telegramCapabilities } from "./capabilities.js";
import { mapTelegramUpdate } from "./map.js";
import { asNumber, asRecord, asString } from "./util.js";

export interface TelegramAdapterOptions {
  token: string;
  accountId?: string;
  fetch?: TelegramFetch;
  baseUrl?: string;
  pollTimeoutSec?: number;
  draftThrottleMs?: number;
  logger?: Logger;
  /** Test hook: skip getMe / polling and only use ingest(). */
  api?: TelegramApi;
}

const ALLOWED_UPDATES = ["message", "edited_message", "callback_query", "message_reaction"];

export class TelegramAdapter implements Adapter, Connectable {
  readonly platform = "telegram" as const;
  readonly capabilities: Capabilities = telegramCapabilities;
  accountId: string;
  private readonly runtime: AdapterRuntime;
  private readonly api: TelegramApi;
  private readonly pollTimeoutSec: number;
  private readonly draftThrottleMs: number;
  private botUserId?: string;
  private botUsername?: string;
  private offset = 0;
  private alive = false;

  constructor(opts: TelegramAdapterOptions) {
    this.accountId = opts.accountId ?? "telegram";
    this.api = opts.api ?? new TelegramApi({ token: opts.token, fetch: opts.fetch, baseUrl: opts.baseUrl });
    this.pollTimeoutSec = opts.pollTimeoutSec ?? 30;
    this.draftThrottleMs = opts.draftThrottleMs ?? 800;
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
    return this.alive;
  }

  async connect(signal: AbortSignal): Promise<void> {
    this.alive = true;
    try {
      await this.ensureBot(signal);
      while (!signal.aborted) {
        const updates = await this.api.call<unknown[]>(
          "getUpdates",
          {
            offset: this.offset,
            timeout: this.pollTimeoutSec,
            allowed_updates: ALLOWED_UPDATES,
          },
          signal,
        );
        for (const update of updates) {
          const rec = asRecord(update);
          const id = asNumber(rec?.update_id);
          if (id !== undefined) this.offset = id + 1;
          await this.ingest(update);
        }
      }
    } catch (err) {
      if (signal.aborted || isAbortError(err)) return;
      throw err;
    } finally {
      this.alive = false;
    }
  }

  async disconnect(): Promise<void> {
    this.alive = false;
  }

  async ingest(raw: unknown): Promise<void> {
    const events = mapTelegramUpdate(raw, {
      accountId: this.accountId,
      botUserId: this.botUserId,
      botUsername: this.botUsername,
    });
    for (const event of events) {
      if (event.type === "action") {
        const cb = asRecord(asRecord(raw)?.callback_query);
        const cbId = asString(cb?.id);
        if (cbId) {
          await this.api.call("answerCallbackQuery", { callback_query_id: cbId }).catch(() => undefined);
        }
      }
      await this.runtime.dispatch(event);
    }
  }

  async send(chat: ChatRef, msg: OutMessage): Promise<MsgRef[]> {
    assertChatPlatform(this, chat);
    const text = [markdownText(msg), statusText(msg)].filter(Boolean).join("\n\n") || "…";
    const chunks = chunkText(text, this.capabilities.maxTextLength);
    const buttons = collectButtons(msg);
    const refs: MsgRef[] = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const isLast = i === chunks.length - 1;
      const sent = await this.runtime.outbound(chat, () =>
        this.api.call<TelegramMessage>("sendMessage", {
          chat_id: Number(chat.chatId) || chat.chatId,
          text: chunks[i],
          message_thread_id: chat.threadId ? Number(chat.threadId) || chat.threadId : undefined,
          reply_parameters:
            i === 0 && msg.replyTo
              ? { message_id: Number(msg.replyTo.messageId) || msg.replyTo.messageId }
              : undefined,
          reply_markup: isLast && buttons.length > 0 ? inlineKeyboard(buttons) : undefined,
        }),
      );
      refs.push(toRef(chat, sent));
    }
    return refs;
  }

  async edit(ref: MsgRef, msg: OutMessage): Promise<void> {
    assertChatPlatform(this, ref.chat);
    const text = [markdownText(msg), statusText(msg)].filter(Boolean).join("\n\n") || "…";
    const buttons = collectButtons(msg);
    try {
      await this.runtime.outbound(ref.chat, () =>
        this.api.call("editMessageText", {
          chat_id: Number(ref.chat.chatId) || ref.chat.chatId,
          message_id: Number(ref.messageId) || ref.messageId,
          text: text.slice(0, this.capabilities.maxTextLength),
          reply_markup: buttons.length > 0 ? inlineKeyboard(buttons) : undefined,
        }),
      );
    } catch (err) {
      if (err instanceof Error && /message is not modified/i.test(err.message)) return;
      throw err;
    }
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

  async typing(chat: ChatRef): Promise<void> {
    assertChatPlatform(this, chat);
    await this.runtime.outbound(chat, () =>
      this.api.call("sendChatAction", {
        chat_id: Number(chat.chatId) || chat.chatId,
        action: "typing",
        message_thread_id: chat.threadId ? Number(chat.threadId) || chat.threadId : undefined,
      }),
    );
  }

  async react(ref: MsgRef, emoji: string): Promise<void> {
    assertChatPlatform(this, ref.chat);
    await this.runtime.outbound(ref.chat, () =>
      this.api.call("setMessageReaction", {
        chat_id: Number(ref.chat.chatId) || ref.chat.chatId,
        message_id: Number(ref.messageId) || ref.messageId,
        reaction: [{ type: "emoji", emoji }],
      }),
    );
  }

  async download(media: MediaRef): Promise<ReadableStream<Uint8Array>> {
    const file = await this.api.call<{ file_path?: string }>("getFile", { file_id: media.id });
    if (!file.file_path) throw new Error(`telegram getFile returned no path for ${media.id}`);
    return this.api.downloadFile(file.file_path);
  }

  private async ensureBot(signal?: AbortSignal): Promise<void> {
    if (this.botUserId) return;
    const me = await this.api.call<TelegramUser>("getMe", {}, signal);
    this.botUserId = String(me.id);
    this.botUsername = me.username;
    if (this.accountId === "telegram") {
      this.accountId = this.botUserId;
      this.runtime.accountId = this.botUserId;
    }
  }
}

function inlineKeyboard(buttons: { id: string; label: string; style?: string }[]) {
  return {
    inline_keyboard: [
      buttons.map((b) => ({
        text: b.style === "danger" ? `✕ ${b.label}` : b.style === "primary" ? `● ${b.label}` : b.label,
        callback_data: b.id.slice(0, 64),
      })),
    ],
  };
}

function toRef(chat: ChatRef, sent: TelegramMessage): MsgRef {
  return { chat, messageId: String(sent.message_id) };
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof Error && err.name === "AbortError") ||
    (typeof err === "object" && err !== null && (err as { name?: string }).name === "AbortError")
  );
}
