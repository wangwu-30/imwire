import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SessionStore } from "@imwire/session";

/** `imw_<agentId>.<43 chars base64url of 32 random bytes>` */
export const TOKEN_RE = /^imw_(ag_[0-9a-f]{24})\.([A-Za-z0-9_-]{43})$/;
/** Matches anything token-shaped, for log redaction. */
export const TOKEN_SCAN_RE = /imw_[A-Za-z0-9_]+\.[A-Za-z0-9_-]{10,}/g;
export const DEFAULT_TOKEN_TTL_MS = 90 * 24 * 3600_000;
export const MAX_TOKEN_TTL_MS = 365 * 24 * 3600_000;
export const ROTATE_OVERLAP_MS = 24 * 3600_000;

export function mintToken(agentId: string): string {
  return `imw_${agentId}.${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Safe-to-log identifier of a token: first 8 hex of its sha256. */
export function tokenFingerprint(token: string): string {
  return hashToken(token).slice(0, 8);
}

function sameHash(a: string, b: string | undefined): boolean {
  if (!b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export type AuthResult =
  | { ok: true; agentId: string; name: string; via: "current" | "previous" }
  | { ok: false; reason: "bad_format" | "unknown" | "revoked" | "expired" | "bad_token" | "bind_mismatch"; agentId?: string };

export interface PeerInfo {
  /** Peer uid when known; undefined means "proven only by socket permissions". */
  uid?: number;
}

/**
 * Validate a token against the DB on every call, so revocation and expiry
 * take effect immediately. Only hashes are compared (constant time).
 */
export function authenticateAgent(store: SessionStore, token: string, now: number, peer: PeerInfo = {}): AuthResult {
  const m = TOKEN_RE.exec(token);
  if (!m) return { ok: false, reason: "bad_format" };
  const agentId = m[1]!;
  const row = store.agentAuth(agentId);
  if (!row) return { ok: false, reason: "unknown" };
  if (row.revokedAt !== undefined) return { ok: false, reason: "revoked", agentId };
  if (row.bind) {
    const want = /^unix:uid=(\d+)$/.exec(row.bind);
    if (!want || peer.uid === undefined || Number(want[1]) !== peer.uid) {
      return { ok: false, reason: "bind_mismatch", agentId };
    }
  }
  const h = hashToken(token);
  if (sameHash(h, row.tokenHash)) {
    if (row.expiresAt !== undefined && row.expiresAt <= now) return { ok: false, reason: "expired", agentId };
    return { ok: true, agentId, name: row.name, via: "current" };
  }
  if (sameHash(h, row.prevTokenHash)) {
    if (row.prevExpiresAt === undefined || row.prevExpiresAt <= now) return { ok: false, reason: "expired", agentId };
    return { ok: true, agentId, name: row.name, via: "previous" };
  }
  return { ok: false, reason: "bad_token", agentId };
}

/** Parse "90d", "24h", "30m", "15s" or plain ms. */
export function parseDuration(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const m = /^(\d+)\s*(d|h|m|s|ms)?$/.exec(raw.trim());
  if (!m) throw new Error(`bad duration: ${raw}`);
  const n = Number(m[1]);
  const unit = m[2] ?? "ms";
  const mult = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000, ms: 1 }[unit as "d"];
  return n * mult;
}
