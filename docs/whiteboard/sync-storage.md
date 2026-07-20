# Sync and storage

Live document sync, media uploads, and where whiteboard data lives.

## Overview

Each board UUID maps to one **Durable Object** (`WhiteboardBoard`) that runs a `@tldraw/sync-core` `TLSocketRoom` with **SQLite** persistence. Clients connect with `@tldraw/sync` `useSync`. Images and videos go to **R2** under owner-scoped keys; signed-in library indexes are JSON objects in the same bucket.

## WebSocket sync

### Client

`src/components/TldrawBoard.tsx`:

```ts
const store = useSync({
  uri,           // builds /api/whiteboard/connect/{uuid}?...
  assets: r2AssetStore,
  onCustomMessageReceived,
})
```

Connect URL query params:

| Param | Purpose |
|-------|---------|
| `sessionId` | Required by the DO (tldraw session id) |
| `hostSecret` | Present when this browser created the board → host |
| `displayName` | Full Google name (or empty for guests) for People list |
| `userId` | tldraw user id for Follow / force-follow camera target |

### Worker routing

`src/worker.ts` matches `/api/whiteboard/connect/:uuid`, validates UUID, requires `Upgrade: websocket`, then:

```ts
env.WHITEBOARDS.idFromName(boardId) → stub.fetch(request)
```

### Durable Object room

`src/worker/WhiteboardBoard.ts`:

- Storage: `DurableObjectSqliteSyncWrapper` + `SQLiteSyncStorage` (table prefix `tldraw_`).
- Schema: default tldraw shapes/bindings via `createTLSchema`.
- Hibernation: WebSocket auto-response for `{"type":"ping"}` / `pong`; session snapshots on socket attachments; resume on wake.
- `clientTimeout: Infinity` so Cloudflare-kept sockets are not pruned by the room.

Custom messages the DO sends to connected clients:

| Type | Payload | Purpose |
|------|---------|---------|
| `wb:participants` | `{ yourSessionId, participants[] }` | People list |
| `wb:canEdit` | `{ canEdit }` | Guest readonly toggle |
| `wb:forceFollow` | `{ forceFollow, hostUserId }` | Camera lock |

Document persistence is the DO SQLite room — not the hub library indexes. Removing a board from Recents/Library only drops the **index entry**.

## R2 assets

**Binding:** `WHITEBOARD_ASSETS`  
**Bucket:** `scsfoxchase-tech-whiteboards`  
**Object key:** `assets/{ownerKey}/{assetId}`

### HTTP API

`src/worker/assetRoutes.ts` — `/api/whiteboard/assets/{ownerKey}/{assetId}`

| Method | Auth | Behavior |
|--------|------|----------|
| `PUT` | `google:*` requires Clerk session whose `ownerKey` matches; `local:*` is capability-URL (unguessable UUIDs) | Upload body (max **8 MB**) |
| `GET` / `HEAD` | Public if key known | Stream object; long cache |
| `DELETE` | Same write rules as PUT | Delete object |

Allowed MIME: JPEG, PNG, GIF, WebP, SVG, MP4, WebM.

### Client upload path

`r2AssetStore` in `src/lib/whiteboard-assets.ts` (passed to `useSync`):

1. Wait for auth ready when Clerk is configured.
2. `ownerKey = getOwnerKey()` → `local:{deviceInstallId}` or `google:{accountId}`.
3. Mint asset UUID; `PUT` with `Content-Type` (+ Bearer for Google).
4. Upsert Assets index (`upsertAssetActive` → localStorage or cloud).
5. Return absolute `src` URL so peers resolve the same capability path.

`resolve` returns `asset.props.src` as stored.

### Hub Assets index (metadata)

Separate from R2 binaries:

| Mode | Storage |
|------|---------|
| Signed out | `localStorage` key `scsfoxchase.whiteboard.assets` |
| Signed in | R2 JSON `library/{ownerKey}/assets.json` via `/api/whiteboard/library/assets` |

Index entries include `id`, `title`, `mimeType`, `r2Key`, `ownerKey`, timestamps, optional `sourceBoardIds`. Deleting from the hub removes the index row and best-effort deletes the R2 object.

## Cloud library board index

Signed-in Recents/Library boards:

- R2 key: `library/{ownerKey}/boards.json`
- API: `/api/whiteboard/library/boards` (GET list, PUT upsert) and `.../boards/:id` (DELETE)
- Clerk required — see [auth-libraries.md](./auth-libraries.md)

## Local board library (signed out)

`localStorage` key `scsfoxchase.whiteboard.library` — array of `{ id, title, lastAccessedAt, previewDataUrl? }`.

Host secrets: `scsfoxchase.whiteboard.host.{boardId}`.  
Device install id: `scsfoxchase.whiteboard.deviceInstallId`.

Removing a local board also best-effort deletes IndexedDB names used by older local tldraw persistence keys for that board id (sync path is DO-backed; cleanup is defensive).

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

## Key files

| Path | Role |
|------|------|
| `src/worker.ts` | Connect upgrade + API dispatch |
| `src/worker/WhiteboardBoard.ts` | Sync room, DO meta storage, custom messages |
| `src/worker/assetRoutes.ts` | R2 PUT/GET/DELETE |
| `src/worker/libraryRoutes.ts` | Cloud boards/assets JSON indexes |
| `src/components/TldrawBoard.tsx` | `useSync` client |
| `src/lib/whiteboard-assets.ts` | `r2AssetStore` + local asset index |
| `src/lib/whiteboard-cloud.ts` | Cloud index fetch/upsert/delete |
| `wrangler.jsonc` | Bindings |
