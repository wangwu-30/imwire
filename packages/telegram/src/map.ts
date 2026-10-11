import type { ChatRef, Inbound, MediaRef, MsgRef, Platform, UserRef } from "@imwire/core";
import { asArray, asNumber, asRecord, asString } from "./util.js";

const PLATFORM: Platform = "telegram";

export interface TelegramMapContext {
  accountId: string;
  botUserId?: string;
  botUsername?: string;
}

export function mapTelegramUpdate(raw: unknown, ctx: TelegramMapContext): Inbound[] {
  const update = asRecord(raw);
  if (!update) return [];
  const updateId = asNumber(update.update_id);
  const events: Inbound[] = [];

  if (update.message) {
    const mapped = mapMessage(update.message, ctx, updateId, "message", raw);
    if (mapped) events.push(mapped);
  }
  if (update.edited_message) {
    const mapped = mapMessage(update.edited_message, ctx, updateId, "edit", raw);
    if (mapped) events.push(mapped);
  }
  if (update.callback_query) {
    const mapped = mapCallback(update.callback_query, ctx, updateId, raw);
    if (mapped) events.push(mapped);
  }
  if (update.message_reaction) {
    const mapped = mapReaction(update.message_reaction, ctx, updateId, raw);
    if (mapped) events.push(mapped);
  }
  return events;
}

function mapMessage(
  rawMsg: unknown,
  ctx: TelegramMapContext,
  updateId: number | undefined,
  mode: "message" | "edit",
  raw: unknown,
): Inbound | undefined {
  const msg = asRecord(rawMsg);
  if (!msg) return undefined;
  const topic = msg.is_topic_message === true ? asString(msg.message_thread_id) : undefined;
  const chat = mapChat(msg.chat, ctx, topic);
  if (!chat) return undefined;
  const from = mapUser(msg.from, ctx) ?? {
    platform: PLATFORM,
    accountId: ctx.accountId,
    userId: "unknown",
  };
  const messageId = asString(msg.message_id);
  if (!messageId) return undefined;
  const ts = (asNumber(msg.edit_date) ?? asNumber(msg.date) ?? 0) * 1000;
  const text = extractText(msg);
  const target: MsgRef = { chat, messageId };

  if (mode === "edit") {
    return { type: "edit", id: eventId("edit", updateId, messageId), ts, target, from, text, raw };
  }

  const command = parseCommand(text, ctx.botUsername);
  if (command) {
    return {
      type: "command",
      id: eventId("cmd", updateId, messageId),
      ts,
      chat,
      from,
      messageId,
      name: command.name,
      args: command.args,
      raw,
    };
  }

  const replyTo = mapReplyTo(msg, chat);
  const media = mapMedia(msg);
  return {
    type: "message",
    id: eventId("msg", updateId, messageId),
    ts,
    chat,
    from,
    messageId,
    text,
    mentionsBot: mentionsBot(msg, text, chat, ctx),
    replyTo,
    media: media.length > 0 ? media : undefined,
    raw,
  };
}

function mapCallback(
  rawCb: unknown,
  ctx: TelegramMapContext,
  updateId: number | undefined,
  raw: unknown,
): Inbound | undefined {
  const cb = asRecord(rawCb);
  if (!cb) return undefined;
  const from = mapUser(cb.from, ctx);
  const message = asRecord(cb.message);
  const topic = message?.is_topic_message === true ? asString(message.message_thread_id) : undefined;
  const chat = mapChat(message?.chat, ctx, topic);
  const messageId = asString(message?.message_id);
  if (!from || !chat || !messageId) return undefined;
  const data = asString(cb.data) ?? "";
  const [actionId, value] = splitAction(data);
  return {
    type: "action",
    id: eventId("cb", updateId, asString(cb.id) ?? messageId),
    ts: Date.now(),
    target: { chat, messageId },
    from,
    actionId,
    value,
    raw,
  };
}

function mapReaction(
  rawRx: unknown,
  ctx: TelegramMapContext,
  updateId: number | undefined,
  raw: unknown,
): Inbound | undefined {
  const rx = asRecord(rawRx);
  if (!rx) return undefined;
  const chat = mapChat(rx.chat, ctx);
  const messageId = asString(rx.message_id);
  const from = mapUser(rx.user, ctx);
  if (!chat || !messageId || !from) return undefined;
  const newer = reactionsOf(rx.new_reaction);
  const older = new Set(reactionsOf(rx.old_reaction));
  const added = newer.find((e) => !older.has(e));
  const removed = reactionsOf(rx.old_reaction).find((e) => !newer.includes(e));
  const emoji = added ?? removed;
  if (!emoji) return undefined;
  return {
    type: "reaction",
    id: eventId("rx", updateId, `${messageId}:${emoji}`),
    ts: (asNumber(rx.date) ?? 0) * 1000,
    target: { chat, messageId },
    from,
    emoji,
    added: Boolean(added),
    raw,
  };
}

