-- Durable, cross-conversation memory. Every row is scoped by client_id.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL,
  title       TEXT NOT NULL,
  created_at  TEXT NOT NULL,   -- ISO 8601 UTC
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_client ON conversations(client_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  rowid_int       INTEGER PRIMARY KEY AUTOINCREMENT,  -- FTS content rowid
  id              TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  client_id       TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content         TEXT NOT NULL,
  created_at_utc  TEXT NOT NULL,   -- ISO 8601 UTC, lexicographically sortable
  tz              TEXT NOT NULL,   -- user's IANA tz at the time (for rendering "Monday 9 Nov" later)
  plan_json       TEXT NULL,       -- assistant only: the validated plan
  sources_json    TEXT NULL        -- assistant only: cited sources [{n,title,url,published_date,retrieved_at}]
);
CREATE INDEX IF NOT EXISTS idx_msg_client_time ON messages(client_id, created_at_utc);
CREATE INDEX IF NOT EXISTS idx_msg_conv_time ON messages(conversation_id, created_at_utc);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='rowid_int',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid_int, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid_int, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid_int, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid_int, new.content);
END;
