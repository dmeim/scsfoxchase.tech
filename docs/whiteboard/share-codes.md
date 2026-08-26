# Share codes

Short join codes for classroom boards: one permanent code per board, Copy Code / Copy Link, hub join, and KV + Durable Object storage.

Treat live share codes as **classroom PINs**. Anyone who can read the code can join the board for as long as it exists. Share-code joiners land as **Editor**; they can draw only while **Group Edit** is On. UUID-only links stay **Viewer** unless an Owner/Manager sets **Editor** on **People**. Do not write a code on a hallway-facing board. Prefer the board link (`/board/{uuid}`) for anything that stays on screen.

## Overview

Each board has **one** share code, minted once (`1A2B3C4D` form — digit-letter four times). It does not expire, rotate, or close. Joiners who type the code (hub sets a ~12h join-proof cookie) land as **Editor**. Direct UUID / Copy Link visits without that cookie stay **Viewer**.

**Owner or Manager** only can read the code and copy it. Editor and Viewer get **403** (`Only the Owner or a Manager can manage the share code.`). Proof is a live session token, scratch host secret, or Clerk matching `cloudOwnerKey`. Leftover host secret on a Google-owned board is **not** enough. Knowing the board UUID is **not** share-admin proof.

Join lookup (`GET /api/whiteboard/join/:code`) stays **unauthenticated** (rate-limited). A code only **opens** the board; **Group Edit** decides whether Editors can draw. UUID-only stays **Viewer**.

Deleting the board from the cloud library **frees the KV mapping**. `/board/{uuid}` may still load (UUID access is a separate capability). Unsaved 24h expiry also deletes the KV key.

## Format

| Property | Value |
|----------|--------|
| New mints | Eight characters — digit-letter four times (`1A2B3C4D`) |
| Join also accepts | Legacy four-character `1A2B` codes still in KV |
| Normalization | Trim + uppercase |
| TTL | **None.** The code lasts for the life of the board |
| KV key | `code:{CODE}` |
| KV value | JSON `{ boardId }` with **no** `expirationTtl` |

Helpers: `normalizeShareCode`, `sampleShareCode`, `kvCodeKey` in `src/worker/shareCode.ts`.

Existing 4-character codes are kept and rewritten to KV without TTL on the next Owner/Manager GET or board connect. New boards mint 8-character codes.

A ~**12 hour** join-proof **cookie** (`scsfoxchase_wbj_{boardId}`) still proves “this tab typed the code.” The code itself does not expire; after the cookie lapses, a UUID visit is Viewer until the student enters the code again.

## Storage model

Two layers stay in sync:

1. **KV** (`WHITEBOARD_CODES`) — join lookup index (no TTL).
2. **Durable Object** (`WhiteboardBoard`) — `meta:activeCode`, mint rate log.

The DO has **one** alarm slot for **unsaved-board TTL (24h)** only. Share codes are not alarmed.

On first connect (`ensureBoardLifetime`) the DO mints if missing and upserts KV without TTL. Library delete calls Durable Object RPC `revokeShareCodeMapping` so the PIN returns to the pool. `DELETE /code` remains as an internal HTTP path (unsaved expiry / admin). Not a manage-panel action.

## HTTP API

Routed in `src/worker.ts` → `src/worker/codeRoutes.ts` (join) or forwarded to the board DO (code CRUD).

### Join

```
GET /api/whiteboard/join/:code
```

**Auth:** none (rate-limited). Returns a board UUID only; it does not grant draw access.

**Response 200:** `{ "id": "<board-uuid>" }`  
**404:** code missing, malformed, or bad board id — message: *That code isn't available…*
**429:** join rate limit (see below) — *Too many join attempts. Wait a moment and try again.*

Used by the hub when the join field looks like a share code (`lookupShareCode` in `src/lib/whiteboard-codes.ts`).

### Board code state

```
GET    /api/whiteboard/boards/:uuid/code       # read; mint if none
POST   /api/whiteboard/boards/:uuid/code       # same (ensure minted)
DELETE /api/whiteboard/boards/:uuid/code       # internal revoke
```

