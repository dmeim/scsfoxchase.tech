# R2 rollback and Cloudflare usage postmortem

> **Historical recovery snapshot (2026-08-27):** The image/R2 redesign introduced after `81242d2` was removed by `e6f2eec`; the remaining Durable Object cold-wake write was removed by `6720789`. The SHA and production checks below document that earlier recovery, not the current D1 cutover. Verify the current live SHA and migration state before relying on them; production D1 migration, R2 backfill, and cutover deployment are not claimed complete here. New image/video insertion remains intentionally disabled. Existing media remains readable.

This is the canonical handoff for the rollback, the Cloudflare usage incident, and the safeguards that must survive future work. The older [incident history](./image-r2-incident-history.md) and [fix plan](./image-r2-fix-plan.md) are detailed historical evidence, not instructions for the current runtime.

## Executive summary

Three failures overlapped:

1. **Image durability was not reliable.** Several versions could paint an image locally before R2 had a durable copy, publish a scene reference too early, or block normal Excalidraw placement behind upload state.
2. **The redesign amplified Cloudflare writes.** A full-scene echo/flush loop repeatedly UPSERTed the entire `scene_json`. A separate eight-second metadata poll repeatedly rewrote share-code KV state.
3. **The final `Connecting…` outage was a Durable Object quota failure.** Production logs showed `Exceeded allowed rows written in Durable Objects free tier.` Both `/connect` and `/meta` failed before the board handshake could complete.

The recovery was deliberately not a blind Git revert. It restored the simpler `81242d2`-era scene/media architecture while keeping independent correctness and usage fixes. A second commit then removed schema inspection/DDL from every Durable Object constructor wake.

The Workers Paid upgrade helped the exhausted account resume writes once the entitlement propagated. It did **not** prove that the abandoned R2 image code was correct: the R2 usage dashboard was far below its included operation limits, while the Durable Object row-write limit was the resource that failed.

## Incident evidence

### Cloudflare dashboard snapshot

The dashboard snapshot on 2026-08-27 showed usage accumulated while the broken versions were live:

| Metric | Observed | Interpretation |
|---|---:|---|
| Durable Object requests | 227.3k | High for the small deployment and consistent with polling/reconnect/write amplification |
| Durable Object duration | 404 GB-s | Elevated alongside the request loop |
| SQLite rows read | 291.91k | Historical total for the period |
| SQLite rows written | 217.24k | The critical signal; production also emitted the explicit Free-tier row-write error |
| SQLite stored data | 2.23 MB | Storage size was not the problem |
| R2 Class A operations | 600 | Far below the 1 million/month Standard-storage free allowance at the time |
| R2 Class B operations | 4.31k | Far below the 10 million/month allowance at the time |
| R2 storage | 0 GB-month (rounded) | R2 capacity was not exhausted |

At the incident date, Cloudflare documented 100,000 SQLite rows written/day on Workers Free, with further operations of that type failing until the daily reset. `put`, `delete`, and `setAlarm` also count as rows written for SQLite-backed Durable Objects. Workers Paid included 50 million rows written/month before overage. Treat those numbers as a dated snapshot and re-check [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) before making a future cost decision.

R2's dated allowances and rates are in [R2 pricing](https://developers.cloudflare.com/r2/pricing/). The incident's R2 counts were nowhere near those allowances.

### Production failure and recovery

After `e6f2eec` deployed, boards could still remain on `Connecting…`. A live `wrangler tail` showed `/connect` and `/meta` failing in `listUserSqlTables` from the `WhiteboardBoard` constructor with:

```text
Exceeded allowed rows written in Durable Objects free tier.
```

That established two facts:

- the immediate board-loading outage was Cloudflare rejecting Durable Object storage work, not an Excalidraw rendering or service-worker failure;
- running schema discovery/migration from every constructor wake made even an otherwise read-only existing-board connection depend on write quota.

