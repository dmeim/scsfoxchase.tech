# Sync and storage

Live document sync, media uploads, and where whiteboard data lives.

## Overview

Each board UUID maps to one **Durable Object** (`WhiteboardBoard`). Clients open a **native WebSocket** (not `@tldraw/sync`). The DO persists plaintext Excalidraw `{ elements, appState }` in SQLite table `excalidraw_scene` as one `scene_json` TEXT value. Clients include `databaseJson` from `serializeAsJSON(..., {}, "database")` so `files` is always `{}`; binaries live in R2, not in the scene JSON. New board image assets use board-scoped R2 keys, while older owner-key media remains readable for compatibility. Signed-in library indexes are JSON objects in the same bucket.

Do not use `excalidraw-room`, Firebase, `oss-collab`, Liveblocks, or Yjs for this product.

## WebSocket sync

### Client

`src/components/WhiteboardCanvas.tsx` + `src/lib/whiteboard-sync.ts`:

1. `buildWhiteboardConnectUrl` → `/api/whiteboard/connect/{uuid}?sessionId=…`
2. On change, debounce ~1s (`SCENE_FLUSH_MS`), send `scene:update` with elements whose `version` increased; periodically send a full set. Each flush includes `databaseJson` from `serializeAsJSON(elements, appState, {}, "database")` (`files: {}`).
3. Incoming `scene:sync` / `scene:update`: `restoreElements` + `reconcileElements`, then `updateScene({ captureUpdate: NEVER })`. Incoming `wb:error` shows an Excalidraw toast; that change was not stored.
4. Client ping every 25s (`{"type":"ping"}`); DO auto-responds `pong` without waking JS.

`media.syncFiles` starts the current client image-upload path. It synchronously stages a newly observed Data URL before the asynchronous Blob conversion, keeps the image out of scene publication until the outbox upload is ready, and requeues a rejected scene mutation by its `mutationId`. The server-side invariant below remains authoritative.

Connect URL query params:

| Param | Purpose |
|-------|---------|
| `sessionId` | Required; stored in `sessionStorage` per board so refresh keeps the same session |
| `displayName` | Google full name, or a generated guest name |
| `userId` | Guest device-install UUID only (Follow target). Signed-in identity is not put on the query string |

Scratch **host proof** (`hostSecret`) and Clerk JWT are the first WebSocket message (`wb:auth`). The Durable Object also accepts `X-Board-Host` on the upgrade request. Do not put `hostSecret` on the connect query string (access logs). HTTP privileged calls still send host proof as `X-Board-Host` / `Authorization: Bearer`, not as a WebSocket URL param.

Clerk is **never** verified during the upgrade: browsers cannot set WebSocket headers, and a slow Clerk BAPI call there would block the 101 handshake and the initial `scene:sync`. The socket opens, the DO sends the full scene, and identity settles afterwards.

`wb:auth` is repeatable, because Clerk can settle long after connect on a cold Chromebook:

| Client state | `wb:auth` payload | Durable Object |
|--------------|-------------------|----------------|
| Signed out (or scratch host) | `hostSecret?` | Resolves role and sends the single `wb:hello` |
| Signed in, JWT ready | `token`, `hostSecret?` | Same, with Google identity from `verifyToken` |
| Signed in, JWT not ready | `signedIn: true`, `hostSecret?` | Stays **pending** — no hello — unless host proof alone already earns a can-edit role. The client shows "Connecting…" and retries every second |
| Signed in, JWT arrives late | `token` on an already-greeted socket | `reauthenticateSocket` upgrades in place via `wb:role`; never a second hello, never a downgrade unless the identity changed |

This is what keeps a real Owner from being greeted as Viewer just because Clerk was slow.

### Worker routing

`src/worker.ts` matches `/api/whiteboard/connect/:uuid`, validates UUID, requires `Upgrade: websocket`, then:

```ts
env.WHITEBOARDS.idFromName(boardId) → stub.fetch(request)
```

The PWA service worker (`public/sw.js`) **never intercepts `/api/*`**, so this upgrade is not cached.

### Durable Object room

`src/worker/WhiteboardBoard.ts`:

