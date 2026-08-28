-- Enforce the owner marker's non-null primary key constraint.
--
-- SQLite cannot alter a column's NOT NULL property in place, so rebuild the
-- small marker table. Rows with a null owner_key are invalid markers from the
-- preview-era schema and are intentionally not carried into the repaired
-- table; all valid markers are preserved.

CREATE TABLE library_owner_imports__repaired (
  owner_key TEXT NOT NULL PRIMARY KEY,
  imported_at TEXT NOT NULL,
  import_version INTEGER NOT NULL
);

INSERT INTO library_owner_imports__repaired (
  owner_key,
  imported_at,
  import_version
)
SELECT owner_key, imported_at, import_version
FROM library_owner_imports
WHERE owner_key IS NOT NULL;

DROP TABLE library_owner_imports;

ALTER TABLE library_owner_imports__repaired
  RENAME TO library_owner_imports;