Workers Paid and R2 Paid were confirmed active on the same Cloudflare account. Entitlement propagation was not instantaneous, but the error stopped after propagation and the `6720789` cold-wake safeguard deployed.

## Commit timeline

| Commit | Date | What changed | Outcome |
|---|---|---|---|
| `657a896` | Aug 13 | First owner-key R2 media path: `assets/{ownerKey}/{assetId}`; Excalidraw painted from memory and PUT followed | Existing media could survive, but local paint was not proof of a completed upload |
| `72c22b2` | Aug 26 | Added board-scoped R2 objects, a DO manifest, IndexedDB outbox, and `asset_not_ready` scene gate | Scene references could publish before staging/upload; full-scene echo also produced an approximately 9 Hz whole-scene UPSERT loop |
| `2a612f7` | Aug 26 | Mirrored legacy owner-key PUTs into board-scoped storage for leftover tabs | Compatibility-only; irrelevant after all tabs refreshed |
| `0cfc5c2` | Aug 26 | Made scene publication default-deny until upload readiness | Staged too early in Excalidraw's click-to-place flow, causing empty/flickering canvas and stuck saving states |
| `12f06f5` | Aug 26 | Restored paint-first behavior and removed writer echo | Fixed part of the loop but did not solve all handshake/image failures |
| `f74692b` | Aug 27 | Added immediate `wb:auth`, bounded auth resolution, mint-once codes, `GET /meta` no-mint behavior, identical-write skipping, and alarm guards | Valuable independent fixes; production still had unresolved image/Connecting reports |
| `a1e9489` | Aug 27 | Large handshake and image redesign with SHA-256 IDs, manifest-independent reads, and a real Worker test harness | Build passed, but an old production board still stayed on `Connecting…`; production/old-board/real-Clerk coverage was missing |
| `3d6144a` | Aug 27 | Documentation-only record of the failed `a1e9489` round | No runtime recovery |
| `e6f2eec` | Aug 27 | Removed the post-`81242d2` image write stack, retained safe usage fixes, disabled new media insertion, and bounded remaining client traffic | Correct rollback architecture deployed, but the already-exhausted quota plus constructor schema work still blocked connections |
| `6720789` | Aug 27 | Removed storage/SQL from the DO constructor; made lifetime/schema setup lazy and coalesced; added safe legacy/v2 reads | Production recovered and was verified live |

## What was rolled back

`e6f2eec` removed the post-`81242d2` board-scoped write design rather than trying to repair it in place.

Removed behavior and code included:

- board-scoped R2 `PUT` and `DELETE`;
- the `whiteboard_asset_manifest` Durable Object table and manifest RPCs;
- the fail-closed `asset_not_ready` scene gate;
- the IndexedDB upload outbox (`whiteboard-upload-outbox.ts`);
- scene-publication filtering and the abandoned pre-rollback acknowledgement design;
- board write-proof helpers and the `roleResolved` / `authResult` additions;
- the file sync planner and SHA-256 upload pipeline;
- tests that asserted the removed manifest/outbox/write-proof architecture;
- new image, GIF, MP4, and WebM insertion from the live canvas.

No board scene or R2 bucket was wiped. The rollback intentionally kept compatibility reads so objects created by any of the attempted upload versions can still render if their bytes exist.

## Current storage behavior

### Scene data

- One board UUID maps to one SQLite-backed `WhiteboardBoard` Durable Object.
- The live scene is `{ elements, appState }` in one `excalidraw_scene` row with a `scene_json` column.
- `serializeAsJSON(..., {}, "database")` does not put binary files in the scene JSON.
- Scene persistence is no longer conditional on an R2 manifest.

### Existing media

| Namespace | Current behavior |
|---|---|
| `assets/{ownerKey}/{assetId}` | Legacy owner-key GET/HEAD plus established authenticated PUT/DELETE compatibility. `google:{accountId}` is saved media; `temp:{boardId}` is scratch media. Save/claim can move temp objects to Google ownership. |
| `boards/{boardId}/assets/{fileId}` | Compatibility GET/HEAD only. UUID and 64-character content-hash IDs are accepted. PUT/DELETE return `405`. No manifest or DO lookup occurs. |

