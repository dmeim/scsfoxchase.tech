# Whiteboard D1 library operations

This runbook covers the staged R2-index → D1 metadata cutover. It is for an operator or release maintainer, not for normal application traffic.

## Invariants

- The live Excalidraw scene stays in each board's SQLite-backed `WhiteboardBoard` Durable Object.
- `WHITEBOARD_LIBRARY` contains only signed-in Library / Recents / Assets metadata. It contains no scene JSON or media bytes.
- R2 remains the store for preview bytes and the compatibility source for legacy media. Historical `library/{ownerKey}/boards.json` and `library/{ownerKey}/assets.json` objects are retained as read-only migration/recovery sources.
- New image/video insertion remains disabled. Do not delete historical R2 objects as part of this work.
- `status.scsfoxchase.tech` is out of scope.

## Resources and migration order

| Environment | D1 name / identity | Selection |
|---|---|---|
| Production | `scsfoxchase-tech-whiteboard-library` | `WHITEBOARD_LIBRARY` without `--preview` |
| Remote preview | `scsfoxchase-tech-whiteboard-library-preview` | `WHITEBOARD_LIBRARY` with `--remote --preview` |
| Test/local | `scsfoxchase-tech-whiteboard-library-worker-tests` | `tests/worker/wrangler.jsonc`, local only |

The production and preview IDs are configuration values in `wrangler.jsonc`; do not copy them into scripts or docs. The additive migrations must apply in this order:

1. `0000_create_whiteboard_library.sql` — board/asset metadata and owner-import marker tables.
2. `0001_enforce_library_owner_imports_owner_key.sql` — repairs the marker table's owner-key constraint.
3. `0002_add_library_tombstones.sql` — deletion barriers for concurrent lazy imports.

Apply local first, then remote preview, then production. Applying production D1 and importing R2 indexes are separate steps. Production migration, backfill, and Worker deployment are not assumed complete by this runbook.

## Preflight and migration

Use Wrangler 4.x from the repository. The commands below are the supported forms verified with `npx wrangler d1 migrations --help` and `npx wrangler d1 execute --help`:

```bash
npx wrangler d1 migrations list WHITEBOARD_LIBRARY --local
npx wrangler d1 migrations apply WHITEBOARD_LIBRARY --local

npx wrangler d1 migrations list WHITEBOARD_LIBRARY --remote --preview
npx wrangler d1 migrations apply WHITEBOARD_LIBRARY --remote --preview

npx wrangler d1 migrations list WHITEBOARD_LIBRARY --remote
# After preview verification and explicit release approval:
npx wrangler d1 migrations apply WHITEBOARD_LIBRARY --remote
```

`apply` prompts for confirmation and captures a backup. Stop if the migration list, database name, or target mode is not the one intended. Never apply the production command with `--preview`, and never use a production database ID in local test configuration.

Verify the schema without writing data:

```bash
npx wrangler d1 execute WHITEBOARD_LIBRARY --remote --preview --command "SELECT name FROM d1_migrations ORDER BY id"
npx wrangler d1 execute WHITEBOARD_LIBRARY --remote --preview --command "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'library_%' ORDER BY name"
```

The `d1 list` inventory (including `num_tables`) is only a resource hint, not schema evidence. Treat the migration list and the `sqlite_master` query above as authoritative, and run them separately against the production binding after its approved migration.

Repeat both commands without `--preview` for production only after production migration approval. Do not use `--yes` for the migration apply unless the operator is intentionally running a non-interactive, reviewed change.

## Admin secret handling

The operator client is `scripts/whiteboard-library-operator.mjs`. It sends the admin secret only in an `Authorization` header. Supply `WHITEBOARD_ADMIN_SECRET` through a protected environment/secret manager, or omit it in an interactive TTY and use the script's masked prompt. Never put the secret in an argument, URL, manifest, checkpoint, shell history, or log. The script rejects `--secret`.

The admin route must be configured with `WHITEBOARD_ADMIN_SECRET`; if it is absent, the endpoint returns `503`. The route is bounded to 25 objects per scan/import page and does not write R2, Durable Objects, or KV.

