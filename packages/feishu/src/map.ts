import type { ChatRef, Inbound, MediaRef, Platform, UserRef } from "@imwire/core";
import { asArray, asNumber, asRecord, asString } from "./util.js";

const PLATFORM: Platform = "feishu";

export interface FeishuMapContext {
  accountId: string;
  botOpenId?: string;
}

export function mapFeishuEvent(raw: unknown, ctx: FeishuMapContext, hint?: string): Inbound[] {
  const rec = asRecord(raw);
  if (!rec) return [];

  const header = asRecord(rec.header);
  const eventType =
    hint ??
    asString(header?.event_type) ??
    asString(rec.event_type) ??
    asString(rec.type) ??
    inferType(rec);

  const event = asRecord(rec.event) ?? rec;
  const eventId =
    asString(header?.event_id) ??
    asString(rec.event_id) ??
    asString(event.event_id) ??
    fallbackId(eventType, event);

  const ts = parseTs(asString(header?.create_time) ?? asString(event.create_time) ?? asString(rec.create_time));

  if (eventType === "card.action.trigger" || eventType === "card.action.trigger_v1") {
    const mapped = mapAction(event, ctx, eventId, ts, raw);
    return mapped ? [mapped] : [];
  }
  if (eventType === "im.message.receive_v1" || looksLikeMessage(event)) {
    const mapped = mapMessage(event, ctx, eventId, ts, raw);
    return mapped ? [mapped] : [];
  }
  if (eventType === "im.message.reaction.created_v1" || eventType === "im.message.reaction.deleted_v1") {
    const mapped = mapReaction(event, ctx, eventId, ts, raw, eventType.endsWith("created_v1"));
    return mapped ? [mapped] : [];
  }
  return [];
}

function inferType(rec: Record<string, unknown>): string | undefined {
  if (asRecord(rec.action) && asRecord(rec.context)) return "card.action.trigger";
  if (asRecord(rec.message) && asRecord(rec.sender)) return "im.message.receive_v1";
  return undefined;
}

function looksLikeMessage(event: Record<string, unknown>): boolean {
  return Boolean(asRecord(event.message) && asRecord(event.sender));
}

function mapMessage(
  event: Record<string, unknown>,
  ctx: FeishuMapContext,
  eventId: string,
  ts: number,
  raw: unknown,
): Inbound | undefined {
  const message = asRecord(event.message);
  const sender = asRecord(event.sender);
  if (!message || !sender) return undefined;
  const chat = mapChat(message, ctx);
  if (!chat) return undefined;
  const from = mapSender(sender, ctx);
  const rawText = extractRawText(message);
  const messageId = asString(message.message_id) ?? eventId;
  // Docs: dedup receive_v1 by message_id, not event_id.
  const id = messageId;
  const command = parseCommand(rawText);
  if (command) {
    return {
      type: "command",
      id,
      ts,
      chat,
      from,
      messageId,
      name: command.name,
      args: command.args,
      raw,
    };
  }
  const parentId = asString(message.parent_id);
  return {
    type: "message",
    id,
    ts: asNumber(message.create_time) ?? ts,
    chat,
    from,
    messageId,
    text: expandMentions(rawText, message),
    mentionsBot: mentionsBot(message, chat, ctx),
    replyTo: parentId ? { chat, messageId: parentId } : undefined,
    media: mapMedia(message),
    raw,
  };
}

function mapAction(
  event: Record<string, unknown>,
  ctx: FeishuMapContext,
  eventId: string,
  ts: number,
  raw: unknown,
): Inbound | undefined {
  const operator = asRecord(event.operator);
  const action = asRecord(event.action);
  const context = asRecord(event.context);
  const chatId = asString(context?.open_chat_id);
  const messageId = asString(context?.open_message_id);
  if (!chatId || !messageId) return undefined;
  const chatType = asString(context?.chat_type) ?? asString(event.chat_type);
  const chat: ChatRef = {
    platform: PLATFORM,
    accountId: ctx.accountId,
    chatId,
    kind: chatType === "p2p" || chatType === "private" || chatType === "dm" ? "dm" : "group",
  };
  const from: UserRef = {
    platform: PLATFORM,
    accountId: ctx.accountId,
    userId: asString(operator?.open_id) ?? asString(operator?.user_id) ?? "unknown",
  };
  const { actionId, value } = actionIds(action);
  return {
    type: "action",
    id: eventId,
    ts,
    target: { chat, messageId },
    from,
    actionId,
    value,
    raw,
  };
}

function mapReaction(
  event: Record<string, unknown>,
  ctx: FeishuMapContext,
  eventId: string,
  ts: number,
  raw: unknown,
  added: boolean,
): Inbound | undefined {
  const messageId = asString(event.message_id) ?? asString(asRecord(event.message_id_info)?.message_id);
  const chatId = asString(event.chat_id) ?? asString(asRecord(event.message_id_info)?.chat_id);
  const userId =
    asString(asRecord(event.user_id)?.open_id) ?? asString(event.open_id) ?? asString(event.operator_id);
  const emoji =
    asString(asRecord(event.reaction_type)?.emoji_type) ?? asString(event.emoji) ?? asString(event.reaction_type);
  if (!messageId || !chatId || !userId || !emoji) return undefined;
  const chat: ChatRef = { platform: PLATFORM, accountId: ctx.accountId, chatId, kind: "group" };
  return {
    type: "reaction",
    id: eventId,
    ts,
    target: { chat, messageId },
    from: { platform: PLATFORM, accountId: ctx.accountId, userId },
    emoji,
    added,
    raw,
  };
}

