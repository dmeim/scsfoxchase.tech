# Share codes

Short join codes for classroom boards: Open / Closed, Copy, New, hub join, and KV + Durable Object expiry.

Treat live share codes as **secrets**. Anyone who can read an Open code can join the board. They land as **Viewer** unless **Group Edit** is On (then share-code joiners can draw) or an Owner/Manager sets **Editor** on **People**. UUID-only links stay **Viewer**. Do not write a code on a hallway-facing board or otherwise project it where passers-by can photograph it. Prefer the board link (`/board/{uuid}`) for anything that stays on screen.

## Overview

A share code is a four-character token: **digit, letter** twice (`1A2B` form, `([0-9][A-Z]){2}`). While **Open**, the code resolves to a board UUID for 12 hours. **Closed** (or expiry) **drops the KV mapping** so `GET /api/whiteboard/join/:code` cannot start a new session.

**Owner or Manager** only can Open, Closed, rotate, or copy the code. Editor and Viewer get **403** (`Only the Owner or a Manager can manage the share code.`). Proof is a live session token, scratch host secret, or Clerk matching `cloudOwnerKey`. Leftover host secret on a Google-owned board is **not** enough. Knowing the board UUID is **not** share-admin proof.

Join lookup (`GET /api/whiteboard/join/:code`) stays **unauthenticated** (rate-limited). A code only **opens** the board; role is decided on connect. Join is **view-only** unless **Group Edit** is On (share-code joiners land as **Editor**) or an Owner or Manager sets **Editor** on **People**. UUID-only stays **Viewer**. Opening a code does not by itself mean students can draw.

**Closed does not revoke the UUID.** UUID access remains a separate capability: `/board/{uuid}` still loads the canvas after Closed until connect-time auth exists (see the “Connect trusts client userId” launch item). Closed only stops *new* joins that still need the short code.

## Format and TTL

| Property | Value |
|----------|--------|
| Pattern | Four characters — digit-letter twice (`1A2B` form) |
| Normalization | Trim + uppercase |
| TTL | **12 hours** (`SHARE_CODE_TTL_SECONDS` / `SHARE_CODE_TTL_MS` in `src/worker/shareCode.ts`) |
| KV key | `code:{1A2B}` |
| KV value | JSON `{ boardId, exp }` with `expirationTtl` matching the TTL |

Helpers: `normalizeShareCode`, `sampleShareCode`, `kvCodeKey` in `src/worker/shareCode.ts`.

Existing codes in KV from before this format change (eight-character `A1B2C3D4` era) no longer parse. Teachers need **Open** / **New code** after deploy so students get a `1A2B`-form code.

## Storage model

Two layers stay in sync:

1. **KV** (`WHITEBOARD_CODES`) — join lookup index.
2. **Durable Object** (`WhiteboardBoard`) — `meta:activeCode`, `meta:codeExpiresAt`, DO **alarm** at expiry, mint rate log.

The DO has **one** alarm slot: the sooner of share-code expiry (12h) and unsaved-board TTL (24h). The alarm handler reschedules whatever is still pending.

On mint/rotate the DO writes KV and schedules an alarm. On revoke or alarm, it deletes the KV key and clears DO code meta. `GET` that finds an expired DO code revokes it and returns closed. That KV delete is what keeps Closed from minting new joins; join never writes a new mapping.

## HTTP API

Routed in `src/worker.ts` → `src/worker/codeRoutes.ts` (join) or forwarded to the board DO (code CRUD).

### Join

```
GET /api/whiteboard/join/:code
```

**Auth:** none (rate-limited). Returns a board UUID only; it does not grant Editor.

**Response 200:** `{ "id": "<board-uuid>" }`  
**404:** code missing, expired, malformed, or bad board id — message: *That code isn't available…*  
**429:** join rate limit (see below) — *Too many join attempts. Wait a moment and try again.*

Used by the hub when the join field looks like a share code (`lookupShareCode` in `src/lib/whiteboard-codes.ts`). The hub treats codes as 1A2B-form tokens (`src/scripts/whiteboard-hub.ts`).

### Board code state

```
GET    /api/whiteboard/boards/:uuid/code
POST   /api/whiteboard/boards/:uuid/code          # open / keep
POST   /api/whiteboard/boards/:uuid/code?rotate=1 # mint new
DELETE /api/whiteboard/boards/:uuid/code          # closed
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
{ "code": "<1A2B-form-code>", "expiresAt": "2026-07-20T23:00:00.000Z", "open": true }
```