The commands below use the stable direct Worker origin `https://scsfoxchase-tech.dimitri-meimaridis.workers.dev`. It bypasses the zone's managed challenge for CLI traffic while still targeting the same deployed Worker; bearer authentication is unchanged. Set `WHITEBOARD_OPERATOR_URL` or pass `--base-url` to use another permitted origin. Use the custom domain only when its WAF permits CLI requests.

## Read-only scan (dry run)

`scan` is the dry-run operation: it lists only exact `library/{ownerKey}/boards.json` and `library/{ownerKey}/assets.json` R2 objects, validates JSON, counts valid/invalid/duplicate entries, and records object ETags and SHA-256 values. It does not mutate R2 or D1. There is intentionally no `--dry-run` flag; do not invent one.

```bash
node scripts/whiteboard-library-operator.mjs scan \
  --base-url https://scsfoxchase-tech.dimitri-meimaridis.workers.dev \
  --manifest ./ops/whiteboard-library-manifest.json \
  --checkpoint ./ops/whiteboard-library-manifest.json.checkpoint.json
```

The scan checkpoints after every page and can be rerun with the same manifest path. Review `valid`, `invalid`, `duplicates`, `reasonCodes`, and the object `etag`/`sha256` values. Do not import until invalid objects are understood and the source objects are stable.

## Explicit, resumable import

Import is a deliberate, optional pre-seed action and requires `--confirm-import`. The server re-reads every manifest object and refuses to import if its ETag or SHA-256 differs from the scan, if the source fails validation, or if the owner identity is unresolved. A successful page is recorded in the checkpoint; rerunning the command skips already imported object keys. Source R2 objects remain unchanged.

```bash
node scripts/whiteboard-library-operator.mjs import \
  --base-url https://scsfoxchase-tech.dimitri-meimaridis.workers.dev \
  --manifest ./ops/whiteboard-library-manifest.json \
  --checkpoint ./ops/whiteboard-library-import.checkpoint.json \
  --confirm-import
```

Operator pre-seeding inserts only validated rows idempotently and honors tombstones. It must not write `library_owner_imports`: a global operator cannot resolve the authenticated canonical Google identity versus the legacy Clerk fallback. The first authenticated library access performs the canonical/legacy lazy merge and is the only path that finalizes that owner's import marker. Therefore a completed operator import alone never means an owner is fully cut over. A changed source returns a conflict; rescan rather than overriding it. Keep the manifest and checkpoint protected because they contain migration metadata, even though they do not contain the admin secret.

## Verify counts and representatives

Do not record expected counts until the scan result is reviewed. After import, inspect D1 with read-only SQL. Use `--preview` while validating preview and omit it for production:

```bash
npx wrangler d1 execute WHITEBOARD_LIBRARY --remote --preview --command "SELECT 'library_boards' AS table_name, COUNT(*) AS row_count FROM library_boards UNION ALL SELECT 'library_assets', COUNT(*) FROM library_assets UNION ALL SELECT 'library_owner_imports', COUNT(*) FROM library_owner_imports UNION ALL SELECT 'library_board_tombstones', COUNT(*) FROM library_board_tombstones UNION ALL SELECT 'library_asset_tombstones', COUNT(*) FROM library_asset_tombstones"
npx wrangler d1 execute WHITEBOARD_LIBRARY --remote --preview --command "SELECT name FROM d1_migrations ORDER BY id"
npx wrangler d1 execute WHITEBOARD_LIBRARY --remote --preview --command "SELECT import_version, COUNT(*) AS owner_count FROM library_owner_imports GROUP BY import_version ORDER BY import_version"
```

Compare D1 row counts with the valid scan entries, then check representative owners, board IDs, asset IDs, timestamps, preview references, and tombstones through targeted, protected queries or the authenticated Library API; do not paste owner identifiers into shared logs. Treat `library_owner_imports` as the count of owners finalized by authenticated lazy import, not as a count of operator-imported objects. Verify owner isolation through the authenticated Library API and confirm that an authenticated first access completes the expected marker. Repeat the checks against production only after its migration/import has been explicitly approved. Keep the source R2 object count, ETag, and SHA-256 manifest as the audit record.