function mapChat(message: Record<string, unknown>, ctx: FeishuMapContext): ChatRef | undefined {
  const chatId = asString(message.chat_id);
  if (!chatId) return undefined;
  const chatType = asString(message.chat_type);
  return {
    platform: PLATFORM,
    accountId: ctx.accountId,
    chatId,
    kind: chatType === "p2p" || chatType === "private" ? "dm" : "group",
    threadId: asString(message.thread_id),
  };
}

function mapSender(sender: Record<string, unknown>, ctx: FeishuMapContext): UserRef {
  const ids = asRecord(sender.sender_id) ?? sender;
  return {
    platform: PLATFORM,
    accountId: ctx.accountId,
    userId: asString(ids.open_id) ?? asString(ids.user_id) ?? asString(ids.union_id) ?? "unknown",
  };
}

function extractRawText(message: Record<string, unknown>): string {
  const contentRaw = message.content;
  const parsed = typeof contentRaw === "string" ? safeJson(contentRaw) : asRecord(contentRaw);
  if (!parsed) return typeof contentRaw === "string" ? contentRaw : "";
  const text = asString(parsed.text);
  if (text) return text;
  const title = asString(parsed.title);
  const content = asString(parsed.content);
  if (title || content) return [title, content].filter(Boolean).join("\n");
  return "";
}

function expandMentions(text: string, message: Record<string, unknown>): string {
  const mentions = asArray(message.mentions) ?? [];
  let out = text;
  for (const m of mentions) {
    const rec = asRecord(m);
    if (!rec) continue;
    const key = asString(rec.key);
    const name = asString(rec.name);
    if (key && name) out = out.split(key).join(`@${name}`);
  }
  return out.replace(/@_user_\d+/g, "").replace(/[ \t]{2,}/g, " ");
}

function mapMedia(message: Record<string, unknown>): MediaRef[] | undefined {
  const type = asString(message.message_type);
  const parsed =
    typeof message.content === "string" ? safeJson(message.content) : asRecord(message.content);
  if (!parsed) return undefined;
  const messageId = asString(message.message_id);
  const encode = (key: string): string => (messageId ? `${messageId}/${key}` : key);
  if (type === "image" || asString(parsed.image_key)) {
    const id = asString(parsed.image_key);
    return id ? [{ id: encode(id), kind: "image" }] : undefined;
  }
  if (type === "file" || asString(parsed.file_key)) {
    const id = asString(parsed.file_key);
    return id ? [{ id: encode(id), kind: "file", name: asString(parsed.file_name) }] : undefined;
  }
  if (type === "audio" && asString(parsed.file_key)) {
    const id = asString(parsed.file_key);
    return id ? [{ id: encode(id), kind: "audio" }] : undefined;
  }
  if (type === "media" && asString(parsed.file_key)) {
    const id = asString(parsed.file_key);
    return id ? [{ id: encode(id), kind: "video" }] : undefined;
  }
  return undefined;
}

function mentionsBot(
  message: Record<string, unknown>,
  chat: ChatRef,
  ctx: FeishuMapContext,
): boolean {
  if (chat.kind === "dm") return true;
  if (!ctx.botOpenId) return false;
  const mentions = asArray(message.mentions) ?? [];
  for (const m of mentions) {
    const rec = asRecord(m);
    if (!rec) continue;
    const id = asRecord(rec.id);
    if (asString(id?.open_id) === ctx.botOpenId) return true;
  }
  return false;
}

function actionIds(action: Record<string, unknown> | undefined): { actionId: string; value?: string } {
  if (!action) return { actionId: "unknown" };
  const value = action.value;
  if (typeof value === "string") {
    const idx = value.indexOf(":");
    if (idx === -1) return { actionId: value };
    return { actionId: value.slice(0, idx), value: value.slice(idx + 1) };
  }
  const rec = asRecord(value);
  if (rec) {
    const id = asString(rec.actionId) ?? asString(rec.action) ?? asString(rec.key) ?? asString(rec.id);
    if (id) {
      const extra = asString(rec.value);
      return { actionId: id, value: extra };
    }
    const first = Object.entries(rec)[0];
    if (first) return { actionId: first[0], value: asString(first[1]) };
  }
  const name = asString(action.name);
  if (name) return { actionId: name };
  return { actionId: asString(action.tag) ?? "unknown" };
}

function parseCommand(text: string): { name: string; args: string } | undefined {
  const cleaned = text.replace(/@_user_\d+\s*/g, "").trim();
  const match = /^\/([a-zA-Z0-9_]+)(?:\s+([\s\S]*))?$/.exec(cleaned);
  if (!match) return undefined;
  return { name: match[1] ?? "", args: (match[2] ?? "").trim() };
}

function parseTs(value: string | undefined): number {
  if (!value) return Date.now();
  const n = Number(value);
  if (!Number.isFinite(n)) return Date.now();
  // Feishu card callbacks are microseconds; message events are ms.
  if (n > 1e15) return Math.floor(n / 1000);
  return n;
}

function fallbackId(eventType: string | undefined, event: Record<string, unknown>): string {
  const mid = asString(asRecord(event.message)?.message_id) ?? asString(asRecord(event.context)?.open_message_id);
  return `${eventType ?? "event"}:${mid ?? Math.random().toString(36).slice(2)}`;
}

function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}
