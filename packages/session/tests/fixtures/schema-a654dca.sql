-- Session schema as of main a654dca (pre-a2h). Used by the upgrade test.
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
