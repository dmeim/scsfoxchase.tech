# Sync and storage

Live document sync, the temporary media rollback, and where Whiteboard data lives.

> **Current storage boundary (2026-08-27):** The post-`81242d2` board-scoped upload design was abandoned. New image/video insertion is temporarily disabled. Existing media remains readable from legacy `assets/{ownerKey}/{assetId}` objects and from read-only board-scoped `boards/{boardId}/assets/{fileId}` objects. Board-scoped GET/HEAD works; PUT/DELETE return `405`. The live scene remains in Durable Object SQLite. Signed-in Library / Recents / Assets metadata is in D1; historical R2 JSON indexes remain read-only migration sources.

## Overview

Each board UUID maps to one **Durable Object** (`WhiteboardBoard`). Clients open a native WebSocket (not `@tldraw/sync`). The DO persists plaintext Excalidraw `{ elements, appState }` in the SQLite table `excalidraw_scene` as one `scene_json` value. Clients send `databaseJson` from `serializeAsJSON(..., {}, "database")`, so `files` is `{}`; binary media is never stored in the scene JSON.

The live media namespace is the original owner-key layout:

```text
assets/{ownerKey}/{assetId}
```

The board-scoped namespace is retained only as a read-only compatibility path for objects written during the abandoned rollout:

```text
boards/{boardId}/assets/{fileId}
```

There is no board asset manifest, IndexedDB upload outbox, `roleResolved` / `authResult` protocol, or board write-proof protocol in the rolled-back runtime. The current scene protocol does use mutation IDs and `scene:ack` frames.

Do not use `excalidraw-room`, Firebase, `oss-collab`, Liveblocks, or Yjs for this product.

## WebSocket sync

### Client

`src/components/WhiteboardCanvas.tsx` + `src/lib/whiteboard-sync.ts`:

1. `buildWhiteboardConnectUrl` opens `/api/whiteboard/connect/{uuid}?sessionId=…`.
2. On change, a trailing ~1-second debounce (`SCENE_FLUSH_MS`) sends a mutation-ID-bearing `scene:update` with elements whose `version` increased. Periodically a full element set is sent. Each flush includes `databaseJson` from `serializeAsJSON(elements, appState, {}, "database")` (`files: {}`).
3. Incoming `scene:sync` / `scene:update` is merged with `restoreElements` + `reconcileElements`, then applied with `captureUpdate: NEVER`.
4. The client retires a mutation only after `scene:ack` (`applied`, `duplicate`, or `noop`). A transient `persist_failed` keeps the immutable mutation and retries after bounded reconnect backoff; malformed or oversized failures are terminal and shown to the user.
5. Client ping runs every 25 seconds (`{"type":"ping"}`); the DO auto-responds with `pong` without waking JavaScript.

New image/video insertion is paused at the canvas boundary. Existing image references still run the read/hydrate path described below; they do not enqueue an upload.

### Authentication handshake

The Worker validates the board UUID, canonical UUID `sessionId`, and `Upgrade: websocket`, then runs `WHITEBOARD_CONNECT_LIMITER` before `WHITEBOARDS.get().fetch`. The binding allows 120 admissions per 60 seconds per trusted `CF-Connecting-IP`; local/test fallback buckets expire and are capped at 4096 keys. Each DO admits at most 64 total sockets and 32 pending-auth sockets; pending auth expires after approximately 30 seconds without a per-socket alarm.

Scratch host proof (`hostSecret`) and a Clerk JWT are sent in the first WebSocket message (`wb:auth`), not in the connect query string. `X-Board-Host` on the upgrade request is a non-mutating compatibility check for an already initialized board only; it cannot create host metadata or claim a random UUID. Do not put the host secret in a URL because query strings can reach access logs.

The socket opens and sends the stored scene before Clerk is necessarily ready. A signed-in tab without a JWT sends `signedIn: true` and remains pending until a token arrives; a late token upgrades the existing session with `wb:role`. A socket receives one `wb:hello`; the runtime does not emit a second hello for late authentication. There are no `roleResolved` or `wb:authResult` frames.

