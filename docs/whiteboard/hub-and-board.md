# Hub and board UI

How teachers and students create, join, and manage whiteboards in the browser.

## Overview

- **Hub** (`/whiteboard`) — create a board, join by share code / link / UUID. Recents, Assets, and Library render only when signed in (cloud indexes).
- **Board** (`/board/{uuid}`) — full-page Excalidraw canvas under the site header; manage panel opens from the centered **Whiteboard** control.
- There is **no localStorage board library**. Signed-out create is a live scratch Durable Object (URL + DO). Save / reopen from Library requires Google sign-in. See [auth-libraries.md](./auth-libraries.md).

Call the product **Whiteboard**, not Excalidraw.

## Hub (`/whiteboard`)

**Page:** `src/pages/whiteboard.astro`  
**Script:** `src/scripts/whiteboard-hub.ts`  
**Styles:** `src/styles/whiteboard.css`

Chromebook vertical space: `@media (max-height: 800px)` tightens hub padding and section gaps so the page still fits 1366×768 without scrolling.

### Create

- **Create a new whiteboard** mints a UUID, stores a **host secret** in `localStorage` (ephemeral Owner proof for this browser), then navigates to `/board/{uuid}`.
- Default title: `YYYY-MM-DD_HH-MM-SS` (local 24-hour time).
- Create waits for Clerk auth to settle (`whenAuthReady`) so signed-in users autosave to the cloud library and become **Owner**.
- Signed-out create does **not** write a library index. The board stays in the Durable Object across Chromebook refresh and is deleted after **24 hours** if it is never saved.

### Join

The join field accepts:

| Input | Behavior |
|-------|----------|
| Share code `A1B2C3D4` | `GET /api/whiteboard/join/:code` → board UUID, then open |
| Full URL or `/board/{uuid}` path | Parse UUID from path |
| Bare UUID | Open directly |

Join does **not** add the board to Recents/Library. Invalid input or an unavailable code shows a hint under the field.

A share code (or link / UUID) only **opens** the board. Joiners land as **Viewer**: they can watch, not draw. There is no class-wide Editor setting yet. Until one ships, an Owner or Manager must set **Editor** on each person in the **People** list (manage panel, Share Open). Opening a code does not give the class draw access.

Join parsing: `parseJoinInput` in `src/scripts/whiteboard-library.ts`.  
Code lookup: `lookupShareCode` in `src/lib/whiteboard-codes.ts`. Details: [share-codes.md](./share-codes.md).

### Recents / Library / Assets

Shown only while signed in (`[data-wb-cloud-lists]`). Signed-out hub copy explains scratch vs Save.

| Section | Content |
|---------|---------|
| **Recents** | Up to 8 boards by `lastAccessedAt` from the Google library |
| **Library** | Full sorted cloud board list |
| **Assets** | Hidden for now — canvas uploads stay on the board (`assets/{ownerKey}/{fileId}`) and are not a class media library |

Recents and Library cards support **Rename** and **Delete** (confirmation). Delete removes the **cloud index** row only. Board delete does not delete Durable Object state or R2 media for classmates still on the board.

While Clerk is loading, empty states show **Loading…** so cloud lists do not flash empty.

Hub footer note switches copy for signed-in vs signed-out.

### Hub header link

Off the board page, the header center control is a link to `/whiteboard` (`data-whiteboard-mode="hub"` in `Header.astro`). The Whiteboard chip is visible (not hidden).

## Board page (`/board/{uuid}`)

**Page:** `src/pages/board.astro`  
**Canvas:** `src/components/WhiteboardCanvas.tsx` (`client:only="react"`)  
**Rewrite:** `public/_redirects` — `/board/*` → `/board` (200); `src/middleware.ts` does the same in `astro dev`.

Fonts: `board.astro` sets `window.EXCALIDRAW_ASSET_PATH = '/excalidraw/'` in `<head>` before the island mounts. The canvas module sets the same path as a fallback.

### Shell behavior

- Invalid or missing UUID → redirect to `/whiteboard`.
- On load (after auth ready), `touchBoardActive(boardId)` updates last-accessed for boards already in the signed-in library, or **claims** a scratch board this browser created (host secret present). Join without a secret does not upsert Recents.
- Footer is hidden (`hideFooter`); `boardChrome={true}` enables the manage panel in the header.

### Canvas

`WhiteboardCanvas`:

