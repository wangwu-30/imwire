import { proactiveFailure, proactiveText, type ProactiveResult } from "./proactive.js";
import { timingSafeEqual } from "node:crypto";
import {
  noopLogger,
  systemClock,
  type Adapter,
  type ChatRef,
  type Clock,
  type DraftHandle,
  type Inbound,
  type Logger,
  type MsgRef,
  type OutMessage,
  type UserRef,
} from "@imwire/core";
import {
  A2H_APPROVAL_DEFAULT_S,
  A2H_ASK_DEFAULT_S,
  A2H_CHOICE_MAX,
  A2H_CHOICES_MAX,
  A2H_FALLBACK_WINDOW_MS,
  A2hError,
  ACTION_DIGEST_RE,
  actionBindingHash,
  agentTopicTitle,
  canonicalJson,
  clampTtlS,
  DEFAULT_QUIET_HOURS,
  formatLocal,
  frameHeader,
  isoLocal,
  isQuietTime,
  safeAgentName,
  sanitizeAgentLine,
  sanitizeAgentText,
  shortCode,
  imAccountVerifier,
  meetsLevel,
  type ApproverVerdict,
  type ApproverVerifier,
  type AssuranceLevel,
  type QuietHours,
} from "./a2h.js";
import { groupKey, identityKey, pairCode, PAIR_CODE_RE } from "./ids.js";
import { isTotpVerifier, TOTP_CODE_RE, type TotpEnrollment, type TotpVerifier } from "./totp.js";
import {
  DEFAULT_LOG_WINDOW,
  EXECUTION_UNKNOWN_AFTER_MS,
  RECEIPT_LEVELS,
  SessionStore,
  type GrantSpec,
  type ReceiptLevel,
  type ReceiptRecord,
} from "./store.js";
import {
  isDenyOption,
  isExplicitApprove,
  type AgentDriver,
  type A2hRequest,
  type A2hScope,
  type A2hView,
  type AgentRecord,
  type ApprovalDecision,
  type OwnerAllowlistEntry,
  type PendingApproval,
  type TurnSink,
  type UserTurn,
} from "./types.js";

const UNPAIRED =
  "This bot is private. Ask someone already linked to send /pair, then send the 8-digit code here.";
const INTERRUPTED = "The previous reply was interrupted. Please resend.";
const PAIR_TTL_MS = 10 * 60 * 1000;
const PAIR_RATE = 5;
const PAIR_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_APPROVAL_TTL_MS = 10 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 15 * 1000;
const RESTART_LABEL = "已失效（hub 重启）";

export interface SessionGatewayOptions {
  dbPath: string;
  /** Ordered proactive channels. WeCom is always excluded. */
  preferredChannels?: Array<"telegram" | "feishu">;
  driver: AgentDriver;
  allowlist?: OwnerAllowlistEntry[];
  clock?: Clock;
  logger?: Logger;
  unpairedText?: string;
  /** Approval wait TTL. Default 10 minutes. Persisted as `approval.expires_at`. */
  approvalTimeoutMs?: number;
  /** How often the expiry sweeper runs. Default 15 s; 0 disables the timer (call `sweepExpired()` yourself). */
  sweepIntervalMs?: number;
  /**
   * a2h quiet hours (Q5). Messages are still delivered; nothing nudges.
   * Default 23:00–08:00 UTC+8. `null` disables.
   */
  quietHours?: QuietHours | null;
  /**
   * a2h identity policy: who agents may target and whether a click is a
   * valid decision. Default keeps v1 behaviour (allowlisted owner, linked IM
   * account). Fail-closed: a throwing verifier denies the click.
   */
  approverVerifier?: ApproverVerifier | ((store: SessionStore) => ApproverVerifier);
  /**
   * Identity bootstrap/binding policy (compat switch, a2h-identity §3).
   * - "legacy" (default): unchanged behaviour — an allowlisted ID's first DM
   *   becomes the owner; `/pair` needs only the 8-digit code.
   * - "totp": owners are created by `initOwner()` (CLI) and claimed with
   *   `/claim <code> <totp>`; `/pair` needs `<code> <totp>`, only allowlisted
   *   IDs may claim or pair, every bound surface is notified, and new
   *   surfaces get a cooling-off period. Requires a TotpVerifier.
   */
  identityMode?: "legacy" | "totp";
  /**
   * Run the boot-time "pending → expired" pass (default true). Admin tools
   * (CLI) that open the same DB next to a running hub must pass false.
   */
  bootExpiry?: boolean;
  logWindow?: number;
}

type TurnPhase = "running" | "finalizing" | "handoff";

interface ActiveTurn {
  conversationId: string;
  surface: ChatRef;
  adapter: Adapter;
  draft: DraftHandle;
  generated: string;
  replyTo?: MsgRef;
  personId?: string;
  switchNote?: string;
  phase: TurnPhase;
  /** True only while `driver.prompt` is in flight (not typing / hand-off). */
  streaming: boolean;
  stopped?: boolean;
}

interface ApprovalWaiter {
  resolve: (decision: ApprovalDecision) => void;
  abort: () => void;
}

export class SessionGateway {
  readonly store: SessionStore;
  private readonly preferredChannels: Array<"telegram" | "feishu">;
  private readonly proactivePending = new Map<string, Promise<ProactiveResult>>();
  private readonly driver: AgentDriver;
  private readonly allowlist: OwnerAllowlistEntry[];
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly unpairedText: string;
  private readonly approvalTimeoutMs: number;
  private readonly logWindow: number;
  private readonly adapters = new Map<string, Adapter>();
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly active = new Map<string, ActiveTurn>();
  private readonly followups = new Map<string, UserTurn[]>();
  private readonly approvalWaiters = new Map<string, ApprovalWaiter>();
  private readonly agentSessions = new Map<string, string>();
  private readonly turns = new Map<string, Promise<void>>();
  private readonly expiredOnBoot: PendingApproval[] = [];
  private readonly expiredAsksOnBoot: A2hRequest[] = [];
  private readonly quietHours: QuietHours | null;
  private readonly verifier: ApproverVerifier;
  private readonly identityMode: "legacy" | "totp";
  private readonly a2hListeners = new Map<string, Set<() => void>>();
  private readonly sweepTimer?: ReturnType<typeof setInterval>;
  private closed = false;
  private recoverChain: Promise<void> = Promise.resolve();

  constructor(opts: SessionGatewayOptions) {
    this.store = new SessionStore(opts.dbPath);
    this.driver = opts.driver;
    this.preferredChannels = opts.preferredChannels ?? ["telegram", "feishu"];
    this.allowlist = opts.allowlist ?? [];
    this.clock = opts.clock ?? systemClock();
    this.logger = opts.logger ?? noopLogger;
    this.unpairedText = opts.unpairedText ?? UNPAIRED;
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? DEFAULT_APPROVAL_TTL_MS;
    this.logWindow = opts.logWindow ?? DEFAULT_LOG_WINDOW;
    const v = opts.approverVerifier;
    this.verifier = typeof v === "function" ? v(this.store) : (v ?? imAccountVerifier);
    this.identityMode = opts.identityMode ?? "legacy";
    if (this.identityMode === "totp" && !isTotpVerifier(this.verifier)) {
      throw new Error('identityMode "totp" requires a TotpVerifier');
    }
    this.quietHours = opts.quietHours === undefined ? DEFAULT_QUIET_HOURS : opts.quietHours;
    const boot = opts.bootExpiry !== false;
    // Q4: a hub restart fails every open agent request closed.
    for (const req of !boot ? [] :  this.store.expirePendingA2hRequests(this.clock.now(), "restart")) {
      this.logger.info("expired a2h request on boot", { id: req.id });
      if (req.kind === "ask") this.expiredAsksOnBoot.push(req);
      this.store.audit({
        at: this.clock.now(),
        action: "expire",
        result: "expired_on_restart",
        agentId: req.agentId,
        personId: req.personId,
        requestId: req.id,
      });
    }
    for (const expired of !boot ? [] : this.store.expirePendingApprovals(this.clock.now(), "expired")) {
      this.logger.info("expired stale approval on boot", { id: expired.id });
      this.expiredOnBoot.push(expired);
      this.syncA2hFromApproval(expired);
    }
    const sweepMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    if (sweepMs > 0) {
      this.sweepTimer = setInterval(() => {
        try {
          this.sweepExpired();
        } catch (err) {
          this.logger.warn("expiry sweep failed", { err: String(err) });
        }
      }, sweepMs);
      this.sweepTimer.unref?.();
    }
  }

  /**
   * Expiry sweeper. Denies approvals and expires a2h requests whose persisted
   * `expires_at` has passed (fail-closed), wakes any in-process waiter, and
   * rewrites the cards. Safe to call at any time; idempotent.
   */
  sweepExpired(): { approvals: PendingApproval[]; requests: A2hRequest[] } {
    if (this.closed) return { approvals: [], requests: [] };
    const now = this.clock.now();
    const approvals = this.store.expireDueApprovals(now, "expired");
    for (const decided of approvals) {
      this.syncA2hFromApproval(decided);
      this.approvalWaiters.get(decided.id)?.resolve("deny");
      this.approvalWaiters.delete(decided.id);
      void this.updateApprovalCards(decided, "denied");
    }
    const requests = this.store.expireDueA2hRequests(now);
    for (const req of requests) {
      this.notifyA2h(req.id);
      if (req.kind === "ask") void this.closeAskCards(req, "已过期");
      this.store.audit({
        at: now,
        action: "expire",
        result: "expired",
        agentId: req.agentId,
        personId: req.personId,
        requestId: req.id,
      });
    }
    try {
      this.markUnknownExecutions();
    } catch (err) {
      this.logger.warn("execution-unknown sweep failed", { err: String(err) });
    }
    return { approvals, requests };
  }

  /**
   * v1 target gate (Q6): the data model is multi-person, but agents may only
   * reach people who are owners on the allowlist.
   */
  isA2hTargetAllowed(personId: string): boolean {
    try {
      return this.verifier.isAllowedTarget(personId, { isAllowlistedOwner: this.isAllowlistedOwner(personId) });
    } catch {
      return false;
    }
  }

  private isAllowlistedOwner(personId: string): boolean {
    return this.store
      .listIdentities(personId)
      .some((id) =>
        this.allowlist.some(
          (o) => o.platform === id.platform && o.accountId === id.accountId && o.userId === id.userId,
        ),
      );
  }

  /** Grant an agent scopes on a person. Throws unless the person passes the v1 allowlist gate. */
  grantAgent(agentId: string, personId: string, scopes: A2hScope[]): void {
    if (!this.store.getAgent(agentId)) throw new Error(`unknown agent ${agentId}`);
    if (!this.isA2hTargetAllowed(personId)) {
      this.store.audit({
        at: this.clock.now(),
        action: "grant",
        result: "forbidden_target",
        agentId,
        personId,
      });
      throw new Error("a2h v1: agents may only reach allowlisted owners");
    }
    this.store.setAgentGrant(agentId, personId, scopes);
  }

  /** Pluggable approver check for targeted (a2h) approvals. Fail-closed. */
  private async verifyApproverClick(
    approval: PendingApproval,
    from: UserRef,
    surface: ChatRef | undefined,
  ): Promise<ApproverVerdict> {
    const ident = this.store.findIdentity(from.platform, from.accountId, from.userId);
    const request = this.store.a2hRequestByApproval(approval.id);
    let ok = false;
    let level: AssuranceLevel = "none";
    let reason: string | undefined;
    const reqRisk = request ? this.store.a2hActionState(request.id)?.risk : undefined;
    // critical: TOTP always, whatever the verifier or a per-agent downgrade says.
    const need =
      reqRisk === "critical"
        ? "verified"
        : maxLevel(this.verifier.requiredLevel ?? "im_account", (approval.requiredLevel as AssuranceLevel) ?? "im_account");
    try {
      const verdict = await this.verifier.verifyApprover({
        personId: approval.targetPersonId!,
        clickerPersonId: ident?.personId ?? "",
        from: { platform: from.platform, accountId: from.accountId, userId: from.userId },
        approvalId: approval.id,
        requestId: request?.id,
        agentId: request?.agentId,
        surface: surface ? { ...surface } : undefined,
        requiredLevel: need,
        risk: reqRisk,
        now: this.clock.now(),
      });
      level = verdict.level;
      reason = verdict.reason;
      ok = verdict.ok && meetsLevel(verdict.level, need);
      // critical additionally needs a live TOTP step-up for this exact request.
      if (ok && reqRisk === "critical" && !(request && this.store.liveStepUp(request.id, approval.targetPersonId!))) {
        ok = false;
        reason = "step_up_required";
      }
      if (verdict.ok && !ok) reason = "insufficient_level";
    } catch {
      reason = "verifier_error"; // never echo verifier internals into the audit trail
    }
    if (ok) return { ok: true, level };
    if (reason === "step_up_required") {
      this.store.audit({
        at: this.clock.now(),
        action: "click",
        result: "step_up_required",
        agentId: request?.agentId,
        personId: ident?.personId,
        requestId: request?.id,
      });
      return { ok: false, level, reason };
    }
    {
      this.store.audit({
        at: this.clock.now(),
        action: "click",
        result: "unverified_click",
        agentId: request?.agentId,
        personId: ident?.personId,
        requestId: request?.id,
        detail: { approvalId: approval.id, level, reason },
      });
    }
    return { ok: false, level, reason };
  }

