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

export const AUDIT_SCHEMA_VERSION = 1;

/** One neutral a2h event (schema v1). Secrets are never written here. */
export interface A2hEvent {
  v: number;
  /** Monotonic cursor. */
  id: number;
  at: number;
  agentId?: string;
  action: string;
  personId?: string;
  requestId?: string;
  object?: string;
  bindingHash?: string;
  decision: string;
  detail?: unknown;
}

type AuditRow = {
  id: number;
  at: number;
  agent_id: string | null;
  action: string;
  person_id: string | null;
  request_id: string | null;
  result: string;
  detail: string | null;
  v: number | null;
  object: string | null;
  binding_hash: string | null;
};

type MessageRow = {
  id: string;
  seq: number;
  role: string;
  surface: string | null;
  content: string;
  created_at: number;
  author: string | null;
  request_id: string | null;
};

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
CREATE TABLE IF NOT EXISTS person_credential (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  kind TEXT NOT NULL,
  secret_enc BLOB,
  public_key BLOB,
  code_hash TEXT,
  last_step INTEGER,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS person_credential_person ON person_credential(person_id, kind);
CREATE TABLE IF NOT EXISTS approval_stepup (
  request_id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  method TEXT NOT NULL,
  surface TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE TABLE IF NOT EXISTS auth_failure (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id TEXT,
  at INTEGER NOT NULL,
  kind TEXT
);
CREATE INDEX IF NOT EXISTS auth_failure_person ON auth_failure(person_id, at);
CREATE TABLE IF NOT EXISTS owner_claim (
  code_hash TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER
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
      // a2h identity (PR 2.5), additive only.
      "ALTER TABLE identity ADD COLUMN linked_via TEXT",
      "ALTER TABLE approval ADD COLUMN required_level TEXT",
      "ALTER TABLE approval ADD COLUMN decided_level TEXT",
      "ALTER TABLE a2h_request ADD COLUMN risk TEXT",
      "ALTER TABLE a2h_request ADD COLUMN stepup_requested_at INTEGER",
      "ALTER TABLE a2h_request ADD COLUMN action_hash TEXT",
      "ALTER TABLE agent ADD COLUMN approval_level TEXT",
      // hub (PR 3): agent token lifecycle, additive only.
      "ALTER TABLE agent ADD COLUMN expires_at INTEGER",
      "ALTER TABLE agent ADD COLUMN prev_token_hash TEXT",
      "ALTER TABLE agent ADD COLUMN prev_expires_at INTEGER",
      "ALTER TABLE agent ADD COLUMN bind TEXT",
      // Neutral, append-only a2h event log (schema v1).
      "ALTER TABLE audit_log ADD COLUMN v INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE audit_log ADD COLUMN object TEXT",
      "ALTER TABLE audit_log ADD COLUMN binding_hash TEXT",
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
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE INDEX IF NOT EXISTS audit_log_agent ON audit_log(agent_id, id);
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
      .prepare<{
        platform: string;
        account_id: string;
        user_id: string;
        person_id: string;
        linked_at: number | null;
        linked_via: string | null;
      }>(
        "SELECT platform, account_id, user_id, person_id, linked_at, linked_via FROM identity WHERE platform = ? AND account_id = ? AND user_id = ?",
      )
      .get(platform, accountId, userId);
    if (!row) return undefined;
    return {
      platform: row.platform,
      accountId: row.account_id,
      userId: row.user_id,
      personId: row.person_id,
      linkedAt: row.linked_at ?? undefined,
      linkedVia: row.linked_via ?? "legacy",
    };
  }

  /** Insert-only. Refuses to re-point an existing identity to another person. */
  linkIdentity(
    personId: string,
    platform: string,
    accountId: string,
    userId: string,
    now: number,
    via = "pair",
  ): boolean {
    const existing = this.findIdentity(platform, accountId, userId);
    if (existing) return existing.personId === personId;
    try {
      this.db
        .prepare(
          "INSERT INTO identity(platform, account_id, user_id, person_id, linked_at, linked_via) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(platform, accountId, userId, personId, now, via);
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
      this.linkIdentity(person.id, platform, accountId, userId, now, "legacy");
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
          .prepare<MessageRow>(
            "SELECT id, seq, role, surface, content, created_at, author, request_id FROM message WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?",
          )
          .all(conversationId, limit)
          .reverse()
      : this.db
          .prepare<MessageRow>(
            "SELECT id, seq, role, surface, content, created_at, author, request_id FROM message WHERE conversation_id = ? ORDER BY seq",
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
        author: m.author ?? undefined,
        requestId: m.request_id ?? undefined,
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
    author?: string;
    requestId?: string;
  }): LogMessage {
    return this.db.transaction(() => {
      const seqRow = this.db
        .prepare<{ n: number }>("SELECT COALESCE(MAX(seq), 0) AS n FROM message WHERE conversation_id = ?")
        .get(opts.conversationId);
      const seq = (seqRow?.n ?? 0) + 1;
      const id = newId("m");
      this.db
        .prepare(
          "INSERT INTO message(id, conversation_id, seq, role, surface, content, created_at, author, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          opts.conversationId,
          seq,
          opts.role,
          opts.surface ? JSON.stringify(opts.surface) : null,
          JSON.stringify({ text: opts.text }),
          opts.now,
          opts.author ?? null,
          opts.requestId ?? null,
        );
      return {
        id,
        seq,
        role: opts.role,
        text: opts.text,
        surface: opts.surface,
        createdAt: opts.now,
        author: opts.author,
        requestId: opts.requestId,
      };
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
    extra: { targetPersonId?: string; expiresAt?: number; source?: "pi" | "agent"; requiredLevel?: string } = {},
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
      requiredLevel: extra.requiredLevel,
      cards: [],
    };
    this.db
      .prepare(
        "INSERT INTO approval(id, conversation_id, tool_call, state, version, cards, requested_by, created_at, target_person_id, expires_at, source, required_level) VALUES (?, ?, ?, 'pending', 1, ?, ?, ?, ?, ?, ?, ?)",
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
        extra.requiredLevel ?? null,
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
        required_level: string | null;
        decided_level: string | null;
      }>(
        "SELECT id, conversation_id, tool_call, state, version, cards, requested_by, chosen, decided_by, decided_at, created_at, target_person_id, expires_at, source, required_level, decided_level FROM approval WHERE id = ?",
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
      requiredLevel: row.required_level ?? undefined,
      decidedLevel: row.decided_level ?? undefined,
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
    decidedLevel?: string,
  ): PendingApproval | undefined {
    const current = this.getApproval(id);
    if (!current || current.state !== "pending") return undefined;
    const updated = this.db
      .prepare(
        "UPDATE approval SET state = ?, decided_by = ?, decided_at = ?, chosen = ?, decided_level = ?, version = version + 1 WHERE id = ? AND state = 'pending' AND version = ?",
      )
      .run(state, decidedBy, now, chosen ?? state, decidedLevel ?? null, id, current.version);
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

  /** Token material for auth. Hashes only; the clear token is never stored. */
  agentAuth(id: string):
    | {
        id: string;
        name: string;
        tokenHash: string;
        expiresAt?: number;
        prevTokenHash?: string;
        prevExpiresAt?: number;
        revokedAt?: number;
        bind?: string;
      }
    | undefined {
    const r = this.db
      .prepare<{
        id: string;
        name: string;
        token_hash: string;
        expires_at: number | null;
        prev_token_hash: string | null;
        prev_expires_at: number | null;
        revoked_at: number | null;
        bind: string | null;
      }>(
        "SELECT id, name, token_hash, expires_at, prev_token_hash, prev_expires_at, revoked_at, bind FROM agent WHERE id = ?",
      )
      .get(id);
    if (!r) return undefined;
    return {
      id: r.id,
      name: r.name,
      tokenHash: r.token_hash,
      expiresAt: r.expires_at ?? undefined,
      prevTokenHash: r.prev_token_hash ?? undefined,
      prevExpiresAt: r.prev_expires_at ?? undefined,
      revokedAt: r.revoked_at ?? undefined,
      bind: r.bind ?? undefined,
    };
  }

  setAgentLifecycle(id: string, opts: { expiresAt?: number; bind?: string }): void {
    this.db
      .prepare("UPDATE agent SET expires_at = ?, bind = COALESCE(?, bind) WHERE id = ?")
      .run(opts.expiresAt ?? null, opts.bind ?? null, id);
  }

  /** Rotate: new hash becomes current; the old one stays valid until `prevExpiresAt`. */
  rotateAgentToken(id: string, newHash: string, expiresAt: number, prevExpiresAt: number): boolean {
    return (
      this.db
        .prepare(
          "UPDATE agent SET prev_token_hash = token_hash, prev_expires_at = ?, token_hash = ?, expires_at = ? WHERE id = ? AND revoked_at IS NULL",
        )
        .run(prevExpiresAt, newHash, expiresAt, id).changes === 1
    );
  }

  listAgents(): Array<{
    id: string;
    name: string;
    createdAt: number;
    expiresAt?: number;
    revokedAt?: number;
    approvalLevel?: string;
    bind?: string;
  }> {
    return this.db
      .prepare<{
        id: string;
        name: string;
        created_at: number;
        expires_at: number | null;
        revoked_at: number | null;
        approval_level: string | null;
        bind: string | null;
      }>("SELECT id, name, created_at, expires_at, revoked_at, approval_level, bind FROM agent ORDER BY created_at")
      .all()
      .map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: r.created_at,
        expiresAt: r.expires_at ?? undefined,
        revokedAt: r.revoked_at ?? undefined,
        approvalLevel: r.approval_level ?? undefined,
        bind: r.bind ?? undefined,
      }));
  }

  agentGrants(agentId: string): Array<{ personId: string; scopes: A2hScope[] }> {
    return this.db
      .prepare<{ person_id: string; scopes: string }>("SELECT person_id, scopes FROM agent_grant WHERE agent_id = ?")
      .all(agentId)
      .map((r) => ({ personId: r.person_id, scopes: JSON.parse(r.scopes) as A2hScope[] }));
  }

  /** Remove every IM binding of a person (owner reset). Returns how many were removed. */
  unlinkAllIdentities(personId: string): number {
    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM presence WHERE person_id = ?").run(personId);
      return this.db.prepare("DELETE FROM identity WHERE person_id = ?").run(personId).changes;
    });
  }

  auditSince(since: number): Array<{
    at: number;
    action: string;
    result: string;
    agentId?: string;
    personId?: string;
    requestId?: string;
    detail?: string;
  }> {
    return this.db
      .prepare<{
        at: number;
        action: string;
        result: string;
        agent_id: string | null;
        person_id: string | null;
        request_id: string | null;
        detail: string | null;
      }>("SELECT at, action, result, agent_id, person_id, request_id, detail FROM audit_log WHERE at >= ? ORDER BY id")
      .all(since)
      .map((r) => ({
        at: r.at,
        action: r.action,
        result: r.result,
        agentId: r.agent_id ?? undefined,
        personId: r.person_id ?? undefined,
        requestId: r.request_id ?? undefined,
        detail: r.detail ?? undefined,
      }));
  }

  /** Set the current token hash (initial mint). Clears any previous token. */
  setAgentToken(id: string, tokenHash: string, expiresAt: number): void {
    this.db
      .prepare("UPDATE agent SET token_hash = ?, expires_at = ?, prev_token_hash = NULL, prev_expires_at = NULL WHERE id = ?")
      .run(tokenHash, expiresAt, id);
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
    /** What the event is about (e.g. "approval", "ask", "agent:<name>", "identity"). */
    object?: string;
    /** sha256 of the bound action object, when there is one. Never the object itself if secret. */
    bindingHash?: string;
  }): void {
    let agentId = entry.agentId;
    let object = entry.object;
    let bindingHash = entry.bindingHash;
    if (entry.requestId && (!agentId || !object || !bindingHash)) {
      const r = this.db
        .prepare<{ agent_id: string; kind: string; action_hash: string | null }>(
          "SELECT agent_id, kind, action_hash FROM a2h_request WHERE id = ?",
        )
        .get(entry.requestId);
      if (r) {
        agentId ??= r.agent_id;
        object ??= r.kind;
        bindingHash ??= r.action_hash ?? undefined;
      }
    }
    this.db
      .prepare(
        "INSERT INTO audit_log(at, agent_id, action, person_id, request_id, result, detail, v, object, binding_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        entry.at,
        agentId ?? null,
        entry.action,
        entry.personId ?? null,
        entry.requestId ?? null,
        entry.result,
        entry.detail === undefined ? null : JSON.stringify(entry.detail),
        AUDIT_SCHEMA_VERSION,
        object ?? null,
        bindingHash ?? null,
      );
  }

  /**
   * Cursor read of the neutral event log. `cursor` is the last id seen
   * (0 = from the start). Optionally scoped to one agent.
   */
  eventsAfter(cursor: number, opts: { agentId?: string; limit?: number } = {}): A2hEvent[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
    const rows = opts.agentId
      ? this.db
          .prepare<AuditRow>("SELECT * FROM audit_log WHERE id > ? AND agent_id = ? ORDER BY id LIMIT ?")
          .all(cursor, opts.agentId, limit)
      : this.db.prepare<AuditRow>("SELECT * FROM audit_log WHERE id > ? ORDER BY id LIMIT ?").all(cursor, limit);
    return rows.map((r) => ({
      v: r.v ?? 1,
      id: r.id,
      at: r.at,
      agentId: r.agent_id ?? undefined,
      action: r.action,
      personId: r.person_id ?? undefined,
      requestId: r.request_id ?? undefined,
      object: r.object ?? undefined,
      bindingHash: r.binding_hash ?? undefined,
      decision: r.result,
      detail: r.detail ? (JSON.parse(r.detail) as unknown) : undefined,
    }));
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

  /**
   * The per-agent topic for a person (Q1). Never changes the active topic;
   * `/topic agent:<name>` finds it by title like any other topic.
   */
  agentConversation(personId: string, agentId: string, title: string, now: number): ConversationSnapshot {
    return this.db.transaction(() => {
      const existing = this.db
        .prepare<{ id: string }>("SELECT id FROM conversation WHERE person_id = ? AND agent_id = ?")
        .get(personId, agentId);
      if (existing) return this.snapshot(existing.id);
      const byTitle = this.db
        .prepare<{ id: string }>(
          "SELECT id FROM conversation WHERE person_id = ? AND title = ? AND is_default = 0 AND agent_id IS NULL",
        )
        .get(personId, title);
      if (byTitle) {
        // A human-created topic with this title is adopted rather than shadowed.
        this.db.prepare("UPDATE conversation SET agent_id = ? WHERE id = ?").run(agentId, byTitle.id);
        return this.snapshot(byTitle.id);
      }
      const id = newId("c");
      this.db
        .prepare(
          "INSERT INTO conversation(id, person_id, group_key, title, is_default, created_at, agent_id) VALUES (?, ?, NULL, ?, 0, ?, ?)",
        )
        .run(id, personId, title, now, agentId);
      return this.snapshot(id);
    });
  }

  agentByName(name: string): AgentRecord | undefined {
    const row = this.db.prepare<{ id: string }>("SELECT id FROM agent WHERE name = ?").get(name);
    return row ? this.getAgent(row.id) : undefined;
  }

  /** Persons whose name matches exactly (case-insensitive). */
  personsByName(name: string): PersonRecord[] {
    return this.db
      .prepare<{ id: string; name: string | null }>("SELECT id, name FROM person WHERE lower(name) = lower(?)")
      .all(name.trim())
      .map((r) => ({ id: r.id, name: r.name ?? undefined }));
  }

  setA2hApprovalId(requestId: string, approvalId: string): void {
    this.db.prepare("UPDATE a2h_request SET approval_id = ? WHERE id = ?").run(approvalId, requestId);
  }

  setA2hPromptMessage(requestId: string, messageId: string): void {
    this.db.prepare("UPDATE a2h_request SET prompt_message_id = ? WHERE id = ?").run(messageId, requestId);
  }

  setA2hAnswerMessage(requestId: string, messageId: string): void {
    this.db.prepare("UPDATE a2h_request SET answer_message_id = ? WHERE id = ?").run(messageId, requestId);
  }

  a2hPromptMessageId(requestId: string): string | undefined {
    return (
      this.db
        .prepare<{ prompt_message_id: string | null }>("SELECT prompt_message_id FROM a2h_request WHERE id = ?")
        .get(requestId)?.prompt_message_id ?? undefined
    );
  }

  /** Request whose prompt was delivered as this platform message (quote-reply routing). */
  a2hRequestByDelivery(chat: ChatRef, platformMsgId: string): A2hRequest | undefined {
    const row = this.db
      .prepare<{ request_id: string | null }>(
        `SELECT m.request_id AS request_id FROM delivery d JOIN message m ON m.id = d.message_id
         WHERE d.platform = ? AND d.account_id = ? AND d.chat_id = ? AND d.platform_msg_id = ?
         ORDER BY d.id DESC LIMIT 1`,
      )
      .get(chat.platform, chat.accountId, chat.chatId, platformMsgId);
    return row?.request_id ? this.getA2hRequest(row.request_id) : undefined;
  }

  /** The latest message the bot delivered into this chat (any source). */
  lastDeliveryInChat(chat: ChatRef): { messageId: string; requestId?: string; createdAt: number } | undefined {
    const row = this.db
      .prepare<{ message_id: string; request_id: string | null; created_at: number }>(
        `SELECT d.message_id AS message_id, m.request_id AS request_id, m.created_at AS created_at
         FROM delivery d JOIN message m ON m.id = d.message_id
         WHERE d.platform = ? AND d.account_id = ? AND d.chat_id = ?
         ORDER BY d.id DESC LIMIT 1`,
      )
      .get(chat.platform, chat.accountId, chat.chatId);
    return row ? { messageId: row.message_id, requestId: row.request_id ?? undefined, createdAt: row.created_at } : undefined;
  }

  deliveriesFor(messageId: string): Array<{ chat: ChatRef; messageId: string }> {
    return this.db
      .prepare<{ platform: string; account_id: string; chat_id: string; platform_msg_id: string | null }>(
        "SELECT platform, account_id, chat_id, platform_msg_id FROM delivery WHERE message_id = ? ORDER BY id",
      )
      .all(messageId)
      .filter((r) => r.platform_msg_id)
      .map((r) => ({
        chat: { platform: r.platform, accountId: r.account_id, chatId: r.chat_id, kind: "dm" as const },
        messageId: r.platform_msg_id!,
      }));
  }

  openA2hRequests(personId: string, kind?: A2hRequestKind): A2hRequest[] {
    const rows = kind
      ? this.db
          .prepare<{ id: string }>(
            "SELECT id FROM a2h_request WHERE person_id = ? AND kind = ? AND state = 'pending' ORDER BY created_at, id",
          )
          .all(personId, kind)
      : this.db
          .prepare<{ id: string }>(
            "SELECT id FROM a2h_request WHERE person_id = ? AND state = 'pending' ORDER BY created_at, id",
          )
          .all(personId);
    return rows.map(({ id }) => this.getA2hRequest(id)).filter((r): r is A2hRequest => Boolean(r));
  }

  // ---- a2h identity (PR 2.5). Never log secrets or codes from here. -------

  totpCredential(personId: string): { id: string; secretEnc: Uint8Array; lastStep?: number } | undefined {
    const row = this.db
      .prepare<{ id: string; secret_enc: Uint8Array; last_step: number | null }>(
        "SELECT id, secret_enc, last_step FROM person_credential WHERE person_id = ? AND kind = 'totp' AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
      )
      .get(personId);
    return row ? { id: row.id, secretEnc: row.secret_enc, lastStep: row.last_step ?? undefined } : undefined;
  }

  /** Revoke all TOTP + recovery credentials and store fresh ones (sealed secret, recovery hashes). */
  replaceCredentials(personId: string, sealedSecret: Uint8Array, recoveryHashes: string[], now: number): void {
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE person_credential SET revoked_at = ? WHERE person_id = ? AND revoked_at IS NULL")
        .run(now, personId);
      this.db
        .prepare("INSERT INTO person_credential(id, person_id, kind, secret_enc, created_at) VALUES (?, ?, 'totp', ?, ?)")
        .run(newId("cr"), personId, sealedSecret, now);
      const ins = this.db.prepare(
        "INSERT INTO person_credential(id, person_id, kind, code_hash, created_at) VALUES (?, ?, 'recovery', ?, ?)",
      );
      for (const h of recoveryHashes) ins.run(newId("cr"), personId, h, now);
    });
  }

  /** CAS: only move last_step forward. False means a concurrent/replayed use. */
  advanceTotpStep(credentialId: string, step: number): boolean {
    return (
      this.db
        .prepare(
          "UPDATE person_credential SET last_step = ? WHERE id = ? AND revoked_at IS NULL AND (last_step IS NULL OR last_step < ?)",
        )
        .run(step, credentialId, step).changes === 1
    );
  }

  consumeRecoveryCode(personId: string, codeHash: string, now: number): boolean {
    return (
      this.db
        .prepare(
          "UPDATE person_credential SET revoked_at = ? WHERE person_id = ? AND kind = 'recovery' AND code_hash = ? AND revoked_at IS NULL",
        )
        .run(now, personId, codeHash).changes === 1
    );
  }

  recordAuthFailure(personId: string, now: number, kind: string): void {
    this.db.prepare("INSERT INTO auth_failure(person_id, at, kind) VALUES (?, ?, ?)").run(personId, now, kind);
  }

  authFailures(personId: string, since: number): number {
    return this.db
      .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM auth_failure WHERE person_id = ? AND at >= ?")
      .get(personId, since)!.n;
  }

  recordStepUp(requestId: string, personId: string, method: string, surface: ChatRef, now: number): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO approval_stepup(request_id, person_id, method, surface, verified_at, consumed_at) VALUES (?, ?, ?, ?, ?, NULL)",
      )
      .run(requestId, personId, method, JSON.stringify(surface), now);
  }

  liveStepUp(requestId: string, personId: string): boolean {
    return Boolean(
      this.db
        .prepare<{ n: number }>(
          "SELECT 1 AS n FROM approval_stepup WHERE request_id = ? AND person_id = ? AND consumed_at IS NULL",
        )
        .get(requestId, personId),
    );
  }

  consumeStepUp(requestId: string, now: number): void {
    this.db
      .prepare("UPDATE approval_stepup SET consumed_at = ? WHERE request_id = ? AND consumed_at IS NULL")
      .run(now, requestId);
  }

  markStepUpRequested(requestId: string, now: number): void {
    this.db
      .prepare("UPDATE a2h_request SET stepup_requested_at = COALESCE(stepup_requested_at, ?) WHERE id = ?")
      .run(now, requestId);
  }

  stepUpRequested(requestId: string): boolean {
    return Boolean(
      this.db
        .prepare<{ t: number | null }>("SELECT stepup_requested_at AS t FROM a2h_request WHERE id = ?")
        .get(requestId)?.t,
    );
  }

  setA2hRisk(requestId: string, risk: string | undefined): void {
    this.db.prepare("UPDATE a2h_request SET risk = ? WHERE id = ?").run(risk ?? null, requestId);
  }

  /** Per-agent downgrade ('im_account' = button only). NULL = default (verified under TOTP). */
  setAgentApprovalLevel(agentId: string, level: "im_account" | "verified" | null): void {
    this.db.prepare("UPDATE agent SET approval_level = ? WHERE id = ?").run(level, agentId);
  }

  agentApprovalLevel(agentId: string | undefined): "im_account" | "verified" | undefined {
    if (!agentId) return undefined;
    const v = this.db
      .prepare<{ l: string | null }>("SELECT approval_level AS l FROM agent WHERE id = ?")
      .get(agentId)?.l;
    return v === "im_account" || v === "verified" ? v : undefined;
  }

  /** One-time first-bind code from `owner init` (stored hashed). */
  createOwnerClaim(personId: string, code: string, now: number, ttlMs: number): void {
    this.db
      .prepare("INSERT INTO owner_claim(code_hash, person_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(hashPairCode(code), personId, now + ttlMs, now);
  }

  liveOwnerClaim(code: string, now: number): string | undefined {
    return (
      this.db
        .prepare<{ person_id: string }>(
          "SELECT person_id FROM owner_claim WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?",
        )
        .get(hashPairCode(code), now)?.person_id ?? undefined
    );
  }

  consumeOwnerClaim(code: string, now: number): boolean {
    return (
      this.db
        .prepare("UPDATE owner_claim SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?")
        .run(now, hashPairCode(code), now).changes === 1
    );
  }

  identityKey = identityKey;
  groupKey = groupKey;
}
