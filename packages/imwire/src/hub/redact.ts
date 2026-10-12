import type { Logger } from "@imwire/core";
import { TOKEN_SCAN_RE } from "./tokens.js";

const OTPAUTH_RE = /otpauth:\/\/[^\s"']+/g;
/** 32+ chars of RFC 4648 base32 — the shape of a TOTP secret. */
const BASE32_SECRET_RE = /\b[A-Z2-7]{32,}\b/g;
const SECRET_KEYS = /token|secret|password|passwd|code|totp|otp|key|recovery|authorization/i;

export function redactText(s: string): string {
  return s
    .replace(TOKEN_SCAN_RE, "imw_[redacted]")
    .replace(OTPAUTH_RE, "otpauth://[redacted]")
    .replace(BASE32_SECRET_RE, "[redacted]");
}

export function redactValue(v: unknown, depth = 0): unknown {
  if (depth > 6) return "[…]";
  if (typeof v === "string") return redactText(v);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redactValue(val, depth + 1);
    }
    return out;
  }
  return v;
}

/** Wrap any logger so tokens, otpauth URLs, base32 secrets and secret-named fields never leave the hub. */
export function redactingLogger(inner: Logger): Logger {
  const wrap =
    (fn: (msg: string, extra?: Record<string, unknown>) => void) =>
    (msg: string, extra?: Record<string, unknown>) =>
      fn(redactText(msg), extra ? (redactValue(extra) as Record<string, unknown>) : undefined);
  return {
    debug: wrap(inner.debug.bind(inner)),
    info: wrap(inner.info.bind(inner)),
    warn: wrap(inner.warn.bind(inner)),
    error: wrap(inner.error.bind(inner)),
  };
}
