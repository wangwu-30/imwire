import type { ChatRef, Inbound, Platform, UserRef } from "@imwire/core";
import { asNumber, asRecord, asString } from "./util.js";

const PLATFORM: Platform = "wecom";

export interface WecomMapContext {
  accountId: string;
}

export interface WecomReplyContext {
  reqId: string;
  msgid: string;
  chatId: string;
}

/**
 * Map aibot_msg_callback / aibot_event_callback frames.
 * https://developer.work.weixin.qq.com/document/path/101463
 */
export function mapWecomEvent(raw: unknown, ctx: WecomMapContext): Inbound[] {
  const rec = asRecord(raw);
  if (!rec) return [];
  const cmd = asString(rec.cmd);
  const headers = asRecord(rec.headers);
  const body = asRecord(rec.body) ?? rec;
  const reqId = asString(headers?.req_id);
  const msgid = asString(body.msgid) ?? reqId ?? "unknown";
  const ts = (asNumber(body.create_time) ?? Math.floor(Date.now() / 1000)) * 1000;

  if (cmd === "aibot_msg_callback" || (asString(body.msgtype) && asString(body.msgtype) !== "event")) {
    const mapped = mapMessage(body, ctx, msgid, ts, raw, reqId);
    return mapped ? [mapped] : [];
  }
  if (cmd === "aibot_event_callback" || asString(body.msgtype) === "event") {
    const mapped = mapEvent(body, ctx, msgid, ts, raw);
    return mapped ? [mapped] : [];
  }
  return [];
}

export function replyContextOf(raw: unknown): WecomReplyContext | undefined {
  const rec = asRecord(raw);
  if (!rec) return undefined;
  if (asString(rec.cmd) !== "aibot_msg_callback") return undefined;
  const headers = asRecord(rec.headers);
  const body = asRecord(rec.body) ?? rec;
  const reqId = asString(headers?.req_id);
  const msgid = asString(body.msgid);
  const chat = chatFromBody(body, "acct");
  if (!reqId || !chat) return undefined;
  return { reqId, msgid: msgid ?? reqId, chatId: chat.chatId };
}

export function isDisconnectedEvent(raw: unknown): boolean {
  const rec = asRecord(raw);
  if (!rec) return false;
  const body = asRecord(rec.body) ?? rec;
  const event = asRecord(body.event) ?? body;
  return asString(event.eventtype) === "disconnected_event";
}

function mapMessage(
  body: Record<string, unknown>,
  ctx: WecomMapContext,
  msgid: string,
  ts: number,
  raw: unknown,
  _reqId?: string,
): Inbound | undefined {
  const chat = chatFromBody(body, ctx.accountId);
  if (!chat) return undefined;
  const from = userFromBody(body, ctx.accountId);
  const text = extractText(body);
  const command = parseCommand(text);
  if (command) {
    return {
      type: "command",
      id: msgid,
      ts,
      chat,
      from,
      messageId: msgid,
      name: command.name,
      args: command.args,
      raw,
    };
  }
  return {
    type: "message",
    id: msgid,
    ts,
    chat,
    from,
    messageId: msgid,
    text,
    mentionsBot: chat.kind === "dm" || text.includes("@"),
    raw,
  };
}

function mapEvent(
  body: Record<string, unknown>,
  ctx: WecomMapContext,
  msgid: string,
  ts: number,
  raw: unknown,
): Inbound | undefined {
  const event = asRecord(body.event) ?? body;
  const eventtype = asString(event.eventtype) ?? asString(body.eventtype);
  if (eventtype !== "template_card_event") return undefined;
  const card = asRecord(event.template_card_event) ?? asRecord(body.template_card_event) ?? event;
  const actionId =
    asString(card.event_key) ??
    asString(card.key) ??
    asString(card.selected_item_key) ??
    asString(asRecord(card.SelectedItems)?.QuestionKey) ??
    "unknown";
  const chat = chatFromBody(body, ctx.accountId);
  if (!chat) return undefined;
  const taskId = asString(card.task_id) ?? asString(card.response_code) ?? msgid;
  return {
    type: "action",
    id: msgid,
    ts,
    target: { chat, messageId: taskId },
    from: userFromBody(body, ctx.accountId),
    actionId,
    value: asString(card.value) ?? asString(card.option_id),
    raw,
  };
}

function chatFromBody(body: Record<string, unknown>, accountId: string): ChatRef | undefined {
  const chattype = asString(body.chattype) ?? asString(body.chat_type);
  const from = asRecord(body.from);
  const userId = asString(from?.userid);
  const groupId = asString(body.chatid);
  const kind: ChatRef["kind"] = chattype === "group" || chattype === "2" ? "group" : "dm";
  const chatId = kind === "group" ? groupId : (groupId ?? userId);
  if (!chatId) return undefined;
  return { platform: PLATFORM, accountId, chatId, kind };
}

function userFromBody(body: Record<string, unknown>, accountId: string): UserRef {
  const from = asRecord(body.from);
  return {
    platform: PLATFORM,
    accountId,
    userId: asString(from?.userid) ?? "unknown",
  };
}

function extractText(body: Record<string, unknown>): string {
  const text = asRecord(body.text);
  if (text && asString(text.content)) return asString(text.content)!.trim();
  const markdown = asRecord(body.markdown);
  if (markdown && asString(markdown.content)) return asString(markdown.content)!.trim();
  const voice = asRecord(body.voice);
  if (voice && asString(voice.content)) return asString(voice.content)!.trim();
  return "";
}

function parseCommand(text: string): { name: string; args: string } | undefined {
  const cleaned = text.replace(/^@\S+\s+/, "").trim();
  const match = /^\/([a-zA-Z0-9_]+)(?:\s+([\s\S]*))?$/.exec(cleaned);
  if (!match) return undefined;
  return { name: match[1] ?? "", args: (match[2] ?? "").trim() };
}
