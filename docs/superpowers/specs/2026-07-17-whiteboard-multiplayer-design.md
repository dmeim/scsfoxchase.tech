# Whiteboard Multiplayer Design

> **Superseded (2026-08).** This July 2026 tldraw dual-library design is historical. The live product is **Whiteboard** on Excalidraw 0.18.1 with a Durable Object WebSocket, cloud-only library, four roles, and Follow Me camera lock — see `tldraw-to-excalidraw.md` and [`docs/whiteboard/`](../../whiteboard/README.md). Do not implement from this file.

**Date:** 2026-07-17  
**Status:** Draft — superseded  
**Site:** scsfoxchase.tech (Astro static + Cloudflare Worker)

## Goal

Replace the nav-bar whiteboard drawer with a real whiteboard product:

1. **Hub** at `/whiteboard` — create, join, Recents, **Assets**, Library (per wireframe + Assets strip).
2. **Live board** at `/board/{uuid}` — site header + full-bleed tldraw canvas.
3. **Realtime multiplayer** via tldraw sync on Cloudflare Durable Objects.
4. **Asset persistence** in R2 (images/videos pasted onto boards), with a hub **Assets** library of the user’s uploads.
5. **Board manage panel** — context-aware center **Whiteboard** header control: link to hub everywhere except on a live board, where it opens a manage/share popover (rename, join code, per-user edit switches).
6. **Dual library mode** — signed-out device libraries (localStorage) and signed-in Google-account libraries (cloud indexes), switchable without destroying either.
7. **Google Sign-In** (designed now; implemented after signed-out R2 path) — primary identity for cloud boards, assets, display names, and host association where relevant.

Audience is K–8 students and teachers on Chromebooks and desktops. UX must stay simple; IDs and storage must stay collision-safe.

---

## Product flows

### Create

