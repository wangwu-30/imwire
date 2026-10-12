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
  agentTopicTitle,
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
  type ApproverVerifier,
  type QuietHours,
} from "./a2h.js";
import { groupKey, identityKey, PAIR_CODE_RE } from "./ids.js";
import { DEFAULT_LOG_WINDOW, SessionStore } from "./store.js";
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

export interface SessionGatewayOptions {
  dbPath: string;
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
  approverVerifier?: ApproverVerifier;
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
  private readonly quietHours: QuietHours | null;
  private readonly verifier: ApproverVerifier;
  private readonly a2hListeners = new Map<string, Set<() => void>>();
  private readonly sweepTimer?: ReturnType<typeof setInterval>;
  private closed = false;
  private recoverChain: Promise<void> = Promise.resolve();

  constructor(opts: SessionGatewayOptions) {
    this.store = new SessionStore(opts.dbPath);
    this.driver = opts.driver;
    this.allowlist = opts.allowlist ?? [];
    this.clock = opts.clock ?? systemClock();
    this.logger = opts.logger ?? noopLogger;
    this.unpairedText = opts.unpairedText ?? UNPAIRED;
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? DEFAULT_APPROVAL_TTL_MS;
    this.logWindow = opts.logWindow ?? DEFAULT_LOG_WINDOW;
    this.verifier = opts.approverVerifier ?? imAccountVerifier;
    this.quietHours = opts.quietHours === undefined ? DEFAULT_QUIET_HOURS : opts.quietHours;
    // Q4: a hub restart fails every open agent request closed.
    for (const req of this.store.expirePendingA2hRequests(this.clock.now(), "restart")) {
      this.logger.info("expired a2h request on boot", { id: req.id });
      this.store.audit({
        at: this.clock.now(),
        action: "expire",
        result: "expired_on_restart",
        agentId: req.agentId,
        personId: req.personId,
        requestId: req.id,
      });
    }
    for (const expired of this.store.expirePendingApprovals(this.clock.now(), "expired")) {
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
  private async verifyApproverClick(approval: PendingApproval, from: UserRef): Promise<boolean> {
    const ident = this.store.findIdentity(from.platform, from.accountId, from.userId);
    const request = this.store.a2hRequestByApproval(approval.id);
    let ok = false;
    let level = "none";
    let reason: string | undefined;
    try {
      const verdict = await this.verifier.verifyApprover({
        personId: approval.targetPersonId!,
        clickerPersonId: ident?.personId ?? "",
        from: { platform: from.platform, accountId: from.accountId, userId: from.userId },
        approvalId: approval.id,
        requestId: request?.id,
        now: this.clock.now(),
      });
      level = verdict.level;
      reason = verdict.reason;
      ok = verdict.ok && meetsLevel(verdict.level, this.verifier.requiredLevel ?? "im_account");
    } catch (err) {
      reason = `verifier_error: ${String(err)}`;
    }
    if (!ok) {
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
    return ok;
  }

  /** Mirror a decided approval onto its a2h request (if any). */
  private syncA2hFromApproval(decided: PendingApproval): void {
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
              : "denied";
    this.store.decideA2hRequest(req.id, state, by, this.clock.now(), { choice: decided.chosen ?? null });
    this.notifyA2h(req.id);
  }

  attach(adapter: Adapter): void {
    this.adapters.set(`${adapter.platform}:${adapter.accountId}`, adapter);
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

  async sendProactive(personId: string, text: string): Promise<void> {
    const surface = this.store.lastSurface(personId);
    if (!surface) return;
    const adapter = this.adapterFor(surface);
    if (!adapter) return;
    const conv = this.store.activeConversation(personId, this.clock.now());
    const msg = this.store.appendMessage({
      conversationId: conv.id,
      role: "assistant",
      text,
      surface,
      now: this.clock.now(),
    });
    const refs = await adapter.send(surface, { blocks: [{ kind: "markdown", text }] });
    for (const ref of refs) this.store.addDelivery(msg.id, ref.chat, ref.messageId);
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
        await this.updateApprovalCards(approval, "expired");
      }
    } catch (err) {
      if (this.closed) return;
      this.logger.warn("expired approval rewrite failed", { err: String(err) });
    }
  }

  private async handleUnpaired(adapter: Adapter, chat: ChatRef, from: UserRef, text: string): Promise<void> {
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

  private async handleAction(from: UserRef, actionId: string, value?: string, target?: MsgRef): Promise<void> {
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
    if (approval.targetPersonId && !(await this.verifyApproverClick(approval, from))) return;
    if (approval.expiresAt !== undefined && approval.expiresAt <= this.clock.now()) {
      // Past TTL but not yet swept: fail closed, never honour a late click.
      this.sweepExpired();
      return;
    }
    const { option, approved } = this.interpretAction(approval, actionId);
    const state = approved ? "approved" : "denied";
    const decided = this.store.decideApproval(
      approval.id,
      state,
      identityKey(from.platform, from.accountId, from.userId),
      this.clock.now(),
      option,
    );
    if (!decided) return;
    this.syncA2hFromApproval(decided);
    this.approvalWaiters.get(approval.id)?.resolve(option);
    this.approvalWaiters.delete(approval.id);
    await this.updateApprovalCards(decided, state);
  }

  private async updateApprovalCards(approval: PendingApproval, state: string): Promise<void> {
    const handled = `${approval.title}\n\n_handled (${state})_`;
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
    risk?: "low" | "medium" | "high";
    expiresInS?: number;
    route?: A2hRoute;
    idempotencyKey?: string;
  }): Promise<A2hView> {
    const { agent, personId } = this.a2hAuthorize(opts.agentId, opts.to, "approve");
    const title = sanitizeAgentLine(opts.title);
    if (!title) throw new A2hError("invalid", "title is required");
    const details = opts.details ? sanitizeAgentText(opts.details) : "";
    const risk = opts.risk && ["low", "medium", "high"].includes(opts.risk) ? opts.risk : undefined;
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
    if (replayed) return this.a2hView(request);
    const code = shortCode(request.id);
    const riskLabel = risk ? { low: "低风险", medium: "中风险", high: "⚠️ 高风险" }[risk] : undefined;
    const card = [
      frameHeader(agent.name),
      "",
      `审批请求：${title}`,
      ...(details ? ["", details] : []),
      "",
      `— 编号 ${code}${riskLabel ? ` · ${riskLabel}` : ""} · 有效至 ${formatLocal(expiresAt)}`,
      "— 只有点按钮才算数；文字回复不算批准。超时视为拒绝。",
    ].join("\n");
    const approval = this.store.createApproval(conv.id, request.id, card, ["approve", "deny"], undefined, now, {
      targetPersonId: personId,
      expiresAt,
      source: "agent",
    });
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
    });
    return this.a2hView(this.store.getA2hRequest(request.id)!);
  }

  /** Ask a question. Replies are untrusted data and never count as approval (Q2). */
  async askPerson(opts: {
    agentId: string;
    to: string;
    question: string;
    choices?: string[];
    allowFreeText?: boolean;
    expiresInS?: number;
    route?: A2hRoute;
    idempotencyKey?: string;
  }): Promise<A2hView> {
    const { agent, personId } = this.a2hAuthorize(opts.agentId, opts.to, "ask");
    const question = sanitizeAgentText(opts.question);
    if (!question) throw new A2hError("invalid", "question is required");
    const choices = (opts.choices ?? []).map((c) => sanitizeAgentLine(c, A2H_CHOICE_MAX)).filter(Boolean);
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
    if (replayed) return this.a2hView(request);
    const code = shortCode(request.id);
    const how = allowFreeText
      ? `引用回复本消息，或发送 /answer ${code} 你的回答`
      : "点下面的选项作答";
    const rendered = [
      frameHeader(agent.name),
      "",
      question,
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
        if (req.kind === "approval") {
          this.store.appendMessage({
            conversationId: req.conversationId,
            role: "user",
            text,
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
    this.store.audit({ at: now, action: "answer", result: "answered", agentId: req.agentId, personId: req.personId, requestId: req.id });
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
