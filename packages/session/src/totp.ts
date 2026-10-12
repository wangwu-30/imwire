/**
 * TOTP second factor for a2h (design: a2h-identity.md §3–§5).
 *
 * - RFC 6238 / RFC 4226: HMAC-SHA1, 6 digits, 30 s step, ±1 step window.
 * - Verified only on the hub. Secrets are AES-256-GCM encrypted at rest with
 *   a hub master key that never touches the database.
 * - Replay: the last accepted step is persisted per credential; a code for
 *   that step or any earlier one is refused.
 * - Lockout: 5 failures within 15 min lock the person for 15 min.
 * - Secrets, codes and recovery codes are never logged or audited.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SessionStore } from "./store.js";
import type { ApproverContext, ApproverVerdict, ApproverVerifier, AssuranceLevel } from "./a2h.js";

export const TOTP_STEP_S = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1;
export const TOTP_SECRET_BYTES = 20; // 160 bit
export const AUTH_FAIL_LIMIT = 5;
export const AUTH_FAIL_WINDOW_MS = 15 * 60 * 1000;
export const AUTH_LOCK_MS = 15 * 60 * 1000;
export const LINK_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const RECOVERY_CODE_COUNT = 10;
export const TOTP_CODE_RE = /^\d{6}$/;

// ---- RFC 4648 base32 ------------------------------------------------------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ---- RFC 4226 / 6238 --------------------------------------------------------
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export function totpStep(nowMs: number, stepS = TOTP_STEP_S): number {
  return Math.floor(nowMs / 1000 / stepS);
}

export function totp(secret: Buffer, nowMs: number): string {
  return hotp(secret, totpStep(nowMs));
}

/** The matching step within ±window, or undefined. Constant-time compare per candidate. */
export function matchTotpStep(secret: Buffer, code: string, nowMs: number, window = TOTP_WINDOW): number | undefined {
  if (!TOTP_CODE_RE.test(code)) return undefined;
  const now = totpStep(nowMs);
  let found: number | undefined;
  for (let d = -window; d <= window; d += 1) {
    const expected = Buffer.from(hotp(secret, now + d));
    if (timingSafeEqual(expected, Buffer.from(code)) && found === undefined) found = now + d;
  }
  return found;
}