  /** Mirror a decided approval onto its a2h request (if any). */
  private syncA2hFromApproval(decided: PendingApproval, ctx?: { quote?: string; channel?: string }): void {
    const req = this.store.a2hRequestByApproval(decided.id);
    if (!req || req.state !== "pending") return;
    const by = decided.decidedBy ?? "unknown";
    const state =
      decided.state === "approved"
        ? "approved"
        : by === "expired" || by === "timeout" || by === "restart"
          ? "expired"
          : by === "cancelled"
            ? "cancelled"
            : by === "failed"
              ? "failed"
              : by === "locked"
                ? "denied"
              : "denied";
    const now = this.clock.now();
    const after = this.store.decideA2hRequest(req.id, state, by, now, { choice: decided.chosen ?? null });
    if (after) {
      const human = state === "approved" || (state === "denied" && by.split(":").length === 3);
      if (ctx) this.store.setA2hMeta(req.id, { quote: ctx.quote, channel: ctx.channel });
      const eid = this.store.audit({
        at: now,
        occurredAt: decided.decidedAt ?? now,
        action: "decision",
        result: state,
        agentId: req.agentId,
        personId: req.personId,
        requestId: req.id,
        source: human ? `actor:person:${req.personId}` : undefined,
        idempotencyKey: `dec:${req.id}`,
        data: this.decisionData(req.id, {
          choice: human ? (decided.chosen ?? null) : null,
          decided_by: human ? `person:${req.personId}` : `system:${by}`,
          decided_level: decided.decidedLevel ?? null,
        }),
      });
      this.store.setA2hDecisionEvent(req.id, eid);
    }
    this.notifyA2h(req.id);
  }

  // ---- v0 request / decision metadata (PR 4) ---------------------------------

  private requestMeta(
    opts: { grant?: GrantSpec; object?: { ref: string; digest?: string }; stateVersion?: string; actionName?: string },
    critical: boolean,
  ): { grant: GrantSpec; objectRef?: string; objectDigest?: string; stateVersion?: string; action?: string } {
    const grant = validateGrant(opts.grant ?? { kind: "once" }, this.clock.now());
    if (critical && grant.kind !== "once") throw new A2hError("invalid", "critical approvals are grant once");
    let objectRef: string | undefined;
    let objectDigest: string | undefined;
    if (opts.object !== undefined) {
      if (!opts.object || typeof opts.object.ref !== "string" || !OBJECT_REF_RE.test(opts.object.ref)) {
        throw new A2hError("invalid", "object.ref must be 1-200 chars of [A-Za-z0-9._:/#@+-]");
      }
      objectRef = opts.object.ref;
      if (opts.object.digest !== undefined) {
        const m = ACTION_DIGEST_RE.exec(String(opts.object.digest).trim().toLowerCase());
        if (!m) throw new A2hError("invalid", "object.digest must be a hex SHA-1/SHA-256/SHA-512 digest");
        objectDigest = m[1]!.length === 64 ? `sha256:${m[1]}` : `digest:${m[1]}`;
      }
    }
    if (opts.stateVersion !== undefined && !/^[A-Za-z0-9._:-]{1,64}$/.test(String(opts.stateVersion))) {
      throw new A2hError("invalid", "state_version must be 1-64 chars of [A-Za-z0-9._:-]");
    }
    if (opts.actionName !== undefined && !/^[a-z][a-z0-9_.-]{0,39}$/.test(String(opts.actionName))) {
      throw new A2hError("invalid", "action_name must be a short lowercase verb");
    }
    return {
      grant,
      objectRef,
      objectDigest,
      stateVersion: opts.stateVersion === undefined ? undefined : String(opts.stateVersion),
      action: opts.actionName,
    };
  }

  /** v0 Request fields for a `*.request.created` event. */
  private requestData(requestId: string, extra: Record<string, unknown>): Record<string, unknown> {
    const req = this.store.getA2hRequest(requestId)!;
    const m = this.store.a2hMeta(requestId)!;
    const st = this.store.a2hActionState(requestId);
    return {
      kind: req.kind,
      to: `person:${req.personId}`,
      ...extra,
      options: m.options ?? [],
      object: m.objectRef || m.objectDigest || st?.actionHash ? { ref: m.objectRef ?? null, digest: m.objectDigest ?? st?.actionHash ?? null } : null,
      state_version: m.stateVersion ?? null,
      action: m.action ?? null,
      grant: wireGrant(m.grant),
    };
  }

  /** v0 Decision fields. Quotes are untrusted, sanitized and code-masked. */
  private decisionData(requestId: string, extra: Record<string, unknown>): Record<string, unknown> {
    const m = this.store.a2hMeta(requestId)!;
    const st = this.store.a2hActionState(requestId);
    return {
      request: requestId,
      ...extra,
      quote: m.quote ?? null,
      channel: m.channel ?? "system",
      scope: { object: m.objectRef ?? null, action: m.action ?? null, digest: st?.actionHash ?? m.objectDigest ?? null },
      state_version: m.stateVersion ?? null,
      grant: wireGrant(m.grant),
    };
  }

  /**
   * v0 Receipt from the agent: received → recorded → executed. Each level is
   * recorded once (replays return the first). `executed` needs an approved
   * (or answered) request, and for critical a successful verifyAction.
   */
  recordReceipt(opts: {
    agentId: string;
    requestId: string;
    level: ReceiptLevel;
    exitCode?: number;
    externalId?: string;
    note?: string;
    occurredAt?: number;
  }): { receipt: ReceiptRecord; replayed: boolean; execution: string } {
    const req = this.store.getA2hRequest(opts.requestId);
    if (!req || req.agentId !== opts.agentId) throw new A2hError("not_found", "no such request for this agent");
    if (!RECEIPT_LEVELS.includes(opts.level)) throw new A2hError("invalid", "level must be received, recorded or executed");
    if (req.kind === "message") throw new A2hError("invalid", "receipts are for approvals and asks");
    if (req.state === "pending") throw new A2hError("invalid", "request is not decided yet");
    if (opts.level === "executed") {
      if (req.state !== "approved" && req.state !== "answered") throw new A2hError("invalid", `cannot execute a ${req.state} request`);
      const st = this.store.a2hActionState(req.id);
      if (st?.risk === "critical" && st.consumedAt === undefined) {
        throw new A2hError("invalid", "critical: call a2h.verifyAction before reporting executed");
      }
    }
    if (opts.exitCode !== undefined && (!Number.isInteger(opts.exitCode) || Math.abs(opts.exitCode) > 2 ** 31)) {
      throw new A2hError("invalid", "exit_code must be an integer");
    }
    if (opts.externalId !== undefined && !EXTERNAL_ID_RE.test(opts.externalId)) {
      throw new A2hError("invalid", "external_id must be 1-200 chars of [A-Za-z0-9._:/#@+=-]");
    }
    const now = this.clock.now();
    const occurredAt = opts.occurredAt !== undefined && opts.occurredAt <= now ? opts.occurredAt : now;
    const note = opts.note ? redactCodes(sanitizeAgentLine(opts.note, 300)) : undefined;
    const prior = this.store.receipts(req.id).find((r) => r.level === opts.level);
    if (prior) return { receipt: prior, replayed: true, execution: this.store.a2hMeta(req.id)?.execution ?? "pending" };
    const m = this.store.a2hMeta(req.id)!;
    const late = opts.level === "executed" && m.execution === "unknown";
    const result = {
      ...(opts.exitCode !== undefined ? { exit_code: opts.exitCode } : {}),
      ...(opts.externalId !== undefined ? { external_id: opts.externalId } : {}),
    };
    const eid = this.store.audit({
      at: now,
      occurredAt,
      action: "receipt",
      result: opts.level,
      agentId: req.agentId,
      personId: req.personId,
      requestId: req.id,
      causationId: m.decisionEvent,
      idempotencyKey: `rcpt:${req.id}:${opts.level}`,
      data: {
        of: m.decisionEvent ?? `request:${req.id}`,
        level: opts.level,
        result: Object.keys(result).length > 0 ? result : null,
        note: note ?? null,
        at: isoLocal(occurredAt),
        ...(late ? { after_unknown: true } : {}),
      },
    });
    const out = this.store.addReceipt({
      requestId: req.id,
      level: opts.level,
      exitCode: opts.exitCode,
      externalId: opts.externalId,
      note,
      occurredAt,
      recordedAt: now,
      eventId: eid,
    });
    return { ...out, execution: this.store.a2hMeta(req.id)?.execution ?? "pending" };
  }

  /**
   * Decided requests with no `executed` receipt after 24h are marked
   * `unknown` in the event log, never assumed done.
   */
  markUnknownExecutions(): number {
    const now = this.clock.now();
    let n = 0;
    for (const r of this.store.dueExecutionUnknown(now - EXECUTION_UNKNOWN_AFTER_MS)) {
      if (!this.store.markExecutionUnknown(r.id)) continue;
      const m = this.store.a2hMeta(r.id);
      const levels = this.store.receipts(r.id).map((x) => x.level);
      this.store.audit({
        at: now,
        action: "execution_unknown",
        result: "unknown",
        agentId: r.agentId,
        personId: r.personId,
        requestId: r.id,
        causationId: m?.decisionEvent,
        data: { of: m?.decisionEvent ?? `request:${r.id}`, execution: "unknown", receipts: levels, after_ms: EXECUTION_UNKNOWN_AFTER_MS },
      });
      n += 1;
    }
    return n;
  }

  /** Register outbound access without subscribing to inbound DMs or boot recovery. */
  registerAdapter(adapter: Adapter): void {
    this.adapters.set(`${adapter.platform}:${adapter.accountId}`, adapter);
  }

  attach(adapter: Adapter): void {
    this.registerAdapter(adapter);
    adapter.on(async (event) => {
      try {
        await this.handle(adapter, event);
      } catch (err) {
        this.logger.error("session handle failed", { err: String(err), type: event.type });
      }
    });
    this.recoverChain = this.recoverChain
      .then(() => this.recoverInterrupted())
      .catch((err: unknown) => {
        this.logger.warn("interrupt recovery failed", { err: String(err) });
      });
    void this.recoverChain;
    void this.rewriteExpiredApprovals();
  }

  adapterFor(chat: ChatRef): Adapter | undefined {
    return this.adapters.get(`${chat.platform}:${chat.accountId}`);
  }

  close(): void {
    this.closed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.store.close();
  }

  async handle(adapter: Adapter, event: Inbound): Promise<void> {
    if (event.type === "action") {
      await this.handleAction(event.from, event.actionId, event.value, event.target);
      return;
    }
    if (event.type !== "message" && event.type !== "command") return;

    const chat = event.chat;
    const from = event.from;
    const text = event.type === "command" ? `/${event.name} ${event.args}`.trim() : event.text;
    const replyTo = event.messageId ? { chat, messageId: event.messageId } : undefined;

    if (chat.kind === "group") {
      if (event.type === "message" && !event.mentionsBot) return;
      const identity = this.store.findIdentity(from.platform, from.accountId, from.userId);
      if (!identity) {
        const key = groupKey(chat.platform, chat.accountId, chat.chatId);
        if (this.store.shouldSendGroupNotice(key, this.clock.now())) {
          await adapter.send(chat, { blocks: [{ kind: "markdown", text: this.unpairedText }] });
        }
        return;
      }
      if (event.type === "command" && event.name === "approve") {
        // Codes must never land in a group log, and group approval never counts.
        await adapter.send(chat, { blocks: [{ kind: "markdown", text: "审批只能在私聊里完成。" }] });
        return;
      }
      const conv = this.store.groupConversation(chat, this.clock.now());
      if (event.type === "command" && (event.name === "stop" || event.name === "cancel")) {
        await this.handleStop(adapter, chat, conv.id);
        return;
      }
      await this.acceptTurn(adapter, conv.id, identity.personId, chat, from, text, replyTo);
      return;
    }

    const identity = this.store.findIdentity(from.platform, from.accountId, from.userId);
    if (!identity) {
      await this.handleUnpaired(adapter, chat, from, text);
      return;
    }

    if (event.type === "command" && event.name === "pair") {
      await this.issuePairCode(adapter, chat, identity.personId, from);
      return;
    }
    if (event.type === "command" && (event.name === "topic" || event.name === "topics")) {
      await this.handleTopic(adapter, chat, identity.personId, event.name, event.args);
      return;
    }
    if (event.type === "command" && (event.name === "stop" || event.name === "cancel")) {
      const conv = this.store.activeConversation(identity.personId, this.clock.now());
      await this.handleStop(adapter, chat, conv.id);
      return;
    }

    if (event.type === "command" && event.name === "approve") {
      this.store.touchPresence(identity.personId, chat, this.clock.now());
      await this.handleApproveCommand(adapter, chat, from, identity.personId, event.args);
      return;
    }
    if (event.type === "message" && TOTP_CODE_RE.test(event.text.trim()) && !event.replyTo) {
      const awaiting = this.awaitingStepUp(identity.personId);
      if (awaiting.length > 0) {
        // Never let a bare TOTP reach pi or the message log.
        if (awaiting.length === 1) await this.submitStepUp(adapter, chat, from, identity.personId, awaiting[0]!, event.text.trim());
        else await this.a2hReply(adapter, chat, "有多个审批在等验证码，请用 /approve <编号> <6位验证码>。");
        return;
      }
    }
    if (event.type === "command" && event.name === "answer") {
      this.store.touchPresence(identity.personId, chat, this.clock.now());
      await this.handleAnswerCommand(adapter, chat, from, identity.personId, event.args);
      return;
    }
    if (event.type === "message") {
      this.store.touchPresence(identity.personId, chat, this.clock.now());
      if (await this.tryResolve(adapter, chat, from, identity.personId, event.text, event.replyTo)) return;
    }

    this.store.touchPresence(identity.personId, chat, this.clock.now());
    const conv = this.store.activeConversation(identity.personId, this.clock.now());
    await this.acceptTurn(adapter, conv.id, identity.personId, chat, from, text, replyTo);
  }

