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
import { TelegramApi, type TelegramFetch, type TelegramMessage, type TelegramUser } from "./api.js";
import { createCallbackTable, decodeCallbackData, inlineKeyboard, type CallbackPersist } from "./buttons.js";
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
  /** Durable store for hashed callback_data (SQLite via session). Survives restarts. */
  callbackStore?: CallbackPersist;
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
  private readonly callbackTable: ReturnType<typeof createCallbackTable>;
  private webhookCleared = false;

  constructor(opts: TelegramAdapterOptions) {
    this.accountId = opts.accountId ?? "telegram";
    this.api = opts.api ?? new TelegramApi({ token: opts.token, fetch: opts.fetch, baseUrl: opts.baseUrl });
    this.callbackTable = createCallbackTable(undefined, opts.callbackStore);
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
        try {
          const updates = await this.api.call<unknown[]>(
            "getUpdates",
            {
              offset: this.offset,
              timeout: this.pollTimeoutSec,
              allowed_updates: ALLOWED_UPDATES,
            },
            mergeAbort(signal, (this.pollTimeoutSec + 10) * 1000),
          );
          for (const update of updates) {
            const rec = asRecord(update);
            const id = asNumber(rec?.update_id);
            if (id !== undefined) this.offset = id + 1;
            await this.ingest(update, { wait: false });
          }
        } catch (err) {
          if (isConflict(err) && !this.webhookCleared) {
            this.webhookCleared = true;
            await this.api.call("deleteWebhook", { drop_pending_updates: false }).catch(() => undefined);
            continue;
          }
          throw err;
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

  async ingest(raw: unknown, opts?: { wait?: boolean }): Promise<void> {
    const events = mapTelegramUpdate(raw, {
      accountId: this.accountId,
      botUserId: this.botUserId,
      botUsername: this.botUsername,
    });
    for (const event of events) {
      if (event.type === "action") {
        const decoded = decodeCallbackData(event.actionId + (event.value ? `:${event.value}` : ""), this.callbackTable);
        // map already split on `:`; prefer table lookup on the raw callback_data
        const rawData = asString(asRecord(asRecord(raw)?.callback_query)?.data);
        const resolved = rawData ? decodeCallbackData(rawData, this.callbackTable) : decoded;
        event.actionId = resolved.actionId;
        event.value = resolved.value;
        const cb = asRecord(asRecord(raw)?.callback_query);
        const cbId = asString(cb?.id);
        if (cbId) {
          await this.api.call("answerCallbackQuery", { callback_query_id: cbId }).catch(() => undefined);
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
          reply_markup: isLast && buttons.length > 0 ? inlineKeyboard(buttons, this.callbackTable) : undefined,
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
          reply_markup: buttons.length > 0 ? inlineKeyboard(buttons, this.callbackTable) : undefined,
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

  async delete(ref: MsgRef): Promise<void> {
    assertChatPlatform(this, ref.chat);
    await this.runtime.outbound(ref.chat, () =>
      this.api.call("deleteMessage", {
        chat_id: Number(ref.chat.chatId) || ref.chat.chatId,
        message_id: Number(ref.messageId) || ref.messageId,
      }),
    );
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

function mergeAbort(signal: AbortSignal, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
  const ac = new AbortController();
  const abort = (): void => ac.abort();
  if (signal.aborted || timeout.aborted) abort();
  else {
    signal.addEventListener("abort", abort, { once: true });
    timeout.addEventListener("abort", abort, { once: true });
  }
  return ac.signal;
}

function isConflict(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { status?: number }).status === 409;
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
