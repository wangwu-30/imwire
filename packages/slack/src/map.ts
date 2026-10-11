import type { ChatRef, Inbound, Platform, UserRef } from "@imwire/core";
import { asArray, asNumber, asRecord, asString } from "./util.js";

const PLATFORM: Platform = "slack";

export interface SlackMapContext {
  accountId: string;
  botUserId?: string;
}

/**
 * Map a Socket Mode envelope or a raw Events API / interactive payload.
 * Envelope: https://docs.slack.dev/apis/events-api/using-socket-mode
 * Block Kit buttons: same page, "Using interactive features" / block_actions.
 */
export function mapSlackEvent(raw: unknown, ctx: SlackMapContext): Inbound[] {
  const rec = asRecord(raw);
  if (!rec) return [];
  const envelopeType = asString(rec.type);
  const payload = asRecord(rec.payload) ?? rec;

  if (envelopeType === "interactive" || asString(payload.type) === "block_actions") {
    const mapped = mapInteractive(payload, ctx, raw);
    return mapped ? [mapped] : [];
  }

  const event = asRecord(payload.event) ?? (asString(payload.type) === "message" ? payload : undefined);
  if (!event) return [];
  const eventType = asString(event.type);
  if (eventType === "message" && asString(event.subtype) === "message_changed") {
    const mapped = mapEdit(event, ctx, raw);
    return mapped ? [mapped] : [];
  }
  if (eventType === "message" || eventType === "app_mention") {
    if (asString(event.subtype) && eventType === "message") return [];
    const mapped = mapMessage(event, ctx, raw);
    return mapped ? [mapped] : [];
  }
  if (eventType === "reaction_added" || eventType === "reaction_removed") {
    const mapped = mapReaction(event, ctx, raw, eventType === "reaction_added");
    return mapped ? [mapped] : [];
  }
  return [];
}

export function envelopeIdOf(raw: unknown): string | undefined {
  return asString(asRecord(raw)?.envelope_id);
}

function mapMessage(event: Record<string, unknown>, ctx: SlackMapContext, raw: unknown): Inbound | undefined {
  if (asString(event.bot_id) && asString(event.user) === ctx.botUserId) return undefined;
  const chat = mapChat(event, ctx);
  if (!chat) return undefined;
  const userId = asString(event.user) ?? "unknown";
  const from: UserRef = { platform: PLATFORM, accountId: ctx.accountId, userId };
  const text = asString(event.text) ?? "";
  const messageId = asString(event.ts) ?? asString(event.event_ts);
  if (!messageId) return undefined;
  const ts = slackTs(messageId);
  const command = parseCommand(text);
  if (command) {
    return {
      type: "command",
      id: `msg:${messageId}`,
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
    id: `msg:${messageId}`,
    ts,
    chat,
    from,
    messageId,
    text,
    mentionsBot: chat.kind === "dm" || mentionsBot(text, ctx.botUserId),
    replyTo: asString(event.thread_ts) && asString(event.thread_ts) !== messageId
      ? { chat, messageId: asString(event.thread_ts)! }
      : undefined,
    raw,
  };
}

function mapEdit(event: Record<string, unknown>, ctx: SlackMapContext, raw: unknown): Inbound | undefined {
  const message = asRecord(event.message);
  const chat = mapChat({ ...event, ...message, channel: event.channel ?? message?.channel }, ctx);
  const messageId = asString(message?.ts) ?? asString(event.ts);
  const userId = asString(message?.user) ?? asString(event.user);
  if (!chat || !messageId || !userId) return undefined;
  return {
    type: "edit",
    id: `edit:${messageId}:${asString(event.event_ts) ?? messageId}`,
    ts: slackTs(asString(event.event_ts) ?? messageId),
    target: { chat, messageId },
    from: { platform: PLATFORM, accountId: ctx.accountId, userId },
    text: asString(message?.text) ?? "",
    raw,
  };
}

function mapInteractive(payload: Record<string, unknown>, ctx: SlackMapContext, raw: unknown): Inbound | undefined {
  const actions = asArray(payload.actions) ?? [];
  const action = asRecord(actions[0]);
  const user = asRecord(payload.user);
  const channel = asRecord(payload.channel);
  const message = asRecord(payload.message);
  const container = asRecord(payload.container);
  const chatId = asString(channel?.id) ?? asString(container?.channel_id);
  const messageId = asString(message?.ts) ?? asString(container?.message_ts);
  const userId = asString(user?.id);
  if (!chatId || !messageId || !userId) return undefined;
  const channelName = asString(channel?.name);
  const kind: ChatRef["kind"] = !channelName || channelName === "directmessage" || chatId.startsWith("D") ? "dm" : "group";
  const threadId = asString(message?.thread_ts);
  const actionId = asString(action?.action_id) ?? "unknown";
  const value = asString(action?.value);
  return {
    type: "action",
    id: `act:${messageId}:${actionId}:${asString(action?.action_ts) ?? userId}`,
    ts: slackTs(asString(action?.action_ts) ?? messageId),
    target: {
      chat: { platform: PLATFORM, accountId: ctx.accountId, chatId, kind, threadId },
      messageId,
    },
    from: { platform: PLATFORM, accountId: ctx.accountId, userId, displayName: asString(user?.username) },
    actionId,
    value,
    raw,
  };
}

function mapReaction(
  event: Record<string, unknown>,
  ctx: SlackMapContext,
  raw: unknown,
  added: boolean,
): Inbound | undefined {
  const item = asRecord(event.item);
  const chatId = asString(item?.channel);
  const messageId = asString(item?.ts);
  const userId = asString(event.user);
  const emoji = asString(event.reaction);
  if (!chatId || !messageId || !userId || !emoji) return undefined;
  return {
    type: "reaction",
    id: `rx:${messageId}:${emoji}:${added ? "1" : "0"}`,
    ts: slackTs(asString(event.event_ts) ?? messageId),
    target: {
      chat: { platform: PLATFORM, accountId: ctx.accountId, chatId, kind: chatId.startsWith("D") ? "dm" : "group" },
      messageId,
    },
    from: { platform: PLATFORM, accountId: ctx.accountId, userId },
    emoji,
    added,
    raw,
  };
}

function mapChat(event: Record<string, unknown>, ctx: SlackMapContext): ChatRef | undefined {
  const chatId = asString(event.channel);
  if (!chatId) return undefined;
  const channelType = asString(event.channel_type);
  const kind: ChatRef["kind"] =
    channelType === "im" || channelType === "mpim" || chatId.startsWith("D") ? "dm" : "group";
  const threadId = asString(event.thread_ts);
  return { platform: PLATFORM, accountId: ctx.accountId, chatId, kind, threadId };
}

function mentionsBot(text: string, botUserId?: string): boolean {
  if (!botUserId) return /<@U[A-Z0-9]+>/.test(text);
  return text.includes(`<@${botUserId}>`);
}

function parseCommand(text: string): { name: string; args: string } | undefined {
  const cleaned = text.replace(/<@U[A-Z0-9]+>/g, "").trim();
  const match = /^\/([a-zA-Z0-9_]+)(?:\s+([\s\S]*))?$/.exec(cleaned);
  if (!match) return undefined;
  return { name: match[1] ?? "", args: (match[2] ?? "").trim() };
}

function slackTs(value: string): number {
  const n = asNumber(value);
  if (n === undefined) return Date.now();
  return n > 1e12 ? n : Math.floor(n * 1000);
}
