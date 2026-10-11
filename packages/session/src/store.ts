import type { ChatRef } from "@imwire/core";
import { groupKey, hashPairCode, identityKey, newId, pairCode } from "./ids.js";
import { openSqlite, type SqlDatabase } from "./sqlite.js";
import type {
  ConversationMeta,
  ConversationSnapshot,
  IdentityRecord,
  LogMessage,
  PendingApproval,
  PersonRecord,
} from "./types.js";

export const PAIR_ATTEMPT_LIMIT = 5;
export const PAIR_CODE_ATTEMPT_LIMIT = 5;
export const PAIR_WINDOW_MS = 10 * 60 * 1000;
export const GROUP_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_LOG_WINDOW = 40;

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
  }

  private migrate(): void {
    const alters = [
      "ALTER TABLE approval ADD COLUMN requested_by TEXT",
      "ALTER TABLE approval ADD COLUMN chosen TEXT",
      "ALTER TABLE approval ADD COLUMN created_at INTEGER",
      "ALTER TABLE pairing ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE interrupt_notice ADD COLUMN last_seq INTEGER NOT NULL DEFAULT 0",
    ];
    for (const sql of alters) {
      try {
        this.db.exec(sql);
      } catch {
        // column exists
      }
    }
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

  /** Increment the per-code counter for a live hash. Burns only that row at the limit. */
  recordCodeMiss(code: string, now: number): { burned: true; personId: string } | undefined {
    const hashed = hashPairCode(code);
    const row = this.db
      .prepare<{ person_id: string; used_at: number | null; expires_at: number; attempts: number }>(
        "SELECT person_id, used_at, expires_at, attempts FROM pairing WHERE code = ?",
      )
      .get(hashed);
    if (!row || row.used_at !== null || row.expires_at <= now) return undefined;
    const next = row.attempts + 1;
    if (next >= PAIR_CODE_ATTEMPT_LIMIT) {
      this.db.prepare("UPDATE pairing SET used_at = ?, attempts = ? WHERE code = ? AND used_at IS NULL").run(now, next, hashed);
      return { burned: true, personId: row.person_id };
    }
    this.db.prepare("UPDATE pairing SET attempts = ? WHERE code = ?").run(next, hashed);
    return undefined;
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

  getCallback(hash: string): { id: string; value?: string } | undefined {
    const row = this.db
      .prepare<{ action_id: string; value: string | null }>(
        "SELECT action_id, value FROM telegram_callback WHERE hash = ?",
      )
      .get(hash);
    if (!row) return undefined;
    return { id: row.action_id, value: row.value ?? undefined };
  }

  setCallback(hash: string, entry: { id: string; value?: string }, now = Date.now()): void {
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
      cards: [],
    };
    this.db
      .prepare(
        "INSERT INTO approval(id, conversation_id, tool_call, state, version, cards, requested_by, created_at) VALUES (?, ?, ?, 'pending', 1, ?, ?, ?)",
      )
      .run(id, conversationId, JSON.stringify({ toolCallId, title, options }), "[]", requestedBy ?? null, now);
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
        created_at: number | null;
      }>(
        "SELECT id, conversation_id, tool_call, state, version, cards, requested_by, chosen, created_at FROM approval WHERE id = ?",
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
      createdAt: row.created_at ?? undefined,
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

  identityKey = identityKey;
  groupKey = groupKey;
}