Hydration tries the board-scoped compatibility object first, then legacy owner-key locations. Existing `/whiteboard-player` links remain supported. Board-scoped objects left by the abandoned rollout are not deleted.

### New media

The Excalidraw image tool is hidden and local image/video paste, drag, and drop insertion are blocked. This is a safety boundary, not a browser bug. Do not remove it until a replacement R2 design passes the checklist later in this document.

Other legitimate storage activity still exists: signed-in board and asset metadata writes use D1, while board previews, legacy owner-key operations, and temp-to-Google claim use R2. Historical `library/{ownerKey}/boards.json` and `assets.json` objects remain read-only source indexes for migration/recovery. Therefore R2 Class A usage should be low, not necessarily zero.

## Cloudflare usage safeguards now live

### Durable Object cold wakes and schema work

`src/worker/WhiteboardBoard.ts` now follows these rules:

- The constructor only installs the platform WebSocket ping/pong auto-response. It performs no SQL, `storage.get`, or `storage.put`.
- `ensureBoardLifetime` coalesces simultaneous `/meta` and WebSocket initialization through one `lifetimeInitialization` promise per object lifetime.
- Existing boards with `meta:boardId` do not rescan `sqlite_master` or execute schema DDL on every cold wake.
- Canonical `scene_json` reads are read-only. Schema migration is deferred until an actual scene write needs it.
- A board left only in the temporary `excalidraw_scene_v2` table can be read without a migration write.
- If both the authoritative legacy table and a partial v2 table exist, the legacy scene wins.
- SQL inspection errors propagate. A quota/storage failure is never converted into an empty scene that could later overwrite real work.

Tests in `tests/whiteboard-board-lifetime.test.ts` cover constructor write-freedom, one-time initialization, v2-only recovery, legacy-over-v2 precedence, and no redundant table creation.

### Scene writes and broadcasts

- `persistScene` compares the exact serialized scene with `lastPersistedJson`; an identical blob skips the SQLite UPSERT.
- A merge with genuinely accepted element changes forces one persist, so the optimization does not drop real edits.
- Empty or stale updates are ignored.
- Scene size remains bounded at 4,000 elements and 2,000,000 UTF-8 bytes.
- Persistence succeeds before broadcast. Accepted mutation IDs receive `scene:ack`; transient failures remain eligible for bounded reconnect retry, while terminal failures emit `wb:error` instead of advertising unsaved state.
- Full and incremental broadcasts exclude the originating writer.
- The client uses a trailing approximately one-second edit flush and sends only increased element versions during normal editing.

The 25-second application ping is answered by `setWebSocketAutoResponse`, so ping/pong does not wake Durable Object JavaScript. A 30-second full-scene resync still exists for convergence; on an unchanged scene it may wake the DO, but exact-blob comparison prevents another SQL scene write.

### Share-code KV

- An existing `meta:activeCode` is returned without rewriting the KV mapping.
- A leftover expiry key is deleted only when it actually exists.
- `GET /api/whiteboard/boards/:uuid/meta` passes `mintShareCode: false`; it does not read or write `WHITEBOARD_CODES`.
- New minting is rate-limited and samples at most 24 candidates.
- Join lookup has per-IP and failed-code rate limits with bounded in-memory maps.

This prevents the old eight-second read-path poll from consuming the KV write budget.

### Metadata, alarms, reconnects, and library touches

- Canvas metadata refresh is event-driven: initial mount, focus, auth change, `wb:hello`, and one delayed post-hello refresh. Concurrent refreshes are coalesced. There is no continuous eight-second poll.
- Reconnect delay is exponential from 500 ms to a maximum of 60 seconds.
- Auth is sent immediately from cached host/token state; signed-in token retries are bounded to 60 seconds.
- Alarm scheduling compares the existing alarm and skips an equivalent `setAlarm`; it deletes only a real stale alarm.
- Repeated title, saved-state, expiry, temporary-prefix, and Group Edit updates are checked before storage mutation.
- The board page binds one scratch-claim/touch owner. Opening a joined board without a host secret does not add it to Recents, and touching an existing row without a new title does not rewrite that board row.

