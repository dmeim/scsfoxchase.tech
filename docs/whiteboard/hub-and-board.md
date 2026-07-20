# Hub and board UI

How teachers and students create, join, and manage whiteboards in the browser.

## Overview

- **Hub** (`/whiteboard`) — create a board, join by share code / link / UUID, browse Recents, Assets, and Library.
- **Board** (`/board/{uuid}`) — full-page tldraw canvas under the site header; manage panel opens from the centered **Whiteboard** control.
- Lists and titles follow **dual library mode**: signed out → this browser; signed in → Google cloud indexes. Sign-in/out swaps which list you see without wiping the other namespace. See [auth-libraries.md](./auth-libraries.md).

## Hub (`/whiteboard`)

**Page:** `src/pages/whiteboard.astro`  
**Script:** `src/scripts/whiteboard-hub.ts`  
**Styles:** `src/styles/whiteboard.css`

### Create

- **Create a new whiteboard** mints a UUID, stores a **host secret** in `localStorage`, upserts the board into the active library (local or cloud), then navigates to `/board/{uuid}`.
- Default title: `YYYY-MM-DD_HH-MM-SS` (local 24-hour time).
- Create waits for Clerk auth to settle (`whenAuthReady`) so signed-in users do not create under `local:{deviceInstallId}`.

### Join

The join field accepts:

| Input | Behavior |
|-------|----------|
| Share code `A1B2` | `GET /api/whiteboard/join/:code` → board UUID, then open |
| Full URL or `/board/{uuid}` path | Parse UUID from path |
| Bare UUID | Open directly |

On success the hub upserts the board into the active library (`touchBoardActive`) and navigates to `/board/{id}`. Invalid input or an unavailable code shows a hint under the field.

Join parsing: `parseJoinInput` in `src/scripts/whiteboard-library.ts`.  
Code lookup: `lookupShareCode` in `src/lib/whiteboard-codes.ts`. Details: [share-codes.md](./share-codes.md).

### Recents / Library / Assets

| Section | Content |
|---------|---------|
| **Recents** | Up to 8 boards by `lastAccessedAt` (same source as Library) |
| **Library** | Full sorted board list for the active mode |
| **Assets** | Images/videos uploaded from boards under the active owner key |

Each card supports **Rename** and **Delete** (confirmation). Delete removes the index entry for the **active** mode only (local or cloud). Board delete does not delete Durable Object state or R2 media for classmates still on the board; asset delete also best-effort `DELETE`s the R2 object.

While Clerk is loading, empty states show **Loading…** so local lists do not flash before cloud mode.

Hub footer note switches copy for signed-in vs signed-out mode.

### Hub header link

Off the board page, the header center control is a link to `/whiteboard` (`data-whiteboard-mode="hub"` in `Header.astro`).

## Board page (`/board/{uuid}`)

**Page:** `src/pages/board.astro`  
**Canvas:** `src/components/TldrawBoard.tsx` (`client:only="react"`)  
**Rewrite:** `public/_redirects` — `/board/*` → `/board` (200); `src/middleware.ts` does the same in `astro dev`.

### Shell behavior

- Invalid or missing UUID → redirect to `/whiteboard`.
- On load (after auth ready), `touchBoardActive(boardId)` upserts the board into the active library and fills the manage-panel title + `document.title`.
- Footer is hidden (`hideFooter`); `boardChrome={true}` enables the manage panel in the header.

### Canvas

`TldrawBoard`:

1. Reads `boardId` from the path (or optional prop).
2. Connects with `@tldraw/sync` `useSync` to `/api/whiteboard/connect/{uuid}` (plus `sessionId`, optional `hostSecret`, `displayName`, `userId`).
3. Uses `r2AssetStore` for image/video uploads.
4. Handles custom DO messages (`wb:participants`, `wb:canEdit`, `wb:forceFollow`) and bridges Follow / force-follow to the manage panel via `window` events.

Sync and asset details: [sync-storage.md](./sync-storage.md).  
People / Edit / force-follow: [people-permissions.md](./people-permissions.md).

## Header manage panel

**Markup:** `src/components/Header.astro` (`boardChrome` branch)  
**Behavior:** `src/scripts/whiteboard-menu.ts` (`data-whiteboard-mode="manage"`)

Toggle: **Whiteboard** button opens a dialog panel. Escape / outside click closes it.

### Name this whiteboard

- Editable title (max 80 chars) → Save → `setBoardTitleActive` (localStorage or cloud library).
- Hint: “Saved on this device.” vs “Saved to your Google library.”

### Share

Open / Closed switch on the left column. When **Open**, the right column shows the share code (click to copy), **New Code**, **Copy Link** (permanent `/board/{uuid}` URL), expiry countdown, and People. See [share-codes.md](./share-codes.md).

Anyone who can open the board URL can call the code API (UUID is the capability). Host secret is **not** required for share-code actions.

### Follow Me

Host-only toggle beside the **People** heading in the share-on right column (hidden unless `getHostSecret(boardId)` is present). Same force-follow API as before (“Everyone follows me”). See [people-permissions.md](./people-permissions.md).

### People

Shown only while Share is Open. Columns: **Name** | **Follow** | **Edit**. Live list from DO custom messages. See [people-permissions.md](./people-permissions.md).

### Whiteboard Library

Secondary link on the left column back to `/whiteboard`.

## Host secret (manage privileges)

When a board is **created** on a device, a 32-byte hex secret is stored at:

`localStorage['scsfoxchase.whiteboard.host.' + boardId]`

On WebSocket connect, that secret is sent as `hostSecret`. The Durable Object hashes it (SHA-256) and:

- First secret seen for the board → stored as host hash; that session is host.
- Later connects with the same secret → host; without it → guest.

**Host-only** manage actions: Edit switches, Follow Me.  
**Not host-gated:** rename (library), share Open/Closed / click-code copy / New Code / Copy Link, voluntary Follow.

Joining via link or code does **not** grant the host secret — only the creating browser (unless the secret is copied into another browser’s `localStorage`).

Helpers: `createBoard` / `createBoardActive`, `getHostSecret` in `src/scripts/whiteboard-library.ts`.

## Key files

| Path | Role |
|------|------|
| `src/pages/whiteboard.astro` | Hub markup |
| `src/pages/board.astro` | Board shell + touch/title script |
| `src/scripts/whiteboard-hub.ts` | Create, join, render lists, card menus |
| `src/scripts/whiteboard-menu.ts` | Manage panel |
| `src/scripts/whiteboard-library.ts` | Library, host secret, join parsing |
| `src/components/TldrawBoard.tsx` | Sync canvas island |
| `src/components/Header.astro` | Manage panel DOM + Clerk |
| `public/_redirects` | `/board/*` → `/board` |
| `src/middleware.ts` | Dev rewrite for `/board/{uuid}` |
