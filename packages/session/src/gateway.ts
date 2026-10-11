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
  type UserRef,
} from "@imwire/core";
import { groupKey, identityKey, PAIR_CODE_RE } from "./ids.js";
import { DEFAULT_LOG_WINDOW, SessionStore } from "./store.js";
import {
  isDenyOption,
  isExplicitApprove,
  type AgentDriver,
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
const CODE_BURNED = "Your pairing code was burned after too many wrong guesses. Send /pair for a new one.";

export interface SessionGatewayOptions {
  dbPath: string;
  driver: AgentDriver;
  allowlist?: OwnerAllowlistEntry[];
  clock?: Clock;
  logger?: Logger;
  unpairedText?: string;
  /** Approval wait TTL. Default 10 minutes. */
  approvalTimeoutMs?: number;
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
  private closed = false;

  constructor(opts: SessionGatewayOptions) {
    this.store = new SessionStore(opts.dbPath);
    this.driver = opts.driver;
    this.allowlist = opts.allowlist ?? [];
    this.clock = opts.clock ?? systemClock();
    this.logger = opts.logger ?? noopLogger;
    this.unpairedText = opts.unpairedText ?? UNPAIRED;
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? DEFAULT_APPROVAL_TTL_MS;
    this.logWindow = opts.logWindow ?? DEFAULT_LOG_WINDOW;
    for (const expired of this.store.expirePendingApprovals(this.clock.now(), "expired")) {
      this.logger.info("expired stale approval on boot", { id: expired.id });
      this.expiredOnBoot.push(expired);
    }
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
    void this.recoverInterrupted();
    void this.rewriteExpiredApprovals();
  }

  adapterFor(chat: ChatRef): Adapter | undefined {
    return this.adapters.get(`${chat.platform}:${chat.accountId}`);
  }

  close(): void {
    this.closed = true;
    this.store.close();
  }

  async handle(adapter: Adapter, event: Inbound): Promise<void> {
    if (event.type === "action") {
      await this.handleAction(event.from, event.actionId, event.value);
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
      const burned = this.store.recordCodeMiss(code, now);
      if (burned) await this.notifyCodeBurned(burned.personId);
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
    } catch (err) {
      turn.streaming = false;
      this.logger.error("turn failed", { conversationId, err: String(err) });
      try {
        await turn.draft.abort(err instanceof Error ? err.message : "turn failed");
      } catch {
        // ignore
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
          if (decided) void this.updateApprovalCards(decided, "denied");
          finish("deny");
        },
      });
      void this.clock.sleep(this.approvalTimeoutMs).then(() => {
        if (settled) return;
        const decided = this.store.decideApproval(id, "denied", "timeout", this.clock.now(), "deny");
        if (decided) void this.updateApprovalCards(decided, "denied");
        finish("deny");
      });
    });
  }

  private async handleStop(adapter: Adapter, chat: ChatRef, conversationId: string): Promise<void> {
    const session = this.agentSessions.get(conversationId);
    if (session) await this.driver.cancel(session).catch(() => undefined);
    for (const [id, waiter] of [...this.approvalWaiters.entries()]) {
      const approval = this.store.getApproval(id);
      if (approval?.conversationId !== conversationId) continue;
      waiter.abort();
    }
    const turn = this.active.get(conversationId);
    if (turn) {
      turn.streaming = false;
      try {
        await turn.draft.abort("stopped");
      } catch {
        // ignore
      }
    }
    await adapter.send(chat, { blocks: [{ kind: "markdown", text: "Stopped." }] });
  }

  private async notifyCodeBurned(personId: string): Promise<void> {
    const surface = this.store.lastSurface(personId);
    if (!surface) return;
    const dest = this.adapterFor(surface);
    if (!dest) return;
    await dest.send(surface, { blocks: [{ kind: "markdown", text: CODE_BURNED }] }).catch(() => undefined);
  }

  private async renderApproval(approval: PendingApproval, adapter: Adapter, chat: ChatRef): Promise<void> {
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
    const cards = [...approval.cards, ...refs.map((r) => ({ chat: r.chat, messageId: r.messageId }))];
    this.store.setApprovalCards(approval.id, cards);
  }

  private async rerenderApprovals(conversationId: string, adapter: Adapter, chat: ChatRef): Promise<void> {
    for (const approval of this.store.pendingApprovals(conversationId)) {
      await this.renderApproval(approval, adapter, chat);
    }
  }

  private canDecide(approval: PendingApproval, from: UserRef): boolean {
    const ident = this.store.findIdentity(from.platform, from.accountId, from.userId);
    if (!ident) return false;
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

  private async handleAction(from: UserRef, actionId: string, value?: string): Promise<void> {
    const approvalId = value && this.store.getApproval(value) ? value : actionId;
    const approval = this.store.getApproval(approvalId);
    if (!approval || approval.state !== "pending") return;
    if (!this.canDecide(approval, from)) return;
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

function sameSurface(a: ChatRef, b: ChatRef): boolean {
  return a.platform === b.platform && a.accountId === b.accountId && a.chatId === b.chatId;
}

function isDenyLike(opt: string): boolean {
  return /^(deny|denied|reject|rejected|block|no)$/i.test(opt);
}
