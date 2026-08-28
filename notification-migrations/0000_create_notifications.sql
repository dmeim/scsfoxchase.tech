CREATE TABLE IF NOT EXISTS notifications (
  owner_key TEXT NOT NULL,
  notification_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('success', 'warning', 'info', 'error')),
  icon_name TEXT NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  description TEXT,
  toast_persist INTEGER NOT NULL DEFAULT 0 CHECK (toast_persist IN (0, 1)),
  dedupe_key TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  read_at TEXT,
  PRIMARY KEY (owner_key, notification_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_owner_dedupe
  ON notifications(owner_key, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_owner_active
  ON notifications(owner_key, expires_at, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_expiry
  ON notifications(expires_at);