Relevant tests include:

- `tests/whiteboard-usage.test.ts`
- `tests/whiteboard-board-lifetime.test.ts`
- `tests/worker/idle-board.test.ts`
- `tests/worker/reconnect-kv.test.ts`
- `tests/worker/writer-echo.test.ts`
- `tests/worker/scene-cold-do.test.ts`
- `tests/worker/board-assets.test.ts`

## Expected usage baseline

Use this table when deciding whether a graph is normal or a regression.

| Situation | Expected activity |
|---|---|
| Board open and idle | One long-lived WebSocket; platform-handled ping/pong; 30-second convergence messages may invoke the DO, but unchanged scenes should not add SQLite scene rows |
| User draws | One trailing client flush after the burst; accepted changes produce a scene UPSERT and broadcast to other sockets |
| Page focus/auth/hello | A small number of coalesced metadata reads, not an eight-second stream |
| Existing share code | DO metadata read; no KV PUT |
| First use of a new board | One-time scene schema/lifetime metadata and unsaved alarm setup |
| Existing board after DO eviction | Read scene and metadata without constructor DDL |
| New canvas image/video attempt | Blocked in the client; no board-scoped R2 PUT |
| Existing media display | R2 Class B read from board compatibility or legacy owner-key object |

Red flags:

- SQLite rows written rising while every board is idle;
- repeated `WHITEBOARD_CODES.put` for an existing code or from `GET /meta`;
- board-scoped asset PUT/DELETE returning anything other than `405` before a reviewed media redesign;
- frequent Class A R2 operations with no library, preview, claim, or explicit legacy upload activity;
- reconnect attempts staying near ten seconds during a prolonged outage instead of reaching the 60-second ceiling;
- the Free-tier row-write error on an account that the dashboard says is Paid;
- a storage/read exception followed by an empty board scene.

## Historical production validation (pre-D1 cutover)

For the older recovery release `6720789` (not a current cutover-status claim):

- `npm test`: 12 files, 49 tests passed;
- `npm run build`: passed;
- `npm run preview:upload`: passed, Worker preview version `1f4f7a88-9bff-4d06-8f23-1f089f627fbd`;
- GitHub Workers Build `3f3fe0fd-6e07-441d-aeb2-9f8a03cf3f38`: success;
- live `/api/whiteboard/version`: `6720789ce878`, built `2026-08-27T18:35:40.988Z`;
- a known existing board's `/meta`: HTTP 200;
- the real production board loaded Excalidraw and cleared `Connecting…`;
- one fresh UUID initialized with HTTP 200 and a 24-hour scratch expiry, proving new-board DO writes worked after Paid entitlement propagation;
- browser diagnostics contained no board error, only normal service-worker registration logs.

## Operator runbook

### Verify the deployed code first

```bash
curl -fsS https://scsfoxchase-tech.dimitri-meimaridis.workers.dev/api/whiteboard/version
```

Do not diagnose a browser observation until the returned SHA matches the commit being discussed. GitHub Workers Builds on `main` is the only production deployer. Use `npm run preview:upload` before merging; do not deploy production from a laptop.

### If boards stay on `Connecting…`

1. Check `/api/whiteboard/version`.
2. Request `/api/whiteboard/boards/{known-board-uuid}/meta` once. A 500 here points below the browser handshake.
3. Reload one board once; do not create a reconnect storm across many tabs.
4. Run a short, bounded `npx wrangler tail` and capture the exact exception, UTC time, and Ray ID.
5. In Cloudflare, open **Durable Objects → `scsfoxchase-tech_WhiteboardBoard` → Metrics/Logs**. Inspect requests, errors, duration, rows read/written, and stored bytes. Cloudflare documents the dashboard and GraphQL datasets in [DO metrics and analytics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/).
6. If the Paid subscription is active but Cloudflare still reports a Free-tier quota error after propagation time, open a paid support case. Include the Worker, DO class/namespace, live version, exact error, UTC timestamps, Ray IDs, and proof of the active subscription.

