import type { ChatRef, Inbound, Platform, UserRef } from "@imwire/core";
import { TOPIC_CARD, TOPIC_ROBOT } from "./capabilities.js";
import { asArray, asNumber, asRecord, asString } from "./util.js";

const PLATFORM: Platform = "dingtalk";

export interface DingTalkMapContext {
  accountId: string;
  chatForTrack?: (outTrackId: string) => ChatRef | undefined;
}

/**
 * Map a Stream CALLBACK frame or a raw robot / card payload.
 *
 * Robot fields: https://open.dingtalk.com/document/dingstart/robot-receive-message
 * Card callback topic: `/v1.0/card/instances/callback`
 *   https://open.dingtalk.com/document/resourcedownload/introduction-to-stream-mode.md
 */
export function mapDingTalkEvent(raw: unknown, ctx: DingTalkMapContext): Inbound[] {
  const rec = asRecord(raw);
  if (!rec) return [];

  const topic = streamTopic(rec);
  const payload = unwrapData(rec);
  if (!payload) return [];

  if (topic === TOPIC_CARD || looksLikeCardCallback(payload)) {
    const mapped = mapCard(payload, ctx, raw);
    return mapped ? [mapped] : [];
  }
  if (topic === TOPIC_ROBOT || looksLikeRobot(payload)) {
    const mapped = mapRobot(payload, ctx, raw);
    return mapped ? [mapped] : [];
  }
  return [];
}

export interface RobotSession {
  chatId: string;
  webhook?: string;
  webhookExpiresAt?: number;
  conversationType?: string;
  senderStaffId?: string;
}

export function robotSessionOf(raw: unknown): RobotSession | undefined {
  const rec = asRecord(raw);
  const payload = rec ? unwrapData(rec) : asRecord(raw);
  if (!payload) return undefined;
  const chatId = asString(payload.conversationId);
  if (!chatId) return undefined;
  return {
    chatId,
    webhook: asString(payload.sessionWebhook),
    webhookExpiresAt: asNumber(payload.sessionWebhookExpiredTime),
    conversationType: asString(payload.conversationType),
    senderStaffId: asString(payload.senderStaffId) ?? asString(payload.senderId),
  };
}

function streamTopic(rec: Record<string, unknown>): string | undefined {
  const headers = asRecord(rec.headers);
  return asString(headers?.topic) ?? asString(rec.topic);
}

function unwrapData(rec: Record<string, unknown>): Record<string, unknown> | undefined {
  if (looksLikeRobot(rec) || looksLikeCardCallback(rec)) return rec;
  const data = rec.data;
  if (typeof data === "string") {
    try {
      return asRecord(JSON.parse(data));
    } catch {
      return undefined;
    }
  }
  return asRecord(data) ?? rec;
}

function looksLikeRobot(payload: Record<string, unknown>): boolean {
  return Boolean(asString(payload.conversationId) && (payload.text || payload.msgtype || payload.msgId));
}

function looksLikeCardCallback(payload: Record<string, unknown>): boolean {
  return Boolean(
    asString(payload.outTrackId) ||
      asString(payload.type) === "actionCallback" ||
      asRecord(payload.content)?.cardPrivateData ||
      asRecord(payload.cardPrivateData),
  );
}

function mapRobot(
  payload: Record<string, unknown>,
  ctx: DingTalkMapContext,
  raw: unknown,
): Inbound | undefined {
  const chatId = asString(payload.conversationId);
  if (!chatId) return undefined;
  const conversationType = asString(payload.conversationType);
  const chat: ChatRef = {
    platform: PLATFORM,
    accountId: ctx.accountId,
    chatId,
    kind: conversationType === "1" ? "dm" : "group",
  };
  const userId =
    asString(payload.senderStaffId) ?? asString(payload.senderId) ?? asString(payload.senderNick) ?? "unknown";
  const from: UserRef = {
    platform: PLATFORM,
    accountId: ctx.accountId,
    userId,
    displayName: asString(payload.senderNick),
  };
  const text = extractText(payload);
  const messageId = asString(payload.msgId) ?? asString(payload.messageId) ?? `dt-${chatId}-${userId}`;
  const ts = asNumber(payload.createAt) ?? Date.now();
  const command = parseCommand(text);
  if (command) {
    return {
      type: "command",
      id: messageId,
      ts,
      chat,
      from,
      messageId,
      name: command.name,
      args: command.args,
      raw,
    };
  }
  return {
    type: "message",
    id: messageId,
    ts,
    chat,
    from,
    messageId,
    text,
    mentionsBot: chat.kind === "dm" || payload.isInAtList === true,
    raw,
  };
}

