-- Keep an explicit deletion barrier for lazy R2 -> D1 imports.
--
-- Importing an old R2 snapshot and deleting a live row are separate Worker
-- requests.  A tombstone makes the delete durable in D1, so an import that
-- started in another Worker isolate cannot recreate the deleted row after
-- the delete commits.  An explicit authenticated PUT clears the tombstone
-- in the same D1 batch as its upsert; preview PATCHes never clear it.

CREATE TABLE IF NOT EXISTS library_board_tombstones (
  owner_key TEXT NOT NULL,
  board_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (owner_key, board_id)
);

CREATE INDEX IF NOT EXISTS library_board_tombstones_owner
  ON library_board_tombstones (owner_key);

CREATE TABLE IF NOT EXISTS library_asset_tombstones (
  owner_key TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (owner_key, asset_id)
);

CREATE INDEX IF NOT EXISTS library_asset_tombstones_owner
  ON library_asset_tombstones (owner_key);