- Storage: SQLite `excalidraw_scene` — one row (`id = 1`) with a single `scene_json` TEXT column (`{ elements, appState }`) plus `updated_at`.
- Persist: `persistScene` UPSERTs `scene_json`. Caps from `src/lib/whiteboard-sync.ts`: `MAX_SCENE_ELEMENTS` (4000) and `MAX_SCENE_JSON_BYTES` (2_000_000, string length of the JSON). Incoming `scene:update` uses `parseSceneElements` (overflow throws). Stored reads use `parseStoredSceneElements` so an already-oversize board is not trimmed on load.
- Fail-closed: oversize, missing asset manifests, or SQLite failure throws `ScenePersistError`. The DO sends `wb:error` (`scene_too_large`, `asset_not_ready`, or `persist_failed`) to the writer and other Editors and **does not** `broadcastScene` that update. The in-memory cache is written only after a successful UPSERT.
- Merge: last-write-wins by element `version`, then `versionNonce` (`mergeSceneElements`).
- Hibernation: WebSocket auto-response for ping/pong; session snapshots on socket attachments; resume on wake.
- Viewer writes: `viewModeEnabled` on the client is **not** enough — the DO ignores `scene:update` when `sessionCanEdit(role, classCanEdit)` is false (Viewers always; Editors while Group Edit is Off).
- Join (`GET /api/whiteboard/join/:code`) returns a UUID only. Role is decided on connect: guests default to **Viewer** unless they are Owner, already stored as Editor/Manager, or they join with the active share code (**Editor**). UUID-only stays **Viewer**. **Group Edit** (`meta:classCanEdit`) is a live draw gate, not a join-time role switch: Editors can draw only while it is On.
- Unsaved TTL: first connect starts a **24h** clock. `PATCH /api/whiteboard/boards/:uuid/meta` with `savedToLibrary` lifts it. Alarm deletes the scene (and schedules temp R2 cleanup) if never saved.

Live schema (`SCENE_TABLE_SQL`):

```sql
CREATE TABLE IF NOT EXISTS excalidraw_scene (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  scene_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)
```

Older Durable Object SQLite used `database_json` + `live_json` on the same row. That pair can exceed the platform per-row limit even when each value is under `MAX_SCENE_JSON_BYTES`. The constructor runs `migrateExcalidrawSceneTable`: copy `live_json` (else `{ elements, appState }` from `database_json`) into `scene_json` via a temporary `excalidraw_scene_v2` rename, then drop the dual-column table. Those old column names are not the live schema.

Custom messages the DO sends to connected clients:

| Type | Payload | Purpose |
|------|---------|---------|
| `wb:hello` | `{ sessionId, role, canEdit, authToken, owner, … }` | Session identity for the manage panel |
| `wb:participants` | `{ yourSessionId, yourRole, participants[] }` | People list |
| `wb:role` | `{ role, canEdit }` | Role change for this session |
| `wb:error` | `{ code, message }` | Persist failed (`scene_too_large`, `persist_failed`, or `asset_not_ready`). Last change was not stored or broadcast |
| `scene:ack` | `{ mutationId }` | Optional acknowledgement after a `scene:update` with that mutation id succeeds |
| `wb:forceFollow` | `{ forceFollow, targetUserId, targetSessionId, subjects }` | Follow User — lock follower cameras to the target |
| `wb:sceneBounds` | `{ socketId, bounds }` | Leader viewport; voluntary Follow uses this until pan unfollows; Follow User snaps to cached bounds |

Document persistence is the DO scene — not the hub library indexes. Removing a board from Recents/Library only drops the **index entry**.

## Board-scoped R2 assets

**Binding:** `WHITEBOARD_ASSETS`  
**Bucket:** `scsfoxchase-tech-whiteboards`  
**Object key:** `boards/{boardId}/assets/{fileId}`
**Routes:** `/api/whiteboard/boards/{boardId}/assets/{fileId}`

This is the current route for new canvas image uploads. `boardId` and `fileId` must be UUIDs. PUT accepts JPEG, PNG, GIF, WebP, SVG, MP4, or WebM, with a maximum body size of **8 MB**. The request must prove access to that board with the scratch host secret or a live can-edit board session (`X-Board-Id` plus `X-Board-Host`, or `X-Board-Session` and `X-Board-Auth`). Viewers cannot write.

GET and HEAD are intentionally unauthenticated for connected players, but they are manifest-gated: the Worker returns an asset only when the board's Durable Object has a `ready` manifest row whose `r2Key` exactly matches the board-scoped key. The route does not fall back to an owner-key object. DELETE uses the same board write gate and refuses with `409` while a non-deleted image element still references the file.

### Durable Object manifest

`WhiteboardBoard` creates this SQLite table when the object starts:

```sql
CREATE TABLE IF NOT EXISTS whiteboard_asset_manifest (
  file_id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  etag TEXT,
  status TEXT NOT NULL CHECK (status IN ('ready', 'deleted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)
```

The manifest is board-local DO state, not the Hub Assets index. A board PUT follows this order:

1. Validate board proof, MIME, and size, then write the complete body to R2.
2. Upsert the file's manifest row as `ready` with the board key, MIME type, and byte count.
3. Return `201` only after both operations succeed.