**Auth (GET of the secret value, POST, DELETE):** Owner/Manager. The Worker forwards host proof, live session token, and/or Clerk session to the Durable Object (`requireShareCodeAdmin` in `WhiteboardBoard.ts`). Client helpers send those headers (`shareAdminHeaders` in `src/lib/whiteboard-codes.ts`).

| Proof | When it counts |
|-------|----------------|
| Live session (`X-Board-Session` + `X-Board-Auth`) | Connected Owner or Manager |
| Scratch host secret (`X-Board-Host` / Bearer) | Unsaved board only (no `google:` cloud owner) |
| Clerk matching `cloudOwnerKey` | Saved Google Owner |

**403:** Viewer, Editor, unsigned caller, or leftover host on a Google-owned board — `{ "error": "Only the Owner or a Manager can manage the share code." }`

**GET / POST success shape:**

```json
{ "code": "<1A2B3C4D-or-legacy-1A2B>" }
```

**After DELETE / no code:**

```json
{ "code": null }
```

| Action | Behavior |
|--------|----------|
| GET / POST | If a valid code exists, keep it and rewrite KV without TTL; otherwise mint 8-character |
| DELETE | Revoke KV + DO meta. Join by that code 404s. `/board/{uuid}` still works. Used on library delete and unsaved expiry |

There is no rotate and no Open/Closed.

### Rate limit

Two separate limits:

| Limit | Where | Window |
|-------|--------|--------|
| **Join per IP** | `handleJoin` in `codeRoutes.ts` | **60** attempts per **60 seconds** (all joins: success and fail). Sized for a class behind one school NAT. |
| **Join per-code failed lookups** | `handleJoin` after a miss | **10** failed lookups per code per **60 seconds**. Successful joins do not count. |
| **First mint** | Durable Object `assertMintAllowed` | **12** attempts per board per **10-minute** rolling window (`meta:codeMintLog`). Exceeding returns **429**. Unrelated to join. |

Join counters are **isolate-local** (in-memory on the Worker isolate). Limits reset if the isolate recycles.

Allocation retries random samples (up to 24) until a free KV key is found.

## Manage panel UI

On `/board/{uuid}`, header manage panel (`Header.astro` + `whiteboard-menu.ts`). Share code, Copy Code, and Copy Link are **Owner/Manager only** (`canManageShare`). Editor and Viewer do not see those controls.

- Header: **← Library**, inline name + pencil, **Share Code** chip (click to copy)
- **Copy Code** / **Copy Link** under the chip, each with an info popover
- Right column **Sharing Features:** Group Edit, Follow User
- Left column **People** (always, not gated on sharing)

Keep the code off hallway-facing displays; use **Copy Link** when the URL can stay on screen. Copying the link does not grant Editor.

## Hub join flow

1. User enters code (or link/UUID) on `/whiteboard`.
2. Hub classifies as `code` (4- or 8-character digit-letter) or `board`.
3. For codes: `GET /api/whiteboard/join/:code` → UUID.
4. Navigate to `/board/{uuid}`. Join does **not** write Recents/Library. A successful code lookup stores the join-proof cookie.

Joining does **not** make the user Owner. Scratch Owner stays with the creating browser (host secret). Saved boards use the Google Owner. Share-code joiners land as **Editor**; UUID-only stays **Viewer**. **Group Edit** Off freezes Editors (view-only) without changing the role. See [hub-and-board.md](./hub-and-board.md) and [people-permissions.md](./people-permissions.md).

## Key files

| Path | Role |
|------|------|
| `src/worker/shareCode.ts` | Format, KV key helpers |
| `src/worker/codeRoutes.ts` | Join + join rate limits + forward board code routes |
| `src/worker/WhiteboardBoard.ts` | Mint-once / revoke / mint rate limit / `requireShareCodeAdmin` (Owner/Manager) |
| `src/lib/whiteboard-codes.ts` | Client fetch helpers |
| `src/scripts/whiteboard-menu.ts` | Manage panel share UI |
| `src/scripts/whiteboard-hub.ts` | Hub join by code |
| `wrangler.jsonc` | `WHITEBOARD_CODES` KV binding |
