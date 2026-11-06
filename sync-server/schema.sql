-- Beayy sync-only backend.
-- Payload data is compressed and end-to-end encrypted by clients; R2 stores ciphertext only.
-- D1 stores account credentials metadata, device sessions, and blob indexes.

CREATE TABLE IF NOT EXISTS users (
  user TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  created INTEGER NOT NULL,
  email TEXT,
  salt TEXT,
  kdf TEXT,
  auth_hash TEXT,
  wrapped_key TEXT,
  recovery_hash TEXT,
  fails INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  display_name TEXT,
  avatar TEXT,
  profile_updated INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (email);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  name TEXT NOT NULL,
  device TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user);

CREATE TABLE IF NOT EXISTS blobs (
  user TEXT NOT NULL,
  device TEXT NOT NULL,
  segment TEXT NOT NULL,
  size INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY (user, device, segment)
);

CREATE INDEX IF NOT EXISTS blobs_updated ON blobs (user, updated);
CREATE INDEX IF NOT EXISTS blobs_seg ON blobs (user, segment);