  async sendProactive(personId: string, text: string): Promise<ProactiveResult> {
    const result = await this.sendProactiveTo(personId, text);
    if (result.status !== "delivered") {
      this.logger.warn("proactive delivery failed", {
        status: result.status, channel: result.channel,
        code: result.status === "dead" ? result.detail : result.reason,
      });
    }
    return result;
  }

  async sendProactiveTo(personId: string, text: string, opts: { idempotencyKey?: string } = {}): Promise<ProactiveResult> {
    const key = opts.idempotencyKey;
    if (!key) return this.deliverProactive(personId, text);
    const pending = this.proactivePending.get(key);
    if (pending) return pending;
    const run = this.deliverProactive(personId, text, key);
    this.proactivePending.set(key, run);
    try { return await run; }
    finally { this.proactivePending.delete(key); }
  }

  private async deliverProactive(personId: string, text: string, key?: string): Promise<ProactiveResult> {
    const prior = key ? this.store.getOutboxDelivery(key) : undefined;
    if (prior?.status === "delivered" && prior.refs[0]) {
      return { status: "delivered", surface: prior.refs[0].chat, refs: prior.refs };
    }
    const identities = this.store.listIdentities(personId);
    const last = this.store.lastSurface(personId);
    let surface: ChatRef | undefined;
    let adapter: Adapter | undefined;
    for (const channel of this.preferredChannels) {
      // Runtime config is not necessarily typed; never allow WeCom here.
      if (channel !== "telegram" && channel !== "feishu") continue;
      for (const ident of identities.filter((id) => id.platform === channel)) {
        const candidate: ChatRef = last?.platform === channel && last.accountId === ident.accountId && last.kind === "dm"
          ? last : { platform: channel, accountId: ident.accountId, chatId: ident.userId, kind: "dm" };
        const a = this.adapterFor(candidate);
        if (!a || a.capabilities.proactiveSend !== true || a.isAlive?.() === false) continue;
        surface = candidate;
        adapter = a;
        break;
      }
      if (surface) break;
    }
    if (!surface || !adapter) {
      const reason = identities.length ? "unsupported" : "no_surface";
      return { status: "dead", reason, detail: reason };
    }
    const cleaned = proactiveText(text);
    let refs: MsgRef[];
    try {
      refs = await adapter.send(surface, { blocks: [{ kind: "text", text: cleaned }] }, { maxAttempts: 1 });
      if (!refs.length) return { status: "dead", reason: "permanent", detail: "empty_refs", channel: surface.platform };
    } catch (err) {
      return { ...proactiveFailure(err, this.clock.now()), channel: surface.platform };
    }
    const now = this.clock.now();
    const conv = this.store.activeConversation(personId, now);
    const msg = this.store.appendMessage({ conversationId: conv.id, role: "assistant", text: cleaned, surface, now });
    // Delivery references and the durable dedup marker commit together.
    this.store.db.transaction(() => {
      for (const ref of refs) this.store.addDelivery(msg.id, ref.chat, ref.messageId);
      if (key) this.store.putOutboxDelivery({
        outboxId: key, status: "delivered", attempts: prior?.attempts ?? 1,
        nextTryAt: null, refs, updatedAt: now, channel: surface.platform,
      });
    });
    return { status: "delivered", surface, refs };
  }

  private async recoverInterrupted(): Promise<void> {
    if (this.closed) return;
    try {
      for (const tail of this.store.unansweredTails()) {
        if (this.closed) return;
        const surfaces = this.surfacesForTail(tail);
        let sent = false;
      for (const surface of surfaces) {
        const adapter = this.adapterFor(surface);
        if (!adapter) continue;
        try {
          await adapter.send(surface, { blocks: [{ kind: "markdown", text: INTERRUPTED }] });
          sent = true;
          break;
        } catch (err) {
          this.logger.warn("interrupt notice failed", { err: String(err) });
        }
      }
      if (sent && !this.closed) this.store.markInterruptNotified(tail.conversationId, tail.seq);
      }
    } catch (err) {
      if (this.closed) return;
      this.logger.warn("interrupt recovery failed", { err: String(err) });
    }
  }