If manifest registration fails after the R2 write, the Worker best-effort deletes the object and returns `503`; an unregistered object is not readable through the board route. DELETE first marks the manifest `deleted` after checking the live scene, then deletes the R2 object. A failed R2 delete is reported as `503`, and cleanup is not silently treated as complete.

### R2-before-scene invariant

`WhiteboardBoard.applySceneUpdate` checks each newly referenced image file id against the board manifest **after element merge and before `persistScene`**. If the row is missing or not `ready`, it raises `asset_not_ready`; the DO sends `wb:error` to the writer and editing sessions and does not persist or broadcast that scene update. Successful scene persistence happens before the corresponding scene broadcast.

The invariant is enforced on both sides. `WhiteboardCanvas` blocks the image synchronously while DataURL conversion and outbox staging are in flight, filters other scene payloads around it, and resends the current mutation after a correlated `asset_not_ready` error once the upload reaches R2. The DO remains fail-closed if a client races or bypasses that guard.

### Scene acknowledgements

`scene:update` accepts an optional `mutationId`. After `applySceneUpdate` returns successfully, the DO sends `{"type":"scene:ack","mutationId":"…"}` to that socket. A failed persistence or asset-readiness check goes through `wb:error` instead and does not send an acknowledgement. Older clients may omit `mutationId` and continue to use the existing sync behavior.

`WhiteboardCanvas` adds the mutation id, retains the mutation until its matching acknowledgement or error, and uses the acknowledged scene version/file references to clear durable outbox state. A server scene hydration also clears durable jobs whose image tombstones are present, after hydration and only when they are not newer local live references.

## Legacy owner-key assets

The original namespace remains for existing scene links and older uploads:

**Object key:** `assets/{ownerKey}/{assetId}`
**Route:** `/api/whiteboard/assets/{ownerKey}/{assetId}`

| Owner key | Current meaning |
|-----------|-----------------|
| `google:{accountId}` | Legacy media for a signed-in saved board |
| `temp:{boardId}` | Legacy media for an unsaved/signed-out scratch board; subject to the 24h scratch lifetime |
| `local:{deviceId}` | Leftover objects; GET/HEAD only, not a new write path |

The legacy route still streams public GET/HEAD results. `google:` PUT/DELETE requires the matching Clerk account; a board Editor proof cannot select an arbitrary account-global key. `temp:` writes require board host proof or a live can-edit session; `local:` PUT/DELETE is rejected. The legacy GET resolver can try a board hint's `temp:` key and the requested owner key so old links continue to work. The board-scoped route itself never performs this fallback; `whiteboard-excalidraw-files.ts` tries it explicitly after a board-scoped image read misses.

Current canvas behavior is split by media type: image/GIF files found in Excalidraw `BinaryFiles` use the board-scoped outbox path, and MP4/WebM drag-and-drop or paste also uploads through the board-scoped route and stores `/whiteboard-player?board=…&id=…` links. Existing legacy player links remain readable. Save/claim copies legacy `temp:{boardId}` objects to `google:{accountId}` and rewrites those persisted player links. It does not move board-scoped objects.

The player page is `src/pages/whiteboard-player.astro`. Worker responses keep SVG downloads non-navigable and set `X-Frame-Options: SAMEORIGIN` for the same-origin player; `public/_headers` keeps the global default at `DENY` elsewhere.

## IndexedDB upload outbox

`src/lib/whiteboard-upload-outbox.ts` provides the current durable client queue for board-scoped image bytes. It is separate from Excalidraw's in-memory `BinaryFiles` cache because that cache may be gone after reload.

- Database: `scs-whiteboard-upload-outbox`, version `2`.
- Object stores: `uploads` for metadata and `upload-blobs` for the Blob, both keyed by `[boardId, fileId]`.
- A staged job stores its Blob in `upload-blobs` and metadata (MIME type, latest image-element snapshots, scene version, attempt metadata, and error details) in `uploads` before upload processing begins. Version 1 inline Blobs migrate to the split stores.
- States are `pending`, `uploading`, `uploaded`, `failed`, `auth-blocked`, and `permanent-failure`.
- Network errors, `408`/`429`, and `5xx` failures retry. Delays are 1s, 2s, 4s, 8s, 16s, then 30s for later attempts. `401`/`403` wait for auth/board readiness; invalid MIME, oversized bodies, and other permanent client errors do not auto-retry.
- `online`, window focus, board hello, and auth events wake the queue. A job left `uploading` when a tab dies is reset to `pending` on the next load.

