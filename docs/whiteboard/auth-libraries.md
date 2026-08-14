# Auth and cloud library

Clerk Google sign-in, owner keys, and how Recents / Library / Assets work as a **signed-in cloud library only**. There is no dual local/cloud board library.

## Overview

- **Create** works signed in or out.
- **Local saving is gone.** No `localStorage` board library; signed-out Recents / Library / Assets are not shown.
- **Save / reopen from Library** requires Google sign-in. Signed-in **create autosaves** to the cloud library. That Google account is **Owner**.
- Signed-out create is a **live scratch board** (URL + Durable Object). The creating browser is **ephemeral Owner** (host secret) so roles and Follow still work. It is not in anyone’s library.
- “Leave and lose work” means **never saved to the cloud library**, not “destroy on refresh.” Chromebooks refresh. The scene stays in the DO; **unsaved boards and their temp R2 objects are deleted after 24 hours**.
- Sign in on a scratch board this browser created and Save: that Google account **claims Owner**, temp R2 files move under `google:{accountId}`, 24h TTL comes off.

Join by share code, link, or UUID still works with **no account**. Joiners are **Viewer** by default.

## Clerk on the client

**Island:** `src/components/ClerkAuth.tsx` in the site header (`Header.astro`) with `client:only="react"` (same rationale as the board canvas — skip Vite SSR for `@clerk/react` hooks).

- Uses `@clerk/react` (`ClerkProvider`, `SignInButton`, `UserButton`) — Astro 7 is outside `@clerk/astro`’s peer range.
- Publishable key: `PUBLIC_CLERK_PUBLISHABLE_KEY` (inlined at build).
- Production Frontend API domain: **`clerk.scsfoxchase.tech`** (encoded in the live publishable key; OAuth callback on that host). Documented in `DEPLOYMENT.md`.
- Google-only provider is configured in the Clerk Dashboard (not custom OAuth redirect code).
- `AuthBridge` sets identity + session token getter; marks auth resolved for hub/board gating.

Optional allowlist: `PUBLIC_CLERK_ALLOWED_DOMAINS` (comma-separated domains and/or full emails). Empty → all Google accounts allowed. Client signs out and shows a hint when the email is not allowed (e.g. school domain).

Production `pk_live_` keys reject localhost — use the live site or a `pk_test_` instance for local auth.

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

## Owner keys

| Mode | Owner key | How it is chosen |
|------|-----------|------------------|
| Signed-in saved board | `google:{accountId}` | Google OAuth `sub` when present; otherwise Clerk `user.id` |
| Unsaved / signed-out canvas files | `temp:{boardId}` | Board UUID; 24h TTL on R2 |
| Guest identity (not a library) | `deviceInstallId` in `localStorage` | Stable per browser for generated display names and Follow `userId` |

`getOwnerKey()` in `src/scripts/whiteboard-library.ts` returns the signed-in Google key or `local:{deviceInstallId}` (legacy hub uploads). Live canvas media uses `ownerKeyForBoardMeta` → `temp:` or `google:`.

R2 media keys: `assets/{ownerKey}/{assetId}`.  
Cloud indexes: `library/{ownerKey}/boards.json` and `library/{ownerKey}/assets.json`.

Clearing site data creates a new `deviceInstallId` and a new guest name. It does not wipe a Google library.

## Cloud library vs scratch

| Surface | Signed out | Signed in |
|---------|------------|-----------|
| Recents / Library / Assets hub | Hidden | `GET/PUT/DELETE /api/whiteboard/library/boards` and `…/assets` |
| Create | Scratch DO + host secret; 24h TTL | Autosave to cloud; Owner = this Google account |
| Join | Opens the board as Viewer | Same; does **not** add Recents unless you already own it or Save a scratch you created |
| Save / claim | N/A (sign in first) | Creating-browser host secret + Clerk → Owner, lift TTL, move temp R2 |
| Canvas files | `temp:{boardId}` | `google:{accountId}` after save |

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

All require a valid Clerk session. Indexes are scoped to the authenticated `ownerKey`.

| Method | Path | Body / notes |
|--------|------|----------------|
| `GET` | `/api/whiteboard/library/boards` | `{ boards, ownerKey }` sorted by `lastAccessedAt` |
| `PUT` | `/api/whiteboard/library/boards` | Board entry upsert; optional `X-Board-Host` to claim DO meta |
| `DELETE` | `/api/whiteboard/library/boards/:uuid` | Drop index row |
| `GET` | `/api/whiteboard/library/assets` | `{ assets, ownerKey }` |
| `PUT` | `/api/whiteboard/library/assets` | Asset entry; `ownerKey` must match session |
| `DELETE` | `/api/whiteboard/library/assets/:uuid` | Drop index row |
| `GET` | `/api/whiteboard/boards/:uuid/meta` | `{ savedToLibrary, cloudOwnerKey, unsavedExpiresAt, … }` |
| `PATCH` | `/api/whiteboard/boards/:uuid/meta` | Host secret; `savedToLibrary` + `cloudOwnerKey` lifts 24h TTL |

Client wrappers: `src/lib/whiteboard-cloud.ts`.

## Key files

| Path | Role |
|------|------|
| `src/components/ClerkAuth.tsx` | Header sign-in / AuthBridge |
| `src/lib/whiteboard-identity.ts` | Identity, tokens, allowlist helpers |
| `src/worker/clerkAuth.ts` | Worker session verification |
| `src/worker/libraryRoutes.ts` | Cloud board/asset indexes |
| `src/worker/assetRoutes.ts` | Google write auth + temp claim |
| `src/scripts/whiteboard-library.ts` | Cloud create / touch / claim, host secret |
| `src/lib/whiteboard-assets.ts` | Temp/google owner keys + hub asset index |
| `src/lib/whiteboard-cloud.ts` | Authenticated library fetch client |
| `.dev.vars.example` / `.env.example` | Clerk env templates (no license key) |
