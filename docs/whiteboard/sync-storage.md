# Sync and storage

Live document sync, media uploads, and where whiteboard data lives.

## Overview

Each board UUID maps to one **Durable Object** (`WhiteboardBoard`). Clients open a **native WebSocket** (not `@tldraw/sync`). The DO persists plaintext Excalidraw `{ elements, appState }` in SQLite table `excalidraw_scene` as one `scene_json` TEXT value. Clients include `databaseJson` from `serializeAsJSON(..., {}, "database")` so `files` is always `{}`; binaries live in R2, not in the scene JSON. Image/GIF bytes and MP4/WebM files go to **R2** keyed by Excalidraw `fileId`. Signed-in library indexes are JSON objects in the same bucket.

Do not use `excalidraw-room`, Firebase, `oss-collab`, Liveblocks, or Yjs for this product.

## WebSocket sync

### Client

`src/components/WhiteboardCanvas.tsx` + `src/lib/whiteboard-sync.ts`:

1. `buildWhiteboardConnectUrl` → `/api/whiteboard/connect/{uuid}?sessionId=…`
2. On change, debounce ~1s (`SCENE_FLUSH_MS`), send `scene:update` with elements whose `version` increased; periodically send a full set. Each flush includes `databaseJson` from `serializeAsJSON(elements, appState, {}, "database")` (`files: {}`).
3. Incoming `scene:sync` / `scene:update`: `restoreElements` + `reconcileElements`, then `updateScene({ captureUpdate: NEVER })`. Incoming `wb:error` shows an Excalidraw toast; that change was not stored.
4. Client ping every 25s (`{"type":"ping"}`); DO auto-responds `pong` without waking JS.

Connect URL query params:

| Param | Purpose |
|-------|---------|
| `sessionId` | Required; stored in `sessionStorage` per board so refresh keeps the same session |
| `displayName` | Google full name, or a generated guest name |
| `userId` | Guest device-install UUID only (Follow target). Signed-in identity is not put on the query string |

Scratch **host proof** (`hostSecret`) and Clerk JWT are the first WebSocket message (`wb:auth`). The Durable Object also accepts `X-Board-Host` on the upgrade request. Do not put `hostSecret` on the connect query string (access logs). HTTP privileged calls still send host proof as `X-Board-Host` / `Authorization: Bearer`, not as a WebSocket URL param.

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
- Fail-closed: oversize or SQLite failure throws `ScenePersistError`. The DO sends `wb:error` (`scene_too_large` or `persist_failed`) to the writer and other Editors and **does not** `broadcastScene` that update. The in-memory cache is written only after a successful UPSERT.
- Merge: last-write-wins by element `version`, then `versionNonce` (`mergeSceneElements`).
- Hibernation: WebSocket auto-response for ping/pong; session snapshots on socket attachments; resume on wake.
- Viewer writes: `viewModeEnabled` on the client is **not** enough — the DO ignores `scene:update` when `roleCanEdit` is false.
- Join (`GET /api/whiteboard/join/:code`) returns a UUID only. Role is decided on connect: guests default to **Viewer** unless they are Owner, already stored as Editor/Manager, or they join with the active share code while **Class can edit** is On (`meta:classCanEdit`) — then they land as **Editor**. UUID-only stays **Viewer**. A join code alone does not mean students can draw.
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
| `wb:error` | `{ code, message }` | Persist failed (`scene_too_large` or `persist_failed`). Last change was not stored or broadcast |
| `wb:forceFollow` | `{ forceFollow, targetUserId, targetSessionId, subjects }` | Follow Me — lock follower cameras to the target |
| `wb:sceneBounds` | `{ socketId, bounds }` | Leader viewport; voluntary Follow uses this until pan unfollows; Follow Me snaps to cached bounds |

Document persistence is the DO scene — not the hub library indexes. Removing a board from Recents/Library only drops the **index entry**.

## R2 assets

**Binding:** `WHITEBOARD_ASSETS`  
**Bucket:** `scsfoxchase-tech-whiteboards`  
**Object key:** `assets/{ownerKey}/{assetId}`

Owner keys on canvas files:

| Board state | Owner key |
|-------------|-----------|
| Signed-in **saved** board | `google:{accountId}` |
| Unsaved / signed-out scratch | `temp:{boardId}` (24h) |

Canvas files use `temp:` / `google:` only (`assets/{ownerKey}/{fileId}`). The Worker still accepts `local:*` keys for leftover objects; that prefix is not a live hub upload path. PUT/DELETE on `temp:*` / `local:*` require a host secret or a live can-edit session.

### HTTP API

`src/worker/assetRoutes.ts` — `/api/whiteboard/assets/{ownerKey}/{assetId}`

| Method | Auth | Behavior |
|--------|------|----------|
| `PUT` | `google:*` requires Clerk session whose `ownerKey` matches; `temp:*` / `local:*` require host secret or a live can-edit session | Upload body (max **8 MB**) |
| `GET` / `HEAD` | Public if key known | Stream object; long cache. Expired `temp:*` objects 404 |
| `DELETE` | Same write rules as PUT | Delete object |
| `POST /api/whiteboard/assets/claim` | Clerk | Move `temp:{boardId}` → `google:{id}` after Save |

Allowed MIME: JPEG, PNG, GIF, WebP, SVG, MP4, WebM.

### Canvas upload path

`src/lib/whiteboard-excalidraw-files.ts` (not hub drag-drop onto the Assets strip):

1. Image/GIF: `generateIdForFile` → PUT R2 → `addFiles` on peers by `fileId`. Persist only files referenced by elements.
2. MP4/WebM: PUT R2 → insert an embeddable whose `link` is `/whiteboard-player?owner=…&id=…`. `validateEmbeddable` / `renderEmbeddable` allow that same-origin player.
3. YouTube / Vimeo: stock Excalidraw embeds (`frame-src` in CSP).
4. On Save/claim, temp objects move under the Google owner key; player links on the scene are rewritten.

Player page: `src/pages/whiteboard-player.astro`. Worker sets `X-Frame-Options: SAMEORIGIN` so the canvas iframe works (`public/_headers` has a matching exception). Global CSP is `X-Frame-Options: DENY` elsewhere.

### Hub Assets index (metadata)

Separate from R2 binaries. Canvas PUT writes the object only; it does **not** upsert `assets.json`. The hub **Assets** strip is hidden until that index write exists, so it is not presented as a class media library.

- R2 JSON `library/{ownerKey}/assets.json` via `/api/whiteboard/library/assets` (API still exists for leftover rows)
- Index entries include `id`, `title`, `mimeType`, `r2Key`, `ownerKey`, timestamps, optional `sourceBoardIds`
- Recents / Library are signed-in cloud only; signed-out lists stay hidden

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
- `img-src` / `media-src` `'self'` — resolved R2 URLs under `/api/whiteboard/assets/*`
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