1. Reads `boardId` from the path (or optional prop).
2. Opens a native WebSocket to `/api/whiteboard/connect/{uuid}` (`sessionId` required; optional `displayName` and guest `userId` on the query). Scratch host proof and Clerk JWT are the first message (`wb:auth`), not the URL. `X-Board-Host` is also accepted on the upgrade if a client can set it.
3. Merges remote elements with `reconcileElements`; remote applies use `captureUpdate: NEVER`.
4. Uploads image/GIF bytes to R2 by Excalidraw `fileId`; MP4/WebM become a same-origin `/whiteboard-player` embed. YouTube / Vimeo stay stock.
5. Handles custom DO messages (`wb:hello`, `wb:participants`, `wb:role`, `wb:forceFollow`, `wb:sceneBounds`) and bridges Follow / roles to the manage panel via `window` events.

Sync and asset details: [sync-storage.md](./sync-storage.md).  
People / roles / Follow: [people-permissions.md](./people-permissions.md).

## Header manage panel

**Markup:** `src/components/Header.astro` (`boardChrome` branch)  
**Behavior:** `src/scripts/whiteboard-menu.ts` (`data-whiteboard-mode="manage"`)

Toggle: **Whiteboard** button opens a dialog panel. Escape / outside click closes it.

### Name this whiteboard

- Editable title (max 80 chars) → Save → `setBoardTitleActive`.
- Signed in + already in library (or this browser created it): saved to the Google library.
- Signed out: title is kept in `sessionStorage` for this scratch tab only — it is not a local library.

### Share

Open / Closed switch on the left column. When **Open**, the right column shows the share code (click to copy), **New Code**, **Copy Link** (permanent `/board/{uuid}` URL), expiry countdown, and People. See [share-codes.md](./share-codes.md).

The code is a join token, not an edit grant. Students who join with it stay **Viewer** until you set **Editor** on **People**.

Anyone who can open the board URL can call the code API (UUID is the capability). Host secret is **not** required for share-code actions.

### Follow Me

Owner/Manager control beside the **People** heading (hidden unless this session can force-follow). Toggle plus a target select (self or another participant). Unlike voluntary Follow (pan to unfollow), Follow Me **locks** the camera — guests cannot pan away; the island snaps to leader bounds and covers the canvas with a transparent overlay. See [people-permissions.md](./people-permissions.md).

### People

Shown only while Share is Open. Columns: **Name** | **Follow** | **Role**. Live list from DO custom messages. See [people-permissions.md](./people-permissions.md).

Until a class-Editor setting exists, use the **Role** column to promote a joiner from **Viewer** to **Editor** if they should draw.

### Whiteboard Library

Secondary link on the left column back to `/whiteboard`.

## Ephemeral Owner (scratch boards)

When a board is **created** on a device, a 32-byte hex secret is stored at:

`localStorage['scsfoxchase.whiteboard.host.' + boardId]`

On connect, that secret is sent in the first WebSocket message (`wb:auth` `hostSecret`) or as `X-Board-Host` — not on the connect query string (query strings hit access logs). The Durable Object hashes it (SHA-256) and:

- First secret seen for the board → stored as host hash; that session is **ephemeral Owner**.
- Later connects with the same secret → Owner on an unsaved board; without it → guest (**Viewer** by default).

On a **saved** board, Owner is the Google account (`google:{accountId}`), not whoever still holds the creating-browser secret.

**Owner/Manager** manage actions: role changes, Follow Me / force-follow.  
**Not Owner-gated:** rename (library, when allowed), share Open/Closed / click-code copy / New Code / Copy Link, voluntary Follow.

Joining via link or code does **not** grant the host secret — only the creating browser (unless the secret is copied into another browser’s `localStorage`).

Helpers: `createBoardActive`, `getHostSecret`, `claimBoardToLibrary` in `src/scripts/whiteboard-library.ts`.

## Key files

| Path | Role |
|------|------|
| `src/pages/whiteboard.astro` | Hub markup |
| `src/pages/board.astro` | Board shell + font path + touch/title script |
| `src/pages/whiteboard-player.astro` | Same-origin video player |
| `src/scripts/whiteboard-hub.ts` | Create, join, render lists, card menus |
| `src/scripts/whiteboard-menu.ts` | Manage panel |
| `src/scripts/whiteboard-library.ts` | Cloud library, host secret, join parsing |
| `src/components/WhiteboardCanvas.tsx` | Excalidraw collab island |
| `src/components/Header.astro` | Manage panel DOM + Clerk |
| `public/_redirects` | `/board/*` → `/board` |
| `src/middleware.ts` | Dev rewrite for `/board/{uuid}` |
