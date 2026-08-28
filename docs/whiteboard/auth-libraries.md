# Auth and cloud library

Clerk Google sign-in, owner keys, and how Recents / Library / Assets work as a **signed-in cloud library only**. There is no dual local/cloud board library. Library metadata is stored in D1; R2 retains previews, legacy media, and historical JSON source indexes for migration/recovery. New canvas image/video insertion is temporarily disabled; this page describes the compatibility reads retained during the rollback.

## Overview

- **Create** works signed in or out.
- **Local saving is gone.** No `localStorage` board library; signed-out Recents / Library / Assets are not shown.
- **Save / reopen from Library** requires Google sign-in. Signed-in **create autosaves** metadata to D1. That Google account is **Owner**.
- Signed-out create is a **live scratch board** (URL + Durable Object). The creating browser is **ephemeral Owner** (host secret) so roles and Follow still work. It is not in anyone’s library.
- “Leave and lose work” means **never saved to the cloud library**, not “destroy on refresh.” Chromebooks refresh. The scene stays in the DO; **unsaved boards and their temp R2 objects are deleted after 24 hours**.
- Sign in on a scratch board this browser created and Save: that Google account **claims Owner**, the D1 board row is written, legacy `temp:{boardId}` R2 files move under `google:{accountId}`, and the 24h TTL comes off. Existing board-scoped objects are not moved.
- New canvas image/video insertion is temporarily disabled. Existing media is still readable through legacy owner-key objects and the read-only board-scoped compatibility route. The Hub Assets index is a separate metadata list and is not a binary source of truth.

Join by share code, link, or UUID still works with **no account**. Role is decided on connect. Share-code joiners land as **Editor**. UUID-only stays **Viewer**. **Group Edit** (default Off) is a live draw gate: Editors can draw only while it is On. Owner or Manager can still set **Editor** on **People**.

## Clerk on the client

**Island:** `src/components/ClerkAuth.tsx` in the site header (`Header.astro`) with `client:only="react"` (same rationale as the board canvas — skip Vite SSR for `@clerk/react` hooks).

- Uses `@clerk/react` (`ClerkProvider`, `SignInButton`, `UserButton`) — Astro 7 is outside `@clerk/astro`’s peer range.
- Publishable key: `PUBLIC_CLERK_PUBLISHABLE_KEY` (inlined at build).
- Production Frontend API domain: **`clerk.scsfoxchase.tech`** (encoded in the live publishable key; OAuth callback on that host). Documented in `DEPLOYMENT.md`.
- Google-only provider is configured in the Clerk Dashboard (not custom OAuth redirect code).
- `AuthBridge` sets identity + session token getter; marks auth resolved for hub/board gating.

Optional allowlist: `PUBLIC_CLERK_ALLOWED_DOMAINS` (comma-separated domains and/or full emails). Empty → all Google accounts allowed. Client signs out and shows a hint when the email is not allowed (e.g. school domain).

Production `pk_live_` keys reject localhost — use the live site or a `pk_test_` instance for local auth.

## WebSocket admission and first-message auth

The Worker validates the board UUID, canonical UUID `sessionId`, and WebSocket upgrade before resolving the board Durable Object. `WHITEBOARD_CONNECT_LIMITER` admits 120 upgrades per 60 seconds keyed only by trusted `CF-Connecting-IP`; local/test fallback buckets expire and are capped at 4096 keys. A board caps total sockets at 64 and pending authentication sockets at 32. Pending auth expires after approximately 30 seconds without creating a per-socket alarm.

The upgrade is storage-write-free for an unauthenticated random UUID. An arbitrary `X-Board-Host` is only a non-mutating proof for an already initialized board; it cannot claim a fresh UUID. The creating browser must send a valid host secret in its first `wb:auth` frame. A `signedIn: true` frame without a JWT stays pending, and a later verified Clerk JWT upgrades the same socket. Existing UUID viewers can still read the scene. Share-cookie joiners are Editors, Clerk owners/managers are owners/managers, and signed-out creators are ephemeral scratch Owners. These auth transitions do not expose host secrets or tokens in URLs.

## Clerk on the Worker

**Module:** `src/worker/clerkAuth.ts` (`@clerk/backend`).

