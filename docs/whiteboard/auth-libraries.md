# Auth and dual libraries

Clerk Google sign-in, owner keys, and how Recents / Library / Assets switch between local and cloud without wiping either side.

## Overview

Whiteboards work **signed out** (device-local indexes + `local:*` R2 assets) and **signed in** (Google account cloud indexes + `google:*` assets). Sign-in and sign-out swap which namespace the hub and manage panel read/write. The other namespace stays intact on the device or in R2.

## Clerk on the client

**Island:** `src/components/ClerkAuth.tsx` in the site header (`Header.astro`).

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

Secrets / vars: `CLERK_SECRET_KEY` (Worker secret), `PUBLIC_CLERK_PUBLISHABLE_KEY`, optional `PUBLIC_CLERK_ALLOWED_DOMAINS`. Local: `.dev.vars` (see `.dev.vars.example`).

## Owner keys

| Mode | Owner key | How it is chosen |
|------|-----------|------------------|
| Signed out | `local:{deviceInstallId}` | UUID in `localStorage` (`scsfoxchase.whiteboard.deviceInstallId`), minted on first use |
| Signed in | `google:{accountId}` | Google OAuth `sub` when present; otherwise Clerk `user.id` |

`getOwnerKey()` in `src/scripts/whiteboard-library.ts` returns the active identity’s key or the local key.

R2 media keys: `assets/{ownerKey}/{assetId}`.  
Cloud indexes: `library/{ownerKey}/boards.json` and `library/{ownerKey}/assets.json`.

Clearing site data creates a new `deviceInstallId` and a new empty local namespace.

## Dual library mode

Active helpers (`*Active` in `whiteboard-library.ts` / `whiteboard-assets.ts`) branch on `isSignedIn()`:

| Surface | Signed out | Signed in |
|---------|------------|-----------|
| Recents / Library | `localStorage` `scsfoxchase.whiteboard.library` | `GET/PUT/DELETE /api/whiteboard/library/boards` |
| Assets hub index | `localStorage` `scsfoxchase.whiteboard.assets` | `/api/whiteboard/library/assets` |
| New uploads | R2 under `local:…` | R2 under `google:…` (+ Bearer) |
| Create / touch / rename board | Local upsert | Cloud upsert |
| Delete board/asset from hub | Local index only | Cloud index only |

**Important:** Removing a board or asset in one mode does not delete the other mode’s index. Sign out returns you to the device lists that were there before sign-in.

Hub and manage panel wait for `whenAuthReady()` so signed-in users do not briefly write or render local lists. `onAuthChange` re-renders hub lists when identity flips.

Identity module: `src/lib/whiteboard-identity.ts` (`setActiveIdentity`, `getSessionToken` / `getAuthHeaders`, `identityFromClerkUser`).

## Display names

| Context | Source |
|---------|--------|
| People list (full) | `displayName` from Clerk (`fullName` or first+last) sent on connect |
| Cursor / presence tag | `shortDisplayName` → e.g. `Ada L.` (`src/lib/whiteboard-display-name.ts`) |
| Guests | Empty display name → People label `Guest {sessionTail}` |

## Cloud library API summary

All require a valid Clerk session. Indexes are scoped to the authenticated `ownerKey`.

| Method | Path | Body / notes |
|--------|------|----------------|
| `GET` | `/api/whiteboard/library/boards` | `{ boards, ownerKey }` sorted by `lastAccessedAt` |
| `PUT` | `/api/whiteboard/library/boards` | Board entry upsert |
| `DELETE` | `/api/whiteboard/library/boards/:uuid` | Drop index row |
| `GET` | `/api/whiteboard/library/assets` | `{ assets, ownerKey }` |
| `PUT` | `/api/whiteboard/library/assets` | Asset entry; `ownerKey` must match session |
| `DELETE` | `/api/whiteboard/library/assets/:uuid` | Drop index row |

Client wrappers: `src/lib/whiteboard-cloud.ts`.

## Key files

| Path | Role |
|------|------|
| `src/components/ClerkAuth.tsx` | Header sign-in / AuthBridge |
| `src/lib/whiteboard-identity.ts` | Identity, tokens, allowlist helpers |
| `src/worker/clerkAuth.ts` | Worker session verification |
| `src/worker/libraryRoutes.ts` | Cloud board/asset indexes |
| `src/worker/assetRoutes.ts` | Google write auth for assets |
| `src/scripts/whiteboard-library.ts` | Owner key, dual-mode board helpers |
| `src/lib/whiteboard-assets.ts` | Dual-mode asset index + uploads |
| `src/lib/whiteboard-cloud.ts` | Authenticated library fetch client |
| `.dev.vars.example` / `.env.example` | Clerk env templates |
