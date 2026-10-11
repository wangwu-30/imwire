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
import { identityKey } from "./ids.js";
import { SessionStore } from "./store.js";
import type { AgentDriver, OwnerAllowlistEntry, PendingApproval, TurnSink, UserTurn } from "./types.js";

const UNPAIRED =
  "This bot is private. Ask someone already linked to send /pair, then send the 6-digit code here.";
const PAIR_TTL_MS = 10 * 60 * 1000;
const PAIR_RATE = 5;
const PAIR_WINDOW_MS = 10 * 60 * 1000;

export interface SessionGatewayOptions {
  dbPath: string;
  driver: AgentDriver;
  allowlist?: OwnerAllowlistEntry[];
  clock?: Clock;
  logger?: Logger;
  unpairedText?: string;
}

interface ActiveTurn {
  conversationId: string;
  surface: ChatRef;
  adapter: Adapter;
  draft: DraftHandle;
  generated: string;
  replyTo?: MsgRef;
  personId?: string;
  switchNote?: string;
}

interface ApprovalWaiter {
  resolve: (decision: string) => void;
}

export class SessionGateway {
  readonly store: SessionStore;
  private readonly driver: AgentDriver;
  private readonly allowlist: OwnerAllowlistEntry[];
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly unpairedText: string;
  private readonly adapters = new Map<string, Adapter>();
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly active = new Map<string, ActiveTurn>();
  private readonly followups = new Map<string, UserTurn[]>();
  private readonly approvalWaiters = new Map<string, ApprovalWaiter>();
  private readonly agentSessions = new Map<string, string>();
  private readonly turns = new Map<string, Promise<void>>();

  constructor(opts: SessionGatewayOptions) {
    this.store = new SessionStore(opts.dbPath);
    this.driver = opts.driver;
    this.allowlist = opts.allowlist ?? [];
    this.clock = opts.clock ?? systemClock();
    this.logger = opts.logger ?? noopLogger;
    this.unpairedText = opts.unpairedText ?? UNPAIRED;
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
  }

  adapterFor(chat: ChatRef): Adapter | undefined {
    return this.adapters.get(`${chat.platform}:${chat.accountId}`);
  }

  close(): void {
    this.store.close();
  }