  private surfacesForTail(tail: {
    personId?: string;
    surface?: ChatRef;
  }): ChatRef[] {
    const out: ChatRef[] = [];
    const seen = new Set<string>();
    const add = (s?: ChatRef) => {
      if (!s) return;
      const k = `${s.platform}:${s.accountId}:${s.chatId}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push(s);
    };
    add(tail.surface);
    if (tail.personId) {
      add(this.store.lastSurface(tail.personId));
      for (const ident of this.store.listIdentities(tail.personId)) {
        add({ platform: ident.platform, accountId: ident.accountId, chatId: ident.userId, kind: "dm" });
      }
    }
    return out;
  }

  private async rewriteExpiredApprovals(): Promise<void> {
    if (this.closed) return;
    try {
      for (const approval of this.expiredOnBoot) {
        if (this.closed) return;
        // Q4: agent cards say plainly that the request died with the hub.
        if (approval.source === "agent") await this.updateApprovalCards(approval, "expired", RESTART_LABEL);
        else await this.updateApprovalCards(approval, "expired");
      }
      for (const req of this.expiredAsksOnBoot) {
        if (this.closed) return;
        await this.closeAskCards(req, RESTART_LABEL);
      }
    } catch (err) {
      if (this.closed) return;
      this.logger.warn("expired approval rewrite failed", { err: String(err) });
    }
  }

  private async handleUnpaired(adapter: Adapter, chat: ChatRef, from: UserRef, text: string): Promise<void> {
    if (this.identityMode === "totp") {
      await this.handleUnpairedTotp(adapter, chat, from, text);
      return;
    }
    const sender = identityKey(from.platform, from.accountId, from.userId);
    const now = this.clock.now();
    const code = text.trim();
    if (PAIR_CODE_RE.test(code)) {
      const personId = this.store.livePairPerson(code, now);
      if (personId) {
        if (this.store.pairLocked(sender, now)) {
          if (this.store.shouldTellLockout(sender, now)) {
            await adapter.send(chat, { blocks: [{ kind: "markdown", text: "Too many pairing attempts. Try again later." }] });
          }
          return;
        }
        const consumed = this.store.consumePairCode(code, now);
        if (!consumed) {
          await adapter.send(chat, { blocks: [{ kind: "markdown", text: this.unpairedText }] });
          return;
        }
        this.store.recordPairAttempt(sender, now, true);
        const linked = this.store.linkIdentity(consumed, from.platform, from.accountId, from.userId, now);
        if (!linked) {
          await adapter.send(chat, { blocks: [{ kind: "markdown", text: this.unpairedText }] });
          return;
        }
        this.store.touchPresence(consumed, chat, now);
        await adapter.send(chat, {
          blocks: [{ kind: "markdown", text: "Linked. You share one conversation across IMs." }],
        });
        const ownerSurface = this.store.lastSurface(consumed);
        if (ownerSurface && !sameSurface(ownerSurface, chat)) {
          const dest = this.adapterFor(ownerSurface);
          await dest
            ?.send(ownerSurface, {
              blocks: [{ kind: "markdown", text: `Linked ${from.platform} account ${from.userId}.` }],
            })
            .catch(() => undefined);
        }
        return;
      }
      if (this.store.pairLocked(sender, now)) {
        if (this.store.shouldTellLockout(sender, now)) {
          await adapter.send(chat, { blocks: [{ kind: "markdown", text: "Too many pairing attempts. Try again later." }] });
        }
        return;
      }
      this.store.recordPairAttempt(sender, now, false);
      if (this.store.pairLocked(sender, now)) {
        if (this.store.shouldTellLockout(sender, now)) {
          await adapter.send(chat, { blocks: [{ kind: "markdown", text: "Too many pairing attempts. Try again later." }] });
        }
        return;
      }
      await adapter.send(chat, { blocks: [{ kind: "markdown", text: this.unpairedText }] });
      return;
    }

    const owner = this.allowlist.find(
      (e) => e.platform === from.platform && e.accountId === from.accountId && e.userId === from.userId,
    );
    if (owner) {
      const { created } = this.store.bootstrapOwner(
        from.platform,
        from.accountId,
        from.userId,
        owner.name ?? from.displayName,
        now,
      );
      const ident = this.store.findIdentity(from.platform, from.accountId, from.userId);
      if (ident) this.store.touchPresence(ident.personId, chat, now);
      if (created) {
        await adapter.send(chat, {
          blocks: [{ kind: "markdown", text: "Welcome. You are the owner. Send /pair to link another IM." }],
        });
      }
      return;
    }

    await adapter.send(chat, { blocks: [{ kind: "markdown", text: this.unpairedText }] });
  }

  private async issuePairCode(adapter: Adapter, chat: ChatRef, personId: string, from: UserRef): Promise<void> {
    const now = this.clock.now();
    const createdBy = identityKey(from.platform, from.accountId, from.userId);
    const result = this.store.createPairCode(personId, createdBy, now + PAIR_TTL_MS, now, PAIR_RATE, PAIR_WINDOW_MS);
    if (result === "rate_limited") {
      await adapter.send(chat, { blocks: [{ kind: "markdown", text: "Too many pairing codes. Try again later." }] });
      return;
    }
    await adapter.send(chat, {
      blocks: [{ kind: "markdown", text: `Pairing code: ${result} (valid 10 minutes, one use). Send it to this bot from the new IM.` }],
    });
  }

  private async handleTopic(
    adapter: Adapter,
    chat: ChatRef,
    personId: string,
    name: string,
    args: string,
  ): Promise<void> {
    if (name === "topics" || args.trim() === "" || args.trim() === "list") {
      const topics = this.store.listTopics(personId);
      const lines = topics.map((t) => `${t.active ? "→ " : "  "}${t.isDefault ? "default" : t.title}`);
      await adapter.send(chat, {
        blocks: [{ kind: "markdown", text: lines.length ? `Topics:\n${lines.join("\n")}` : "No topics yet." }],
      });
      return;
    }
    const title = args.replace(/^new\s+/i, "").trim();
    const conv = this.store.switchTopic(personId, title, this.clock.now());
    await adapter.send(chat, {
      blocks: [{ kind: "markdown", text: `Switched to ${conv.isDefault ? "default" : conv.title}. This applies on every IM.` }],
    });
  }

  private async acceptTurn(
    adapter: Adapter,
    conversationId: string,
    personId: string | undefined,
    chat: ChatRef,
    from: UserRef,
    text: string,
    replyTo?: MsgRef,
  ): Promise<void> {
    let start = false;
    await this.lane(conversationId, async () => {
      const current = this.active.get(conversationId);
      const turn: UserTurn = { text, source: { chat, from } };
      if (current) {
        const canSwitch = !sameSurface(current.surface, chat) && current.phase === "running";
        if (canSwitch) {
          await this.switchSurface(current, adapter, chat, replyTo);
          let steered = false;
          if (current.streaming && this.driver.steer && this.agentSessions.has(conversationId)) {
            steered = Boolean(
              await this.driver.steer(this.agentSessions.get(conversationId) ?? "", turn),
            );
          }
          if (steered) {
            this.store.appendMessage({
              conversationId,
              role: "user",
              text,
              surface: chat,
              now: this.clock.now(),
            });
            return;
          }
        }
        this.enqueue(conversationId, turn);
        return;
      }
      this.store.appendMessage({
        conversationId,
        role: "user",
        text,
        surface: chat,
        now: this.clock.now(),
      });
      this.active.set(conversationId, {
        conversationId,
        surface: chat,
        adapter,
        draft: await this.safeDraft(adapter, chat, replyTo),
        generated: "",
        replyTo,
        personId,
        phase: "running",
        streaming: false,
      });
      start = true;
    });
    if (start) this.launch(conversationId, { text, source: { chat, from } });
  }

  private enqueue(conversationId: string, turn: UserTurn): void {
    const follow = this.followups.get(conversationId) ?? [];
    follow.push(turn);
    this.followups.set(conversationId, follow);
  }

  private launch(conversationId: string, input: UserTurn): void {
    const running = this.runTurn(conversationId, input).catch((err: unknown) => {
      this.logger.error("turn crashed", { conversationId, err: String(err) });
    });
    this.turns.set(conversationId, running);
    void running.finally(() => {
      if (this.turns.get(conversationId) === running) this.turns.delete(conversationId);
    });
  }

  async waitForIdle(conversationId?: string): Promise<void> {
    if (conversationId) {
      await this.turns.get(conversationId);
      return;
    }
    await Promise.all([...this.turns.values()]);
  }

  private async switchSurface(turn: ActiveTurn, nextAdapter: Adapter, nextChat: ChatRef, replyTo?: MsgRef): Promise<void> {
    const dest = nextChat.platform;
    const note = `→ continued in ${dest}`;
    try {
      await turn.draft.abort(note);
    } catch {
      // ignore
    }
    const replay = turn.generated;
    turn.adapter = nextAdapter;
    turn.surface = nextChat;
    turn.replyTo = replyTo;
    turn.switchNote = note;
    turn.draft = await this.safeDraft(nextAdapter, nextChat, replyTo);
    if (replay) turn.draft.append(replay);
    await this.rerenderApprovals(turn.conversationId, nextAdapter, nextChat);
  }

  private async runTurn(conversationId: string, input: UserTurn): Promise<void> {
    const turn = this.active.get(conversationId);
    if (!turn) return;
    turn.phase = "running";
    turn.streaming = false;
    try {
      await turn.adapter.typing(turn.surface).catch(() => undefined);
      const snap = this.store.snapshot(conversationId, { maxMessages: this.logWindow });
      const ensured = await this.driver.ensureSession(snap);
      this.agentSessions.set(conversationId, ensured.agentSessionId);
      const sink = this.makeSink(turn);
      turn.streaming = true;
      const result = await this.driver.prompt(ensured.agentSessionId, input, sink);
      turn.streaming = false;
      if (turn.stopped) {
        try {
          await turn.draft.abort("stopped");
        } catch {
          // ignore
        }
      } else {
        turn.phase = "finalizing";
        const finalText = turn.generated || result.text;
        const refs = await turn.draft.finalize({
          blocks: [{ kind: "markdown", text: finalText || "…" }],
        });
        const msg = this.store.appendMessage({
          conversationId,
          role: "assistant",
          text: finalText,
          surface: turn.surface,
          now: this.clock.now(),
        });
        for (const ref of refs) this.store.addDelivery(msg.id, ref.chat, ref.messageId);
      }
    } catch (err) {
      turn.streaming = false;
      if (!turn.stopped) {
        this.logger.error("turn failed", { conversationId, err: String(err) });
        try {
          await turn.draft.abort(err instanceof Error ? err.message : "turn failed");
        } catch {
          // ignore
        }
      }
    }

    let queued: UserTurn[] = [];
    let handoffAdapter: Adapter | undefined;
    await this.lane(conversationId, async () => {
      queued = this.followups.get(conversationId) ?? [];
      this.followups.delete(conversationId);
      if (queued.length === 0) {
        this.active.delete(conversationId);
        return;
      }
      const live = this.active.get(conversationId) ?? turn;
      live.phase = "handoff";
      live.streaming = false;
      const adapter = this.adapterFor(queued[queued.length - 1]!.source.chat) ?? live.adapter;
      live.adapter = adapter;
      live.surface = queued[queued.length - 1]!.source.chat;
      live.generated = "";
      live.replyTo = undefined;
      this.active.set(conversationId, live);
      handoffAdapter = adapter;
    });
    if (queued.length > 0 && handoffAdapter) {
      const live = this.active.get(conversationId);
      if (!live) return;
      const next: UserTurn = {
        text: queued.map((q) => q.text).join("\n"),
        source: queued[queued.length - 1]!.source,
      };
      try {
        live.draft = await this.safeDraft(handoffAdapter, next.source.chat);
        for (const q of queued) {
          this.store.appendMessage({
            conversationId,
            role: "user",
            text: q.text,
            surface: q.source.chat,
            now: this.clock.now(),
          });
        }
        live.phase = "running";
        live.streaming = false;
        await this.runTurn(conversationId, next);
      } catch (err) {
        this.logger.error("handoff draft failed", { conversationId, err: String(err) });
        await this.lane(conversationId, async () => {
          const rest = this.followups.get(conversationId) ?? [];
          this.followups.set(conversationId, [...queued, ...rest]);
          this.active.delete(conversationId);
        });
        await this.flushFollowups(conversationId);
      }
    }
  }

  private async safeDraft(adapter: Adapter, chat: ChatRef, replyTo?: MsgRef): Promise<DraftHandle> {
    let last: unknown;
    for (let i = 0; i < 3; i += 1) {
      try {
        return await adapter.draft(chat, replyTo ? { replyTo } : undefined);
      } catch (err) {
        last = err;
        this.logger.warn("draft failed, retrying", { err: String(err), attempt: i + 1 });
      }
    }
    throw last instanceof Error ? last : new Error(String(last ?? "draft failed"));
  }

  private async flushFollowups(conversationId: string): Promise<void> {
    let start = false;
    let input: UserTurn | undefined;
    await this.lane(conversationId, async () => {
      if (this.active.has(conversationId)) return;
      const queued = this.followups.get(conversationId) ?? [];
      if (queued.length === 0) return;
      this.followups.delete(conversationId);
      for (const q of queued) {
        this.store.appendMessage({
          conversationId,
          role: "user",
          text: q.text,
          surface: q.source.chat,
          now: this.clock.now(),
        });
      }
      const first = queued[0]!;
      const adapter = this.adapterFor(first.source.chat);
      if (!adapter) {
        this.followups.set(conversationId, queued);
        return;
      }
      try {
        const draft = await this.safeDraft(adapter, first.source.chat);
        this.active.set(conversationId, {
          conversationId,
          surface: first.source.chat,
          adapter,
          draft,
          generated: "",
          personId: this.store.conversationMeta(conversationId)?.personId,
          phase: "running",
          streaming: false,
        });
        input = {
          text: queued.map((q) => q.text).join("\n"),
          source: queued[queued.length - 1]!.source,
        };
        start = true;
      } catch (err) {
        this.logger.error("flush draft failed", { conversationId, err: String(err) });
        this.followups.set(conversationId, queued);
      }
    });
    if (start && input) this.launch(conversationId, input);
  }

  private makeSink(turn: ActiveTurn): TurnSink {
    return {
      text: (delta) => {
        const live = this.active.get(turn.conversationId) ?? turn;
        live.generated += delta;
        live.draft.append(delta);
      },
      status: (s) => {
        const live = this.active.get(turn.conversationId) ?? turn;
        live.draft.setStatus(s);
      },
      requestApproval: async (req) => {
        const live = this.active.get(turn.conversationId) ?? turn;
        const approval = this.store.createApproval(
          live.conversationId,
          req.toolCallId,
          req.title,
          req.options,
          live.personId,
          this.clock.now(),
          { expiresAt: this.clock.now() + this.approvalTimeoutMs, source: "pi" },
        );
        await this.renderApproval(approval, live.adapter, live.surface);
        return this.waitForApproval(approval.id);
      },
    };
  }

  private waitForApproval(id: string): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (decision: ApprovalDecision) => {
        if (settled) return;
        settled = true;
        this.approvalWaiters.delete(id);
        resolve(decision);
      };
      this.approvalWaiters.set(id, {
        resolve: finish,
        abort: () => {
          const decided = this.store.decideApproval(id, "denied", "cancelled", this.clock.now(), "deny");
          if (decided) {
            this.syncA2hFromApproval(decided);
            void this.updateApprovalCards(decided, "denied");
          }
          finish("deny");
        },
      });
      // Expiry lives in the DB (`expires_at`); this timer only nudges the
      // sweeper so the waiter wakes promptly instead of on the next tick.
      void this.clock.sleep(this.approvalTimeoutMs).then(() => {
        if (settled) return;
        this.sweepExpired();
        if (settled) return;
        const decided = this.store.decideApproval(id, "denied", "timeout", this.clock.now(), "deny");
        if (decided) void this.updateApprovalCards(decided, "denied");
        finish("deny");
      });
    });
  }

  private async handleStop(adapter: Adapter, chat: ChatRef, conversationId: string): Promise<void> {
    const turn = this.active.get(conversationId);
    if (turn) {
      turn.stopped = true;
      turn.streaming = false;
    }
    const dropped = this.followups.get(conversationId)?.length ?? 0;
    this.followups.delete(conversationId);
    const session = this.agentSessions.get(conversationId);
    if (session) await this.driver.cancel(session).catch(() => undefined);
    for (const [id, waiter] of [...this.approvalWaiters.entries()]) {
      const approval = this.store.getApproval(id);
      if (approval?.conversationId !== conversationId) continue;
      waiter.abort();
    }
    if (turn) {
      try {
        await turn.draft.abort("stopped");
      } catch {
        // ignore
      }
    }
    const extra =
      dropped > 0 ? ` Dropped ${dropped} queued message${dropped === 1 ? "" : "s"}.` : "";
    await adapter.send(chat, { blocks: [{ kind: "markdown", text: `Stopped.${extra}` }] });
  }

  private async renderApproval(approval: PendingApproval, adapter: Adapter, chat: ChatRef): Promise<MsgRef[]> {
    const buttons = (approval.options.length > 0 ? approval.options : ["approve", "deny"]).map((opt) => ({
      id: opt,
      label: opt === "deny" ? "Deny" : opt === "approve" ? "Approve" : opt,
      style: opt === "deny" || isDenyLike(opt) ? ("danger" as const) : ("primary" as const),
      value: approval.id,
    }));
    const refs = await adapter.send(chat, {
      blocks: [
        { kind: "markdown", text: approval.title },
        { kind: "buttons", buttons },
      ],
    });
    const fresh = this.store.getApproval(approval.id) ?? approval;
    const cards = [...fresh.cards, ...refs.map((r) => ({ chat: r.chat, messageId: r.messageId }))];
    this.store.setApprovalCards(approval.id, cards);
    return refs;
  }

  private async rerenderApprovals(conversationId: string, adapter: Adapter, chat: ChatRef): Promise<void> {
    for (const approval of this.store.pendingApprovals(conversationId)) {
      await this.renderApproval(approval, adapter, chat);
    }
  }

  private canDecide(approval: PendingApproval, from: UserRef): boolean {
    const ident = this.store.findIdentity(from.platform, from.accountId, from.userId);
    if (!ident) return false;
    // a2h: only the person who was asked may decide.
    if (approval.targetPersonId) return ident.personId === approval.targetPersonId;
    const conv = this.store.conversationMeta(approval.conversationId);
    if (!conv) return false;
    if (conv.personId) return ident.personId === conv.personId;
    if (approval.requestedBy) return ident.personId === approval.requestedBy;
    return true;
  }

  private interpretAction(approval: PendingApproval, actionId: string): { option: ApprovalDecision; approved: boolean } {
    const options = approval.options.length > 0 ? approval.options : ["approve", "deny"];
    if (!options.includes(actionId)) return { option: "deny", approved: false };
    if (isDenyOption(actionId)) return { option: actionId, approved: false };
    return { option: actionId, approved: isExplicitApprove(actionId) };
  }

  private async handleAction(from: UserRef, actionId: string, value?: string, target?: MsgRef, quote?: string): Promise<void> {
    if (value && actionId.startsWith("a2h:")) {
      const req = this.store.getA2hRequest(value);
      if (req?.kind === "ask") {
        await this.handleAskChoice(req, from, actionId, target);
        return;
      }
    }
    const approvalId = value && this.store.getApproval(value) ? value : actionId;
    const approval = this.store.getApproval(approvalId);
    if (!approval || approval.state !== "pending") return;
    if (!this.canDecide(approval, from)) {
      if (approval.targetPersonId) {
        this.store.audit({
          at: this.clock.now(),
          action: "click",
          result: "forbidden_click",
          personId: this.store.findIdentity(from.platform, from.accountId, from.userId)?.personId,
          requestId: this.store.a2hRequestByApproval(approval.id)?.id,
          detail: { approvalId: approval.id, from: identityKey(from.platform, from.accountId, from.userId) },
        });
      }
      return;
    }
    if (approval.expiresAt !== undefined && approval.expiresAt <= this.clock.now()) {
      // Past TTL but not yet swept: fail closed, never honour a late click.
      this.sweepExpired();
      return;
    }
    const { option, approved } = this.interpretAction(approval, actionId);
    let decidedLevel: string | undefined;
    if (approval.targetPersonId) {
      if (target && target.chat.kind !== "dm") {
        // a2h cards are DM-only; a click in a group never decides (deny included).
        this.store.audit({
          at: this.clock.now(),
          action: "click",
          result: "group_click",
          personId: this.store.findIdentity(from.platform, from.accountId, from.userId)?.personId,
          requestId: this.store.a2hRequestByApproval(approval.id)?.id,
        });
        return;
      }
      if (approved) {
        // Denying never needs a second factor: it can only make the outcome safer.
        const verdict = await this.verifyApproverClick(approval, from, target?.chat);
        if (!verdict.ok) {
          if (verdict.reason === "step_up_required") await this.promptStepUp(approval, target?.chat);
          else if (target) await this.explainRefusal(target.chat, verdict.reason);
          return;
        }
        decidedLevel = verdict.level;
      } else {
        decidedLevel = "im_account";
      }
    }
    const state = approved ? "approved" : "denied";
    const decided = this.store.decideApproval(
      approval.id,
      state,
      identityKey(from.platform, from.accountId, from.userId),
      this.clock.now(),
      option,
      decidedLevel,
    );
    if (!decided) return;
    if (approval.targetPersonId) {
      const req = this.store.a2hRequestByApproval(approval.id);
      if (req) this.store.consumeStepUp(req.id, this.clock.now());
    }
    this.syncA2hFromApproval(decided, {
      quote: quote ?? `[按钮] ${approved ? "批准" : "拒绝"}`,
      channel: target?.chat ? `${target.chat.platform}:${target.chat.kind}` : from.platform,
    });
    this.approvalWaiters.get(approval.id)?.resolve(option);
    this.approvalWaiters.delete(approval.id);
    await this.updateApprovalCards(decided, state);
  }

  private async updateApprovalCards(approval: PendingApproval, state: string, label?: string): Promise<void> {
    const handled = `${approval.title}\n\n_${label ?? `handled (${state})`}_`;
    for (const card of approval.cards) {
      const dest = this.adapterFor(card.chat);
      if (!dest) continue;
      try {
        await dest.edit(card, { blocks: [{ kind: "markdown", text: handled }] });
      } catch {
        await dest.send(card.chat, { blocks: [{ kind: "markdown", text: handled }] }).catch(() => undefined);
      }
    }
  }

  // ---- a2h identity: TOTP step-up, /claim, /pair+TOTP (PR 2.5) -------------

  /**
   * Session-layer half of `imwire owner init` (CLI lands in PR 3): create the
   * owner person, enrol TOTP + recovery codes and mint a one-time claim code
   * (10 min). Returns the only clear copies; nothing secret is logged.
   */
  initOwner(opts: { name: string; account?: string; claimTtlMs?: number }): TotpEnrollment & {
    personId: string;
    claimCode: string;
  } {
    const v = this.totpVerifier();
    const now = this.clock.now();
    const person = this.store.createPerson(opts.name, now);
    this.store.defaultConversation(person.id, now);
    const enrollment = v.enroll(person.id, opts.account ?? opts.name, now);
    const claimCode = pairCode();
    this.store.createOwnerClaim(person.id, claimCode, now, opts.claimTtlMs ?? 10 * 60 * 1000);
    this.store.audit({ at: now, action: "owner_init", result: "ok", personId: person.id });
    return { ...enrollment, personId: person.id, claimCode };
  }

  /** `imwire owner enroll-totp` for an existing (legacy) owner. */
  enrollTotp(personId: string, account?: string): TotpEnrollment {
    const v = this.totpVerifier();
    if (!this.store.getPerson(personId)) throw new A2hError("unknown_person", "no such person");
    const out = v.enroll(personId, account ?? this.store.getPerson(personId)?.name ?? personId, this.clock.now());
    this.store.audit({ at: this.clock.now(), action: "enroll_totp", result: "ok", personId });
    return out;
  }

  private totpVerifier(): TotpVerifier {
    if (!isTotpVerifier(this.verifier)) throw new A2hError("invalid", "TOTP is not configured on this hub");
    return this.verifier;
  }

  private isAllowlistedSender(from: UserRef): boolean {
    return this.allowlist.some(
      (e) => e.platform === from.platform && e.accountId === from.accountId && e.userId === from.userId,
    );
  }

  private async handleUnpairedTotp(adapter: Adapter, chat: ChatRef, from: UserRef, text: string): Promise<void> {
    const say = (t: string) => adapter.send(chat, { blocks: [{ kind: "markdown", text: t }] });
    const now = this.clock.now();
    const sender = identityKey(from.platform, from.accountId, from.userId);
    // Allowlist is the gate: unknown IDs cannot even attempt /claim or /pair.
    if (!this.isAllowlistedSender(from) || chat.kind !== "dm") {
      await say(this.unpairedText);
      return;
    }
    const v = this.totpVerifier();
    const claim = /^\/claim\s+(\d{8})\s+(\d{6})\s*$/.exec(text.trim());
    const pair = /^(\d{8})(?:\s+(\d{6}))?\s*$/.exec(text.trim());
    if (claim) {
      const personId = this.store.liveOwnerClaim(claim[1]!, now);
      if (!personId || this.store.pairLocked(sender, now)) {
        this.store.recordPairAttempt(sender, now, false);
        await say("首绑码无效或已过期。请在 Mac mini 上重新运行 imwire owner init。");
        return;
      }
      const check = v.checkCode(personId, claim[2]!, now);
      if (!check.ok) {
        this.store.audit({ at: now, action: "claim", result: `totp_${check.reason}`, personId });
        await say(totpFailureText(check.reason));
        return;
      }
      if (!this.store.consumeOwnerClaim(claim[1]!, now)) {
        await say("首绑码已经用过。");
        return;
      }
      this.store.linkIdentity(personId, from.platform, from.accountId, from.userId, now, "claim");
      this.store.touchPresence(personId, chat, now);
      this.store.audit({ at: now, action: "claim", result: "linked", personId, detail: { surface: from.platform } });
      await say("已认领。你是主人。要绑定其他 IM，在这里发 /pair，再到新 IM 上发「配对码 验证码」。");
      return;
    }
    if (pair) {
      const personId = this.store.livePairPerson(pair[1]!, now);
      if (!personId || this.store.pairLocked(sender, now)) {
        this.store.recordPairAttempt(sender, now, false);
        await say(this.unpairedText);
        return;
      }
      if (!pair[2]) {
        await say("还需要验证码：请发送「配对码 6位验证码」，例如 12345678 123456。");
        return;
      }
      const check = v.checkCode(personId, pair[2], now);
      if (!check.ok) {
        this.store.recordPairAttempt(sender, now, false);
        this.store.audit({ at: now, action: "pair", result: `totp_${check.reason}`, personId });
        if (check.nowLocked) await this.lockoutPerson(personId);
        await say(totpFailureText(check.reason));
        return;
      }
      const consumed = this.store.consumePairCode(pair[1]!, now);
      if (consumed !== personId || !this.store.linkIdentity(personId, from.platform, from.accountId, from.userId, now, "pair+totp")) {
        await say(this.unpairedText);
        return;
      }
      this.store.recordPairAttempt(sender, now, true);
      this.store.touchPresence(personId, chat, now);
      this.store.audit({ at: now, action: "pair", result: "linked", personId, detail: { surface: from.platform } });
      await say("已绑定。这个 IM 有 24 小时冷静期，期间不能用来批准需要验证码的审批。");
      await this.notifyAllSurfaces(
        personId,
        `新增绑定：${from.platform} ${from.userId}，时间 ${formatLocal(now)}。不是你操作的话，请在 Mac mini 上执行 imwire owner reset。`,
        chat,
      );
      return;
    }
    await say("请先在 Mac mini 上运行 imwire owner init，然后在这里发送 /claim <首绑码> <6位验证码>。");
  }

  private async notifyAllSurfaces(personId: string, text: string, except?: ChatRef): Promise<void> {
    const seen = new Set<string>();
    const targets: ChatRef[] = [];
    const add = (c?: ChatRef) => {
      if (!c || c.kind !== "dm") return;
      const k = `${c.platform}:${c.accountId}:${c.chatId}`;
      if (seen.has(k) || (except && sameSurface(c, except))) return;
      seen.add(k);
      targets.push(c);
    };
    add(this.store.lastSurface(personId));
    for (const i of this.store.listIdentities(personId)) {
      if (except && i.platform === except.platform && i.accountId === except.accountId && i.userId === except.chatId) continue;
      add({ platform: i.platform, accountId: i.accountId, chatId: i.userId, kind: "dm" });
    }
    for (const c of targets) {
      await this.adapterFor(c)?.send(c, { blocks: [{ kind: "markdown", text }] }).catch(() => undefined);
    }
  }

  private awaitingStepUp(personId: string): A2hRequest[] {
    return this.store
      .openA2hRequests(personId, "approval")
      .filter((r) => this.store.stepUpRequested(r.id));
  }

  private async promptStepUp(approval: PendingApproval, chat: ChatRef | undefined): Promise<void> {
    const req = this.store.a2hRequestByApproval(approval.id);
    if (!req) return;
    this.store.markStepUpRequested(req.id, this.clock.now());
    const surface = chat ?? this.store.lastSurface(req.personId);
    const adapter = surface ? this.adapterFor(surface) : undefined;
    if (!adapter || !surface) return;
    const code = shortCode(req.id);
    const refs = await adapter
      .send(surface, {
        blocks: [
          {
            kind: "markdown",
            text: `需要验证码才能批准（编号 ${code}）。请回复 /approve ${code} <6位验证码>，或直接引用这条消息回复 6 位数字。验证码只在本机校验，不会转给 agent。`,
          },
        ],
      })
      .catch(() => []);
    // Quote-replies to the prompt route like quote-replies to the card.
    const promptMsg = this.store.a2hPromptMessageId(req.id);
    if (promptMsg) for (const ref of refs) this.store.addDelivery(promptMsg, ref.chat, ref.messageId);
  }

  private async explainRefusal(chat: ChatRef, reason: string | undefined): Promise<void> {
    const text =
      reason === "cooling_off"
        ? "这个 IM 刚绑定，还在 24 小时冷静期内，不能批准这类审批。请在已绑定更久的 IM 上操作。"
        : reason === "locked"
          ? "验证码错误次数过多，已锁定 15 分钟。"
          : undefined;
    if (!text) return;
    await this.adapterFor(chat)?.send(chat, { blocks: [{ kind: "markdown", text }] }).catch(() => undefined);
  }

  private async handleApproveCommand(
    adapter: Adapter,
    chat: ChatRef,
    from: UserRef,
    personId: string,
    args: string,
  ): Promise<void> {
    const m = /^\s*(\S+)\s+(\d{6})\s*$/.exec(args ?? "");
    if (!m) {
      await this.a2hReply(adapter, chat, "用法：/approve <编号> <6位验证码>");
      return;
    }
    const code = m[1]!.toLowerCase();
    const matches = this.store.openA2hRequests(personId, "approval").filter((r) => shortCode(r.id) === code);
    if (matches.length !== 1) {
      await this.a2hReply(adapter, chat, `没有找到编号为 ${code} 的待审批请求。`);
      return;
    }
    await this.submitStepUp(adapter, chat, from, personId, matches[0]!, m[2]!);
  }

  /**
   * Second factor for one approval. Order: DM only → TOTP configured →
   * surface not cooling off → code (lockout, replay) → bind the step-up to
   * this request → run the normal click path, which re-verifies.
   */
  private async submitStepUp(
    adapter: Adapter,
    chat: ChatRef,
    from: UserRef,
    personId: string,
    req: A2hRequest,
    code: string,
  ): Promise<void> {
    const now = this.clock.now();
    const audit = (result: string) =>
      this.store.audit({ at: now, action: "step_up", result, agentId: req.agentId, personId, requestId: req.id });
    if (chat.kind !== "dm") return;
    if (!isTotpVerifier(this.verifier)) {
      audit("not_configured");
      await this.a2hReply(adapter, chat, "这个 hub 没有启用验证码。");
      return;
    }
    if (req.kind !== "approval" || req.state !== "pending" || req.personId !== personId || !req.approvalId) {
      await this.a2hReply(adapter, chat, `编号 ${shortCode(req.id)} 的审批已经结束。`);
      return;
    }
    const ident = this.store.findIdentity(from.platform, from.accountId, from.userId);
    if (!ident || ident.personId !== personId) return;
    if (this.verifier.inCooldown(ident, now)) {
      audit("cooling_off");
      await this.explainRefusal(chat, "cooling_off");
      return;
    }
    const check = this.verifier.checkCode(personId, code, now);
    if (!check.ok) {
      audit(`totp_${check.reason}`);
      if (check.nowLocked || check.reason === "locked") await this.lockoutPerson(personId);
      else await this.a2hReply(adapter, chat, totpFailureText(check.reason));
      return;
    }
    this.store.recordStepUp(req.id, personId, "totp", chat, now);
    audit("ok");
    await this.handleAction(from, "approve", req.approvalId, { chat, messageId: "" }, `/approve ${shortCode(req.id)} ******（已验证 TOTP）`);
  }

  /** 5 failures / 15 min: deny every pending targeted approval and tell every surface. */
  private async lockoutPerson(personId: string): Promise<void> {
    const now = this.clock.now();
    for (const a of this.store.pendingApprovals()) {
      if (a.targetPersonId !== personId) continue;
      const decided = this.store.decideApproval(a.id, "denied", "locked", now, "deny", "none");
      if (!decided) continue;
      this.syncA2hFromApproval(decided);
      await this.updateApprovalCards(decided, "denied");
    }
    this.store.audit({ at: now, action: "lockout", result: "locked", personId });
    await this.notifyAllSurfaces(personId, "验证码连续错误，已锁定 15 分钟，所有待审批已拒绝。不是你操作的话，请在 Mac mini 上执行 imwire owner reset。");
  }

  // ---- a2h: hub support (PR 3) ----------------------------------------------

  /** Revocation: every open request of the agent becomes cancelled (approvals deny). */
  async cancelAgentRequests(agentId: string, reason = "agent revoked"): Promise<number> {
    const open = this.store.pendingA2hRequests().filter((r) => r.agentId === agentId);
    for (const r of open) await this.cancelRequest({ agentId, requestId: r.id, reason });
    return open.length;
  }

  /** People this agent may reach (grant + target gate). No raw IM ids are returned. */
  findPeople(agentId: string, query?: string): Array<{
    personId: string;
    name?: string;
    reachableVia: string[];
    allowed: A2hScope[];
  }> {
    const agent = this.store.getAgent(agentId);
    if (!agent || agent.revokedAt !== undefined) throw new A2hError("unknown_agent", "unknown agent");
    const q = query?.trim().toLowerCase();
    return this.store
      .agentGrants(agentId)
      .filter((g) => this.isA2hTargetAllowed(g.personId))
      .map((g) => {
        const person = this.store.getPerson(g.personId);
        let via: string[] = [];
        try {
          via = [...new Set(this.a2hSurfaces(g.personId, "all").map((c) => c.platform))];
        } catch {
          via = [];
        }
        return { personId: g.personId, name: person?.name, reachableVia: via, allowed: g.scopes };
      })
      .filter((p) => !q || p.personId === query || (p.name ?? "").toLowerCase() === q);
  }

  /** Messages in the agent's own topic for a person. Human text is untrusted. */
  readAgentContext(opts: { agentId: string; to: string; sinceSeq?: number; limit?: number }): {
    conversationId: string;
    messages: Array<{ seq: number; author: string; via?: string; at: string; text: string; requestId: string | null; untrusted: true }>;
  } {
    const { agent, personId } = this.a2hAuthorize(opts.agentId, opts.to, "read");
    const conv = this.agentTopic(agent, personId);
    const limit = Math.max(1, Math.min(opts.limit ?? 30, 50));
    const msgs = this.store
      .snapshot(conv.id)
      .messages.filter((m) => m.seq > (opts.sinceSeq ?? 0))
      .slice(-limit);
    return {
      conversationId: conv.id,
      messages: msgs.map((m) => ({
        seq: m.seq,
        author: m.author ?? (m.role === "user" ? "human" : "assistant"),
        via: m.surface?.platform,
        at: isoLocal(m.createdAt),
        text: m.text,
        requestId: m.requestId ?? null,
        untrusted: true as const,
      })),
    };
  }

  // ---- a2h: agent-facing API (PR 2) ---------------------------------------

  /** Send a one-way message from an agent into its `agent:<name>` topic. */
  async sendToPerson(opts: {
    agentId: string;
    to: string;
    text: string;
    route?: A2hRoute;
    idempotencyKey?: string;
  }): Promise<A2hView & { messageId?: string; delivered: Array<{ platform: string; ok: boolean }> }> {
    const { agent, personId } = this.a2hAuthorize(opts.agentId, opts.to, "send");
    const body = sanitizeAgentText(opts.text);
    const now = this.clock.now();
    const conv = this.agentTopic(agent, personId);
    const { request, replayed } = this.store.createA2hRequest({
      agentId: agent.id,
      personId,
      conversationId: conv.id,
      kind: "message",
      payload: { text: body, code: "", quiet: isQuietTime(now, this.quietHours) },
      expiresAt: now,
      now,
      idempotencyKey: opts.idempotencyKey,
    });
    if (replayed) return { ...this.a2hView(request), delivered: [] };
    const surfaces = this.a2hSurfaces(personId, opts.route);
    const rendered = `${frameHeader(agent.name)}\n\n${body}`;
    const msg = this.store.appendMessage({
      conversationId: conv.id,
      role: "assistant",
      text: body,
      surface: surfaces[0],
      now,
      author: `agent:${safeAgentName(agent.name)}`,
      requestId: request.id,
    });
    this.store.setA2hPromptMessage(request.id, msg.id);
    const delivered = await this.a2hDeliver(msg.id, surfaces, { blocks: [{ kind: "markdown", text: rendered }] });
    const ok = delivered.some((d) => d.ok);
    this.store.decideA2hRequest(request.id, ok ? "delivered" : "failed", ok ? "hub" : "failed", this.clock.now());
    this.store.audit({
      at: now,
      action: "send",
      result: ok ? "delivered" : "failed",
      agentId: agent.id,
      personId,
      requestId: request.id,
    });
    this.notifyA2h(request.id);
    return { ...this.a2hView(this.store.getA2hRequest(request.id)!), messageId: msg.id, delivered };
  }

  /**
   * Approval card from an agent. Only the asked person's button click counts;
   * expiry, cancel, failure and unknown buttons all deny (fail-closed).
   */
  async createAgentApproval(opts: {
    agentId: string;
    to: string;
    title: string;
    details?: string;
    risk?: "low" | "medium" | "high" | "critical";
    /** critical only: the exact object being approved (plain JSON) … */
    action?: unknown;
    /** … or a digest of it (git SHA, file sha256). Exactly one is required for critical. */
    actionDigest?: string;
    /** v0 Decision.grant. Default once (pre-v0 behaviour); the hub RPC requires it. */
    grant?: GrantSpec;
    /** v0 Request.object */
    object?: { ref: string; digest?: string };
    /** v0 Request.state_version: the object's version the agent saw. */
    stateVersion?: string;
    /** v0 Decision.scope.action: what will be done (verb), e.g. "deploy". */
    actionName?: string;
    /** v0 Request.options[].consequence for the two buttons. */
    consequences?: { approve?: string; deny?: string };
    expiresInS?: number;
    route?: A2hRoute;
    idempotencyKey?: string;
  }): Promise<A2hView> {
    const { agent, personId } = this.a2hAuthorize(opts.agentId, opts.to, "approve");
    const title = sanitizeAgentLine(opts.title);
    if (!title) throw new A2hError("invalid", "title is required");
    const details = opts.details ? sanitizeAgentText(opts.details) : "";
    const risk = opts.risk && ["low", "medium", "high", "critical"].includes(opts.risk) ? opts.risk : undefined;
    const meta = this.requestMeta(opts, risk === "critical");
    let bindingHash: string | undefined;
    if (risk === "critical") {
      if (!isTotpVerifier(this.verifier)) throw new A2hError("totp_required", "critical approvals need TOTP on this hub");
      if (!this.store.totpCredential(personId)) throw new A2hError("totp_required", "target has no TOTP enrolled");
      bindingHash = actionBindingHash({ action: opts.action, digest: opts.actionDigest });
    } else if (opts.action !== undefined || opts.actionDigest !== undefined) {
      throw new A2hError("invalid", "action binding is only for risk: critical");
    }
    const ttlS = clampTtlS(opts.expiresInS, A2H_APPROVAL_DEFAULT_S);
    const now = this.clock.now();
    const expiresAt = now + ttlS * 1000;
    const conv = this.agentTopic(agent, personId);
    const { request, replayed } = this.store.createA2hRequest({
      agentId: agent.id,
      personId,
      conversationId: conv.id,
      kind: "approval",
      payload: { title, details, risk, quiet: isQuietTime(now, this.quietHours) },
      expiresAt,
      now,
      idempotencyKey: opts.idempotencyKey,
    });
    if (opts.grant === undefined) warnDefaultGrant(request.id, agent.name, agent.id);
    if (replayed) {
      // Same idempotency key must not re-bind a different object.
      const prior = this.store.a2hActionState(request.id);
      if ((prior?.actionHash ?? undefined) !== bindingHash) {
        throw new A2hError("conflict", "idempotency_key reused with a different action");
      }
      return this.a2hView(request);
    }
    const code = shortCode(request.id);
    // Pinned now: later policy changes never affect cards already sent. critical is never downgraded.
    const requiredLevel: AssuranceLevel =
      risk === "critical"
        ? "verified"
        : (this.verifier.requiredLevelFor?.({ agentId: agent.id, risk }) ?? this.verifier.requiredLevel ?? "im_account");
    const riskLabel = risk ? { low: "低风险", medium: "中风险", high: "⚠️ 高风险", critical: "⛔ 关键操作" }[risk] : undefined;
    const preview =
      risk === "critical" && opts.action !== undefined ? sanitizeAgentText(canonicalJson(opts.action), 600) : undefined;
    const approvalOptions = [
      {
        id: "approve",
        label: "批准",
        consequence: opts.consequences?.approve
          ? sanitizeAgentLine(opts.consequences.approve, A2H_CONSEQUENCE_MAX)
          : meta.action
            ? `agent 执行 ${meta.action}`
            : "agent 继续执行",
      },
      {
        id: "deny",
        label: "拒绝",
        consequence: opts.consequences?.deny ? sanitizeAgentLine(opts.consequences.deny, A2H_CONSEQUENCE_MAX) : "agent 不执行",
      },
    ];
    const card = [
      frameHeader(agent.name),
      "",
      `审批请求：${title}`,
      ...(meta.objectRef ? [`对象：${meta.objectRef}${meta.stateVersion ? `（版本 ${meta.stateVersion}）` : ""}`] : []),
      ...(opts.consequences ? [`批准 → ${approvalOptions[0]!.consequence}；拒绝 → ${approvalOptions[1]!.consequence}`] : []),
      ...(details ? ["", details] : []),
      ...(bindingHash
        ? ["", `绑定对象：${preview ? `\n${preview}\n` : ""}${bindingHash.slice(0, 19)}…（执行前会核对，对象变了就作废）`]
        : []),
      "",
      `— 编号 ${code}${riskLabel ? ` · ${riskLabel}` : ""} · 有效至 ${formatLocal(expiresAt)}`,
      "— 只有点按钮才算数；文字回复不算批准。超时视为拒绝。",
    ].join("\n");
    const approval = this.store.createApproval(conv.id, request.id, card + stepUpFooter(requiredLevel, code), ["approve", "deny"], undefined, now, {
      targetPersonId: personId,
      expiresAt,
      source: "agent",
      requiredLevel,
    });
    this.store.setA2hRisk(request.id, risk);
    if (bindingHash) this.store.setA2hActionHash(request.id, bindingHash);
    this.store.setA2hMeta(request.id, { ...meta, options: approvalOptions });
    this.store.setA2hApprovalId(request.id, approval.id);
    const msg = this.store.appendMessage({
      conversationId: conv.id,
      role: "assistant",
      text: `审批请求：${title}${details ? `\n\n${details}` : ""}`,
      now,
      author: `agent:${safeAgentName(agent.name)}`,
      requestId: request.id,
    });
    this.store.setA2hPromptMessage(request.id, msg.id);
    let sent = 0;
    for (const surface of this.a2hSurfaces(personId, opts.route)) {
      const adapter = this.adapterFor(surface);
      if (!adapter) continue;
      try {
        const refs = await this.renderApproval(approval, adapter, surface);
        for (const ref of refs) this.store.addDelivery(msg.id, ref.chat, ref.messageId);
        sent += refs.length;
      } catch (err) {
        this.logger.warn("a2h approval render failed", { err: String(err), platform: surface.platform });
      }
    }
    if (sent === 0) {
      const failed = this.store.decideApproval(approval.id, "denied", "failed", this.clock.now(), "deny");
      if (failed) this.syncA2hFromApproval(failed);
    }
    this.store.audit({
      at: now,
      action: "approve",
      result: sent > 0 ? "pending" : "failed",
      agentId: agent.id,
      personId,
      requestId: request.id,
      object: risk === "critical" ? "critical_action" : "approval",
      bindingHash,
      detail: risk ? { risk } : undefined,
      idempotencyKey: opts.idempotencyKey,
      data: this.requestData(request.id, { title, reply_by: isoLocal(expiresAt), risk: risk ?? null }),
    });
    return this.a2hView(this.store.getA2hRequest(request.id)!);
  }

  /**
   * Pre-execution check for a critical approval. Passes only if the request
   * is approved with TOTP (`verified`) and the object (or digest) hashes to
   * the one bound on the card. Single use: a second call fails. Every call
   * is audited with the bound and presented hashes (never the object).
   */
  verifyApprovedAction(opts: { agentId: string; requestId: string; action?: unknown; actionDigest?: string }): {
    ok: boolean;
    reason?: "not_found" | "not_critical" | "not_approved" | "not_verified" | "mismatch" | "already_used" | "invalid";
    bindingHash?: string;
  } {
    const req = this.store.getA2hRequest(opts.requestId);
    if (!req || req.agentId !== opts.agentId) return { ok: false, reason: "not_found" };
    const st = this.store.a2hActionState(req.id)!;
    const now = this.clock.now();
    const fail = (reason: NonNullable<ReturnType<SessionGateway["verifyApprovedAction"]>["reason"]>, presented?: string) => {
      this.store.audit({
        at: now,
        action: "action_verify",
        result: `rejected:${reason}`,
        agentId: req.agentId,
        personId: req.personId,
        requestId: req.id,
        object: "critical_action",
        bindingHash: st.actionHash,
        detail: presented ? { presented_hash: presented } : undefined,
      });
      return { ok: false, reason, bindingHash: st.actionHash };
    };
    if (st.risk !== "critical" || !st.actionHash) return fail("not_critical");
    let presented: string;
    try {
      presented = actionBindingHash({ action: opts.action, digest: opts.actionDigest });
    } catch {
      return fail("invalid");
    }
    if (req.state !== "approved") return fail("not_approved", presented);
    const approval = req.approvalId ? this.store.getApproval(req.approvalId) : undefined;
    if (approval?.decidedLevel !== "verified") return fail("not_verified", presented);
    if (!timingSafeEqualStr(presented, st.actionHash)) return fail("mismatch", presented);
    if (!this.store.consumeA2hAction(req.id, now)) return fail("already_used", presented);
    this.store.audit({
      at: now,
      action: "action_verify",
      result: "ok",
      agentId: req.agentId,
      personId: req.personId,
      requestId: req.id,
      object: "critical_action",
      bindingHash: st.actionHash,
    });
    return { ok: true, bindingHash: st.actionHash };
  }

  /**
   * Tool gate: "allow" only for exact tool names the owner marked read-only
   * for this agent (via the CLI). Everything else goes to a human. Drivers
   * and agents cannot change the policy.
   */
  checkTool(agentId: string, tool: string): { decision: "allow" | "ask_human"; reason: string } {
    const agent = this.store.getAgent(agentId);
    if (!agent || agent.revokedAt !== undefined) throw new A2hError("unknown_agent", "unknown agent");
    const name = typeof tool === "string" ? tool.trim() : "";
    const cls = name ? this.store.toolClass(agentId, name) : undefined;
    const out =
      cls === "read_only"
        ? { decision: "allow" as const, reason: "read_only_allowlisted" }
        : { decision: "ask_human" as const, reason: name ? "not_allowlisted" : "invalid_tool" };
    this.store.audit({
      at: this.clock.now(),
      action: "tool_check",
      result: out.decision,
      agentId,
      object: `tool:${sanitizeAgentLine(name, 80)}`,
      detail: { reason: out.reason },
    });
    return out;
  }

  /** Ask a question. Replies are untrusted data and never count as approval (Q2). */
  async askPerson(opts: {
    agentId: string;
    to: string;
    question: string;
    /** Plain labels, or v0 options with a consequence each. */
    choices?: Array<string | { label: string; consequence?: string }>;
    allowFreeText?: boolean;
    /** v0 Decision.grant. Default once (pre-v0 behaviour); the hub RPC requires it. */
    grant?: GrantSpec;
    /** v0 Request.object */
    object?: { ref: string; digest?: string };
    /** v0 Request.state_version: the object's version the agent saw. */
    stateVersion?: string;
    /** v0 Decision.scope.action: what will be done (verb), e.g. "deploy". */
    actionName?: string;
    expiresInS?: number;
    route?: A2hRoute;
    idempotencyKey?: string;
  }): Promise<A2hView> {
    const { agent, personId } = this.a2hAuthorize(opts.agentId, opts.to, "ask");
    const meta = this.requestMeta(opts, false);
    const question = sanitizeAgentText(opts.question);
    if (!question) throw new A2hError("invalid", "question is required");
    const rawChoices = (opts.choices ?? []).map((c) => (typeof c === "string" ? { label: c } : c));
    const choiceOpts = rawChoices
      .map((c, i) => ({
        id: `a2h:${i}`,
        label: sanitizeAgentLine(String(c.label ?? ""), A2H_CHOICE_MAX),
        consequence: c.consequence ? sanitizeAgentLine(String(c.consequence), A2H_CONSEQUENCE_MAX) : "",
      }))
      .filter((c) => c.label);
    const choices = choiceOpts.map((c) => c.label);
    if (choices.length > A2H_CHOICES_MAX) throw new A2hError("invalid", `at most ${A2H_CHOICES_MAX} choices`);
    const allowFreeText = opts.allowFreeText ?? choices.length === 0;
    if (!allowFreeText && choices.length === 0) throw new A2hError("invalid", "need choices or free text");
    const ttlS = clampTtlS(opts.expiresInS, A2H_ASK_DEFAULT_S);
    const now = this.clock.now();
    const expiresAt = now + ttlS * 1000;
    const conv = this.agentTopic(agent, personId);
    const base = { question, choices, allowFreeText, quiet: isQuietTime(now, this.quietHours) };
    const { request, replayed } = this.store.createA2hRequest({
      agentId: agent.id,
      personId,
      conversationId: conv.id,
      kind: "ask",
      payload: base,
      expiresAt,
      now,
      idempotencyKey: opts.idempotencyKey,
    });
    if (opts.grant === undefined) warnDefaultGrant(request.id, agent.name, agent.id);
    if (replayed) return this.a2hView(request);
    const code = shortCode(request.id);
    const how = allowFreeText
      ? `引用回复本消息，或发送 /answer ${code} 你的回答`
      : "点下面的选项作答";
    const askOptions = choiceOpts.map((c) => ({ ...c, consequence: c.consequence || "答案转给 agent" }));
    this.store.setA2hMeta(request.id, { ...meta, options: askOptions });
    const rendered = [
      frameHeader(agent.name),
      "",
      question,
      ...(choiceOpts.some((c) => c.consequence) ? ["", ...choiceOpts.map((c) => `· ${c.label} → ${c.consequence || "答案转给 agent"}`)] : []),
      "",
      `— 问题编号 ${code} · 有效至 ${formatLocal(expiresAt)}`,
      `— ${how}。你的回答只会转给这个 agent，不会当作批准。`,
    ].join("\n");
    this.store.db
      .prepare("UPDATE a2h_request SET payload = ? WHERE id = ?")
      .run(JSON.stringify({ ...base, code, rendered }), request.id);
    const msg = this.store.appendMessage({
      conversationId: conv.id,
      role: "assistant",
      text: question,
      now,
      author: `agent:${safeAgentName(agent.name)}`,
      requestId: request.id,
    });
    this.store.setA2hPromptMessage(request.id, msg.id);
    const blocks: OutMessage["blocks"] = [{ kind: "markdown", text: rendered }];
    if (choices.length > 0) {
      blocks.push({
        kind: "buttons",
        buttons: choices.map((label, i) => ({ id: `a2h:${i}`, label, value: request.id })),
      });
    }
    const delivered = await this.a2hDeliver(msg.id, this.a2hSurfaces(personId, opts.route), { blocks });
    if (!delivered.some((d) => d.ok)) {
      this.store.decideA2hRequest(request.id, "failed", "failed", this.clock.now());
      this.notifyA2h(request.id);
    }
    this.store.audit({
      at: now,
      action: "ask",
      result: delivered.some((d) => d.ok) ? "pending" : "failed",
      agentId: agent.id,
      personId,
      requestId: request.id,
      idempotencyKey: opts.idempotencyKey,
      data: this.requestData(request.id, { question, reply_by: isoLocal(expiresAt) }),
    });
    return this.a2hView(this.store.getA2hRequest(request.id)!);
  }

  /** Withdraw an open request. Cancelling an approval denies it. */
  async cancelRequest(opts: { agentId: string; requestId: string; reason?: string }): Promise<A2hView> {
    const req = this.store.getA2hRequest(opts.requestId);
    if (!req || req.agentId !== opts.agentId) throw new A2hError("not_found", "no such request for this agent");
    if (req.state !== "pending") return this.a2hView(req);
    if (req.kind === "approval" && req.approvalId) {
      const decided = this.store.decideApproval(req.approvalId, "denied", "cancelled", this.clock.now(), "deny");
      if (decided) {
        this.syncA2hFromApproval(decided);
        this.approvalWaiters.get(decided.id)?.resolve("deny");
        this.approvalWaiters.delete(decided.id);
        await this.updateApprovalCards(decided, "cancelled");
      }
    } else {
      const decided = this.store.decideA2hRequest(req.id, "cancelled", "cancelled", this.clock.now());
      if (decided) {
        this.notifyA2h(req.id);
        if (req.kind === "ask") await this.closeAskCards(decided, "已撤回");
      }
    }
    this.store.audit({
      at: this.clock.now(),
      action: "cancel",
      result: "cancelled",
      agentId: req.agentId,
      personId: req.personId,
      requestId: req.id,
      detail: opts.reason ? { reason: opts.reason.slice(0, 200) } : undefined,
    });
    return this.a2hView(this.store.getA2hRequest(req.id)!);
  }

  /** Current state of a request owned by this agent. */
  getAgentRequest(agentId: string, requestId: string): A2hView {
    const req = this.store.getA2hRequest(requestId);
    if (!req || req.agentId !== agentId) throw new A2hError("not_found", "no such request for this agent");
    return this.a2hView(req);
  }

  /**
   * Resolve when any of the requests is terminal or after `waitMs` (via the
   * gateway clock). `waitMs = 0` is a non-blocking poll.
   */
  async waitForRequests(agentId: string, requestIds: string[], waitMs: number): Promise<A2hView[]> {
    const views = () => requestIds.map((id) => this.getAgentRequest(agentId, id));
    const done = () => views().some((v) => v.status !== "pending");
    if (waitMs <= 0 || done()) return views();
    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        for (const id of requestIds) this.a2hListeners.get(id)?.delete(onChange);
        resolve();
      };
      const onChange = () => {
        if (done()) finish();
      };
      for (const id of requestIds) {
        let set = this.a2hListeners.get(id);
        if (!set) this.a2hListeners.set(id, (set = new Set()));
        set.add(onChange);
      }
      void this.clock.sleep(waitMs).then(finish);
    });
    return views();
  }

  /**
   * Route a human DM to an open ask (Q2: quote-reply, /answer, or a lone
   * recent ask). Returns true when consumed; otherwise the message goes to
   * the normal turn, with a hint when asks are waiting.
   */
  private async tryResolve(
    adapter: Adapter,
    chat: ChatRef,
    from: UserRef,
    personId: string,
    text: string,
    quoted?: MsgRef,
  ): Promise<boolean> {
    if (quoted) {
      const req = this.store.a2hRequestByDelivery(quoted.chat ?? chat, quoted.messageId);
      if (req && req.personId === personId) {
        if (req.state !== "pending") {
          await this.a2hReply(adapter, chat, `编号 ${shortCode(req.id)} 的请求已经结束（${req.state}），这条回复没有转给 agent。`);
          return true;
        }
        if (req.kind === "approval" && TOTP_CODE_RE.test(text.trim())) {
          await this.submitStepUp(adapter, chat, from, personId, req, text.trim());
          return true;
        }
        if (req.kind === "approval") {
          this.store.appendMessage({
            conversationId: req.conversationId,
            role: "user",
            text: redactCodes(text),
            surface: chat,
            now: this.clock.now(),
            requestId: req.id,
          });
          this.store.audit({
            at: this.clock.now(),
            action: "reply",
            result: "text_on_approval_ignored",
            agentId: req.agentId,
            personId,
            requestId: req.id,
          });
          await this.a2hReply(adapter, chat, "文字回复不算批准。要批准或拒绝，请点审批卡片上的按钮。");
          return true;
        }
        if (req.kind === "ask") {
          await this.answerAsk(adapter, req, chat, from, text, undefined);
          return true;
        }
      }
    }
    const open = this.store.openA2hRequests(personId, "ask");
    const freeText = open.filter((r) => askPayload(r).allowFreeText);
    if (freeText.length === 1 && open.length === 1) {
      const only = freeText[0]!;
      const last = this.store.lastDeliveryInChat(chat);
      if (
        last?.requestId === only.id &&
        this.clock.now() - last.createdAt <= A2H_FALLBACK_WINDOW_MS
      ) {
        await this.answerAsk(adapter, only, chat, from, text, undefined);
        return true;
      }
    }
    if (open.length > 0) {
      const codes = open.map((r) => shortCode(r.id)).join("、");
      await this.a2hReply(
        adapter,
        chat,
        `有 ${open.length} 个 agent 的问题待回答（${codes}）。这条消息按普通对话处理；要回答请引用回复那条问题，或发送 /answer <编号> 你的回答。`,
      );
    }
    return false;
  }

  private async handleAnswerCommand(
    adapter: Adapter,
    chat: ChatRef,
    from: UserRef,
    personId: string,
    args: string,
  ): Promise<void> {
    const m = /^\s*(\S+)\s*([\s\S]*)$/.exec(args ?? "");
    const code = m?.[1]?.toLowerCase();
    const answer = (m?.[2] ?? "").trim();
    if (!code || !answer) {
      await this.a2hReply(adapter, chat, "用法：/answer <编号> 你的回答");
      return;
    }
    const matches = this.store.openA2hRequests(personId, "ask").filter((r) => shortCode(r.id) === code);
    if (matches.length !== 1) {
      await this.a2hReply(adapter, chat, `没有找到编号为 ${code} 的待回答问题。`);
      return;
    }
    await this.answerAsk(adapter, matches[0]!, chat, from, answer, undefined);
  }

  private async handleAskChoice(req: A2hRequest, from: UserRef, actionId: string, target?: MsgRef): Promise<void> {
    const ident = this.store.findIdentity(from.platform, from.accountId, from.userId);
    if (!ident || ident.personId !== req.personId) {
      this.store.audit({
        at: this.clock.now(),
        action: "click",
        result: "forbidden_click",
        agentId: req.agentId,
        personId: ident?.personId,
        requestId: req.id,
        detail: { from: identityKey(from.platform, from.accountId, from.userId) },
      });
      return;
    }
    if (req.state !== "pending") return;
    if (req.expiresAt <= this.clock.now()) {
      this.sweepExpired();
      return;
    }
    const idx = Number(actionId.slice("a2h:".length));
    const choice = askPayload(req).choices[idx];
    if (choice === undefined) return; // unknown button: ignore, request stays open until expiry
    const chat = target?.chat ?? this.store.lastSurface(req.personId);
    const adapter = chat ? this.adapterFor(chat) : undefined;
    await this.answerAsk(adapter, req, chat, from, choice, choice);
  }

  private async answerAsk(
    adapter: Adapter | undefined,
    req: A2hRequest,
    chat: ChatRef | undefined,
    from: UserRef,
    text: string,
    choice: string | undefined,
  ): Promise<void> {
    const now = this.clock.now();
    if (req.expiresAt <= now) {
      this.sweepExpired();
      if (adapter && chat) await this.a2hReply(adapter, chat, `编号 ${shortCode(req.id)} 的问题已过期，回答没有转给 agent。`);
      return;
    }
    const payload = askPayload(req);
    let picked = choice;
    if (picked === undefined && payload.choices.length > 0) {
      picked = payload.choices.find((c) => c.toLowerCase() === text.trim().toLowerCase());
    }
    if (!payload.allowFreeText && picked === undefined) {
      if (adapter && chat) await this.a2hReply(adapter, chat, "这个问题只接受选项，请点消息下面的按钮。");
      return;
    }
    const answer = {
      choice: picked ?? null,
      text,
      via: chat?.platform ?? from.platform,
      at: isoLocal(now),
      untrusted: true as const,
    };
    const decided = this.store.decideA2hRequest(
      req.id,
      "answered",
      identityKey(from.platform, from.accountId, from.userId),
      now,
      answer,
    );
    if (!decided) return; // lost the race: first answer wins, no side effects
    const msg = this.store.appendMessage({
      conversationId: req.conversationId,
      role: "user",
      text,
      surface: chat,
      now,
      requestId: req.id,
    });
    this.store.setA2hAnswerMessage(req.id, msg.id);
    this.store.setA2hMeta(req.id, {
      quote: redactCodes(sanitizeAgentLine(text, 500)),
      channel: chat ? `${chat.platform}:${chat.kind}` : from.platform,
    });
    const eid = this.store.audit({
      at: now,
      action: "answer",
      result: "answered",
      agentId: req.agentId,
      personId: req.personId,
      requestId: req.id,
      source: `actor:person:${req.personId}`,
      idempotencyKey: `dec:${req.id}`,
      data: this.decisionData(req.id, { choice: picked ?? null, decided_by: `person:${req.personId}`, untrusted: true }),
    });
    this.store.setA2hDecisionEvent(req.id, eid);
    this.notifyA2h(req.id);
    await this.closeAskCards(decided, "已回答");
    const agent = this.store.getAgent(req.agentId);
    if (adapter && chat) await this.a2hReply(adapter, chat, `已转给 agent「${safeAgentName(agent?.name ?? "?")}」。`);
  }

  private async closeAskCards(req: A2hRequest, label: string): Promise<void> {
    const promptId = this.store.a2hPromptMessageId(req.id);
    if (!promptId) return;
    const rendered = (askPayload(req).rendered ?? "").trim();
    const text = `${rendered}\n\n_${label}_`.trim();
    for (const ref of this.store.deliveriesFor(promptId)) {
      const dest = this.adapterFor(ref.chat);
      await dest?.edit(ref, { blocks: [{ kind: "markdown", text }] }).catch(() => undefined);
    }
  }

  private async a2hReply(adapter: Adapter, chat: ChatRef, text: string): Promise<void> {
    await adapter.send(chat, { blocks: [{ kind: "markdown", text }] }).catch(() => undefined);
  }

  private a2hAuthorize(agentId: string, to: string, scope: A2hScope): { agent: AgentRecord; personId: string } {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new A2hError("unknown_agent", "unknown agent");
    if (agent.revokedAt !== undefined) throw new A2hError("revoked", "agent token revoked");
    let personId: string;
    if (this.store.getPerson(to)) {
      personId = to;
    } else {
      const byName = this.store.personsByName(to);
      if (byName.length === 0) throw new A2hError("unknown_person", "no such person");
      if (byName.length > 1) throw new A2hError("ambiguous_person", "name matches more than one person");
      personId = byName[0]!.id;
    }
    if (!this.isA2hTargetAllowed(personId) || !this.store.agentScopes(agent.id, personId).includes(scope)) {
      this.store.audit({ at: this.clock.now(), action: scope, result: "forbidden", agentId: agent.id, personId });
      throw new A2hError("forbidden", `agent may not ${scope} this person`);
    }
    return { agent, personId };
  }

  private agentTopic(agent: AgentRecord, personId: string) {
    return this.store.agentConversation(personId, agent.id, agentTopicTitle(agent.name), this.clock.now());
  }

  /** v1: DMs only, only adapters that can send proactively. Last active surface first. */
  private a2hSurfaces(personId: string, route: A2hRoute = "last_active"): ChatRef[] {
    const out: ChatRef[] = [];
    const seen = new Set<string>();
    const add = (c: ChatRef | undefined) => {
      if (!c || c.kind !== "dm") return;
      const adapter = this.adapterFor(c);
      if (!adapter || adapter.capabilities.proactiveSend === false) return;
      const k = `${c.platform}:${c.accountId}`;
      if (seen.has(k)) return; // one DM per bot account
      seen.add(k);
      out.push(c);
    };
    add(this.store.lastSurface(personId));
    for (const ident of this.store.listIdentities(personId)) {
      add({ platform: ident.platform, accountId: ident.accountId, chatId: ident.userId, kind: "dm" });
    }
    const picked =
      route === "all" ? out : route === "last_active" ? out.slice(0, 1) : out.filter((c) => c.platform === route);
    if (picked.length === 0) throw new A2hError("no_surface", "no reachable DM for this person");
    return picked;
  }

  private async a2hDeliver(
    messageId: string,
    surfaces: ChatRef[],
    msg: OutMessage,
  ): Promise<Array<{ platform: string; ok: boolean }>> {
    const out: Array<{ platform: string; ok: boolean }> = [];
    for (const surface of surfaces) {
      const adapter = this.adapterFor(surface);
      if (!adapter) continue;
      try {
        const refs = await adapter.send(surface, msg);
        for (const ref of refs) this.store.addDelivery(messageId, ref.chat, ref.messageId);
        out.push({ platform: surface.platform, ok: refs.length > 0 });
      } catch (err) {
        this.logger.warn("a2h send failed", { err: String(err), platform: surface.platform });
        out.push({ platform: surface.platform, ok: false });
      }
    }
    return out;
  }

  private notifyA2h(id: string): void {
    for (const fn of [...(this.a2hListeners.get(id) ?? [])]) fn();
  }

  private a2hView(req: A2hRequest): A2hView {
    const by = req.decidedBy && req.decidedBy.split(":").length === 3 ? req.decidedBy : undefined;
    const answer = req.kind === "ask" && req.state === "answered" ? (req.answer as A2hView["answer"]) : null;
    const approval = req.approvalId ? this.store.getApproval(req.approvalId) : undefined;
    return {
      requestId: req.id,
      code: req.kind === "message" ? "" : shortCode(req.id),
      kind: req.kind,
      status: req.state,
      approved: req.kind === "approval" && req.state === "approved",
      conversationId: req.conversationId,
      expiresAt: isoLocal(req.expiresAt),
      decidedAt: req.decidedAt !== undefined ? isoLocal(req.decidedAt) : null,
      decidedBy: by ? { personId: req.personId, via: by.split(":")[0]! } : null,
      answer: answer ?? null,
      quiet: Boolean((req.payload as { quiet?: boolean } | null)?.quiet),
      requiredLevel: approval?.requiredLevel ?? null,
      decidedLevel: approval?.decidedLevel ?? null,
      stepUpRequired: req.kind === "approval" && req.state === "pending" && this.store.stepUpRequested(req.id),
      grant: req.kind === "message" ? null : wireGrant(this.store.a2hMeta(req.id)?.grant ?? { kind: "once" }),
      execution:
        req.kind === "message" || (req.state !== "approved" && req.state !== "answered")
          ? null
          : (this.store.a2hMeta(req.id)?.execution ?? "pending"),
      receipts: req.kind === "message" ? [] : this.store.receipts(req.id).map((r) => r.level),
      risk: req.kind === "approval" ? (this.store.a2hActionState(req.id)?.risk ?? null) : null,
      bindingHash: req.kind === "approval" ? (this.store.a2hActionState(req.id)?.actionHash ?? null) : null,
    };
  }

  private lane(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.lanes.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.lanes.set(
      key,
      next.catch((err: unknown) => {
        this.logger.error("lane failed", { key, err: String(err) });
      }),
    );
    return next;
  }
}

const A2H_CONSEQUENCE_MAX = 120;
const OBJECT_REF_RE = /^[A-Za-z0-9._:/#@+-]{1,200}$/;
const EXTERNAL_ID_RE = /^[A-Za-z0-9._:/#@+=-]{1,200}$/;
const MAX_GRANT_UNTIL_MS = 30 * 24 * 3600_000;

/** grant: once | task(task_id) | until(time, ≤ 30 days ahead). */
export function validateGrant(g: GrantSpec, now: number): GrantSpec {
  if (!g || typeof g !== "object") throw new A2hError("invalid", "grant is required");
  if (g.kind === "once") return { kind: "once" };
  if (g.kind === "task") {
    if (typeof g.taskId !== "string" || !/^[A-Za-z0-9._:/#-]{1,120}$/.test(g.taskId)) {
      throw new A2hError("invalid", "grant task needs a task_id");
    }
    return { kind: "task", taskId: g.taskId };
  }
  if (g.kind === "until") {
    if (typeof g.until !== "number" || !Number.isFinite(g.until) || g.until <= now || g.until > now + MAX_GRANT_UNTIL_MS) {
      throw new A2hError("invalid", "grant until must be in the future (max 30 days)");
    }
    return { kind: "until", until: g.until };
  }
  throw new A2hError("invalid", "grant must be once, task or until");
}

/** In-process callers that omit grant get once; say so loudly (the RPC requires it). */
function warnDefaultGrant(requestId: string, agentName: string, agentId: string): void {
  console.warn(
    `[imwire/a2h] request ${requestId} from agent ${agentName} (${agentId}) has no grant; defaulted to once. Pass grant explicitly (once | task | until).`,
  );
}

export function wireGrant(g: GrantSpec): Record<string, unknown> {
  if (g.kind === "task") return { kind: "task", task_id: g.taskId };
  if (g.kind === "until") return { kind: "until", until: isoLocal(g.until) };
  return { kind: "once" };
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function maxLevel(a: AssuranceLevel, b: AssuranceLevel): AssuranceLevel {
  return meetsLevel(a, b) ? a : b;
}

function stepUpFooter(level: AssuranceLevel, code: string): string {
  return level === "verified" ? `\n— 批准需要补交验证码：点「批准」后回复 /approve ${code} <6位验证码>。` : "";
}

/** Mask anything that looks like a one-time code before it is persisted. */
export function redactCodes(text: string): string {
  return text.replace(/\b\d{6}\b/g, "******");
}

function totpFailureText(reason: string): string {
  switch (reason) {
    case "replay":
      return "这个验证码已经用过，请等下一个。";
    case "locked":
      return "验证码错误次数过多，已锁定 15 分钟。";
    case "not_enrolled":
      return "还没有配置验证码，请先在 Mac mini 上运行 imwire owner enroll-totp。";
    case "error":
      return "验证失败，请稍后再试。";
    default:
      return "验证码不对。";
  }
}

export type A2hRoute = "last_active" | "all" | (string & {});

function askPayload(req: A2hRequest): {
  question: string;
  choices: string[];
  allowFreeText: boolean;
  rendered?: string;
} {
  const p = (req.payload ?? {}) as { question?: string; choices?: string[]; allowFreeText?: boolean; rendered?: string };
  return {
    question: p.question ?? "",
    choices: Array.isArray(p.choices) ? p.choices : [],
    allowFreeText: p.allowFreeText !== false,
    rendered: p.rendered,
  };
}

function sameSurface(a: ChatRef, b: ChatRef): boolean {
  return a.platform === b.platform && a.accountId === b.accountId && a.chatId === b.chatId;
}

function isDenyLike(opt: string): boolean {
  return /^(deny|denied|reject|rejected|block|no)$/i.test(opt);
}
