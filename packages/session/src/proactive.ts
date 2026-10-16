import { isRetryableError, retryAfterMs, type ChatRef, type MsgRef } from "@imwire/core";

export type ProactiveResult =
  | { status: "delivered"; surface: ChatRef; refs: MsgRef[] }
  | { status: "dead"; reason: "unsupported" | "no_surface" | "permanent"; detail: string; channel?: string }
  | { status: "retrying"; reason: string; retryable: true; retryAfterMs?: number; channel?: string };

/** Safe machine codes only: never include exception messages, URLs or vendor payloads. */
export function proactiveFailure(error: unknown, now: number): Exclude<ProactiveResult, { status: "delivered" }> {
  let err = error;
  for (let i = 0; i < 5; i++) {
    if (!err || typeof err !== "object") break;
    const e = err as Record<string, unknown>;
    const status = typeof e.status === "number" ? e.status : e.statusCode;
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 600) {
      const code = `http_${status}`;
      if (status !== 429 && status < 500) return { status: "dead", reason: "permanent", detail: code };
      return { status: "retrying", reason: code, retryable: true, retryAfterMs: retryDelay(e, now) };
    }
    if (isRetryableError(e)) {
      return { status: "retrying", reason: "network", retryable: true, retryAfterMs: retryDelay(e, now) };
    }
    if (!e.cause) break;
    err = e.cause;
  }
  // fetch reports connection failures as TypeError; do not copy its message.
  if (err instanceof TypeError) return { status: "retrying", reason: "network", retryable: true };
  return { status: "dead", reason: "permanent", detail: "send_failed" };
}

function retryDelay(err: Record<string, unknown>, now: number): number | undefined {
  const direct = retryAfterMs(err);
  if (direct !== undefined) return direct;
  const headers = err.headers as { get?: (key: string) => unknown; [key: string]: unknown } | undefined;
  const value = headers?.get?.("retry-after") ?? headers?.["Retry-After"] ?? headers?.["retry-after"];
  if (typeof value !== "string") return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** Keep line breaks; strip other controls and bidi formatting, then limit Unicode code points. */
export function proactiveText(text: string): string {
  const cleaned = Array.from(text)
    .filter((c) => c === "\n" || !/[\p{Cc}\p{Cf}]/u.test(c))
    .join("")
    // Feishu text messages recognize <at ...> tags even without Markdown.
    .replace(/<\/?at\b[^>]*>/gi, (tag) => tag.replace(/</g, "＜").replace(/>/g, "＞"));
  return Array.from(cleaned).slice(0, 2000).join("");
}