### Worker routing

`src/worker.ts` matches `/api/whiteboard/connect/:uuid`, validates the UUID/session/upgrade, applies connection admission, and only then forwards to the board object:

```ts
admitWhiteboardConnect(request, env) → env.WHITEBOARDS.idFromName(boardId) → stub.fetch(request)
```

The PWA service worker (`public/sw.js`) never intercepts `/api/*`, so this upgrade is not cached.

### Durable Object room

`src/worker/WhiteboardBoard.ts`:

- Storage is one `excalidraw_scene` row (`id = 1`) with `scene_json TEXT` and `updated_at`.
- `persistScene` enforces the scene element/JSON caps and skips a SQL write when the serialized scene is unchanged from `lastPersistedJson`. Accepted element merges still persist; a metadata/database-only flush with an identical blob is a no-op.
- SQLite failures and oversize/malformed scenes send `wb:error` (`persist_failed`, `scene_too_large`, or `malformed_scene`) and do not broadcast that failed update. Image availability is not a server-side scene gate.
- Accepted mutations send `scene:ack` after durable persistence; duplicate mutation IDs are acknowledged without a second write. Transient persistence failures retain the client mutation for reconnect retry; terminal protocol/size failures do not retry forever.
- Incoming WebSocket frames are rejected before JSON parsing when their UTF-8 byte length exceeds the bounded frame cap. Scene/database JSON is capped at 2,000,000 UTF-8 bytes and scenes remain capped at 4,000 elements.
- Merge is last-write-wins by element `version`, then `versionNonce` (`mergeSceneElements`).
- Full `scene:sync` broadcasts exclude the writer (`exceptSessionId = fromSessionId`), preserving the `12f06f5` echo fix. Incremental updates also exclude their sender.
- WebSocket auto-response handles ping/pong; socket attachments are restored after hibernation.
- Viewers cannot mutate the scene. Editors can mutate only while Group Edit is on; Owner and Manager can always mutate.

The retained anti-usage guards are deliberately separate from media:

- The Durable Object constructor performs no storage or SQL work. Lifetime initialization is coalesced, existing canonical boards do not run schema DDL on cold wake, and legacy/v2 reads remain write-free until an actual migration write is required.
- Share codes are minted once. An existing `meta:activeCode` is returned without another KV write.
- `GET /api/whiteboard/boards/:uuid/meta` does not mint or rewrite the share-code KV mapping.
- Alarm scheduling reads the current alarm and avoids a redundant `setAlarm` or `deleteAlarm`.
- Identical scene persistence avoids a redundant SQLite UPSERT.
- Full scene broadcasts exclude the writer and do not trigger a client-side full-flush echo.

The incident, recovery evidence, Cloudflare usage baseline, and operator checklist are in [r2-rollback-cloudflare-usage.md](./r2-rollback-cloudflare-usage.md). D1 migration, source scan/import, export, verification, and rollback are in [d1-library-operations.md](./d1-library-operations.md).

### Live SQLite schema

```sql
CREATE TABLE IF NOT EXISTS excalidraw_scene (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  scene_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)
```

Older objects may still be migrated from the former `database_json` + `live_json` columns into `scene_json`. No scene JSON migration is required for this rollback, and no storage wipe should be performed.

### Custom messages

| Type | Payload | Purpose |
|------|---------|---------|
| `wb:hello` | `{ sessionId, role, canEdit, authToken, owner, … }` | Session identity for the manage panel |
| `wb:participants` | `{ yourSessionId, yourRole, participants[] }` | People list |
| `wb:role` | `{ role, canEdit }` | Manual role change or late-auth upgrade |
| `scene:ack` | `{ mutationId, status, revision? }` | Durable mutation outcome: `applied`, `duplicate`, or `noop` |
| `wb:error` | `{ code, message, mutationId, terminal }` | Scene size, malformed payload, or persistence failure |
| `wb:forceFollow` | `{ forceFollow, targetUserId, targetSessionId, subjects }` | Follow User camera lock |
| `wb:sceneBounds` | `{ socketId, bounds }` | Leader viewport for Follow |