  async handle(adapter: Adapter, event: Inbound): Promise<void> {
    if (event.type === "action") {
      await this.handleAction(adapter, event.from, event.actionId, event.value);
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
        await adapter.send(chat, { blocks: [{ kind: "markdown", text: this.unpairedText }] });
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

  private async handleUnpaired(adapter: Adapter, chat: ChatRef, from: UserRef, text: string): Promise<void> {
    const code = text.trim();
    if (/^\d{6}$/.test(code)) {
      const personId = this.store.consumePairCode(code, this.clock.now());
      if (personId) {
        this.store.linkIdentity(personId, from.platform, from.accountId, from.userId, this.clock.now());
        this.store.touchPresence(personId, chat, this.clock.now());
        await adapter.send(chat, {
          blocks: [{ kind: "markdown", text: "Linked. You share one conversation across IMs." }],
        });
        return;
      }
    }

    const owner = this.allowlist.find(
      (e) => e.platform === from.platform && e.accountId === from.accountId && e.userId === from.userId,
    );
    if (owner) {
      const person = this.store.createPerson(owner.name ?? from.displayName, this.clock.now());
      this.store.linkIdentity(person.id, from.platform, from.accountId, from.userId, this.clock.now());
      this.store.defaultConversation(person.id, this.clock.now());
      this.store.touchPresence(person.id, chat, this.clock.now());
      await adapter.send(chat, {
        blocks: [{ kind: "markdown", text: "Welcome. You are the owner. Send /pair to link another IM." }],
      });
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
      this.store.appendMessage({
        conversationId,
        role: "user",
        text,
        surface: chat,
        now: this.clock.now(),
      });
      const current = this.active.get(conversationId);
      if (current) {
        if (!sameSurface(current.surface, chat)) {
          await this.switchSurface(current, adapter, chat, replyTo);
          if (this.driver.steer && this.agentSessions.has(conversationId)) {
            await this.driver.steer(this.agentSessions.get(conversationId) ?? "", { text, source: { chat, from } });
          }
          return;
        }
        const follow = this.followups.get(conversationId) ?? [];
        follow.push({ text, source: { chat, from } });
        this.followups.set(conversationId, follow);
        return;
      }
      this.active.set(conversationId, {
        conversationId,
        surface: chat,
        adapter,
        draft: await adapter.draft(chat, { replyTo }),
        generated: "",
        replyTo,
        personId,
      });
      start = true;
    });
    if (start) {
      const running = this.runTurn(conversationId, { text, source: { chat, from } });
      this.turns.set(conversationId, running);
      void running.finally(() => {
        if (this.turns.get(conversationId) === running) this.turns.delete(conversationId);
      });
    }
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
    turn.draft = await nextAdapter.draft(nextChat, { replyTo });
    if (replay) turn.draft.append(replay);
    await this.rerenderApprovals(turn.conversationId, nextAdapter, nextChat);
  }

  private async runTurn(conversationId: string, input: UserTurn): Promise<void> {
    const turn = this.active.get(conversationId);
    if (!turn) return;
    try {
      await turn.adapter.typing(turn.surface).catch(() => undefined);
      const snap = this.store.snapshot(conversationId);
      const ensured = await this.driver.ensureSession(snap);
      this.agentSessions.set(conversationId, ensured.agentSessionId);
      const sink = this.makeSink(turn);
      const result = await this.driver.prompt(ensured.agentSessionId, input, sink);
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
      this.logger.error("turn failed", { conversationId, err: String(err) });
      try {
        await turn.draft.abort("turn failed");
      } catch {
        // ignore
      }
    } finally {
      this.active.delete(conversationId);
    }
    const queued = this.followups.get(conversationId) ?? [];
    this.followups.delete(conversationId);
    const next = queued.at(-1);
    if (next) {
      const adapter = this.adapterFor(next.source.chat);
      if (adapter) {
        this.active.set(conversationId, {
          conversationId,
          surface: next.source.chat,
          adapter,
          draft: await adapter.draft(next.source.chat),
          generated: "",
          personId: turn.personId,
        });
        await this.runTurn(conversationId, next);
      }
    }
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
        const approval = this.store.createApproval(live.conversationId, req.toolCallId, req.title, req.options);
        await this.renderApproval(approval, live.adapter, live.surface);
        return this.waitForApproval(approval.id);
      },
    };
  }

  private waitForApproval(id: string): Promise<string> {
    return new Promise((resolve) => {
      this.approvalWaiters.set(id, { resolve });
    });
  }

  private async renderApproval(approval: PendingApproval, adapter: Adapter, chat: ChatRef): Promise<void> {
    const buttons = (approval.options.length > 0 ? approval.options : ["approve", "deny"]).map((opt) => ({
      id: opt,
      label: opt === "deny" ? "Deny" : opt === "approve" ? "Approve" : opt,
      style: opt === "deny" ? ("danger" as const) : ("primary" as const),
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

  private async handleAction(adapter: Adapter, from: UserRef, actionId: string, value?: string): Promise<void> {
    const approvalId = value && this.store.getApproval(value) ? value : actionId;
    const approval = this.store.getApproval(approvalId);
    if (!approval || approval.state !== "pending") return;
    const decision = actionId === "deny" || actionId === "denied" ? "denied" : "approved";
    const decided = this.store.decideApproval(approval.id, decision, identityKey(from.platform, from.accountId, from.userId), this.clock.now());
    if (!decided) return;
    this.approvalWaiters.get(approval.id)?.resolve(decision);
    this.approvalWaiters.delete(approval.id);
    const handled = `${approval.title}\n\n_handled (${decision})_`;
    for (const card of decided.cards) {
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
