import type { ChatRef } from "@imwire/core";
import { groupKey, identityKey, newId, pairCode } from "./ids.js";
import { openSqlite, type SqlDatabase } from "./sqlite.js";
import type {
  ConversationSnapshot,
  IdentityRecord,
  LogMessage,
  PendingApproval,
  PersonRecord,
} from "./types.js";

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
  used_at INTEGER
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
  cards TEXT
);
CREATE TABLE IF NOT EXISTS presence (
  person_id TEXT PRIMARY KEY REFERENCES person(id),
  last_surface TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL
);
`;

export class SessionStore {
  readonly db: SqlDatabase;

  constructor(path: string) {
    this.db = openSqlite(path);
    try {
      this.db.exec("PRAGMA journal_mode = WAL");
    } catch {
      // :memory: or node:sqlite without file
    }
    this.db.exec(SCHEMA);
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

  linkIdentity(personId: string, platform: string, accountId: string, userId: string, now: number): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO identity(platform, account_id, user_id, person_id, linked_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(platform, accountId, userId, personId, now);
  }

  createPairCode(
    personId: string,
    createdBy: string,
    expiresAt: number,
    now: number,
    maxPerWindow: number,
    windowMs: number,
  ): string | "rate_limited" {
    const created = this.db
      .prepare<{ n: number }>(
        "SELECT COUNT(*) AS n FROM pairing WHERE created_by = ? AND created_at >= ?",
      )
      .get(createdBy, now - windowMs);
    if ((created?.n ?? 0) >= maxPerWindow) return "rate_limited";
    for (let i = 0; i < 20; i += 1) {
      const code = pairCode();
      try {
        this.db
          .prepare("INSERT INTO pairing(code, person_id, expires_at, created_at, created_by) VALUES (?, ?, ?, ?, ?)")
          .run(code, personId, expiresAt, now, createdBy);
        return code;
      } catch {
        // collision
      }
    }
    throw new Error("could not allocate pairing code");
  }

  consumePairCode(code: string, now: number): string | undefined {
    const row = this.db
      .prepare<{ person_id: string; expires_at: number; used_at: number | null }>(
        "SELECT person_id, expires_at, used_at FROM pairing WHERE code = ?",
      )
      .get(code);
    if (!row || row.used_at !== null || row.expires_at <= now) return undefined;
    const updated = this.db
      .prepare("UPDATE pairing SET used_at = ? WHERE code = ? AND used_at IS NULL AND expires_at > ?")
      .run(now, code, now);
    if (updated.changes !== 1) return undefined;
    return row.person_id;
  }

  defaultConversation(personId: string, now: number): ConversationSnapshot {
    const existing = this.db
      .prepare<{ id: string; title: string }>(
        "SELECT id, title FROM conversation WHERE person_id = ? AND is_default = 1",
      )
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

  snapshot(conversationId: string): ConversationSnapshot {
    const conv = this.db
      .prepare<{ id: string; person_id: string | null; group_key: string | null; title: string; is_default: number }>(
        "SELECT id, person_id, group_key, title, is_default FROM conversation WHERE id = ?",
      )
      .get(conversationId);
    if (!conv) throw new Error(`unknown conversation ${conversationId}`);
    const messages = this.db
      .prepare<{ id: string; seq: number; role: string; surface: string | null; content: string; created_at: number }>(
        "SELECT id, seq, role, surface, content, created_at FROM message WHERE conversation_id = ? ORDER BY seq",
      )
      .all(conversationId)
      .map((m) => {
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
    return {
      id: conv.id,
      personId: conv.person_id ?? undefined,
      groupKey: conv.group_key ?? undefined,
      title: conv.title,
      isDefault: conv.is_default === 1,
      messages,
    };
  }

  appendMessage(opts: {
    conversationId: string;
    role: LogMessage["role"];
    text: string;
    surface?: ChatRef;
    now: number;
  }): LogMessage {
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

  createApproval(conversationId: string, toolCallId: string, title: string, options: string[]): PendingApproval {
    const id = newId("a");
    const rec: PendingApproval = {
      id,
      conversationId,
      toolCallId,
      title,
      options,
      version: 1,
      state: "pending",
      cards: [],
    };
    this.db
      .prepare("INSERT INTO approval(id, conversation_id, tool_call, state, version, cards) VALUES (?, ?, ?, 'pending', 1, ?)")
      .run(id, conversationId, JSON.stringify({ toolCallId, title, options }), "[]");
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
      }>("SELECT id, conversation_id, tool_call, state, version, cards FROM approval WHERE id = ?")
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
      cards: row.cards ? (JSON.parse(row.cards) as PendingApproval["cards"]) : [],
    };
  }

  setApprovalCards(id: string, cards: PendingApproval["cards"]): void {
    this.db.prepare("UPDATE approval SET cards = ? WHERE id = ?").run(JSON.stringify(cards), id);
  }

  pendingApprovals(conversationId: string): PendingApproval[] {
    return this.db
      .prepare<{ id: string }>("SELECT id FROM approval WHERE conversation_id = ? AND state = 'pending'")
      .all(conversationId)
      .map((r) => this.getApproval(r.id))
      .filter((a): a is PendingApproval => Boolean(a));
  }

  decideApproval(id: string, decision: "approved" | "denied", decidedBy: string, now: number): PendingApproval | undefined {
    const current = this.getApproval(id);
    if (!current || current.state !== "pending") return undefined;
    const updated = this.db
      .prepare(
        "UPDATE approval SET state = ?, decided_by = ?, decided_at = ?, version = version + 1 WHERE id = ? AND state = 'pending' AND version = ?",
      )
      .run(decision, decidedBy, now, id, current.version);
    if (updated.changes !== 1) return undefined;
    return this.getApproval(id);
  }

  identityKey = identityKey;
}