export function otpauthUrl(secretB32: string, account: string, issuer = "imwire"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_S}`;
}

// ---- secret at rest -----------------------------------------------------------
/** AES-256-GCM. Output: iv(12) | tag(16) | ciphertext. */
export function sealSecret(masterKey: Buffer, plain: Buffer): Buffer {
  if (masterKey.length !== 32) throw new Error("credential master key must be 32 bytes");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", masterKey, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export function openSecret(masterKey: Buffer, sealed: Uint8Array): Buffer {
  const buf = Buffer.from(sealed);
  const d = createDecipheriv("aes-256-gcm", masterKey, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code.replace(/[\s-]/g, "").toLowerCase()).digest("hex");
}

export function newRecoveryCode(): string {
  const raw = base32Encode(randomBytes(8)).slice(0, 10).toLowerCase();
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

// ---- authority + verifier -------------------------------------------------------
export type CodeCheck =
  | { ok: true; step: number }
  | { ok: false; reason: "wrong" | "replay" | "locked" | "not_enrolled" | "error"; nowLocked?: boolean };

export interface TotpEnrollment {
  /** Show once (QR / manual entry). Never persisted in clear. */
  secretBase32: string;
  otpauthUrl: string;
  /** Show once. Only hashes are stored. */
  recoveryCodes: string[];
}

export interface TotpVerifierOptions {
  store: SessionStore;
  /** 32-byte master key (Keychain / 0600 file on the hub). Never stored in the DB. */
  masterKey: Buffer;
  /** Per-agent downgrade to button-only, by agent id. Default: every a2h approval needs `verified`. */
  approvalLevelFor?: (agentId: string | undefined) => AssuranceLevel | undefined;
  cooldownMs?: number;
}

/**
 * ApproverVerifier backed by TOTP step-up. Pure policy + local code checks;
 * the gateway owns the IM conversation (prompting, /approve, cards).
 */
export class TotpVerifier implements ApproverVerifier {
  readonly requiredLevel: AssuranceLevel = "im_account";
  readonly store: SessionStore;
  private readonly masterKey: Buffer;
  private readonly cooldownMs: number;
  private readonly levelFor?: (agentId: string | undefined) => AssuranceLevel | undefined;

  constructor(opts: TotpVerifierOptions) {
    if (opts.masterKey.length !== 32) throw new Error("credential master key must be 32 bytes");
    this.store = opts.store;
    this.masterKey = opts.masterKey;
    this.cooldownMs = opts.cooldownMs ?? LINK_COOLDOWN_MS;
    this.levelFor = opts.approvalLevelFor;
  }

  /** Q6 gate + enrolment: a person without TOTP cannot be targeted (fail-closed). */
  isAllowedTarget(personId: string, ctx: { isAllowlistedOwner: boolean }): boolean {
    return ctx.isAllowlistedOwner && this.store.totpCredential(personId) !== undefined;
  }

  /** Level fixed on the approval at creation. `risk: "high"` can only raise it. */
  requiredLevelFor(ctx: { agentId?: string; risk?: string }): AssuranceLevel {
    if (ctx.risk === "high") return "verified";
    const policy = this.store.agentApprovalLevel(ctx.agentId) ?? this.levelFor?.(ctx.agentId);
    return policy === "im_account" ? "im_account" : "verified";
  }

  verifyApprover(ctx: ApproverContext): ApproverVerdict {
    if (ctx.clickerPersonId !== ctx.personId) return { ok: false, level: "none", reason: "not_target" };
    if (!ctx.surface || ctx.surface.kind !== "dm") return { ok: false, level: "none", reason: "group_click" };
    if (this.isLocked(ctx.personId, ctx.now)) return { ok: false, level: "none", reason: "locked" };
    const need = ctx.requiredLevel ?? "verified";
    const ident = this.store.findIdentity(ctx.from.platform, ctx.from.accountId, ctx.from.userId);
    const cooling = ident ? this.inCooldown(ident, ctx.now) : true;
    if (need !== "verified") return { ok: true, level: "im_account" };
    if (cooling) return { ok: false, level: "im_account", reason: "cooling_off" };
    if (ctx.requestId && this.store.liveStepUp(ctx.requestId, ctx.personId)) return { ok: true, level: "verified" };
    return { ok: false, level: "im_account", reason: "step_up_required" };
  }

  inCooldown(ident: { linkedAt?: number; linkedVia?: string }, now: number): boolean {
    if (ident.linkedVia !== "pair" && ident.linkedVia !== "pair+totp") return false;
    return (ident.linkedAt ?? 0) + this.cooldownMs > now;
  }

  isLocked(personId: string, now: number): boolean {
    return this.store.authFailures(personId, now - AUTH_FAIL_WINDOW_MS) >= AUTH_FAIL_LIMIT;
  }

  /** Enrol (or re-enrol) TOTP + recovery codes. Returns the only clear copies. */
  enroll(personId: string, account: string, now: number): TotpEnrollment {
    const secret = randomBytes(TOTP_SECRET_BYTES);
    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => newRecoveryCode());
    this.store.replaceCredentials(
      personId,
      sealSecret(this.masterKey, secret),
      recoveryCodes.map(hashRecoveryCode),
      now,
    );
    const b32 = base32Encode(secret);
    return { secretBase32: b32, otpauthUrl: otpauthUrl(b32, account), recoveryCodes };
  }

  /**
   * Check a TOTP code: lockout → decrypt → ±1 step → replay (step must be
   * newer than the last accepted one, CAS-persisted). Failures are counted.
   */
  checkCode(personId: string, code: string, now: number): CodeCheck {
    if (this.isLocked(personId, now)) return { ok: false, reason: "locked" };
    const cred = this.store.totpCredential(personId);
    if (!cred) return { ok: false, reason: "not_enrolled" };
    let step: number | undefined;
    try {
      step = matchTotpStep(openSecret(this.masterKey, cred.secretEnc), code.trim(), now);
    } catch {
      return { ok: false, reason: "error" };
    }
    if (step === undefined || (cred.lastStep !== undefined && step <= cred.lastStep)) {
      const reason = step === undefined ? "wrong" : "replay";
      this.store.recordAuthFailure(personId, now, reason);
      return { ok: false, reason, nowLocked: this.isLocked(personId, now) };
    }
    if (!this.store.advanceTotpStep(cred.id, step)) {
      this.store.recordAuthFailure(personId, now, "replay");
      return { ok: false, reason: "replay", nowLocked: this.isLocked(personId, now) };
    }
    return { ok: true, step };
  }

  /** One-time recovery code (CLI recovery path). */
  useRecoveryCode(personId: string, code: string, now: number): boolean {
    if (this.isLocked(personId, now)) return false;
    const ok = this.store.consumeRecoveryCode(personId, hashRecoveryCode(code), now);
    if (!ok) this.store.recordAuthFailure(personId, now, "recovery");
    return ok;
  }
}

export function isTotpVerifier(v: ApproverVerifier): v is TotpVerifier {
  return v instanceof TotpVerifier;
}