## No-clobber D1 export

Export is an emergency recovery artifact: it reads paginated D1 rows, checkpoints each page, and writes a new rollback-compatible directory containing `library/{ownerKey}/boards.json` and `assets.json`. It refuses an existing output directory or file and never writes to R2. Choose a new, protected output directory and checkpoint each time. Page fragments are kept in the deterministic checkpoint sibling `<checkpoint>.export-work-<operationId>` until finalization; the generated operation ID is recorded in the checkpoint.

```bash
node scripts/whiteboard-library-operator.mjs export \
  --base-url https://scsfoxchase-tech.dimitri-meimaridis.workers.dev \
  --output ./ops/whiteboard-d1-export-YYYYMMDD-HHMM \
  --checkpoint ./ops/whiteboard-d1-export-YYYYMMDD-HHMM.checkpoint.json \
  --limit 25
```

For `export`, `--checkpoint` defaults to `<output>.checkpoint.json`; the command above names it explicitly. The output path must not already exist. If the command is interrupted, rerun the same command with the same output and checkpoint paths; it resumes from durable page fragments without refetching completed pages. Do not delete or edit the checkpoint or its operation-specific `.export-work-<operationId>` directory until the export reports completion.

The completed output also contains the hidden `.whiteboard-library-export-<operationId>.json` ownership/audit marker. It is used to prove operation ownership during crash-safe no-clobber resume. This marker is local audit metadata, not an R2 source index; never upload it as `boards.json` or `assets.json`. Verify the number of exported rows and representative metadata before treating the artifact as a recovery source. Do not replace the original R2 source indexes with the export.

## Rollback

If validation or import fails:

1. Stop the import and preserve the manifest, checkpoints, and original R2 source indexes.
2. Read the error, correct the source or release decision, and rescan. Do not bypass ETag/SHA checks or remove tombstones.
3. If the deployed D1-backed Worker must be backed out, export D1 to a new no-clobber directory first.
4. Roll back application code through the reviewed GitHub Workers Build on `main` so the previous known-good Worker can read its intended source. Do not run `npx wrangler deploy` from a laptop. D1 migrations are additive; do not edit or delete migration history to manufacture a down migration.
5. Verify the resulting Worker SHA, library behavior, scene persistence, legacy media reads, and share-code/role paths. Keep D1 and R2 intact until the incident review is complete.

The export is not an automatic route switch. A code rollback and a data recovery decision are separate approvals. Never delete historical R2 objects, Durable Objects, KV share-code mappings, or D1 rows as a first response.

## Release and post-deploy verification

Before merging a Worker cutover:

```bash
npm run build
npx wrangler versions upload
```

`versions upload` creates a preview version and does not take production traffic. Production is deployed only by GitHub Workers Builds on `main`; the dashboard Deploy command remains `npx wrangler deploy`. Apply and verify production D1 before pushing the cutover commit. After Workers Builds finishes, verify the live code before interpreting any observation:

```bash
curl -fsS https://scsfoxchase-tech.dimitri-meimaridis.workers.dev/api/whiteboard/version
```

The returned `sha` must match the expected commit and `builtAt` must be plausible. Smoke-test signed-in Library CRUD/save/claim, preview retention, legacy media reads, WebSocket scene persistence/ack/retry, share-code joins, roles, scratch expiry, and offline boundaries. Check that new image/video insertion remains disabled.

## Observability

Wrangler observability is enabled with structured logs, `invocation_logs: false`, and production head sampling `0.05` (5%). The application emits low-cardinality events for connection admission/auth transitions, throttles, scene rejection/persistence failures, and bounded D1/R2/KV storage failures. It intentionally does not log pings or every successful update.

Logs exclude board/session identifiers, IP addresses, URLs/paths, host/origin values, JWTs, host secrets, arbitrary exception strings, and scene contents. Use event category, backend, operation, status, and retryability—not raw payloads—to correlate an incident. The status site is not part of this runbook.
