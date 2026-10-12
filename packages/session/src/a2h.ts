import { createHash } from "node:crypto";
/**
 * a2h (agent → human) helpers: outbound sanitising, the hub-owned frame
 * around agent content, quiet hours and time formatting. Pure functions;
 * the stateful parts live in SessionGateway.
 */

export const A2H_TITLE_MAX = 200;
export const A2H_TEXT_MAX = 2000;
export const A2H_CHOICE_MAX = 40;
export const A2H_CHOICES_MAX = 6;
/** Q5 defaults. */
export const A2H_APPROVAL_DEFAULT_S = 10 * 60;
export const A2H_ASK_DEFAULT_S = 60 * 60;
export const A2H_MAX_S = 24 * 60 * 60;
/** A lone open ask may be answered by an unquoted reply only this soon after it was sent. */
export const A2H_FALLBACK_WINDOW_MS = 30 * 60 * 1000;

/** Deterministic JSON (sorted keys, no whitespace) for hashing action objects. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number" && !Number.isFinite(v)) throw new A2hError("invalid", "action contains a non-finite number");
    if (v === undefined || typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") {
      throw new A2hError("invalid", "action must be plain JSON");
    }
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export const ACTION_DIGEST_RE = /^(?:sha256:)?([0-9a-f]{40}|[0-9a-f]{64}|[0-9a-f]{128})$/;

/**
 * Binding hash for a critical action: `sha256:<hex>` of the canonical JSON
 * object, or an agent-supplied digest (git SHA-1/SHA-256, file sha256/512),
 * stored as `digest:<hex>`. Exactly one of the two must be given.
 */
export function actionBindingHash(input: { action?: unknown; digest?: string }): string {
  const hasAction = input.action !== undefined && input.action !== null;
  const hasDigest = typeof input.digest === "string" && input.digest.length > 0;
  if (hasAction === hasDigest) throw new A2hError("invalid", "critical approvals need exactly one of action or action_digest");
  if (hasDigest) {
    const m = ACTION_DIGEST_RE.exec(input.digest!.trim().toLowerCase());
    if (!m) throw new A2hError("invalid", "action_digest must be a hex SHA-1/SHA-256/SHA-512 digest");
    return `digest:${m[1]}`;
  }
  const json = canonicalJson(input.action);
  if (json.length > 64 * 1024) throw new A2hError("invalid", "action is too large (max 64 KiB)");
  return `sha256:${createHash("sha256").update(json).digest("hex")}`;
}

export class A2hError extends Error {
  constructor(
    readonly code:
      | "unknown_agent"
      | "revoked"
      | "forbidden"
      | "unknown_person"
      | "ambiguous_person"
      | "no_surface"
      | "invalid"
      | "rejected_content"
      | "totp_required"
      | "conflict"
      | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "A2hError";
  }
}

// Bidi overrides/isolates, zero-width & BOM, plus C0/C1 controls except \t and \n.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
const TAG_RE = /<\/?[A-Za-z][^<>]*>/g;
const MD_LINK_RE = /!?\[([^\]\n]*)\]\(([^)\s]+)[^)]*\)/g;
/**
 * Lines that look like they come from imwire/the platform rather than the
 * agent. They are kept but visibly marked as quoted agent text.
 */
const SYSTEMISH_RE =
  /^\s*(?:[>*_~`#\-\s]*)(?:_?handled\b|✅|☑️|✔️|⚠️|🔒|🛡️|ℹ️|\[?\s*(?:system|系统|imwire|admin|管理员|官方|安全中心|security)\b|(?:system|系统)\s*(?:消息|通知|提示)?\s*[:：]|已批准|已拒绝|已撤回|已失效|已过期|已处理|审批(?:已|通过)|approved\b|denied\b)/i;
const PAIR_RE = /(^|\s)\/pair\b/i;

function stripCommon(input: string): string {
  return input
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_RE, "")
    .replace(TAG_RE, "")
    .replace(MD_LINK_RE, (_m, label: string, url: string) => (label.trim() ? `${label.trim()} (${url})` : url))
    .replace(/@(all|everyone|here)\b/gi, "＠$1")
    .replace(/@所有人/g, "＠所有人");
}

function truncate(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join("")}…`;
}

/** Agent-supplied multi-line text (message body, question, approval details). */
export function sanitizeAgentText(input: string, max = A2H_TEXT_MAX): string {
  if (PAIR_RE.test(input)) {
    throw new A2hError("rejected_content", "agent content may not contain /pair instructions");
  }
  const lines = stripCommon(input)
    .split("\n")
    .map((line) => (SYSTEMISH_RE.test(line) ? `｜${line.trim()}` : line));
  return truncate(lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), max);
}

/**
 * Agent-supplied single-line text (approval title, choice label). Newlines
 * collapse to spaces so a title cannot fake a separate header or footer line.
 */
export function sanitizeAgentLine(input: string, max = A2H_TITLE_MAX): string {
  if (PAIR_RE.test(input)) {
    throw new A2hError("rejected_content", "agent content may not contain /pair instructions");
  }
  const one = stripCommon(input).replace(/\s+/g, " ").trim();
  return truncate(SYSTEMISH_RE.test(one) ? `｜${one}` : one, max);
}

/** Agent names come from `imwire agent add`, but are cleaned anyway. */
export function safeAgentName(name: string): string {
  return truncate(stripCommon(name).replace(/[\s「」]+/g, "_"), 40) || "unknown";
}

