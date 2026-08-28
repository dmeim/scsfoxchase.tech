-- Whiteboard library metadata only.
--
-- Live Excalidraw scenes remain in each board's Durable Object SQLite store.
-- R2 remains the source of preview/media bytes and legacy compatibility files.
-- These tables intentionally contain no scene, image, video, or other blobs.

CREATE TABLE IF NOT EXISTS library_boards (
  owner_key TEXT NOT NULL,
  board_id TEXT NOT NULL,
  title TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL,
  preview_data_url TEXT,
  PRIMARY KEY (owner_key, board_id)
);

-- Recents and library reads always stay isolated to one owner.
CREATE INDEX IF NOT EXISTS library_boards_owner_recent
  ON library_boards (owner_key, last_accessed_at DESC);

CREATE TABLE IF NOT EXISTS library_assets (
  owner_key TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER,
  r2_key TEXT NOT NULL,
  source_board_ids_json TEXT,
  PRIMARY KEY (owner_key, asset_id)
);

-- Asset listings are owner-scoped and ordered by most recent use.
CREATE INDEX IF NOT EXISTS library_assets_owner_recent
  ON library_assets (owner_key, last_accessed_at DESC);

-- One marker per owner and schema/import version makes an R2 -> D1 import
-- idempotent. The source R2 indexes remain untouched for rollback/recovery.
CREATE TABLE IF NOT EXISTS library_owner_imports (
  owner_key TEXT PRIMARY KEY,
  imported_at TEXT NOT NULL,
  import_version INTEGER NOT NULL
);