Do **not** delete/recreate the Durable Object namespace or call the admin wipe endpoint as quota recovery. Neither fixes account entitlement, and both risk board data.

### Cost controls

- Review **Manage Account → Billing → Billable Usage** after releases that alter WebSockets, storage, alarms, library writes, or R2.
- Create multiple low-dollar budget alerts. Cloudflare budget alerts apply to projected account-level usage spend across products, not only the product page where the alert was created. See [Billable Usage and Budget alerts](https://developers.cloudflare.com/changelog/post/2026-04-13-billable-usage-dashboard-and-budget-alerts/).
- Compare a quiet period before and after the release. Absolute billing-period totals include old broken versions and cannot validate a new fix by themselves.
- Filter Durable Object metrics to a single board/object when isolating a hot room; analytics can have ingestion delay and sampling.

## Known limitations after recovery

- New image/video insertion is still disabled. Image durability has not been solved.
- The 30-second full resync is still intentional DO activity, although unchanged persistence is skipped.
- A client `wb:error` displays a throttled toast. Transient `persist_failed` updates are retried on reconnect with bounded backoff; malformed or oversized updates are terminal until corrected.
- Preview upload paths are not fully de-duplicated: a board-list read can occur again during preview upsert, and overlapping idle/hide triggers do not have a dedicated integration test.
- Legacy R2 PUT/DELETE, temp cleanup, and claim paths remain for compatibility. Normal library routes use D1; historical R2 library JSON indexes are read-only source inputs. Their MIME/auth/8 MB constraints do not currently have full end-to-end production tests.
- Alarm expiry and legacy-schema migration have unit coverage but not a production migration fixture for every historical board shape.
- Workers Paid removes the Free hard stop but introduces billable overage. It is capacity, not a substitute for write bounds.

## Rules for a future R2 implementation

Do not resume work by following the abandoned fix plan section-by-section or by restoring deleted files wholesale. Start from current `main` and preserve every usage safeguard above.

A replacement must, at minimum:

1. Keep media bytes out of `scene_json`.
2. Define one explicit ordering rule for local paint, durable R2 write, and scene publication.
3. Never let an inbound full scene trigger an unconditional outbound full scene.
4. Never put a write in a polling/read path.
5. Keep the DO constructor free of schema/storage work.
6. Prove an idle single tab and an idle multi-tab board add no SQLite scene writes.
7. Test real Worker bindings, not only mocked `fetch` or local in-memory state.
8. Exercise signed-out scratch, signed-in Owner, Manager/Editor, old boards, leave/re-enter, refresh during upload, offline/reconnect, empty Chromebook MIME, GIF, and MP4/WebM.
9. Verify the R2 object exists after a completely new browser session before declaring durability fixed.
10. Canary behind a deliberate feature flag or limited cohort and compare DO/R2 metrics before broad rollout.
11. Keep board-scoped compatibility GET/HEAD during any migration; never delete historical objects as part of enabling writes.
12. Re-run the complete test/build/preview/deploy/live-SHA sequence and inspect Cloudflare usage after deployment.

The historical documents remain useful for failure modes and rejected designs:

- [image-r2-incident-history.md](./image-r2-incident-history.md) — detailed point-in-time chronology and failed hypotheses;
- [image-r2-fix-plan.md](./image-r2-fix-plan.md) — abandoned proposal; not an implementation checklist;
- [sync-storage.md](./sync-storage.md) — canonical current runtime;
- [auth-libraries.md](./auth-libraries.md) — current Clerk, owner-key, library, and scratch lifetime behavior.
