import { systemClock, type Clock } from "./types.js";

export interface RetryOptions {
  maxAttempts?: number;
  minMs?: number;
  maxMs?: number;
  factor?: number;
  jitter?: number;
  retryOn?: (err: unknown) => boolean;
  retryAfterMs?: (err: unknown) => number | undefined;
  clock?: Clock;
  random?: () => number;
}

export class RetryError extends Error {
  readonly cause: unknown;
  readonly attempts: number;

  constructor(cause: unknown, attempts: number) {
    super(`retry exhausted after ${attempts} attempt(s)`, { cause: asError(cause) });
    this.name = "RetryError";
    this.cause = cause;
    this.attempts = attempts;
  }
}

export function isRetryableError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const rec = err as { status?: unknown; statusCode?: unknown; code?: unknown; retryable?: unknown };
  if (rec.retryable === true) return true;
  const status = numberish(rec.status) ?? numberish(rec.statusCode);
  if (status === 429 || (status !== undefined && status >= 500 && status < 600)) return true;
  const code = rec.code;
  if (typeof code === "string") {
    const retryableCodes = new Set([
      "ECONNRESET",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "ECONNREFUSED",
      "ENOTFOUND",
      "UND_ERR_SOCKET",
    ]);
    if (retryableCodes.has(code)) return true;
  }
  return false;
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const minMs = opts.minMs ?? 200;
  const maxMs = opts.maxMs ?? 8_000;
  const factor = opts.factor ?? 2;
  const jitter = opts.jitter ?? 0.2;
  const retryOn = opts.retryOn ?? isRetryableError;
  const clock = opts.clock ?? systemClock();
  const random = opts.random ?? Math.random;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !retryOn(err)) {
        throw attempt >= maxAttempts && retryOn(err) ? new RetryError(err, attempt) : err;
      }
      const hinted = (opts.retryAfterMs ?? retryAfterMs)(err);
      const exp = minMs * factor ** (attempt - 1);
      const capped = Math.min(maxMs, exp);
      const spread = capped * jitter;
      const backoff = Math.max(0, capped - spread + random() * spread * 2);
      await clock.sleep(Math.max(backoff, hinted ?? 0));
    }
  }
  throw new RetryError(lastErr, maxAttempts);
}

export function retryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const rec = err as {
    retryAfterMs?: unknown;
    retryAfter?: unknown;
    retry_after?: unknown;
    headers?: unknown;
  };
  const direct = numberish(rec.retryAfterMs);
  if (direct !== undefined) return Math.max(0, direct);
  const seconds = numberish(rec.retryAfter) ?? numberish(rec.retry_after);
  if (seconds !== undefined) return Math.max(0, seconds * 1000);
  const headers = rec.headers;
  if (headers && typeof headers === "object") {
    const raw =
      typeof (headers as { get?: (n: string) => unknown }).get === "function"
        ? (headers as { get: (n: string) => unknown }).get("retry-after")
        : (headers as Record<string, unknown>)["retry-after"] ??
          (headers as Record<string, unknown>)["Retry-After"];
    const n = numberish(typeof raw === "string" ? Number(raw) : raw);
    if (n !== undefined) return Math.max(0, n * 1000);
  }
  return undefined;
}

function numberish(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
