import type { ConversationSnapshot, LogMessage } from "@imwire/session";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function userTextOf(msg: { role?: string; content?: unknown }): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text?: string }).text ?? "") : ""))
      .join("");
  }
  return "";
}

export function toPiMessages(
  log: LogMessage[],
  opts: { systemPrompt: string; provider: string; model: string },
): Message[] {
  const out: Message[] = [
    { role: "system", content: opts.systemPrompt, timestamp: log[0]?.createdAt ?? Date.now() },
  ];
  for (const m of log) {
    if (m.role === "system") {
      out.push({ role: "system", content: m.text, timestamp: m.createdAt });
      continue;
    }
    if (m.role === "user") {
      out.push({ role: "user", content: m.text, timestamp: m.createdAt });
      continue;
    }
    out.push(toAssistantMessage(m.text, m.createdAt, opts.provider, opts.model));
  }
  return out;
}

export function toAssistantMessage(text: string, timestamp: number, provider: string, model: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider,
    model,
    usage: EMPTY_USAGE,
    stopReason: "stop",
    timestamp,
  };
}

const TRUNCATED_PREFIX = "[truncated: original ";

function messageSize(msg: { role?: string; content?: unknown }): number {
  return Math.max(1, userTextOf(msg).length);
}

function hasToolCall(msg: { role?: string; content?: unknown }): boolean {
  if (msg.role !== "assistant" || !Array.isArray(msg.content)) return false;
  return msg.content.some((b) => b && typeof b === "object" && (b as { type?: string }).type === "toolCall");
}

function truncateToolResult<T extends { role?: string; content?: unknown; toolCallId?: string }>(
  msg: T,
  maxChars: number,
): T {
  const text = userTextOf(msg);
  if (text.length <= maxChars) return msg;
  const marker = `${TRUNCATED_PREFIX}${text.length} chars]`;
  return { ...msg, content: [{ type: "text", text: marker }] };
}

function pushToolPair<T extends { role?: string; content?: unknown }>(
  messages: T[],
  start: number,
): { group: T[]; next: number } {
  const group = [messages[start]!];
  let i = start;
  while (i + 1 < messages.length && messages[i + 1]?.role === "toolResult") {
    i += 1;
    group.push(messages[i]!);
  }
  return { group, next: i + 1 };
}

/**
 * Split into a leading system prefix plus whole turns (user + following
 * assistant / tool_call+tool_result / mid-transcript system until the next user).
 */
function groupWholeTurns<T extends { role?: string; content?: unknown }>(
  messages: T[],
): { prefix: T[]; turns: T[][] } {
  const prefix: T[] = [];
  let i = 0;
  while (i < messages.length && messages[i]?.role === "system") {
    prefix.push(messages[i]!);
    i += 1;
  }
  const turns: T[][] = [];
  let current: T[] = [];
  while (i < messages.length) {
    const msg = messages[i]!;
    if (msg.role === "user" && current.length > 0) {
      turns.push(current);
      current = [];
    }
    if (hasToolCall(msg)) {
      const pair = pushToolPair(messages, i);
      current.push(...pair.group);
      i = pair.next;
      continue;
    }
    current.push(msg);
    i += 1;
  }
  if (current.length) turns.push(current);
  return { prefix, turns };
}

/**
 * Bound context by character budget:
 * - never drop the latest user message
 * - keep tool_call + tool_result pairs together (truncate oversized tool results)
 * - drop oldest whole turns (never a middle reply while keeping an older one)
 * - leave system messages in their original positions (do not hoist)
 */
export function windowMessages<T extends { role?: string; content?: unknown; toolCallId?: string }>(
  messages: T[],
  maxChars: number,
): T[] {
  if (maxChars <= 0) return messages;
  const prepared = messages.map((m) =>
    m.role === "toolResult" ? truncateToolResult(m, Math.max(256, Math.floor(maxChars / 2))) : m,
  );
  const { prefix, turns } = groupWholeTurns(prepared);
  const prefixSize = prefix.reduce((n, m) => n + messageSize(m), 0);
  const sizes = turns.map((t) => t.reduce((n, m) => n + messageSize(m), 0));

  const keep = new Array<boolean>(turns.length).fill(false);
  let used = 0;
  if (turns.length > 0) {
    keep[turns.length - 1] = true;
    used += sizes[turns.length - 1]!;
  }
  const keepPrefix = prefixSize === 0 || used + prefixSize <= maxChars;
  if (keepPrefix) used += prefixSize;

  for (let i = turns.length - 2; i >= 0; i -= 1) {
    if (used + sizes[i]! > maxChars) break;
    keep[i] = true;
    used += sizes[i]!;
  }

  return [...(keepPrefix ? prefix : []), ...turns.flatMap((t, i) => (keep[i] ? t : []))];
}

export function snapshotToPi(
  conv: ConversationSnapshot,
  opts: { systemPrompt: string; provider: string; model: string; maxChars: number },
): Message[] {
  return windowMessages(toPiMessages(conv.messages, opts), opts.maxChars);
}