`requireClerkWhiteboardAuth(request, env)`:

1. `authenticateRequest` with authorized parties (production origins + localhost + request `Origin`).
2. Loads user; prefers Google `providerUserId` / `externalId` as **accountId**, else Clerk user id.
3. Builds `ownerKey = google:{accountId}`.
4. Enforces the same email allowlist as the client.

Used by:

- All `/api/whiteboard/library/*` routes
- `PUT` / `DELETE` on `google:*` asset paths
- `POST /api/whiteboard/assets/claim`

Secrets / vars: `CLERK_SECRET_KEY` (Worker secret), `PUBLIC_CLERK_PUBLISHABLE_KEY`, optional `PUBLIC_CLERK_ALLOWED_DOMAINS`. Local: `.dev.vars` (see `.dev.vars.example`). There is no `PUBLIC_TLDRAW_LICENSE_KEY`.

The board-scoped canvas route is read-only compatibility during the rollback. GET/HEAD is public and reads the R2 object directly; PUT/DELETE return `405`. There is no board asset manifest or board write-proof protocol. Legacy owner-key PUT/DELETE authorization remains separate and is described below.

## Owner keys

| Mode | Key / identifier | How it is chosen |
|------|------------------|------------------|
| Existing board-scoped compatibility asset | `boards/{boardId}/assets/{fileId}` | Object left by the abandoned uploader; read-only GET/HEAD, no manifest |
| Legacy signed-in canvas media | `assets/google:{accountId}/{fileId}` | Google OAuth `sub` when present; otherwise Clerk `user.id` |
| Legacy scratch canvas media | `assets/temp:{boardId}/{fileId}` | Board UUID; subject to the 24h scratch lifetime |
| Legacy leftover media | `assets/local:{deviceId}/{fileId}` | Read compatibility only; no new writes |
| Guest identity (not a library) | `deviceInstallId` in `localStorage` | Stable per browser for generated display names and Follow `userId` |

`getOwnerKey()` in `src/scripts/whiteboard-library.ts` still returns the signed-in Google key or `local:{deviceInstallId}` for legacy/library code. New canvas image and video insertion is disabled. Existing legacy image/video/player links may use `temp:` or `google:` owner keys, and those reads remain compatible. Objects left by the abandoned board-scoped uploader remain readable through the board-scoped GET/HEAD route. The hub no longer uploads under `local:`.

R2 media keys: `assets/{ownerKey}/{assetId}` for the live legacy media path; `boards/{boardId}/assets/{fileId}` only for existing objects retained through read-only compatibility.
The authoritative cloud metadata tables are `library_boards`, `library_assets`, `library_owner_imports`, and the board/asset tombstone tables in D1 `WHITEBOARD_LIBRARY`. `library_owner_imports` records completion of an authenticated canonical-owner lazy merge. An operator may optionally pre-seed validated rows, but must not write that marker because a global scan cannot resolve the canonical Google identity versus a legacy Clerk fallback. Historical R2 source indexes remain `library/{ownerKey}/boards.json` and `library/{ownerKey}/assets.json`; they are read-only and never rewritten by normal library routes.

Clearing site data creates a new `deviceInstallId` and a new guest name. It does not wipe a Google library.

## Cloud library vs scratch

| Surface | Signed out | Signed in |
|---------|------------|-----------|
| Recents / Library hub | Hidden | `GET/PUT/DELETE /api/whiteboard/library/boards` backed by D1. The Assets strip is hidden; canvas PUT does not add to the D1 asset metadata |
| Create | Scratch DO + host secret; 24h TTL | Autosave to cloud; Owner = this Google account |
| Join | Opens the board. Share-code joiners land as **Editor**; UUID-only stays **Viewer**. **Group Edit** Off = Editors view-only. Owner/Manager can still set **Editor** on **People** | Same; does **not** add Recents unless you already own it or Save a scratch you created |
| Save / claim | N/A (sign in first) | Creating-browser host secret + Clerk → Owner, write D1 metadata, lift TTL, move temp R2 |
| New canvas images/videos | Temporarily disabled | Temporarily disabled |
| Legacy canvas files | `temp:{boardId}` | `google:{accountId}` after save/claim |