function mapChat(
  rawChat: unknown,
  ctx: TelegramMapContext,
  threadId?: string,
): ChatRef | undefined {
  const chat = asRecord(rawChat);
  if (!chat) return undefined;
  const chatId = asString(chat.id);
  if (!chatId) return undefined;
  const type = asString(chat.type);
  const kind = type === "private" ? "dm" : "group";
  return {
    platform: PLATFORM,
    accountId: ctx.accountId,
    chatId,
    kind,
    threadId,
  };
}

function mapUser(rawUser: unknown, ctx: TelegramMapContext): UserRef | undefined {
  const user = asRecord(rawUser);
  if (!user) return undefined;
  const userId = asString(user.id);
  if (!userId) return undefined;
  const first = asString(user.first_name) ?? "";
  const last = asString(user.last_name);
  const displayName = last ? `${first} ${last}`.trim() : first || asString(user.username);
  return { platform: PLATFORM, accountId: ctx.accountId, userId, displayName };
}

function mapReplyTo(msg: Record<string, unknown>, chat: ChatRef): MsgRef | undefined {
  const reply = asRecord(msg.reply_to_message);
  const id = asString(reply?.message_id);
  if (!id) return undefined;
  const threadId = asString(msg.message_thread_id);
  return { chat: threadId ? { ...chat, threadId } : chat, messageId: id };
}

function mapMedia(msg: Record<string, unknown>): MediaRef[] {
  const out: MediaRef[] = [];
  const photos = asArray(msg.photo);
  if (photos && photos.length > 0) {
    const largest = asRecord(photos[photos.length - 1]);
    const id = asString(largest?.file_id);
    if (id) {
      out.push({
        id,
        kind: "image",
        size: asNumber(largest?.file_size),
      });
    }
  }
  const kinds: Array<[string, MediaRef["kind"]]> = [
    ["document", "file"],
    ["audio", "audio"],
    ["voice", "audio"],
    ["video", "video"],
    ["sticker", "sticker"],
  ];
  for (const [field, kind] of kinds) {
    const rec = asRecord(msg[field]);
    const id = asString(rec?.file_id);
    if (!id) continue;
    out.push({
      id,
      kind,
      name: asString(rec?.file_name),
      mime: asString(rec?.mime_type),
      size: asNumber(rec?.file_size),
    });
  }
  return out;
}

function extractText(msg: Record<string, unknown>): string {
  return asString(msg.text) ?? asString(msg.caption) ?? "";
}

function mentionsBot(
  msg: Record<string, unknown>,
  text: string,
  chat: ChatRef,
  ctx: TelegramMapContext,
): boolean {
  if (chat.kind === "dm") return true;
  if (ctx.botUsername && text.toLowerCase().includes(`@${ctx.botUsername.toLowerCase()}`)) return true;
  const entities = asArray(msg.entities) ?? asArray(msg.caption_entities) ?? [];
  for (const ent of entities) {
    const rec = asRecord(ent);
    if (asString(rec?.type) === "mention" && ctx.botUsername) {
      const offset = asNumber(rec?.offset) ?? 0;
      const length = asNumber(rec?.length) ?? 0;
      const slice = text.slice(offset, offset + length);
      if (slice.toLowerCase() === `@${ctx.botUsername.toLowerCase()}`) return true;
    }
    if (asString(rec?.type) === "text_mention") {
      const user = asRecord(rec?.user);
      if (asString(user?.id) === ctx.botUserId) return true;
    }
  }
  return false;
}

function parseCommand(
  text: string,
  botUsername?: string,
): { name: string; args: string } | undefined {
  const match = /^\/([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return undefined;
  const mention = match[2];
  if (mention && botUsername && mention.toLowerCase() !== botUsername.toLowerCase()) return undefined;
  return { name: match[1] ?? "", args: (match[3] ?? "").trim() };
}

function splitAction(data: string): [string, string | undefined] {
  const idx = data.indexOf(":");
  if (idx === -1) return [data, undefined];
  return [data.slice(0, idx), data.slice(idx + 1)];
}

function reactionsOf(raw: unknown): string[] {
  const arr = asArray(raw) ?? [];
  const out: string[] = [];
  for (const item of arr) {
    const rec = asRecord(item);
    const emoji = asString(rec?.emoji);
    if (emoji) out.push(emoji);
  }
  return out;
}

function eventId(kind: string, updateId: number | undefined, rest: string): string {
  return updateId !== undefined ? `${kind}:${updateId}:${rest}` : `${kind}:${rest}`;
}
