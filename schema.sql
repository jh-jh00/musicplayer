CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT,
  name TEXT,
  picture TEXT,
  created_at INTEGER NOT NULL,
  google_refresh_token TEXT
);

CREATE TABLE IF NOT EXISTS player_state (
  user_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS access_codes (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  redeemed_by TEXT,
  redeemed_at INTEGER,
  expires_at INTEGER,
  FOREIGN KEY (redeemed_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_access_codes_redeemed_by ON access_codes(redeemed_by);

-- 유튜브 API 응답 캐시 (할당량 절약용. 지워도 기능은 동작한다)
CREATE TABLE IF NOT EXISTS api_cache (
  cache_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_cache_expires_at ON api_cache(expires_at);