Hub and manage panel wait for `whenAuthReady()` so signed-in users do not miss cloud upserts. `onAuthChange` re-renders hub lists when identity flips. Signing in on a scratch tab this browser created claims the board (`bindBoardPageScratchClaim`).

Identity module: `src/lib/whiteboard-identity.ts` (`setActiveIdentity`, `getSessionToken` / `getAuthHeaders`, `identityFromClerkUser`).

## Display names

| Context | Source |
|---------|--------|
| People list (full) | Clerk `fullName` (or first+last) when signed in; otherwise a generated guest name |
| Guests | `getOrCreateGuestDisplayName(deviceInstallId)` — school-safe adjective + animal, sticky on this browser (`scsfoxchase.whiteboard.guestDisplayName`) |
| Follow collaborator tag | Same People label (live **cursors are not v1**) |

Helpers: `src/lib/whiteboard-display-name.ts`.

## Cloud library API summary

All require a valid Clerk session. D1 rows are scoped to the authenticated `ownerKey`; the first authenticated access completes the canonical/legacy lazy import and marker if needed. Legacy R2 source indexes are imported only after exact validation and remain unchanged. Optional operator pre-seeding never finalizes an owner marker by itself.

| Method | Path | Body / notes |
|--------|------|----------------|
| `GET` | `/api/whiteboard/library/boards` | D1 `{ boards, ownerKey }` sorted by `lastAccessedAt` |
| `PUT` | `/api/whiteboard/library/boards` | D1 board metadata upsert; optional `X-Board-Host` to claim DO meta |
| `DELETE` | `/api/whiteboard/library/boards/:uuid` | Delete D1 metadata row |
| `GET` | `/api/whiteboard/library/assets` | D1 `{ assets, ownerKey }` |
| `PUT` | `/api/whiteboard/library/assets` | D1 asset metadata; `ownerKey` must match session |
| `DELETE` | `/api/whiteboard/library/assets/:uuid` | Delete D1 metadata row |
| `GET` | `/api/whiteboard/boards/:uuid/meta` | `{ savedToLibrary, cloudOwnerKey, unsavedExpiresAt, … }` |
| `PATCH` | `/api/whiteboard/boards/:uuid/meta` | Host secret; `savedToLibrary` + `cloudOwnerKey` lifts 24h TTL |

The board-scoped compatibility route is not part of the Clerk-owned index API:

| Method | Path | Auth / behavior |
|--------|------|----------------|
| `GET` / `HEAD` | `/api/whiteboard/boards/:uuid/assets/:fileId` | Public read of an existing R2 object; no DO manifest lookup |
| `PUT` / `DELETE` | `/api/whiteboard/boards/:uuid/assets/:fileId` | `405`; board-scoped writes are disabled |

The legacy `/api/whiteboard/assets/:ownerKey/:assetId` route remains for old media and player links. `POST /api/whiteboard/assets/claim` copies legacy `temp:{boardId}` objects to the Google owner; it does not move board-scoped objects.

Client wrappers: `src/lib/whiteboard-cloud.ts`.

The D1 migration, read-only R2 source scan/import, resumable checkpoints, no-clobber export, and rollback procedure are documented in [d1-library-operations.md](./d1-library-operations.md).

## Key files

| Path | Role |
|------|------|
| `src/components/ClerkAuth.tsx` | Header sign-in / AuthBridge |
| `src/lib/whiteboard-identity.ts` | Identity, tokens, allowlist helpers |
| `src/worker/clerkAuth.ts` | Worker session verification |
| `src/worker/libraryRoutes.ts` | Signed-in D1 board/asset metadata routes |
| `src/worker/assetRoutes.ts` | Read-only board compatibility route, legacy Google/temp media auth, and temp claim |
| `src/scripts/whiteboard-library.ts` | Cloud create / touch / claim, host secret |
| `src/lib/whiteboard-assets.ts` | Board-scoped read compatibility, legacy temp/Google owner keys, and Hub Assets index |
| `src/lib/whiteboard-cloud.ts` | Authenticated library fetch client |
| `.dev.vars.example` / `.env.example` | Clerk env templates (no license key) |
