# Whiteboard prime-time hardening

Permanent production work only. Preserve these invariants throughout:

- Live Excalidraw scene data stays in each board's SQLite-backed Durable Object.
- D1 stores signed-in Library / Recents / Assets metadata only.
- R2 continues to store previews and serve legacy media compatibility reads.
- New image/video insertion stays disabled; do not revive the rolled-back upload design.
- Preserve the 4,000-element and 2,000,000-byte scene limits, current Clerk roles, Group Edit, share codes, scratch lifetime, and viewer semantics.
- Never write from a read/poll path, never log JWTs/host secrets/scene contents, and never delete historical R2 objects during migration.
- `status.scsfoxchase.tech` is out of scope.

## 1. D1 library metadata

- [x] Provision a dedicated production D1 database and configure a `WHITEBOARD_LIBRARY` binding plus isolated test/preview binding.
- [x] Add an additive, indexed D1 schema for normalized board rows, asset rows, and idempotent owner-import markers; no media or scene blobs.
- [x] Add a server-only D1 library store with bound parameters, canonical/legacy owner merging, monotonic timestamps, preview retention, owner isolation, and explicit error propagation.
- [x] Cut the existing library board/asset routes and DO library-membership lookup over to D1 without changing public API, Clerk, role, save/claim, delete, preview, or share-code semantics.
- [x] Add an idempotent R2 JSON -> D1 import tool with dry-run validation and a tested D1 -> R2 emergency export; never mutate/delete the source R2 indexes.
- [x] Cover binding drift, CRUD, canonical/legacy import precedence, reruns, malformed source data, D1 failures, ownership, preview references, and deletion with real Worker/D1 integration tests.

## 2. Durable Object abuse, concurrency, and migration safety

- [x] Prevent random unauthenticated UUID connection floods from causing unbounded DO/KV writes while preserving legitimate UUID viewers and signed-out scratch creators; add bounded connect throttling/admission tests.
- [x] Serialize first-time share-code minting so concurrent callers produce exactly one active code and one KV mapping without redundant writes.
- [x] Replace destructive automatic `tldraw_*` table wiping with an explicit non-destructive migration policy; mixed-schema fixtures must never lose a valid Excalidraw scene.
- [x] Keep constructor/cold-wake paths free of schema/storage writes and retain idle zero-write guarantees.

## 3. Reliable, bounded scene protocol

- [x] Add mutation IDs plus server acknowledgements so the client retires changes only after durable persistence and retries transient `persist_failed` updates after reconnect/backoff without echo loops.
- [x] Make oversized/permanent failures terminal and user-visible so they do not retry forever.
- [x] Enforce the 2,000,000-byte cap using UTF-8 bytes, reject oversized WebSocket frames before JSON parsing, and return explicit errors for malformed scene elements/envelopes.
- [x] Add failure-injection, reconnect, duplicate-mutation, Unicode-boundary, oversized-frame, malformed-element, writer-exclusion, multi-tab idle, and unchanged 4,000-element cap tests.

## 4. Worker/R2/security hardening

- [x] Remove unauthenticated global temp-expiry scans from request/upload paths; move cleanup behind bounded authenticated/scheduled maintenance and prove uploads cannot trigger bucket-wide scans.
- [x] Centralize allowed-origin CORS and JSON security/cache headers for Worker API responses; hostile origins must not be reflected and whiteboard API responses must be `no-store`/`nosniff` where applicable.
- [x] Eliminate host-secret query-string transport from normal clients/proxies while retaining only the minimum safe compatibility handling required for old links; add leakage regression tests.
- [x] Add sanitized structured observability for connection/auth outcomes, throttles, scene size/persistence errors, and D1/R2/KV failures without logging credentials or board contents.
- [ ] Require a positive board-owner match for saved-board asset writes, make share-code revocation a prerequisite for successful library deletion, keep Clerk `azp` fixed-origin only, and translate all legacy query proof to scrubbed internal headers.
- [ ] Reject malformed operator scan pages before checkpoint advancement and bound/sanitize authenticated JSON/admin maintenance paths.

## 5. Client, preview, and offline durability

- [x] Make preview capture/upload single-flight and version-deduplicated so overlapping idle/pagehide triggers perform one R2 PUT and one metadata update.
- [x] Eliminate repeated library reads from preview upsert while preserving preview URLs and signed-in-only behavior.
- [x] Add service-worker regression coverage for API bypass, activation/cache cleanup, network-first navigation, offline fallback, and completion of cache writes; preserve the intentional policy.

## 6. Documentation, validation, and production rollout

- [x] Update architecture, environment, deployment, whiteboard storage/auth docs, generated binding types, and operator runbook to describe D1 metadata, migration/export, observability, and unchanged media boundaries.
- [ ] Run the full test suite, type/config checks, production build, secret scan, and adversarial review; fix every task-related failure without weakening tests.
- [ ] Apply and verify local/preview D1 migrations, upload a non-production Worker version, and smoke-test the preview.
- [ ] Dry-run the retained production R2 indexes against preview D1; after deployment, rely on authenticated canonical-owner lazy import and use marker-free operator pre-seeding only when an authorized operator secret is available.
- [ ] Apply the production D1 migration, commit all intended files only, push `main`, and let GitHub Workers Builds deploy production.
- [ ] Confirm the Workers Build succeeds and `/api/whiteboard/version` reports the pushed commit; live-smoke signed-in Library CRUD/save/claim, preview, legacy media reads, WebSocket persistence/retry, share code, roles, scratch board, and offline behavior.
- [ ] Compare quiet/active Cloudflare metrics for DO/D1/KV/R2 errors and write amplification; record any external dashboard-only follow-up without changing the status site.