1. User opens `/whiteboard` and clicks **Create a new whiteboard**.
2. Client (or Worker) mint a new board UUID and a **host secret**.
3. Navigate to `/board/{uuid}`.
4. Host secret is stored in `localStorage` keyed by board UUID (and returned once on create for bookmark/share of host rights on that device).
5. Board opens in edit mode; host can open the Whiteboard manage panel to name the board, open a join code, and set collaborator permissions.
6. Library membership: while **signed out**, upsert into the device localStorage board index; while **signed in**, upsert into the account cloud board index (see [Dual library mode](#dual-library-mode-signed-out-vs-signed-in)).

### Join by code

1. On `/whiteboard`, user enters `A1B2`-style code (or pastes a `/board/{uuid}` URL).
2. Hub calls `GET /api/whiteboard/join/{code}` → `{ boardId }`.
3. Redirect to `/board/{uuid}` as a collaborator (default: **edit** on, unless the host later flips them to view).

### Return later (bookmark)

- Canonical URL is always `/board/{uuid}`.
- Recents / Library cards deep-link to that URL.
- Short codes are **not** for long-term bookmarking; they expire.

### Place / upload an asset on a board

1. User pastes, drops, or otherwise places media onto a live board.
2. Client uploads the binary to R2 via `TLAssetStore` (always — signed out or signed in).
3. The asset is **also** upserted into the active mode’s **Assets** library index (local or cloud), so it appears in the hub Assets strip automatically.
4. Board document still references the asset through tldraw’s normal asset records; the hub Assets list is a convenience index, not a second copy of the binary.

### Manage / share (on a live board)

1. User clicks the center **Whiteboard** header control (same affordance as today’s drawer).
2. Popover opens with: board name + Save, join code open/closed + copy, list of connected users with per-user **Edit** switches, and a link back to the hub.
3. People display names prefer Google `displayName` when signed in; otherwise session / generated labels (see [Google Sign-In](#google-sign-in-future-design-now)).

---

## Routes

| Route | Purpose |
|-------|---------|
| `/whiteboard` | Hub: create, join, Recents, Assets, Library |
| `/board/[uuid]` | Live collaborative canvas + site header |
| `GET /api/whiteboard/join/:code` | Resolve share code → board UUID |
| `POST /api/whiteboard/boards` | Create board metadata + host secret |
| `POST /api/whiteboard/boards/:uuid/code` | Mint / rotate share code (any active board session) |
| `DELETE /api/whiteboard/boards/:uuid/code` | Revoke active code early (any active board session) |
| `GET\|PATCH /api/whiteboard/boards/:uuid/meta` | Title / preview |
| `PATCH /api/whiteboard/boards/:uuid/participants/:sessionId` | Set participant `canEdit` (host secret) |
| `GET /api/whiteboard/connect/:uuid` | WebSocket upgrade → board Durable Object |
| `PUT\|GET /api/whiteboard/assets/:assetId` | R2 asset upload / download (keyed by owner + asset id; see [R2 key layout](#r2-key-layout)) |
| Cloud library APIs (Phase 4b+) | CRUD for account board/asset indexes when signed in — exact paths TBD with auth |

No legacy redirects. Feature is unused in production; ship only the new paths.

Nav **Whiteboard** control is **context-aware** (see Header behavior).

### Astro pages

- `src/pages/whiteboard.astro` — hub (BaseLayout + header).
- `src/pages/board/[uuid].astro` — board shell (BaseLayout + header + `TldrawBoard`).
- Worker routes under `/api/whiteboard/*` for APIs and WebSocket (see Architecture).

---

## Board page chrome

Today `/whiteboard` is a bare full-viewport tldraw document with no site chrome. Going forward, **every live board uses the standard site header**.

### Layout

```
┌──────────────────────────────────────────────────────────┐
│ Header (existing site header)                            │
│  [Logo + Title → /]  [Whiteboard ▾]  [Home][Games][Forms]│
│                          │               [Theme toggle]  │
│                          └─ manage popover (board only)  │
├──────────────────────────────────────────────────────────┤
│                                                          │
│              tldraw canvas (fills remaining height)      │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Rules:

- Use `BaseLayout` + existing `Header` (logo, title, Home / Games / Forms, theme toggle).
- Canvas area is `flex: 1` / `height: calc(100dvh - header)` — no page scroll; tldraw fills the remainder.
- No separate Share button — manage/share lives in the center **Whiteboard** control when on a board.
- Footer is omitted on `/board/[uuid]` (canvas needs the space); hub may keep normal page chrome as fits Chromebook height.

### Header behavior — context-aware Whiteboard control

The center **Whiteboard** control keeps its place in the header on every page. Its behavior depends on route:

| Context | Clicking Whiteboard does |
|---------|--------------------------|
| Anywhere **except** `/board/[uuid]` | Navigate to `/whiteboard` (hub) |
| On `/board/[uuid]` | Toggle manage/share popover (same interaction pattern as today’s drawer) |

On a board page, the control stays a **button** (not a link) so it does not navigate away from the canvas. Inside the popover, include a clear **Whiteboard library** (or “Back to boards”) link to `/whiteboard` for returning to create/join/recents.

| Before | After |
|--------|--------|
| Center “Whiteboard” always opens New / Join drawer | Off-board: go to hub. On-board: manage this board |
| Join/create only from drawer | Join/create on hub; rename / code / permissions on board |

Later (Phase 4b+): header (or hub) gains a **Sign in with Google** control; signing in does not change the Whiteboard control’s route behavior above.

---

## Hub UI (`/whiteboard`)

Match the wireframe, cleaned up to site styles (primary `#125F31`, secondary `#F6D724`, radius `2px` cards / `999px` pills):

1. **Top action row**
   - Primary: **Create a new whiteboard**
   - Join group: text field + **Join**
2. **Recents** — horizontal/grid strip of recent boards for the **active mode** (local or cloud)
3. **Assets** — single-row (or compact strip) of the user’s uploaded assets for the **active mode** (see [Hub Assets](#hub-assets))
4. **Library** — larger grid of saved/known boards for the **active mode**

Recents, Assets, and Library all read from the **active mode’s source of truth** (localStorage when signed out; account cloud indexes when signed in). Switching modes swaps which lists the UI shows; it does not merge or wipe the other namespace.

### Board card

Each card:

- **Preview** thumbnail (static image when available; brand-colored placeholder otherwise)
- **Title**
- **Date accessed**
- **⋮ menu** — **Rename** (inline input + Save) and **Delete** (confirm: Are you sure? Yes / No). Delete removes the entry from the **active** library index only (local or cloud). It does **not** destroy the Durable Object room or R2 objects by default (capability URL may still work until a later hard-delete feature).

Click → `/board/{uuid}`.

### Hub Assets

Section title: **Assets**. Placement: **between Recents and Library**.

Layout: single horizontal row / compact strip (Chromebook-friendly; can scroll horizontally if needed).

Each asset card / chip:

- Thumbnail or mime-type placeholder
- Title (default from filename or “Untitled asset”)
- **⋮ menu** (same pattern as board cards):
  - **Rename** — inline input + **Save**
  - **Delete** — “Are you sure?” → Yes / No. Delete removes the entry from the **active** asset index and should delete (or tombstone) the R2 object under that owner key when the user confirms.

**Automatic indexing:** whenever a user places or uploads an asset of any supported kind onto a whiteboard, the client must upsert that asset into the active Assets library. Users should never need a separate “Save to Assets” step for media they put on a board.

### Board / asset library indexes

Two parallel namespaces (never auto-merged):

| Mode | Boards index | Assets index |
|------|--------------|--------------|
| Signed **out** | `localStorage` `scsfoxchase.whiteboard.library` | `localStorage` `scsfoxchase.whiteboard.assets` |
| Signed **in** | Cloud index keyed by Google identity | Cloud index keyed by Google identity |

**Local board entries** (existing Phase 1–2 shape, preserved):

```ts
{ id, title, lastAccessedAt, previewDataUrl? }
```

**Local / cloud asset entries** (Phase 4a+):

```ts
{
  id: string              // UUID v4, same shape as board ids
  title: string
  createdAt: string       // ISO-8601
  lastAccessedAt: string  // ISO-8601
  mimeType: string
  size?: number
  r2Key: string           // e.g. assets/local:{deviceInstallId}/{assetId}
  sourceBoardIds?: string[] // boards this asset was placed on (optional bookkeeping)
}
```

Server (DO + R2) remains source of truth for board documents and binary bytes; hub lists are convenience indexes.

Clearing browser data clears **local** indexes and the device install id (new anonymous namespace on next visit). Cloud data is unaffected.

---

## Dual library mode (signed-out vs signed-in)

This is a hard product requirement: users must be able to switch modes reliably without data loss.

| Mode / action | Boards + Assets source of truth |
|---------------|----------------------------------|
| Signed **out** | Device **localStorage** indexes (current Phase 1–2 board behavior; Phase 4a adds assets) |
| Signed **in** | Account-associated **cloud** indexes (boards + assets tied to Google identity) |
| Sign **out** | UI reverts to localStorage libraries; **do not** destroy cloud data |
| Sign **in** | UI shows cloud libraries for that account; **do not** destroy local libraries |

### Rules

1. **Separate namespaces** — local and cloud libraries are independent. Signing in does **not** auto-merge, wipe, or overwrite local. Signing out does **not** delete cloud.
2. **Active mode drives UI** — Recents / Library / Assets always read/write the active mode’s index only.
3. **Creates and uploads follow active mode**
   - Signed out → new boards and assets associate to `local:{deviceInstallId}` (and localStorage indexes).
   - Signed in → new boards and assets associate to `google:{sub}` (and cloud indexes).
4. **DO room identity is unchanged** — board document sync still uses the board UUID. What changes by mode is **library membership** (which index lists the board), not the room id.
5. **Optional later (out of scope for Phase 4a/4b MVP):** “Upload local boards/assets to account” — an explicit user action that copies or re-keys selected local items into the Google namespace. Not required now; do not imply silent migration on sign-in.

### Switching UX (expected)

- While signed out: hub shows local Recents / Assets / Library; no cloud lists.
- Sign in: hub immediately shows that Google account’s cloud lists (empty if first time).
- Sign out: hub immediately shows the device local lists again (unchanged from before sign-in).
- Host secrets on the device remain in `localStorage` regardless of sign-in (device capability); cloud may later also record host association by Google id for cross-device admin — see Identity model.

---

## Identity model

### Board UUID

- Canonical ID for every board: UUID v4 (or ULID).
- Used in URL, Durable Object name (`idFromName(uuid)`), sync room.
- Guarantees boards never mash together in sync / DO storage.

### Asset ID

- Canonical ID for every library asset: **UUID v4** (same shape as board ids).
- Minted when the asset is first uploaded/placed.
- Used in R2 object path and in local/cloud asset indexes.
- Distinct from tldraw’s internal asset record ids if those differ — map in `TLAssetStore` as needed, but the **library asset id** is always a UUID v4 we own.

### Device install id (signed-out owner key)

- On first visit, mint a stable UUID v4 and store it in `localStorage` as e.g. `scsfoxchase.whiteboard.deviceInstallId`.
- This is **not** a Google id and is **not** derived from board ids.
- Used as the signed-out owner segment: `local:{deviceInstallId}`.
- Clearing site data creates a new install id; previous `local:*` R2 objects become orphaned capability URLs (acceptable; same class of risk as today’s unlisted boards).

### Owner key

| State | `ownerKey` |
|-------|------------|
| Signed out | `local:{deviceInstallId}` |
| Signed in | `google:{sub}` |

All R2 asset objects and cloud library index rows are scoped by `ownerKey`. Board **rooms** stay UUID-only; owner keys attach to **library membership** and **asset binaries**.

### Host secret

- Random high-entropy token created with the board.
- Proves “host / share admin” on that board without requiring Google login (works for signed-out classroom use).
- Stored client-side (`localStorage`: `scsfoxchase.whiteboard.host.{uuid}`).
- Sent as `Authorization: Bearer <hostSecret>` (or `X-Board-Host`) on privileged API calls.
- Anyone who created the board on a device, or to whom the creator copied the secret later, can manage per-user edit permissions. Losing the secret loses admin on that device; the board UUID link still works for joining.
- **After Google auth:** when a signed-in user creates a board, also record `hostGoogleSub` (or equivalent) on DO metadata so the same person can reclaim host rights from another device without the local secret. Host secret remains valid as a capability. Exact reclaim UX is Phase 4b+.

### Google Sign-In (future — design now)

School uses Google Workspace / Google accounts. Eventually the product shows **Sign in with Google**.

**Auth provider:** Google OIDC / OAuth 2.0. Exact library or stack (Clerk, Workers + Google token verify, Auth.js, etc.) is **TBD at implementation** — identity fields below are fixed.

**Canonical identity fields** (store on session / JWT / Worker auth context):

| Field | Type | Required | Use |
|-------|------|----------|-----|
| `googleSub` | string | Yes | Stable Google subject (`sub`); primary cloud owner key (`google:{sub}`) |
| `email` | string | Yes | Display / support / matching; not the sole ownership key |
| `displayName` | string | Yes | People list + optional cursor name tag |
| `avatarUrl` | string | No | Optional avatar in People list / presence |

**Ties to product data:**

- Cloud **board** library index rows → `googleSub`
- Cloud **asset** library index + R2 prefix → `google:{sub}`
- DO metadata **host association** (when signed-in create) → `googleSub`
- Sync **presence** `displayName` → Google `displayName` when signed in

**UI uses of display name:**

1. Manage panel **People** list (Name column)
2. Optional short **cursor name tag** in multiplayer presence (tldraw presence) so classmates see who is who

Signed-out sessions keep today’s session-scoped / generated labels.

### Share code

| Property | Value |
|----------|--------|
| Format | `A1B2` — letter, digit, letter, digit (`[A-Z][0-9][A-Z][0-9]`) |
| Normalization | Uppercase on create and join |
| Pool size | 26×10×26×10 = **67,600** |
| TTL | **12 hours** from mint/rotate (full school day + buffer) |
| Revocation | Explicit revoke or rotate; expiry via Durable Object alarm / KV TTL |
| Purpose | Easy classroom / peer join — not long-term bookmarks |

Any collaborator currently on the board can **open / close** the join code and copy it — students sharing a project should not need the host secret. Rate-limit open/rotate per board to limit code-pool abuse. **Per-user Edit switches** remain host-secret-only (and later host-Google where recorded).

### Join input accepts

1. Bare code: `A1B2`
2. Full board URL: `https://scsfoxchase.tech/board/{uuid}`
3. Path-only: `/board/{uuid}`

---

## Board manage panel (Whiteboard popover)

Reuses the existing header center popover pattern (anchored under **Whiteboard**, Escape / outside-click to close). Content depends on context:

- **Off a board:** control is a link — no popover (navigates to hub).
- **On `/board/[uuid]`:** control opens this manage panel.

### Panel contents (top → bottom)

1. **Name this whiteboard**
   - Text field prefilled with current title.
   - **Save** button (quick save) → `PATCH` title + update **active** library entry (local or cloud).
2. **Share code**
   - Row: code display (or placeholder) + **Copy**.
   - **Open / Closed** switch:
     - **Open** — mint a code if none, or keep current code active (joinable).
     - **Closed** — revoke / deactivate so new joins by code fail (board UUID URL still works for bookmarks).
   - Show expiry countdown while open (“Expires in …”).
   - Optional secondary **New code** to rotate while leaving the switch Open.
3. **People** (connected collaborators from sync presence)
   - Column headers conceptually: **Name** | **Edit**
   - Each row: display name + an **Edit** switch:
     - Prefer Google `displayName` when that peer is signed in and presence carries it
     - Else session / generated label
     - **On** → can edit (`isReadonly: false`)
     - **Off** → view only (`isReadonly: true`)
   - Host row is always Edit on (cannot demote self via the switch; or switch disabled for self).
   - Only the host (host secret / later host Google) can change others’ switches; non-hosts see the list read-only.
4. **Whiteboard library** link → `/whiteboard` (escape hatch back to hub create/join/recents/assets).

Helper text under the code row: “Codes expire after 12 hours. Bookmark the board page to come back later.”

### Who can do what in the panel

| Action | Host | Other collaborators |
|--------|------|---------------------|
| Rename + Save | Yes | Yes |
| Open / close / copy / rotate code | Yes | Yes |
| Change others’ Edit switches | Yes | No (list visible, switches disabled) |
| Leave via library link | Yes | Yes |

---

## Per-user edit / view permissions

### UX

- Default for a newly joined session: **Edit on**.
- Host flips a participant’s **Edit** switch off → that client becomes view-only immediately.
- Flip back on → editing restored.
- Optional banner on view-only clients: “View only — the board host turned off editing for you.”

This replaces a single global “view only for everyone” toggle with per-person control (same underlying readonly tech).

### Tech (tldraw)

tldraw supports readonly via instance state:

```ts
editor.updateInstanceState({ isReadonly: true })
```

Also: `editor.getIsReadonly()`, React `useReadonly()`.

With `@tldraw/sync`, permissions must be enforced server-side so clients cannot simply flip local state:

- Durable Object tracks each connected session: `{ sessionId, displayName, canEdit, isHost, googleSub? }`.
- Host proven by host secret on WebSocket connect (and later by matching `googleSub` to DO `hostGoogleSub` when present).
- Default `canEdit: true` for new guests; host always `canEdit: true`.
- Host `PATCH` (or DO RPC over the socket control channel) updates `canEdit` for a `sessionId`.
- Target client’s sync permission / signal forces `isReadonly: !canEdit`.
- Presence list in the manage panel is live (join/leave updates the People list).
- When Google auth exists, clients should send `displayName` (and optional `avatarUrl`) into sync presence so People rows and cursor tags are meaningful.

Same mechanism for teacher→class or student→group — only who holds host proof differs.

**Note on identity without Google login:** participants are **session-scoped**. If someone refreshes, they get a new session and default back to Edit on unless we later add sticky tokens. That is acceptable until Google sticky identity (or guest tokens) lands; document that hosts may need to re-flip Edit after a refresh. Sticky per-browser guest tokens can remain a follow-on even after Google exists (for signed-out guests).

**Dependency note:** Phase 6 (per-user Edit) works without Google, but **display names** in People / cursors are much better once Phase 4b Google identity feeds presence. Implement Edit switches on session ids first; wire Google names when auth ships.

---

## Sync backend

Follow tldraw’s recommended Cloudflare stack (`@tldraw/sync` client + `@tldraw/sync-core` / `TLSocketRoom` server), aligned with [tldraw sync](https://tldraw.dev/docs/sync) and the [tldraw-sync-cloudflare](https://github.com/tldraw/tldraw-sync-cloudflare) reference.

### Components

| Piece | Role |
|-------|------|
| Astro static assets | Hub + board UI |
| Cloudflare Worker | HTTP APIs, asset routes, WebSocket upgrade, later Google session verify |
| Durable Object per board | Authoritative `TLSocketRoom`, presence, per-session `canEdit`, code state |
| DO SQLite storage | Persist tldraw document records (survives hibernation) |
| R2 bucket `scsfoxchase-tech-whiteboards` | Binary assets keyed by owner + asset id (R2 forbids `_` in names; product family spelling remains `scsfoxchase-tech_whiteboards`) |
| Cloud library store (Phase 4b+) | Board + asset indexes per `googleSub` (D1 / KV / DO — TBD at implementation) |
| KV (optional) | Global share-code → boardId index for fast join lookup |

### Connection flow

1. Client on `/board/{uuid}` calls `useSync({ uri: wss://…/api/whiteboard/connect/{uuid}?…, assets })`.
2. Worker validates UUID, loads DO via `env.WHITEBOARDS.idFromName(uuid)`, forwards WebSocket.
3. DO accepts hibernatable WebSocket; creates/resumes `TLSocketRoom` with `SQLiteSyncStorage`.
4. Edits fan out to peers; DO is single authority (no split-brain).

### Host proof on socket

- Query param or first-message auth: `hostSecret`.
- DO compares to stored hash of host secret (store **hash only** at rest).
- Sets session role accordingly.
- Later: also accept verified Google session whose `sub` matches DO `hostGoogleSub`.

### Hibernation

- Use Durable Object WebSocket hibernation so idle rooms sleep without dropping connections incorrectly.
- Persist session snapshots on attachments per tldraw Cloudflare guidance (`serializeAttachment` / `handleSocketResume`).

### Binding sketch (`wrangler.jsonc`)

```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "WHITEBOARDS", "class_name": "WhiteboardBoard" }]
  },
  "migrations": [{ "tag": "whiteboard-v1", "new_sqlite_classes": ["WhiteboardBoard"] }],
  "r2_buckets": [{
    "binding": "WHITEBOARD_ASSETS",
    "bucket_name": "scsfoxchase-tech-whiteboards"
  }],
  "kv_namespaces": [{ "binding": "WHITEBOARD_CODES", "id": "…" }]
}
```

Product resource family remains **`scsfoxchase-tech_whiteboards`** (DO + R2 naming convention). Binding name `WHITEBOARDS` matches current Worker code; R2 binding name can be finalized at Phase 4a implement time.

---

## R2 persistence

### What lives where

| Data | Store |
|------|--------|
| Document shapes / pages / bindings | Durable Object SQLite via tldraw sync storage |
| Room metadata, host secret hash, active code, title, session permissions, optional `hostGoogleSub` | Durable Object metadata (SQLite/KV API inside DO) |
| Share code → boardId index | KV (TTL 12h) **and/or** reverse index inside DO + alarm |
| Images / videos / bookmarks binaries | R2 bucket `scsfoxchase-tech-whiteboards` |
| Signed-out Recents / Library / Assets lists | Client `localStorage` |
| Signed-in Recents / Library / Assets lists | Cloud index keyed by `googleSub` (Phase 4b+) |
| Device install id | Client `localStorage` |

### Decision: always upload binaries to R2

**Chosen approach:** always upload asset binaries to R2 when placed on a board — including while signed out. Do **not** keep primary blobs only in IndexedDB.

Rationale:

- One upload path for `TLAssetStore` (simpler sync/multiplayer: peers resolve the same Worker/R2 URL).
- Hub Assets can thumbnail/list without re-hydrating large IndexedDB blobs.
- Signed-out and signed-in differ only in **owner key** and **which index** lists the asset — not in whether bytes hit R2.

Unauthenticated objects under `local:*` are protected the same way boards are today: **capability URL / unguessable UUID**. Knowing `assetId` (and path) is required; there is no public listing API. Migrating `local:*` objects into `google:{sub}` is a **future explicit user action**, not automatic on sign-in.

### R2 key layout

```
assets/{ownerKey}/{assetId}
```

Examples:

- Signed out: `assets/local:550e8400-e29b-41d4-a716-446655440000/7c9e6679-7425-40de-944b-e07fc1f90ae7`
- Signed in: `assets/google:108234567890123456789/7c9e6679-7425-40de-944b-e07fc1f90ae7`

Optional board-scoped convenience copies or redirects are **not** required if the document stores the resolve URL / asset id pointing at the owner-keyed object. Prefer a **single** R2 object per library asset id.

Legacy sketch `boards/{boardId}/{assetId}` is superseded by the owner-keyed layout above (Phase 4a implements the new layout; nothing production-critical uses the old sketch).

### Asset store (`TLAssetStore`)

- `upload(asset, file)` → mint/use library `assetId` (UUID v4) → `PUT` to Worker → R2 at `assets/{ownerKey}/{assetId}` → upsert active Assets index → return resolve URL / asset meta for tldraw.
- `resolve(asset)` → Worker `GET` URL for that object (public capability path or short-lived signed URL — pick one at implementation; default: unguessable path under `/api/whiteboard/assets/...`).

Constraints:

- Max upload size appropriate for Chromebooks (e.g. 5–10 MB); reject oversized with clear error.
- Content-Type allowlist: common image types (+ video if we enable it).
- No public “list all assets in bucket” API — only owner indexes (local or cloud) and capability gets.

### Snapshots / previews (hub cards)

Optional Worker job or client-side:

- Periodically (or on blur) export a small preview PNG via tldraw and store data URL in the active board library, or upload `boards/{id}/preview.png` to R2 for cross-device later.

v1 can use placeholders; preview upload is a follow-on within the same architecture.

---

## Share code lifecycle

1. Collaborator sets share code switch to **Open** (or clicks New code) → Worker/DO:
   - Samples unused `A1B2` code (retry on collision).
   - Writes KV `code → { boardId, exp }` with TTL 12h.
   - Stores `activeCode` + `codeExpiresAt` on DO; sets DO alarm for expiry cleanup.
2. Join → KV lookup → redirect.
3. Rotate (New code) → delete old KV key, mint new, update DO; switch stays Open.
4. Switch **Closed** / alarm → delete KV key, clear DO `activeCode`.
5. Join while Closed or expired → `404` with hub message: “That code isn’t available. Ask for a new code or open the board link.”

Collision strategy: random sample with retry; if pool pressure ever appears (unlikely at school scale), extend to 5 chars — out of scope now.

---

## API contracts (summary)

### `POST /api/whiteboard/boards`

Response:

```json
{
  "id": "uuid",
  "hostSecret": "…",
  "title": "Untitled board"
}
```

When signed in (Phase 4b+): also associate board with `googleSub` in the cloud board index (and optionally set DO `hostGoogleSub`).

### `GET /api/whiteboard/join/:code`

Response: `{ "id": "uuid" }` or 404.

### `POST /api/whiteboard/boards/:uuid/code`

Auth: valid board session (connected to this board, or short-lived session token issued at connect). Rate-limited.  
Response: `{ "code": "A1B2", "expiresAt": "ISO-8601" }`

### `DELETE /api/whiteboard/boards/:uuid/code`

Same auth as mint. Revokes active code.

### `PATCH /api/whiteboard/boards/:uuid/meta`

- `title`: any board session (also mirrored into the **active** client/cloud library).

Body example:

```json
{ "title": "Science Lab Period 2" }
```

### `PATCH /api/whiteboard/boards/:uuid/participants/:sessionId`

Auth: host secret (later also host Google).  
Body: `{ "canEdit": false }`  
Updates that session’s edit permission; DO pushes readonly state to the target client.

### WebSocket `/api/whiteboard/connect/:uuid`

tldraw sync protocol; query includes optional `hostSecret`. Presence exposes session list for the manage panel People rows. Optional query/header for Google session once auth exists (for display name + host reclaim).

### Assets (Phase 4a)

Exact path shape TBD at implement time; conceptually:

- `PUT /api/whiteboard/assets/:assetId` — body = binary; headers include content-type; owner derived from device install id (signed out) or Google session (signed in). Writes `assets/{ownerKey}/{assetId}`.
- `GET /api/whiteboard/assets/:assetId` (or path including ownerKey) — returns bytes if the capability path is known.

Client always upserts the active Assets index after a successful upload.

### Cloud library APIs (Phase 4b+)

CRUD for signed-in board and asset indexes scoped to `googleSub`. Exact routes and store (D1/KV/DO) TBD with auth implementation.

---

## Frontend architecture

| Module | Responsibility |
|--------|----------------|
| `Header.astro` | Context-aware Whiteboard control (link vs manage button); later Sign in with Google |
| `whiteboard-menu.ts` (evolve) | Off-board: unused / simple. On-board: open/close manage popover |
| Hub components | Create/Join actions; Recents; **Assets** strip; Library grids; ⋮ menus |
| `TldrawBoard.tsx` | `useSync` store, per-session readonly binding, license key, presence → panel; R2 `TLAssetStore` |
| Manage panel UI | Name + Save, code open/closed, People + Edit switches |
| `whiteboard-library.ts` | localStorage board Recents/Library + host secrets + deviceInstallId |
| `whiteboard-assets.ts` (evolve) | R2-backed `TLAssetStore` + local/cloud asset index helpers |
| Auth module (Phase 4b+) | Google session; mode switch; identity fields |
| Worker `WhiteboardBoard` DO | Sync room + codes + participant `canEdit` |
| Worker asset handlers | R2 put/get under owner keys |

Evolve the existing drawer script into the on-board manage panel; do not leave the old New/Join drawer on non-board pages (those go to the hub).

---

## Security & school constraints

- No public board or asset listing API — boards and assets are unlisted; UUID paths are capability URLs.
- Host secret is a second capability for admin actions; store hashed server-side.
- Rate-limit code mint, join attempts, and asset uploads on the Worker.
- CSP already used site-wide — ensure WebSocket + asset endpoints allowed.
- Do not put host secrets in the shareable URL.
- Readonly must be enforced by sync permissions, not only UI.
- Google tokens verified server-side; never trust client-supplied `googleSub` alone for cloud writes.
- `local:*` R2 objects are not encrypted at rest beyond R2 defaults; protection is unguessability — same threat model as unlisted boards.

---

## Device fit

- Hub: keep create/join + Recents (+ Assets strip) above the fold on 1366×768 Chromebooks where possible; Library can scroll.
- Assets: single compact row — do not turn into a second full Library grid.
- Board: header + canvas only; no footer; avoid vertical overflow.
- iPad landscape: header compresses via existing global breakpoints; canvas still fills remainder.

---

## Implementation phases

### Done (as of this update)

1. **Routes + chrome** — Hub page UI; `/board/[uuid]` with header + tldraw; context-aware Whiteboard control (link vs manage).
2. **Create + library** — UUID create, local Recents/Library, rename + Save / Delete in manage / cards.
3. **Sync DO** — WebSocket + `TLSocketRoom` + SQLite persistence; `useSync` on live boards (`WHITEBOARDS` binding).

### Remaining (revised)

**4a. R2 + Assets hub (signed-out path first)** — recommended next

- Create R2 bucket `scsfoxchase-tech-whiteboards` (R2 forbids `_`; product family spelling unchanged).
- Mint/store `deviceInstallId`; owner key `local:{deviceInstallId}`.
- `TLAssetStore` upload/resolve to `assets/{ownerKey}/{assetId}`.
- localStorage asset index `scsfoxchase.whiteboard.assets`.
- Hub **Assets** strip between Recents and Library (⋮ Rename / Delete).
- Auto-index assets when placed on a board.
- Design data model fields so `google:{sub}` can drop in later without re-keying the scheme.

**4b. Google auth + cloud libraries** — after 4a (do not block 4a)

- Sign in with Google (OIDC/OAuth; library TBD).
- Identity: `googleSub`, `email`, `displayName`, `avatarUrl?`.
- Cloud board + asset indexes keyed by `googleSub`.
- Dual-mode switching (local ↔ cloud) per [Dual library mode](#dual-library-mode-signed-out-vs-signed-in).
- Presence display names (+ optional cursor tags) from Google.
- Optional DO `hostGoogleSub` on signed-in create.

**5. Share codes** — KV/DO codes, hub join, Open/Closed switch + copy in manage panel.

**6. Per-user Edit switches** — presence list, host-controlled `canEdit`, readonly enforcement. Works on session ids without Google; nicer names once 4b is live. Prefer implementing Edit after share codes; wire Google names when available (soft dependency).

Phases 1–3 are shipped foundation; **4a unblocks pasted media + Assets hub** without waiting on school Google login. **4b** layers accounts on the same owner-key model. **5–6** complete classroom share + permission UX.

---

## Out of scope (this product spec, not forever)

- Automatic merge / wipe of local ↔ cloud libraries on sign-in or sign-out (explicitly **not** desired)
- “Upload local boards/assets to account” migration wizard (future optional action)
- Classroom Google roster sync / Google Classroom assignment deep links
- Board trash / hard delete of DO rooms (hub Delete = index removal only for now)
- Password-protected boards beyond unlisted UUID + host secret
- Mobile phone–first layout polish beyond existing breakpoints
- Legacy `/whiteboard?room=` redirects
- IndexedDB-as-primary-blob-store for assets (rejected in favor of always-R2)

Google Sign-In itself is **in scope for design** and **Phase 4b implementation**, not “forever out of scope.”

---

## Success criteria

- Teacher or student can create a board, share a link, and collaborate in realtime on Chromebooks.
- Classmates can join with a 4-character code during the school day without typing a UUID.
- Returning later via bookmark/Recents opens the same board document from DO-backed state; assets resolve from R2.
- Placing media on a board also lists it under hub **Assets** for the active mode.
- Signed-out and signed-in libraries are separate; switching modes never destroys the other namespace.
- Host can turn Edit off for individual collaborators; those guests cannot edit while locked.
- Site header remains available on boards; Whiteboard control opens manage panel on-board and goes to hub elsewhere.
- Boards never share storage keys (UUID everywhere); assets are owner-keyed under `local:*` or `google:*`.

---

## Next steps (recommendation)

1. **Implement Phase 4a next** — R2 (`scsfoxchase-tech-whiteboards`) + signed-out `deviceInstallId` / `local:{…}` uploads + local asset index + hub Assets strip + auto-index on place. Do **not** block this on Sign in with Google.
2. **Keep Google in the data model now** — `ownerKey`, identity fields, dual-mode rules, and cloud index shape are specified so 4b is additive.
3. **Then Phase 4b** — Google OIDC + cloud indexes + presence names; dual-mode UI switch.
4. **Then Phase 5 (share codes) and Phase 6 (per-user Edit)** — Edit can ship with session labels; upgrade People/cursors when 4b display names exist.

**Verdict:** prefer **Phase 4a before auth**, not auth-first. Auth improves cross-device library and names but is not required for multiplayer sync, R2 media, or the Assets hub.

---

## References

- Wireframe: `Whiteboard page.tldraw`
- tldraw readonly: https://tldraw.dev/sdk-features/readonly
- tldraw sync: https://tldraw.dev/docs/sync
- Reference worker: https://github.com/tldraw/tldraw-sync-cloudflare
- Cloudflare Durable Objects (SQLite + hibernatable WebSockets)
- Product resource family: `scsfoxchase-tech_whiteboards`; R2 bucket name: `scsfoxchase-tech-whiteboards` (see `DEPLOYMENT.md`, `wrangler.jsonc`)