`scene:ack` is sent only after the DO has accepted the mutation (or recognized a duplicate/no-op). The writer is still excluded from scene broadcasts, so acknowledgements do not create echo loops.

## R2 media

**Binding:** `WHITEBOARD_ASSETS`  
**Bucket:** `scsfoxchase-tech-whiteboards`

### New insertion is paused

The Excalidraw image tool is hidden and image/video paste, drag, and drop insertion are temporarily disabled. This is an intentional safety pause while the failed board-scoped upload design is rolled back. The pause does not remove existing scene elements or R2 objects.

### Read-only board-scoped compatibility

**Object key:** `boards/{boardId}/assets/{fileId}`
**Route:** `/api/whiteboard/boards/{boardId}/assets/{fileId}`

The route accepts a board UUID and either a UUID or a 64-character content-hash file id. GET and HEAD read the R2 object directly and do not wake or query a DO manifest. Missing objects return `404`.

| Method | Result |
|--------|--------|
| `GET` / `HEAD` | Read an existing board-scoped object |
| `PUT` | `405` — board-scoped writes are disabled |
| `DELETE` | `405` — board-scoped deletes are disabled |

No manifest row is required or consulted. Objects left in this namespace are not deleted by the rollback. Existing board-scoped scene references can therefore still render if their object exists; otherwise Excalidraw shows its normal missing-file placeholder.

### Legacy owner-key media

**Object key:** `assets/{ownerKey}/{assetId}`
**Route:** `/api/whiteboard/assets/{ownerKey}/{assetId}`

| Owner key | Meaning |
|-----------|---------|
| `google:{accountId}` | Signed-in saved-board media |
| `temp:{boardId}` | Unsaved/signed-out scratch media; subject to the 24-hour scratch lifetime |
| `local:{deviceId}` | Leftover objects; compatibility reads only |

Existing image/GIF files hydrate by trying the board-scoped read-only route first and then the legacy owner-key route (`google:`, `temp:`, and any remembered legacy owner). Existing MP4/WebM player links continue to resolve through their owner key and `/whiteboard-player`.

The legacy route still provides its established authenticated PUT/DELETE paths for owner-key media and the `POST /api/whiteboard/assets/claim` temp-to-Google move. The paused canvas does not initiate new image/video insertion, and the removed board-scoped write-proof flow is not used.

Save/claim may move legacy `assets/temp:{boardId}/` objects to `assets/google:{accountId}/` and rewrite legacy player links. It does not move board-scoped compatibility objects.

### Hub Assets index

The Hub Assets index is a separate signed-in D1 metadata library, not the binary source of truth for a board:

- D1: `WHITEBOARD_LIBRARY.library_assets` (with `owner_key`, asset metadata, and R2 object key)
- R2 source: `library/{ownerKey}/assets.json` is retained read-only for import/recovery
- API: `/api/whiteboard/library/assets` (Clerk required)
- Canvas media is not automatically added to this index.

## Scratch expiry and deletion

The first valid host/Clerk/share authorization or board-meta PATCH starts a 24-hour unsaved clock. An unauthenticated random-UUID scene read does not initialize metadata. Saving to the cloud library lifts the clock. Refreshing or reconnecting does not reset it. `GET /meta` may establish the clock but does not mint a share code; alarm scheduling is idempotent.

When an unsaved board expires, the DO deletes its SQLite scene, clears unsaved metadata and the share-code mapping, best-effort cleans legacy `assets/temp:{boardId}/` objects, and broadcasts an empty scene. No board-scoped manifest cleanup is performed because no manifest exists in the rolled-back runtime. Existing board-scoped compatibility objects are left untouched.

## Cloud library metadata