An `uploaded` job stays in IndexedDB until `markSceneAcknowledged` removes it; `removeUpload` is local-only and never issues a remote DELETE. Recovery snapshots are intentionally hidden until `markServerSceneHydrated` so they cannot overwrite a scene that has not loaded from the server.

The canvas calls `markServerSceneHydrated` after the server scene is applied, `markSceneAcknowledged` after a correlated scene acknowledgement, and restores durable pending image snapshots only after hydration. Local removal is reserved for the explicit failed-upload Remove control and never issues a remote DELETE.

### Pending and failed upload UI

The board has an unpersisted per-asset DOM overlay and a compact global upload status: it dims the asset immediately, shows an indeterminate centered loader after 250 ms (or a compact spinner for a tiny icon), and keeps failed assets visibly failed with Retry and Remove controls. Normal uploads do not open a modal; only failure to write the IndexedDB outbox triggers a blocking warning. The UI remains responsive while ordinary drawing continues.

## Scratch expiry and deletion

The first board connection or board-meta read stores `createdAt` and starts a **24-hour** unsaved expiry. Saving the board to the cloud library clears that alarm. Refreshing or reconnecting does not reset the clock.

When an unsaved board's Durable Object alarm fires, the DO:

1. Deletes the stored scene.
2. Marks all board manifest rows `deleted` and best-effort deletes `boards/{boardId}/assets/` from R2.
3. Best-effort deletes the registered legacy `assets/temp:{boardId}/` prefix.
4. Clears the unsaved metadata and share-code mapping, then broadcasts an empty scene.

The alarm's R2 cleanup is best-effort; scene and manifest cleanup still completes if R2 cleanup errors. Legacy temp GET-on-expiry and the guarded maintenance sweep triggered by an authenticated temp PUT apply only to old `assets/temp:{boardId}/` objects. There is no public global sweep endpoint. They delete stale legacy objects only when the DO explicitly reports the board is still unsaved; an unreadable saved flag leaves the object in place. Legacy owner-key objects are otherwise untouched by board-scoped cleanup.

## Hub Assets index

The Hub Assets index is a separate signed-in metadata library, not a binary source of truth for a board:

- R2 JSON: `library/{ownerKey}/assets.json`
- API: `/api/whiteboard/library/assets` (Clerk required)
- Entries contain metadata such as `id`, `title`, `mimeType`, `r2Key`, `ownerKey`, timestamps, and optional `sourceBoardIds`.

Neither the board-scoped canvas PUT nor the legacy canvas PUT updates `assets.json`. The current Hub Assets section remains hidden, so canvas files are not presented as a class media library.

## Cloud library board index

Signed-in Recents/Library boards:

- R2 key: `library/{ownerKey}/boards.json`
- API: `/api/whiteboard/library/boards` (GET list, PUT upsert) and `.../boards/:id` (DELETE)
- Clerk required — see [auth-libraries.md](./auth-libraries.md)

Join does not write this index. Signed-in **create** and **Save/claim** (creating browser + Google) do.

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
}]
```

Migration tag `whiteboard-v1` registers SQLite class `WhiteboardBoard`.

## CSP (media / fonts)

`public/_headers`:

- `font-src 'self'` — Excalidraw fonts under `/excalidraw/fonts`
- `connect-src 'self'` — same-origin WebSocket and asset PUT/GET
- `img-src` / `media-src` `'self'` — resolved R2 URLs under `/api/whiteboard/assets/*` and `/api/whiteboard/boards/*/assets/*`
- `frame-src 'self'` plus YouTube / Vimeo hosts — player + stock embeds
- `worker-src 'self' blob:` — Excalidraw subset workers

No `cdn.tldraw.com`. No license-key env var.

## Key files

| Path | Role |
|------|------|
| `src/worker.ts` | Connect upgrade + API dispatch |
| `src/worker/WhiteboardBoard.ts` | Scene store, DO meta, custom messages, 24h TTL |
| `src/worker/assetRoutes.ts` | R2 PUT/GET/DELETE / claim |
| `src/worker/libraryRoutes.ts` | Cloud boards/assets JSON indexes |
| `src/components/WhiteboardCanvas.tsx` | WebSocket client + Excalidraw |
| `src/lib/whiteboard-sync.ts` | Protocol types shared by Worker and island |
| `src/lib/whiteboard-excalidraw-files.ts` | Image/GIF/video hooks |
| `src/lib/whiteboard-assets.ts` | R2 helpers + temp owner keys |
| `src/lib/whiteboard-cloud.ts` | Cloud index fetch/upsert/delete + meta claim |
| `scripts/copy-excalidraw-fonts.mjs` | Font copy for Chromebooks / CSP `'self'` |
| `wrangler.jsonc` | Bindings |