function mapCard(
  payload: Record<string, unknown>,
  ctx: DingTalkMapContext,
  raw: unknown,
): Inbound | undefined {
  const outTrackId = asString(payload.outTrackId) ?? asString(payload.trackId) ?? "unknown";
  const userId =
    asString(payload.userId) ??
    asString(payload.staffId) ??
    asString(asRecord(payload.userId)?.staffId) ??
    "unknown";
  const remembered = ctx.chatForTrack?.(outTrackId);
  const chatId =
    remembered?.chatId ??
    asString(payload.openConversationId) ??
    asString(payload.conversationId) ??
    asString(payload.chatId);
  const chat: ChatRef = remembered ?? {
    platform: PLATFORM,
    accountId: ctx.accountId,
    chatId: chatId ?? "unknown",
    kind: asString(payload.conversationType) === "1" ? "dm" : "group",
  };
  const { actionId, value } = cardAction(payload);
  return {
    type: "action",
    id: `${outTrackId}:${actionId}:${asString(payload.eventId) ?? userId}`,
    ts: asNumber(payload.createAt) ?? Date.now(),
    target: { chat, messageId: outTrackId },
    from: { platform: PLATFORM, accountId: ctx.accountId, userId },
    actionId,
    value,
    raw,
  };
}

function parseContent(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof payload.content === "string") {
    try {
      return asRecord(JSON.parse(payload.content));
    } catch {
      return undefined;
    }
  }
  return asRecord(payload.content);
}

function cardAction(payload: Record<string, unknown>): { actionId: string; value?: string } {
  const content = parseContent(payload);
  const privateData = asRecord(content?.cardPrivateData) ?? asRecord(payload.cardPrivateData);
  const actionIds = asArray(privateData?.actionIds);
  const fromIds = asString(actionIds?.[0]);
  const params = asRecord(privateData?.params);
  const fromParams = asString(params?.actionId) ?? asString(params?.action) ?? asString(params?.key);
  if (fromIds) return { actionId: fromIds, value: asString(params?.value) ?? asString(payload.value) };
  if (fromParams) return { actionId: fromParams, value: asString(params?.value) ?? asString(payload.value) };
  const value = asString(payload.value) ?? asString(payload.cardAction);
  if (value) {
    const idx = value.indexOf(":");
    if (idx === -1) return { actionId: value };
    return { actionId: value.slice(0, idx), value: value.slice(idx + 1) };
  }
  const firstBtn = asRecord(asArray(asRecord(payload.action)?.btns)?.[0]);
  if (firstBtn && asString(firstBtn.id)) return { actionId: asString(firstBtn.id) ?? "unknown" };
  return { actionId: asString(payload.actionId) ?? "unknown" };
}

function extractText(payload: Record<string, unknown>): string {
  const text = asRecord(payload.text);
  if (text && asString(text.content)) return asString(text.content)!.trim();
  const markdown = asRecord(payload.markdown);
  if (markdown && asString(markdown.text)) return asString(markdown.text)!.trim();
  if (typeof payload.content === "string") return payload.content.trim();
  return "";
}

function parseCommand(text: string): { name: string; args: string } | undefined {
  const match = /^\/([a-zA-Z0-9_]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return undefined;
  return { name: match[1] ?? "", args: (match[2] ?? "").trim() };
}
