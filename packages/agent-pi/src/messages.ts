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

export function windowMessages<T extends { role?: string; content?: unknown }>(
  messages: T[],
  maxChars: number,
): T[] {
  if (maxChars <= 0) return messages;
  const system = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  const kept: T[] = [];
  let used = system.reduce((n, m) => n + userTextOf(m).length, 0);
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    const msg = rest[i]!;
    const size = Math.max(1, userTextOf(msg).length);
    if (kept.length > 0 && used + size > maxChars) break;
    kept.push(msg);
    used += size;
  }
  kept.reverse();
  return [...system, ...kept];
}

export function snapshotToPi(
  conv: ConversationSnapshot,
  opts: { systemPrompt: string; provider: string; model: string; maxChars: number },
): Message[] {
  return windowMessages(toPiMessages(conv.messages, opts), opts.maxChars);
}