Signed-in Recents/Library boards use D1 `WHITEBOARD_LIBRARY.library_boards` through `/api/whiteboard/library/boards`. Join does not write this metadata. Signed-in create and Save/claim do. The authenticated canonical-owner lazy import finalizes `library_owner_imports`; optional operator pre-seeding only inserts validated rows and never writes that marker. The historical R2 source `library/{ownerKey}/boards.json` remains unchanged and is used only for validated import/recovery.

## Bindings reference

From `wrangler.jsonc`:

```jsonc
"durable_objects": {
  "bindings": [{ "name": "WHITEBOARDS", "class_name": "WhiteboardBoard" }]
},
"r2_buckets": [{
  "binding": "WHITEBOARD_ASSETS",
  "bucket_name": "scsfoxchase-tech-whiteboards"
}],
"kv_namespaces": [{
  "binding": "WHITEBOARD_CODES",
  "id": "…"
}],
"d1_databases": [{
  "binding": "WHITEBOARD_LIBRARY",
  "database_name": "scsfoxchase-tech-whiteboard-library"
}],
"ratelimits": [{
  "name": "WHITEBOARD_CONNECT_LIMITER",
  "simple": { "limit": 120, "period": 60 }
}]
```

`wrangler.jsonc` also configures a separate `preview_database_id`; preview is a distinct bound database and must not be inferred from production state.

Migration tag `whiteboard-v1` registers the SQLite class `WhiteboardBoard`. D1 migrations live under `migrations/` and apply in filename order; see the operator runbook for local, preview, and production commands.

## CSP (media / fonts)

`public/_headers` keeps media and fonts same-origin:

- `font-src 'self'` — Excalidraw fonts under `/excalidraw/fonts`
- `connect-src 'self'` — same-origin WebSocket and asset reads
- `img-src` / `media-src 'self'` — owner-key and board-compatibility R2 routes
- `frame-src 'self'` plus YouTube / Vimeo hosts — player and stock embeds
- `worker-src 'self' blob:` — Excalidraw subset workers

No `cdn.tldraw.com`. No license-key environment variable.

## Observability

Wrangler observability is enabled with structured logs, `invocation_logs: false`, and a 5% production head sampling rate. The application logger emits only allow-listed, low-cardinality admission/auth transitions, throttles, scene rejection/persistence failures, and D1/R2/KV storage-failure categories. It does not log pings or every successful update, and it excludes board/session IDs, IP addresses, URLs/paths, host secrets, JWTs, arbitrary exception text, and scene contents.

## Key files

| Path | Role |
|------|------|
| `src/worker.ts` | Connect upgrade and API dispatch |
| `src/worker/WhiteboardBoard.ts` | Scene store, codes, roles, Follow, 24-hour TTL, write guards |
| `src/worker/connectAdmission.ts` | Rate Limiting admission and bounded local/test fallback |
| `src/worker/assetRoutes.ts` | Legacy owner-key media and read-only board compatibility route |
| `src/worker/libraryRoutes.ts` | Signed-in D1 board/asset metadata routes |
| `src/worker/libraryStore.ts` | D1 metadata and read-only R2 source import |
| `src/worker/adminLibraryRoutes.ts` | Bounded authenticated scan/import/export operator API |
| `src/components/WhiteboardCanvas.tsx` | WebSocket client, Excalidraw, paused insertion, media hydration |
| `src/lib/whiteboard-sync.ts` | Protocol types and scene merge helpers |
| `src/lib/whiteboard-excalidraw-files.ts` | Existing image/GIF/video hydration and player rendering |
| `src/lib/whiteboard-assets.ts` | Owner-key and board-compatibility R2 helpers |
| `src/lib/whiteboard-cloud.ts` | Authenticated library fetch/upsert/delete and meta claim |
| `scripts/copy-excalidraw-fonts.mjs` | Font copy for Chromebooks / CSP `'self'` |
| `wrangler.jsonc` | Bindings |