**Closed / after DELETE:**

```json
{ "code": null, "expiresAt": null, "open": false }
```

| Action | Behavior |
|--------|----------|
| Open (`POST`, no rotate) | If a valid code exists, keep it; otherwise mint |
| New code (`POST?rotate=1`) | Delete old KV entry, mint a new code, reset 12h TTL |
| Closed (`DELETE`) | Revoke KV + DO meta + alarm. Join by that code 404s. `/board/{uuid}` still works until connect auth exists (UUID access is a separate capability). |

### Rate limit

Two separate limits:

| Limit | Where | Window |
|-------|--------|--------|
| **Join per IP** | `handleJoin` in `codeRoutes.ts` | **60** attempts per **60 seconds** (all joins: success and fail). Sized for a class behind one school NAT. |
| **Join per-code failed lookups** | `handleJoin` after a miss/expiry | **10** failed lookups per code per **60 seconds**. Successful joins of an Open code do not count. |
| **Mint/rotate** | Durable Object `assertMintAllowed` | **12** attempts per board per **10-minute** rolling window (`meta:codeMintLog`). Exceeding returns **429**. Unrelated to join. |

Join counters are **isolate-local** (in-memory on the Worker isolate). KV is not used for these counters: a class burst would collide with KV’s ~1 write/sec per key. Limits reset if the isolate recycles; they still stop unmetered four-character-style enumeration on a live isolate.

Allocation retries random samples (up to 24) until a free KV key is found.

## Manage panel UI

On `/board/{uuid}`, header manage panel (`Header.astro` + `whiteboard-menu.ts`). Share Open / Closed, click-to-copy, **New Code**, and **Copy Link** are **Owner/Manager only** (`canManageShare`). Editor and Viewer do not see those controls.

- Left column **Share** switch (Open / Closed) — `openBoardShareCode` / `closeBoardShareCode`
- Left column **Group Edit** switch (Owner/Manager; `meta:classCanEdit`) — Off by default. On = joiners of the active share code land as Editor. UUID-only stays Viewer.
- Hint: *Share-code joiners can draw when Group Edit is on. UUID links stay view-only unless you set Editor on People.*
- When Open, the tools column shows:
  - Share code **button** (not an input) with clipboard icon — click / Enter / Space to copy
  - **New Code** — rotate (`?rotate=1`)
  - **Copy Link** — permanent `{origin}/board/{uuid}` URL
  - Expiry line updated about every 30s (`formatShareExpiry` → “Codes expire in 11h 42m. A new code is needed to share again.”)
  - **People** (roles + Follow) — see [people-permissions.md](./people-permissions.md)

Keep the code off hallway-facing displays; use **Copy Link** when the URL can stay on screen. Copying the link does not grant draw access.

## Hub join flow

1. User enters code (or link/UUID) on `/whiteboard`.
2. Hub classifies as `code` (four-character digit-letter) or `board`.
3. For codes: `GET /api/whiteboard/join/:code` → UUID.
4. Navigate to `/board/{uuid}`. Join does **not** write Recents/Library.

Joining does **not** make the user Owner. Scratch Owner stays with the creating browser (host secret). Saved boards use the Google Owner. Join is **view-only** unless **Group Edit** is On or an Owner or Manager sets **Editor** on **People** — a join code alone does not mean students can draw. UUID-only stays **Viewer**. See [hub-and-board.md](./hub-and-board.md) and [people-permissions.md](./people-permissions.md).

## Key files

| Path | Role |
|------|------|
| `src/worker/shareCode.ts` | Format, TTL, KV key helpers |
| `src/worker/codeRoutes.ts` | Join + join rate limits + forward board code routes |
| `src/worker/WhiteboardBoard.ts` | Mint / revoke / alarm / mint rate limit / `requireShareCodeAdmin` (Owner/Manager) |
| `src/lib/whiteboard-codes.ts` | Client fetch helpers + expiry label |
| `src/scripts/whiteboard-menu.ts` | Manage panel share UI |
| `src/scripts/whiteboard-hub.ts` | Hub join by code |
| `wrangler.jsonc` | `WHITEBOARD_CODES` KV binding |