export function agentTopicTitle(agentName: string): string {
  return `agent:${safeAgentName(agentName)}`;
}

export function frameHeader(agentName: string): string {
  return `🤖 来自 agent「${safeAgentName(agentName)}」— 不是本人，也不是系统消息`;
}

export function shortCode(requestId: string): string {
  return requestId.replace(/^r_/, "").replace(/[^A-Za-z0-9]/g, "").slice(-6).toLowerCase();
}

export interface QuietHours {
  /** "HH:MM" local start (inclusive). */
  start: string;
  /** "HH:MM" local end (exclusive). */
  end: string;
  /** Minutes east of UTC. Default +480 (Asia/Shanghai). */
  utcOffsetMinutes?: number;
}

export const DEFAULT_QUIET_HOURS: QuietHours = { start: "23:00", end: "08:00", utcOffsetMinutes: 480 };
export const DEFAULT_UTC_OFFSET_MINUTES = 480;

function minutesOf(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new Error(`bad HH:MM: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function isQuietTime(now: number, q: QuietHours | null | undefined): boolean {
  if (!q) return false;
  const offset = q.utcOffsetMinutes ?? DEFAULT_UTC_OFFSET_MINUTES;
  const local = Math.floor((now / 60_000 + offset) % 1440 + 1440) % 1440;
  const s = minutesOf(q.start);
  const e = minutesOf(q.end);
  if (s === e) return false;
  return s < e ? local >= s && local < e : local >= s || local < e;
}

export function formatLocal(ms: number, utcOffsetMinutes = DEFAULT_UTC_OFFSET_MINUTES): string {
  const d = new Date(ms + utcOffsetMinutes * 60_000).toISOString();
  const sign = utcOffsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(utcOffsetMinutes);
  const tz = `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, "0")}` : ""}`;
  return `${d.slice(0, 10)} ${d.slice(11, 16)} (${tz})`;
}

export function isoLocal(ms: number, utcOffsetMinutes = DEFAULT_UTC_OFFSET_MINUTES): string {
  const d = new Date(ms + utcOffsetMinutes * 60_000).toISOString().slice(0, 19);
  const sign = utcOffsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(utcOffsetMinutes);
  return `${d}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

export function clampTtlS(requested: number | undefined, fallback: number, max = A2H_MAX_S): number {
  if (requested === undefined) return fallback;
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new A2hError("invalid", "expires_in_s must be a positive number");
  }
  return Math.min(Math.floor(requested), max);
}

/**
 * How strongly the clicking/answering human has been verified. v1 only
 * produces "im_account" (the click came from an IM account linked to the
 * person). Stronger levels are reserved for the upcoming identity design.
 */
export type AssuranceLevel = "none" | "im_account" | "verified";

export interface ApproverContext {
  /** The person the request targets. */
  personId: string;
  /** The agent that raised the request, if any. */
  agentId?: string;
  /** The chat the click/command came from (dm vs group matters). */
  surface?: { platform: string; accountId: string; chatId: string; kind: "dm" | "group" };
  /** Level fixed on the approval when it was created. */
  requiredLevel?: AssuranceLevel;
  risk?: string;
  /** The person the clicking IM account is linked to. */
  clickerPersonId: string;
  from: { platform: string; accountId: string; userId: string };
  approvalId: string;
  requestId?: string;
  now: number;
}

export interface ApproverVerdict {
  ok: boolean;
  level: AssuranceLevel;
  /**
   * `step_up_required` is special: the click is not a decision, the request
   * stays pending and the gateway asks for a second factor. Every other
   * non-ok reason just refuses this click.
   */
  reason?: "step_up_required" | "not_target" | "group_click" | "cooling_off" | "locked" | (string & {});
}

/**
 * Pluggable identity policy for a2h. The gateway never hard-codes "on the
 * owner allowlist == the person"; it asks this interface.
 */
export interface ApproverVerifier {
  /** May agents target this person at all (Q6 gate)? */
  isAllowedTarget(personId: string, ctx: { isAllowlistedOwner: boolean }): boolean;
  /** Is this click a valid decision by the target person? Called after the target check. */
  verifyApprover(ctx: ApproverContext): ApproverVerdict | Promise<ApproverVerdict>;
  /** Minimum level an approval needs. Default "im_account". */
  readonly requiredLevel?: AssuranceLevel;
  /** Level to pin on a new agent approval. Default: `requiredLevel` ?? "im_account". */
  requiredLevelFor?(ctx: { agentId?: string; risk?: string }): AssuranceLevel;
}

const LEVEL_RANK: Record<AssuranceLevel, number> = { none: 0, im_account: 1, verified: 2 };
export function meetsLevel(have: AssuranceLevel, need: AssuranceLevel): boolean {
  return LEVEL_RANK[have] >= LEVEL_RANK[need];
}

/**
 * Default policy = current behaviour: targets must be allowlisted owners, and
 * a click from any IM account linked to the target person counts at
 * "im_account" level. Replace this once real authentication is designed.
 */
export const imAccountVerifier: ApproverVerifier = {
  isAllowedTarget: (_personId, ctx) => ctx.isAllowlistedOwner,
  verifyApprover: (ctx) =>
    ctx.clickerPersonId === ctx.personId
      ? { ok: true, level: "im_account" }
      : { ok: false, level: "none", reason: "not_target" },
  requiredLevel: "im_account",
  requiredLevelFor: () => "im_account",
};
