-- agents-production 資料表（D1）
-- 部署：wrangler d1 execute prod-agent-db --file=./schema.sql

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT 'chat',
  rpm_limit INTEGER,
  revoked_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (key_hash);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 1,
  limit_value INTEGER NOT NULL,
  PRIMARY KEY (bucket_key, window_start)
);

-- 用量統計（best-effort；帳務精準度請用 Cloudflare Logpush / Workers AI 用量 API）
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  request_id TEXT,
  session TEXT,
  principal TEXT,
  model TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  latency_ms INTEGER,
  status TEXT
);

CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events (ts);
