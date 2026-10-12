import type { ChatRef } from "@imwire/core";
import { groupKey, hashPairCode, identityKey, newId, pairCode } from "./ids.js";
import { openSqlite, type SqlDatabase } from "./sqlite.js";
import type {
  ConversationMeta,
  ConversationSnapshot,
  IdentityRecord,
  LogMessage,
  A2hRequest,
  A2hRequestKind,
  A2hScope,
  A2hTerminalState,
  AgentRecord,
  PendingApproval,
  PersonRecord,
} from "./types.js";

export const PAIR_ATTEMPT_LIMIT = 5;
export const PAIR_WINDOW_MS = 10 * 60 * 1000;
export const GROUP_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_LOG_WINDOW = 40;
export const CALLBACK_TTL_MS = 24 * 60 * 60 * 1000;

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS person (
  id TEXT PRIMARY KEY,
  name TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS identity (
  platform TEXT NOT NULL,
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES person(id),
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (platform, account_id, user_id)
);
CREATE TABLE IF NOT EXISTS pairing (
  code TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  used_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pair_attempt (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT NOT NULL,
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pair_lock_notice (
  sender TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation (
  id TEXT PRIMARY KEY,
  person_id TEXT REFERENCES person(id),
  group_key TEXT,
  title TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS conv_person_default
  ON conversation(person_id) WHERE is_default = 1 AND person_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS conv_group
  ON conversation(group_key) WHERE group_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS active_topic (
  person_id TEXT PRIMARY KEY REFERENCES person(id),
  conversation_id TEXT NOT NULL REFERENCES conversation(id)
);
CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id),
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  surface TEXT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(conversation_id, seq)
);
CREATE TABLE IF NOT EXISTS delivery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL REFERENCES message(id),
  platform TEXT NOT NULL,
  account_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  platform_msg_id TEXT,
  state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approval (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id),
  tool_call TEXT NOT NULL,
  state TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  decided_by TEXT,
  decided_at INTEGER,
  cards TEXT,
  requested_by TEXT,
  chosen TEXT,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS presence (
  person_id TEXT PRIMARY KEY REFERENCES person(id),
  last_surface TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS group_notice (
  group_key TEXT PRIMARY KEY,
  last_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS interrupt_notice (
  conversation_id TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agent (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  limits TEXT
);
CREATE TABLE IF NOT EXISTS agent_grant (
  agent_id TEXT NOT NULL REFERENCES agent(id),
  person_id TEXT NOT NULL REFERENCES person(id),
  scopes TEXT NOT NULL,
  PRIMARY KEY (agent_id, person_id)
);
CREATE TABLE IF NOT EXISTS a2h_request (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agent(id),
  person_id TEXT NOT NULL REFERENCES person(id),
  conversation_id TEXT NOT NULL REFERENCES conversation(id),
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  payload TEXT NOT NULL,
  answer TEXT,
  approval_id TEXT REFERENCES approval(id),
  prompt_message_id TEXT,
  answer_message_id TEXT,
  idempotency_key TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (agent_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS a2h_request_open ON a2h_request(state, expires_at);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  agent_id TEXT,
  action TEXT NOT NULL,
  person_id TEXT,
  request_id TEXT,
  result TEXT NOT NULL,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS telegram_callback (
  hash TEXT PRIMARY KEY,
  action_id TEXT NOT NULL,
  value TEXT,
  updated_at INTEGER NOT NULL
);
`;

export class SessionStore {
  readonly db: SqlDatabase;

  constructor(path: string) {
    this.db = openSqlite(path);
    try {
      this.db.exec("PRAGMA journal_mode = WAL");
    } catch {
      // :memory:
    }
    this.db.exec(SCHEMA);
    this.migrate();
    this.purgeCallbacks();
  }

  private migrate(): void {
    const alters = [
      "ALTER TABLE approval ADD COLUMN requested_by TEXT",
      "ALTER TABLE approval ADD COLUMN chosen TEXT",
      "ALTER TABLE approval ADD COLUMN created_at INTEGER",
      "ALTER TABLE pairing ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE interrupt_notice ADD COLUMN last_seq INTEGER NOT NULL DEFAULT 0",
      // a2h (agent → human), additive only.
      "ALTER TABLE approval ADD COLUMN target_person_id TEXT",
      "ALTER TABLE approval ADD COLUMN expires_at INTEGER",
      "ALTER TABLE approval ADD COLUMN source TEXT",
      "ALTER TABLE conversation ADD COLUMN agent_id TEXT",
      "ALTER TABLE message ADD COLUMN author TEXT",
      "ALTER TABLE message ADD COLUMN request_id TEXT",
    ];
    for (const sql of alters) {
      try {
        this.db.exec(sql);
      } catch {
        // column exists
      }
    }
    // Indexes that reference migrated columns must run after the ALTERs.
    this.db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS conv_person_agent
  ON conversation(person_id, agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS delivery_platform_msg
  ON delivery(platform, account_id, chat_id, platform_msg_id);
CREATE INDEX IF NOT EXISTS approval_pending_expiry
  ON approval(state, expires_at);
`);
  }

  close(): void {
    this.db.close();
  }

  createPerson(name: string | undefined, now: number): PersonRecord {
    const id = newId("p");
    this.db.prepare("INSERT INTO person(id, name, created_at) VALUES (?, ?, ?)").run(id, name ?? null, now);
    return { id, name };
  }

  getPerson(id: string): PersonRecord | undefined {
    const row = this.db.prepare<{ id: string; name: string | null }>("SELECT id, name FROM person WHERE id = ?").get(id);
    return row ? { id: row.id, name: row.name ?? undefined } : undefined;
  }

  findIdentity(platform: string, accountId: string, userId: string): IdentityRecord | undefined {
    const row = this.db
      .prepare<{ platform: string; account_id: string; user_id: string; person_id: string }>(
        "SELECT platform, account_id, user_id, person_id FROM identity WHERE platform = ? AND account_id = ? AND user_id = ?",
      )
      .get(platform, accountId, userId);
    if (!row) return undefined;
    return { platform: row.platform, accountId: row.account_id, userId: row.user_id, personId: row.person_id };
  }

  /** Insert-only. Refuses to re-point an existing identity to another person. */
  linkIdentity(personId: string, platform: string, accountId: string, userId: string, now: number): boolean {
    const existing = this.findIdentity(platform, accountId, userId);
    if (existing) return existing.personId === personId;
    try {
      this.db
        .prepare("INSERT INTO identity(platform, account_id, user_id, person_id, linked_at) VALUES (?, ?, ?, ?, ?)")
        .run(platform, accountId, userId, personId, now);
      return true;
    } catch {
      const again = this.findIdentity(platform, accountId, userId);
      return again?.personId === personId;
    }
  }

  bootstrapOwner(
    platform: string,
    accountId: string,
    userId: string,
    name: string | undefined,
    now: number,
  ): { person: PersonRecord; created: boolean } {
    return this.db.transaction(() => {
      const existing = this.findIdentity(platform, accountId, userId);
      if (existing) {
        const person = this.getPerson(existing.personId) ?? { id: existing.personId, name };
        return { person, created: false };
      }
      const person = this.createPerson(name, now);
      this.linkIdentity(person.id, platform, accountId, userId, now);
      this.defaultConversation(person.id, now);
      return { person, created: true };
    });
  }

  purgePairing(now: number, windowMs = PAIR_WINDOW_MS): void {
    this.db
      .prepare("DELETE FROM pairing WHERE expires_at <= ? OR (used_at IS NOT NULL AND created_at < ?)")
      .run(now, now - windowMs);
    this.db.prepare("DELETE FROM pair_attempt WHERE at < ?").run(now - windowMs * 2);
  }

  createPairCode(
    personId: string,
    createdBy: string,
    expiresAt: number,
    now: number,
    maxPerWindow: number,
    windowMs: number,
  ): string | "rate_limited" {
    this.purgePairing(now);
    const created = this.db
      .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM pairing WHERE created_by = ? AND created_at >= ?")
      .get(createdBy, now - windowMs);
    if ((created?.n ?? 0) >= maxPerWindow) return "rate_limited";
    // max 1 live code per identity: revoke previous unused
    this.db
      .prepare("UPDATE pairing SET used_at = ? WHERE created_by = ? AND used_at IS NULL")
      .run(now, createdBy);
    for (let i = 0; i < 20; i += 1) {
      const code = pairCode();
      try {
        this.db
          .prepare(
            "INSERT INTO pairing(code, person_id, expires_at, created_at, created_by, attempts) VALUES (?, ?, ?, ?, ?, 0)",
          )
          .run(hashPairCode(code), personId, expiresAt, now, createdBy);
        return code;
      } catch {
        // collision
      }
    }
    throw new Error("could not allocate pairing code");
  }

  livePairPerson(code: string, now: number): string | undefined {
    this.purgePairing(now);
    const hashed = hashPairCode(code);
    const row = this.db
      .prepare<{ person_id: string; expires_at: number; used_at: number | null }>(
        "SELECT person_id, expires_at, used_at FROM pairing WHERE code = ?",
      )
      .get(hashed);
    if (!row || row.used_at !== null || row.expires_at <= now) return undefined;
    return row.person_id;
  }

  consumePairCode(code: string, now: number): string | undefined {
    this.purgePairing(now);
    const hashed = hashPairCode(code);
    const row = this.db
      .prepare<{ person_id: string; expires_at: number; used_at: number | null }>(
        "SELECT person_id, expires_at, used_at FROM pairing WHERE code = ?",
      )
      .get(hashed);
    if (!row || row.used_at !== null || row.expires_at <= now) return undefined;
    const updated = this.db
      .prepare("UPDATE pairing SET used_at = ? WHERE code = ? AND used_at IS NULL AND expires_at > ?")
      .run(now, hashed, now);
    if (updated.changes !== 1) return undefined;
    return row.person_id;
  }

  recordPairAttempt(sender: string, now: number, ok: boolean): void {
    this.db.prepare("INSERT INTO pair_attempt(sender, at, ok) VALUES (?, ?, ?)").run(sender, now, ok ? 1 : 0);
  }

  failedPairAttempts(sender: string, now: number, windowMs = PAIR_WINDOW_MS): number {
    return (
      this.db
        .prepare<{ n: number }>(
          "SELECT COUNT(*) AS n FROM pair_attempt WHERE sender = ? AND ok = 0 AND at >= ?",
        )
        .get(sender, now - windowMs)?.n ?? 0
    );
  }

  pairLocked(sender: string, now: number): boolean {
    return this.failedPairAttempts(sender, now) >= PAIR_ATTEMPT_LIMIT;
  }

  shouldTellLockout(sender: string, now: number): boolean {
    const row = this.db.prepare<{ at: number }>("SELECT at FROM pair_lock_notice WHERE sender = ?").get(sender);
    if (row && now - row.at < PAIR_WINDOW_MS) return false;
    this.db.prepare("INSERT OR REPLACE INTO pair_lock_notice(sender, at) VALUES (?, ?)").run(sender, now);
    return true;
  }

  shouldSendGroupNotice(key: string, now: number, windowMs = GROUP_NOTICE_WINDOW_MS): boolean {
    const row = this.db.prepare<{ last_at: number }>("SELECT last_at FROM group_notice WHERE group_key = ?").get(key);
    if (row && now - row.last_at < windowMs) return false;
    this.db.prepare("INSERT OR REPLACE INTO group_notice(group_key, last_at) VALUES (?, ?)").run(key, now);
    return true;
  }

  conversationMeta(id: string): ConversationMeta | undefined {
    const conv = this.db
      .prepare<{ id: string; person_id: string | null; group_key: string | null; title: string; is_default: number }>(
        "SELECT id, person_id, group_key, title, is_default FROM conversation WHERE id = ?",
      )
      .get(id);
    if (!conv) return undefined;
    return {
      id: conv.id,
      personId: conv.person_id ?? undefined,
      groupKey: conv.group_key ?? undefined,
      title: conv.title,
      isDefault: conv.is_default === 1,
    };
  }

  defaultConversation(personId: string, now: number): ConversationSnapshot {
    const existing = this.db
      .prepare<{ id: string }>("SELECT id FROM conversation WHERE person_id = ? AND is_default = 1")
      .get(personId);
    if (existing) return this.snapshot(existing.id);
    const id = newId("c");
    this.db
      .prepare(
        "INSERT INTO conversation(id, person_id, group_key, title, is_default, created_at) VALUES (?, ?, NULL, ?, 1, ?)",
      )
      .run(id, personId, "default", now);
    this.db.prepare("INSERT OR REPLACE INTO active_topic(person_id, conversation_id) VALUES (?, ?)").run(personId, id);
    return this.snapshot(id);
  }

  activeConversation(personId: string, now: number): ConversationSnapshot {
    const row = this.db
      .prepare<{ conversation_id: string }>("SELECT conversation_id FROM active_topic WHERE person_id = ?")
      .get(personId);
    if (row) return this.snapshot(row.conversation_id);
    return this.defaultConversation(personId, now);
  }

  listTopics(personId: string): Array<{ id: string; title: string; isDefault: boolean; active: boolean }> {
    const active = this.db
      .prepare<{ conversation_id: string }>("SELECT conversation_id FROM active_topic WHERE person_id = ?")
      .get(personId)?.conversation_id;
    return this.db
      .prepare<{ id: string; title: string; is_default: number }>(
        "SELECT id, title, is_default FROM conversation WHERE person_id = ? ORDER BY is_default DESC, title",
      )
      .all(personId)
      .map((r) => ({
        id: r.id,
        title: r.title,
        isDefault: r.is_default === 1,
        active: r.id === active,
      }));
  }

  switchTopic(personId: string, title: string, now: number): ConversationSnapshot {
    const name = title.trim() || "default";
    if (name === "default") {
      const conv = this.defaultConversation(personId, now);
      this.db.prepare("INSERT OR REPLACE INTO active_topic(person_id, conversation_id) VALUES (?, ?)").run(personId, conv.id);
      return conv;
    }
    const existing = this.db
      .prepare<{ id: string }>("SELECT id FROM conversation WHERE person_id = ? AND title = ? AND is_default = 0")
      .get(personId, name);
    const id = existing?.id ?? newId("c");
    if (!existing) {
      this.db
        .prepare(
          "INSERT INTO conversation(id, person_id, group_key, title, is_default, created_at) VALUES (?, ?, NULL, ?, 0, ?)",
        )
        .run(id, personId, name, now);
    }
    this.db.prepare("INSERT OR REPLACE INTO active_topic(person_id, conversation_id) VALUES (?, ?)").run(personId, id);
    return this.snapshot(id);
  }

  groupConversation(chat: ChatRef, now: number): ConversationSnapshot {
    const key = groupKey(chat.platform, chat.accountId, chat.chatId);
    const existing = this.db.prepare<{ id: string }>("SELECT id FROM conversation WHERE group_key = ?").get(key);
    if (existing) return this.snapshot(existing.id);
    const id = newId("c");
    this.db
      .prepare(
        "INSERT INTO conversation(id, person_id, group_key, title, is_default, created_at) VALUES (?, NULL, ?, ?, 0, ?)",
      )
      .run(id, key, `group:${chat.chatId}`, now);
    return this.snapshot(id);
  }

  snapshot(conversationId: string, opts?: { maxMessages?: number }): ConversationSnapshot {
    const conv = this.conversationMeta(conversationId);
    if (!conv) throw new Error(`unknown conversation ${conversationId}`);
    const limit = opts?.maxMessages;
    const rows = limit
      ? this.db
          .prepare<{ id: string; seq: number; role: string; surface: string | null; content: string; created_at: number }>(
            "SELECT id, seq, role, surface, content, created_at FROM message WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?",
          )
          .all(conversationId, limit)
          .reverse()
      : this.db
          .prepare<{ id: string; seq: number; role: string; surface: string | null; content: string; created_at: number }>(
            "SELECT id, seq, role, surface, content, created_at FROM message WHERE conversation_id = ? ORDER BY seq",
          )
          .all(conversationId);
    const messages = rows.map((m) => {
      const content = JSON.parse(m.content) as { text?: string };
      return {
        id: m.id,
        seq: m.seq,
        role: m.role as LogMessage["role"],
        text: content.text ?? "",
        surface: m.surface ? (JSON.parse(m.surface) as ChatRef) : undefined,
        createdAt: m.created_at,
      };
    });
    return { ...conv, messages };
  }

  appendMessage(opts: {
    conversationId: string;
    role: LogMessage["role"];
    text: string;
    surface?: ChatRef;
    now: number;
  }): LogMessage {
    return this.db.transaction(() => {
      const seqRow = this.db
        .prepare<{ n: number }>("SELECT COALESCE(MAX(seq), 0) AS n FROM message WHERE conversation_id = ?")
        .get(opts.conversationId);
      const seq = (seqRow?.n ?? 0) + 1;
      const id = newId("m");
      this.db
        .prepare(
          "INSERT INTO message(id, conversation_id, seq, role, surface, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          opts.conversationId,
          seq,
          opts.role,
          opts.surface ? JSON.stringify(opts.surface) : null,
          JSON.stringify({ text: opts.text }),
          opts.now,
        );
      return { id, seq, role: opts.role, text: opts.text, surface: opts.surface, createdAt: opts.now };
    });
  }

  addDelivery(messageId: string, chat: ChatRef, platformMsgId: string, state = "sent"): void {
    this.db
      .prepare(
        "INSERT INTO delivery(message_id, platform, account_id, chat_id, platform_msg_id, state) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(messageId, chat.platform, chat.accountId, chat.chatId, platformMsgId, state);
  }

  touchPresence(personId: string, surface: ChatRef, now: number): void {
    this.db
      .prepare("INSERT OR REPLACE INTO presence(person_id, last_surface, last_seen_at) VALUES (?, ?, ?)")
      .run(personId, JSON.stringify(surface), now);
  }

  lastSurface(personId: string): ChatRef | undefined {
    const row = this.db.prepare<{ last_surface: string }>("SELECT last_surface FROM presence WHERE person_id = ?").get(personId);
    return row ? (JSON.parse(row.last_surface) as ChatRef) : undefined;
  }

  unansweredTails(): Array<{
    conversationId: string;
    personId?: string;
    text: string;
    surface?: ChatRef;
    seq: number;
  }> {
    const convs = this.db
      .prepare<{ id: string; person_id: string | null }>("SELECT id, person_id FROM conversation")
      .all();
    const out: Array<{
      conversationId: string;
      personId?: string;
      text: string;
      surface?: ChatRef;
      seq: number;
    }> = [];
    for (const c of convs) {
      const last = this.db
        .prepare<{ role: string; content: string; surface: string | null; seq: number }>(
          "SELECT role, content, surface, seq FROM message WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1",
        )
        .get(c.id);
      if (!last || last.role !== "user") continue;
      const noticed = this.db
        .prepare<{ last_seq: number }>("SELECT last_seq FROM interrupt_notice WHERE conversation_id = ?")
        .get(c.id);
      if (noticed && noticed.last_seq >= last.seq) continue;
      const content = JSON.parse(last.content) as { text?: string };
      out.push({
        conversationId: c.id,
        personId: c.person_id ?? undefined,
        text: content.text ?? "",
        surface: last.surface ? (JSON.parse(last.surface) as ChatRef) : undefined,
        seq: last.seq,
      });
    }
    return out;
  }

  markInterruptNotified(conversationId: string, seq: number): void {
    this.db
      .prepare("INSERT OR REPLACE INTO interrupt_notice(conversation_id, last_seq) VALUES (?, ?)")
      .run(conversationId, seq);
  }

  listIdentities(personId: string): IdentityRecord[] {
    return this.db
      .prepare<{ platform: string; account_id: string; user_id: string; person_id: string }>(
        "SELECT platform, account_id, user_id, person_id FROM identity WHERE person_id = ?",
      )
      .all(personId)
      .map((r) => ({ platform: r.platform, accountId: r.account_id, userId: r.user_id, personId: r.person_id }));
  }

  purgeCallbacks(now = Date.now(), ttlMs = CALLBACK_TTL_MS): void {
    this.db.prepare("DELETE FROM telegram_callback WHERE updated_at < ?").run(now - ttlMs);
  }

  getCallback(hash: string): { id: string; value?: string } | undefined {
    this.purgeCallbacks();
    const row = this.db
      .prepare<{ action_id: string; value: string | null }>(
        "SELECT action_id, value FROM telegram_callback WHERE hash = ?",
      )
      .get(hash);
    if (!row) return undefined;
    return { id: row.action_id, value: row.value ?? undefined };
  }

  setCallback(hash: string, entry: { id: string; value?: string }, now = Date.now()): void {
    this.purgeCallbacks(now);
    this.db
      .prepare("INSERT OR REPLACE INTO telegram_callback(hash, action_id, value, updated_at) VALUES (?, ?, ?, ?)")
      .run(hash, entry.id, entry.value ?? null, now);
  }

  createApproval(
    conversationId: string,
    toolCallId: string,
    title: string,
    options: string[],
    requestedBy: string | undefined,
    now: number,
    extra: { targetPersonId?: string; expiresAt?: number; source?: "pi" | "agent" } = {},
  ): PendingApproval {
    const id = newId("a");
    const rec: PendingApproval = {
      id,
      conversationId,
      toolCallId,
      title,
      options,
      version: 1,
      state: "pending",
      requestedBy,
      createdAt: now,
      targetPersonId: extra.targetPersonId,
      expiresAt: extra.expiresAt,
      source: extra.source,
      cards: [],
    };
    this.db
      .prepare(
        "INSERT INTO approval(id, conversation_id, tool_call, state, version, cards, requested_by, created_at, target_person_id, expires_at, source) VALUES (?, ?, ?, 'pending', 1, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        conversationId,
        JSON.stringify({ toolCallId, title, options }),
        "[]",
        requestedBy ?? null,
        now,
        extra.targetPersonId ?? null,
        extra.expiresAt ?? null,
        extra.source ?? null,
      );
    return rec;
  }

  getApproval(id: string): PendingApproval | undefined {
    const row = this.db
      .prepare<{
        id: string;
        conversation_id: string;
        tool_call: string;
        state: string;
        version: number;
        cards: string | null;
        requested_by: string | null;
        chosen: string | null;
        decided_by: string | null;
        decided_at: number | null;
        created_at: number | null;
        target_person_id: string | null;
        expires_at: number | null;
        source: string | null;
      }>(
        "SELECT id, conversation_id, tool_call, state, version, cards, requested_by, chosen, decided_by, decided_at, created_at, target_person_id, expires_at, source FROM approval WHERE id = ?",
      )
      .get(id);
    if (!row) return undefined;
    const tool = JSON.parse(row.tool_call) as { toolCallId: string; title: string; options: string[] };
    return {
      id: row.id,
      conversationId: row.conversation_id,
      toolCallId: tool.toolCallId,
      title: tool.title,
      options: tool.options,
      version: row.version,
      state: row.state as PendingApproval["state"],
      requestedBy: row.requested_by ?? undefined,
      chosen: row.chosen ?? undefined,
      decidedBy: row.decided_by ?? undefined,
      decidedAt: row.decided_at ?? undefined,
      createdAt: row.created_at ?? undefined,
      targetPersonId: row.target_person_id ?? undefined,
      expiresAt: row.expires_at ?? undefined,
      source: (row.source as PendingApproval["source"]) ?? undefined,
      cards: row.cards ? (JSON.parse(row.cards) as PendingApproval["cards"]) : [],
    };
  }

  setApprovalCards(id: string, cards: PendingApproval["cards"]): void {
    this.db.prepare("UPDATE approval SET cards = ? WHERE id = ?").run(JSON.stringify(cards), id);
  }

  pendingApprovals(conversationId?: string): PendingApproval[] {
    const rows = conversationId
      ? this.db
          .prepare<{ id: string }>("SELECT id FROM approval WHERE conversation_id = ? AND state = 'pending'")
          .all(conversationId)
      : this.db.prepare<{ id: string }>("SELECT id FROM approval WHERE state = 'pending'").all();
    return rows.map((r) => this.getApproval(r.id)).filter((a): a is PendingApproval => Boolean(a));
  }

  decideApproval(
    id: string,
    state: "approved" | "denied",
    decidedBy: string,
    now: number,
    chosen?: string,
  ): PendingApproval | undefined {
    const current = this.getApproval(id);
    if (!current || current.state !== "pending") return undefined;
    const updated = this.db
      .prepare(
        "UPDATE approval SET state = ?, decided_by = ?, decided_at = ?, chosen = ?, version = version + 1 WHERE id = ? AND state = 'pending' AND version = ?",
      )
      .run(state, decidedBy, now, chosen ?? state, id, current.version);
    if (updated.changes !== 1) return undefined;
    return this.getApproval(id);
  }

  expirePendingApprovals(now: number, reason = "expired"): PendingApproval[] {
    const pending = this.pendingApprovals();
    const out: PendingApproval[] = [];
    for (const a of pending) {
      const decided = this.decideApproval(a.id, "denied", reason, now, "deny");
      if (decided) out.push(decided);
    }
    return out;
  }

  /**
   * Sweeper: deny every pending approval whose persisted `expires_at` has
   * passed. Fail-closed — expiry is a denial (`decided_by = reason`).
   */
  expireDueApprovals(now: number, reason = "expired"): PendingApproval[] {
    const due = this.db
      .prepare<{ id: string }>(
        "SELECT id FROM approval WHERE state = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?",
      )
      .all(now);
    const out: PendingApproval[] = [];
    for (const { id } of due) {
      const decided = this.decideApproval(id, "denied", reason, now, "deny");
      if (decided) out.push(decided);
    }
    return out;
  }

  // ---- a2h: agents, grants, requests, audit -------------------------------

  createAgent(name: string, tokenHash: string, now: number): AgentRecord {
    const id = newId("ag");
    this.db
      .prepare("INSERT INTO agent(id, name, token_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(id, name, tokenHash, now);
    return { id, name, createdAt: now };
  }

  getAgent(id: string): AgentRecord | undefined {
    const row = this.db
      .prepare<{ id: string; name: string; created_at: number; revoked_at: number | null }>(
        "SELECT id, name, created_at, revoked_at FROM agent WHERE id = ?",
      )
      .get(id);
    if (!row) return undefined;
    return { id: row.id, name: row.name, createdAt: row.created_at, revokedAt: row.revoked_at ?? undefined };
  }

  revokeAgent(id: string, now: number): void {
    this.db.prepare("UPDATE agent SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id);
  }

  /** Raw grant write. Callers must apply the target allowlist gate first (see SessionGateway.grantAgent). */
  setAgentGrant(agentId: string, personId: string, scopes: A2hScope[]): void {
    this.db
      .prepare("INSERT OR REPLACE INTO agent_grant(agent_id, person_id, scopes) VALUES (?, ?, ?)")
      .run(agentId, personId, JSON.stringify([...new Set(scopes)]));
  }

  agentScopes(agentId: string, personId: string): A2hScope[] {
    const row = this.db
      .prepare<{ scopes: string }>("SELECT scopes FROM agent_grant WHERE agent_id = ? AND person_id = ?")
      .get(agentId, personId);
    if (!row) return [];
    try {
      const parsed = JSON.parse(row.scopes) as unknown;
      return Array.isArray(parsed) ? (parsed.filter((s) => typeof s === "string") as A2hScope[]) : [];
    } catch {
      return [];
    }
  }

  createA2hRequest(opts: {
    agentId: string;
    personId: string;
    conversationId: string;
    kind: A2hRequestKind;
    payload: unknown;
    expiresAt: number;
    now: number;
    approvalId?: string;
    idempotencyKey?: string;
  }): { request: A2hRequest; replayed: boolean } {
    return this.db.transaction(() => {
      if (opts.idempotencyKey !== undefined) {
        const prior = this.db
          .prepare<{ id: string }>("SELECT id FROM a2h_request WHERE agent_id = ? AND idempotency_key = ?")
          .get(opts.agentId, opts.idempotencyKey);
        if (prior) return { request: this.getA2hRequest(prior.id)!, replayed: true };
      }
      const id = newId("r");
      this.db
        .prepare(
          "INSERT INTO a2h_request(id, agent_id, person_id, conversation_id, kind, state, payload, approval_id, idempotency_key, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          opts.agentId,
          opts.personId,
          opts.conversationId,
          opts.kind,
          JSON.stringify(opts.payload ?? null),
          opts.approvalId ?? null,
          opts.idempotencyKey ?? null,
          opts.now,
          opts.expiresAt,
        );
      return { request: this.getA2hRequest(id)!, replayed: false };
    });
  }

  getA2hRequest(id: string): A2hRequest | undefined {
    const row = this.db
      .prepare<{
        id: string;
        agent_id: string;
        person_id: string;
        conversation_id: string;
        kind: string;
        state: string;
        payload: string;
        answer: string | null;
        approval_id: string | null;
        idempotency_key: string | null;
        created_at: number;
        expires_at: number;
        decided_at: number | null;
        decided_by: string | null;
        version: number;
      }>(
        "SELECT id, agent_id, person_id, conversation_id, kind, state, payload, answer, approval_id, idempotency_key, created_at, expires_at, decided_at, decided_by, version FROM a2h_request WHERE id = ?",
      )
      .get(id);
    if (!row) return undefined;
    return {
      id: row.id,
      agentId: row.agent_id,
      personId: row.person_id,
      conversationId: row.conversation_id,
      kind: row.kind as A2hRequestKind,
      state: row.state as A2hRequest["state"],
      payload: JSON.parse(row.payload) as unknown,
      answer: row.answer === null ? undefined : (JSON.parse(row.answer) as unknown),
      approvalId: row.approval_id ?? undefined,
      idempotencyKey: row.idempotency_key ?? undefined,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      decidedAt: row.decided_at ?? undefined,
      decidedBy: row.decided_by ?? undefined,
      version: row.version,
    };
  }

  a2hRequestByApproval(approvalId: string): A2hRequest | undefined {
    const row = this.db.prepare<{ id: string }>("SELECT id FROM a2h_request WHERE approval_id = ?").get(approvalId);
    return row ? this.getA2hRequest(row.id) : undefined;
  }

  /** CAS pending → terminal. Returns undefined if already terminal (idempotent). */
  decideA2hRequest(
    id: string,
    state: A2hTerminalState,
    decidedBy: string,
    now: number,
    answer?: unknown,
  ): A2hRequest | undefined {
    const current = this.getA2hRequest(id);
    if (!current || current.state !== "pending") return undefined;
    const res = this.db
      .prepare(
        "UPDATE a2h_request SET state = ?, decided_by = ?, decided_at = ?, answer = COALESCE(?, answer), version = version + 1 WHERE id = ? AND state = 'pending' AND version = ?",
      )
      .run(state, decidedBy, now, answer === undefined ? null : JSON.stringify(answer), id, current.version);
    if (res.changes !== 1) return undefined;
    return this.getA2hRequest(id);
  }

  /** Sweeper for a2h requests past `expires_at`. */
  expireDueA2hRequests(now: number): A2hRequest[] {
    const due = this.db
      .prepare<{ id: string }>("SELECT id FROM a2h_request WHERE state = 'pending' AND expires_at <= ?")
      .all(now);
    return due
      .map(({ id }) => this.decideA2hRequest(id, "expired", "expired", now))
      .filter((r): r is A2hRequest => Boolean(r));
  }

  /** Boot (Q4): every open a2h request becomes `expired`, regardless of TTL. */
  expirePendingA2hRequests(now: number, reason = "restart"): A2hRequest[] {
    const open = this.db.prepare<{ id: string }>("SELECT id FROM a2h_request WHERE state = 'pending'").all();
    return open
      .map(({ id }) => this.decideA2hRequest(id, "expired", reason, now))
      .filter((r): r is A2hRequest => Boolean(r));
  }

  pendingA2hRequests(): A2hRequest[] {
    return this.db
      .prepare<{ id: string }>("SELECT id FROM a2h_request WHERE state = 'pending'")
      .all()
      .map(({ id }) => this.getA2hRequest(id))
      .filter((r): r is A2hRequest => Boolean(r));
  }

  /** Append-only audit trail. Never pass tokens in `detail`. */
  audit(entry: {
    at: number;
    action: string;
    result: string;
    agentId?: string;
    personId?: string;
    requestId?: string;
    detail?: unknown;
  }): void {
    this.db
      .prepare(
        "INSERT INTO audit_log(at, agent_id, action, person_id, request_id, result, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        entry.at,
        entry.agentId ?? null,
        entry.action,
        entry.personId ?? null,
        entry.requestId ?? null,
        entry.result,
        entry.detail === undefined ? null : JSON.stringify(entry.detail),
      );
  }

  auditEntries(): Array<{ action: string; result: string; agentId?: string; personId?: string; requestId?: string; detail?: string }> {
    return this.db
      .prepare<{
        action: string;
        result: string;
        agent_id: string | null;
        person_id: string | null;
        request_id: string | null;
        detail: string | null;
      }>("SELECT action, result, agent_id, person_id, request_id, detail FROM audit_log ORDER BY id")
      .all()
      .map((r) => ({
        action: r.action,
        result: r.result,
        agentId: r.agent_id ?? undefined,
        personId: r.person_id ?? undefined,
        requestId: r.request_id ?? undefined,
        detail: r.detail ?? undefined,
      }));
  }

  identityKey = identityKey;
  groupKey = groupKey;
}
