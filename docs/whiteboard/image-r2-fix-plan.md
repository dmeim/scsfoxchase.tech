# Whiteboard images + R2: permanent fix plan

> **Final status (2026-08-27): PLAN ABANDONED / ROLLBACK IMPLEMENTED.** This proposal was not adopted. The post-`81242d2` board-scoped upload design (manifest, outbox, scene acknowledgements, and related write-proof/auth protocol) was removed. New image/video insertion is temporarily disabled. Existing media remains readable from legacy `assets/{ownerKey}/{assetId}` and from read-only board-scoped `boards/{boardId}/assets/{fileId}` objects; board-scoped GET/HEAD works, while PUT/DELETE return `405`. The live scene remains in DO SQLite. Retained anti-usage fixes are share-code mint-once / GET `/meta` no-mint, alarm no-op avoidance, identical scene persist skipping, and writer exclusion from full scene broadcasts. Keep this document as historical design context only; see [sync-storage.md](./sync-storage.md) for the implemented runtime.

**Historical status:** proposal that was reviewed and abandoned. The implementation rollback is recorded above; no further work should follow this plan.
**Written against:** `f74692b` (`fix(whiteboard): stop hello hang and idle KV/DO write spam`).
**Companion:** [`image-r2-incident-history.md`](./image-r2-incident-history.md) is the incident record. This file is the fix.

Read §1 to understand *why* the last five commits each traded one bug for another. Read §3–§7 for the work.

---

## 1. Diagnosis

Three causes. Two are design decisions in shipped code, not mistakes — which is exactly why each round of fixes moves the bug instead of removing it. The third is why nobody notices.

### 1.1 Cause A — the handshake is architecturally able to hang

The `Connecting…` overlay clears only on `wb:hello` (`WhiteboardCanvas.tsx:1937`, `!roles.helloReceived`). There are code paths where the Durable Object deliberately sends **nothing at all** and the client deliberately **stops retrying**. There is no timeout, no error frame, and no fallback role. Silence is a protocol state.

The chain:

1. `handleConnect` sets `pendingClerkAuth = true` for **every** socket (`WhiteboardBoard.ts:988-990`). No exceptions.
2. While pending, the DO drops every frame that is not `wb:auth` — including `ping` (`WhiteboardBoard.ts:2770-2778`).
3. Exit from pending requires `resolveAuthMessage` to return non-null. It returns `null` whenever the client said `signedIn: true` and `clerkAuth` is null and the resolved role cannot edit (`WhiteboardBoard.ts:1121`). Returning null means: stay pending, send nothing, log nothing.
4. `clerkAuth` is null for **every** failure mode, indistinguishably. `verifyClerkWhiteboardToken` collapses all of them to `null` (`clerkAuth.ts:433-454`).
5. One of those failure modes is not a failure of the token at all. `authFromClerkUserId` returns null when `isEmailAllowed(email, env)` is false, and `email` is `''` whenever the Clerk profile lookup misses — memory cache cold, KV cache empty, and `users.getUser` times out at `PROFILE_FETCH_TIMEOUT_MS` (5 s) or is rate-limited (`clerkAuth.ts:294-319`).

   **`PUBLIC_CLERK_ALLOWED_DOMAINS` is configured in this project** (non-empty in both `.env` and `.dev.vars`). So `isEmailAllowed('')` is `false`. A slow or rate-limited Clerk BAPI call converts a legitimately signed-in owner with a perfectly valid JWT into "signed in but unverifiable" → step 3 → pending forever.

6. The client cannot recover, because the retry loop disarms itself as soon as a token has been sent: `scheduleAuthRetry` returns early on `if (lastAuthTokenSent) return` (`WhiteboardCanvas.tsx:1210`), its `.finally` stops rescheduling on the same condition, and `sendConnectAuth` only arms it when no token was sent (`WhiteboardCanvas.tsx:1271-1273`).

**Net:** token sent → server silently rejects → no retry, no toast, no hello, hang forever. The only bail-out that exists (the 60 s *"Sign-in is taking too long"* toast) is reachable **only** in the no-token case.

Token *shape* handling is fine — `@clerk/backend` 3.15.1 `verifyToken` returns `{data} | {errors}` and `subFromVerifyTokenResult` handles both. The bug is not there. Do not spend time re-verifying it.

Contributing factors on the same theme:

- **Saved boards have no non-Clerk proof.** `claimBoardToLibrary` calls `clearHostSecret` after a successful Google claim (`whiteboard-library.ts:278`), so a saved board's Owner holds *only* Clerk. Cold Clerk on a Dell Chromebook is the pending path every time. (§4.5 explains why the fix is **not** to keep the host secret.)
- **`ping` is dropped while pending**, so there is no application-level liveness signal during a hang.
- **Dual deploy** (`wrangler deploy` + Workers Builds on `main`) with no way to ask the Worker what it is running. Some "still broken" observations were against a different script version.

What the last three commits actually changed: *when the client sends `wb:auth`*. `0cfc5c2`, `12f06f5`, and `f74692b` all tuned client timing. None added a server fallback, a deadline, or an error frame. **There is currently no code path by which the DO can tell the client that its token failed.** That is why this bug keeps surviving its own fixes.

### 1.2 Cause B — image durability is a distributed transaction, with the scene ordered behind R2

The DO rejects an entire scene mutation if it references an image with no `ready` manifest row:

```1708:1717:src/worker/WhiteboardBoard.ts
	private async validateNewImageAssetReferences(
		existing: SceneElement[],
		accepted: SceneElement[],
	): Promise<void> {
		for (const fileId of newImageFileIds(existing, accepted)) {
			if (!(await this.getBoardAssetManifest({ fileId }))) {
				throw sceneAssetNotReadyError()
			}
		}
	}
```

It is called at `WhiteboardBoard.ts:1852`, **before** `persistScene` at `1854`. The throw discards the whole merged batch. Draw a stroke while an image is uploading and **the stroke is lost too**, not just the image.

Because the client must never trip that gate, it has to guarantee ordering between two independent async pipelines (the R2 PUT and the scene mutation stream). That is the entire purpose of:

- `whiteboard-scene-publication.ts` — default-deny publication filter
- `whiteboard-upload-outbox.ts` — 1,376 lines of IndexedDB queue + staging state machine
- `whiteboard-file-sync-plan.ts` — `planImageFileAction`, `stagingActionForPlan`, `shouldDeferImageUploadWhilePending`, `shouldRestoreRecoveredImage*`
- `acknowledgedImageFileIdsRef` / `inFlightMutationsRef` / `forceSendReadyUploads` bookkeeping in `WhiteboardCanvas.tsx`

Roughly 2,500 lines whose only job is sequencing. Every image incident in the history file is a sequencing bug in that machinery. These two constants are the tell — fossilized bugs preserved as flags, because nothing else can prove they stay off:

```100:103:src/lib/whiteboard-file-sync-plan.ts
/** Recover once after the first server scene; never on every jobs publish. */
export const RECOVER_PENDING_UPLOADS_ON_JOBS_PUBLISH = false
/** Never enqueue flushNow(true) from hydrate/recover/jobs publish. */
export const FORCE_FULL_FLUSH_ON_SERVER_SCENE = false
```

Four structural problems compound it:

| # | Problem | Evidence |
|---|---------|----------|
| B1 | **fileId is a random UUID**, unrelated to the bytes. Idempotent retry, dedupe, and "does the server already have this?" become network-state questions instead of local ones. | `generateWhiteboardImageFileId` → `crypto.randomUUID()` (`whiteboard-file-sync-plan.ts:61-63`) |
| B2 | **Upload authorization depends on the WebSocket handshake**, so images inherit Cause A entirely. A board stuck on Connecting can never upload. | `putImageFile` → `waitForBoardWriteProof(boardId, 2500)` (`whiteboard-excalidraw-files.ts:558`); `assertAssetWriteAccess` requires a host secret or a **live socket** whose role can edit (`WhiteboardBoard.ts:594-633`) |
| B3 | **Image GET requires a DO round trip** to read the manifest before R2 is touched. A lost manifest row makes bytes that exist in R2 permanently unreachable, and every cold image load wakes the DO. | `assetRoutes.ts:1007-1018` |
| B4 | **Two key namespaces still live** client-side: board-scoped for writes, owner-scoped for legacy reads / videos / the claim-and-move, plus a rewrite of player URLs inside persisted scene JSON. | `ownerKeysToTry`, `probeCanvasOwner`, `claimTempCanvasAssets`, `registerTempAssetPrefix` (`whiteboard-excalidraw-files.ts`); `applyTempPlayerUrlRewrite` (`WhiteboardBoard.ts:1764`) |

Also on the write-amplification side: the 8 s `refreshMeta` DO poll (`whiteboard-excalidraw-files.ts:495-497`) is still there. `f74692b` stopped it from writing KV; it still wakes the DO twice a minute per open tab.

### 1.3 Cause C — nothing in the loop can fail a bad fix

`tests/` is seven files, 109 tests, 536 ms — all pure helpers. There is no `@cloudflare/vitest-pool-workers`, so **the DO, the WebSocket handshake, and the asset routes have zero coverage**, and `sendConnectAuth` is untested by the history file's own admission. Every commit was validated by "helpers pass and it builds," then verified by a human clicking production, against an ambiguous deploy. That is a loop that cannot distinguish a fix from a coincidence.

---

## 1.4 Verified facts and working gates

Established by measurement on 2026-08-27, before implementation. Do not re-derive these.

| Fact | Value |
|------|-------|
| `PUBLIC_CLERK_ALLOWED_DOMAINS` set on the live Worker | **Yes** — confirmed as a runtime secret alongside `CLERK_SECRET_KEY`, `PUBLIC_CLERK_PUBLISHABLE_KEY`, `WHITEBOARD_ADMIN_SECRET`. §1.1 step 5 is therefore a **live** outage trigger, not a hypothetical, and §4.1 is the highest-priority change in this document. |
| `npm test` baseline | 7 files, 109 tests, all passing, ~0.5 s. All pure helpers (§1.3). |
| `npx tsc --noEmit -p tsconfig.json` baseline | **159 pre-existing errors.** Not a clean gate. Use "must not increase" plus per-file limits. |
| Typecheck-clean files (must stay at 0) | `src/worker/WhiteboardBoard.ts`, `src/worker/clerkAuth.ts`, `src/worker.ts` |
| Known pre-existing per-file error counts | `WhiteboardCanvas.tsx` 2, `whiteboard-excalidraw-files.ts` 2, `whiteboard-excalidraw-roles.ts` 2, `assetRoutes.ts` 1, `adminRoutes.ts` 1, `libraryRoutes.ts` 1, `whiteboard-menu.ts` 18, `inventory.ts` 127, `dot-waves.ts` 4, `theme-toggle.ts` 1 |
| `npm run build` | Exit 0 **only outside the agent sandbox.** Inside it, `@cloudflare/vite-plugin` dies on `os.networkInterfaces` with `uv_interface_addresses returned Unknown system error 1`. This is a sandbox restriction, **not** a code fault — never "fix" it. Run the build with full permissions. |

Two consequences for anyone verifying this work: a green `tsc` is impossible, so compare counts rather than expecting zero; and a red `npm run build` inside a sandbox means nothing.

## 2. Principles

Every decision below follows from these. If a future change violates one, it is a regression regardless of what it fixes.

1. **Nothing user-visible blocks on a call that can fail.** Every gate has a timeout and a defined degraded state.
2. **The server always answers.** Silence is never a protocol state. Every inbound frame that can be rejected gets a reply saying so.
3. **Liveness and authority are separate.** "The socket is up and the scene is painted" must never depend on "we know your final role."
4. **Scene mutations and image bytes are independent, eventually-consistent streams.** Neither is ordered behind the other, ever.
5. **Asset ids are content hashes.** Identity of bytes is a local, offline-computable fact.
6. **Bindings are tested against real bindings.** Pure-helper tests do not count as coverage of a protocol.

---

## 3. Phase 0 — stop guessing (~2 hours)

Nothing here changes behavior. It makes the next failure legible. Do this first even if the rest is deferred.

### 0.1 Build identity endpoint

Add `GET /api/whiteboard/version` → `{ sha, builtAt }`. Inject at build time via a Vite `define` (`__BUILD_SHA__` from `git rev-parse --short HEAD`, falling back to `CF_VERSION_METADATA` / `"dev"`). Route it in `src/worker.ts` alongside the other `/api/whiteboard/*` handlers.

Also surface it in the client console once on board mount, so a screenshot of DevTools answers "is this the code I deployed?"

**Verifies:** kills the dual-deploy ambiguity permanently.

### 0.2 One deploy path

Choose one and document it in `DEPLOYMENT.md`:

- **Recommended:** keep GitHub Workers Builds on `main` as the only deployer. Stop running `npx wrangler deploy` from a laptop. Use `wrangler versions upload` for preview URLs when you need to test before merge.
- Alternative: disable the Workers Builds trigger and deploy only from CLI.

Mixing them means the live version UUID changes under you ~70 s after every manual deploy.

### 0.3 `wb:authResult` — the frame that ends this class of incident

New DO → client frame, sent **unconditionally** in reply to every `wb:auth`:

```ts
type WbAuthResult = {
  type: 'wb:authResult'
  accepted: boolean          // did this frame change/settle anything
  roleResolved: boolean      // is the role now authoritative
  role: WhiteboardRole       // best-known role right now
  reason?:
    | 'awaiting_token'       // signed in, no JWT yet — expected, transient
    | 'token_invalid'        // signature / expiry / azp — real denial
    | 'clerk_unreachable'    // could not resolve profile — degraded, retryable
    | 'account_not_allowed'  // allowlist denial — terminal, tell the user
    | 'host_mismatch'
}
```

Emit from `finishPendingConnectAuth` and `reauthenticateSocket`, on **every** path including the current `return null` / early-`return` ones. Client logs it and stores the last reason for the UI in §4.3.

This requires §4.1's discriminated verification result to populate `reason` accurately, so land 0.3 and 4.1 together.

**Verifies:** any future hang reports its own cause. This alone would have closed the incident on day one.

---

## 4. Phase 1 — make the handshake unable to hang (~1 day)

Target: **always greet, upgrade later.** Split liveness from authority (Principle 3).

### 4.1 Discriminated Clerk verification

In `src/worker/clerkAuth.ts`, replace the `null`-collapsing returns:

```ts
export type ClerkVerifyResult =
  | { ok: true; auth: ClerkWhiteboardAuth }
  | { ok: false; reason: 'no_token' | 'token_invalid' | 'clerk_unreachable' | 'account_not_allowed' }
```

- `verifyClerkWhiteboardToken` returns `ClerkVerifyResult`. Keep a thin `…OrNull` wrapper only if it avoids touching unrelated call sites in one commit.
- **Split "invalid token" from "cannot reach Clerk."** Today both produce `null` and both deny. They must diverge:
  - `verifyToken` returned `errors` → `token_invalid`. Deny. This is correct behavior.
  - `verifyToken` succeeded (signature and expiry are good, we hold a trusted `sub`) but `resolveClerkProfile` returned nothing → **`clerk_unreachable`, and do not deny**. Trust the verified `sub`: build the auth with `accountId = clerkUserId`, `email = ''`, and a `profileDegraded: true` marker.
  - `account_not_allowed` is reserved for a **non-empty** email that fails the allowlist.
- Therefore change `authFromClerkUserId` (`clerkAuth.ts:317-319`): an empty email caused by a failed profile fetch must no longer read as an allowlist denial. Gate the allowlist on `email !== ''`.

**The one caveat, stated plainly:** with the allowlist configured, this means a Clerk BAPI outage lets a signed-in Clerk user through as `ownerKey = google:{clerkUserId}` rather than `google:{googleSub}`. That is a *different* owner key, so it must **not** be treated as the cloud owner. Guard it: when `profileDegraded` is true, `syncCloudOwnerFromClerk` must not write `META_CLOUD_OWNER_KEY`, and `clerkMatchesCloudOwner` must not match on the fallback id. Degraded auth can earn *stored* roles and share-code Editor; it cannot claim ownership. Ownership decisions wait for a real profile. This is what keeps a JWKS-valid token from silently reassigning a board.

### 4.2 DO: greet on connect, never stay silent

In `WhiteboardBoard.ts`:

1. **`handleConnect` sends `wb:hello` immediately**, with the role provable without Clerk (`resolveConnectRole({ clerkAuth: null, … })` — share-code joiner → `editor`, otherwise `viewer`) plus a new field `roleResolved: false`. The scene already ships on upgrade via `sendFullScene`; hello now ships with it.
2. Keep `pendingClerkAuth` as a **role**-pending flag only. Rename to `roleResolved: boolean` on the attachment to stop it reading as a socket gate.
3. **Stop dropping non-`wb:auth` frames wholesale** (`WhiteboardBoard.ts:2770-2778`). Replace with a narrow rule: while `!roleResolved`, answer `ping`, allow `scene:request` and `wb:follow`, and reject `scene:update` with a `wb:error` carrying `code: 'role_unresolved'` — a *reply*, not a drop. (In practice the client will not send scene updates yet; see §4.3.)
4. **`resolveAuthMessage` never returns `null`.** It returns `{ attachment, roleResolved, reason }`. The old "signed in without verifiable Clerk" case becomes `roleResolved: false` + `reason` — the socket keeps its current role and gets a `wb:authResult`.
5. **Hard deadline.** On connect, `ctx.storage.setAlarm` (or a `setTimeout` guarded by the existing alarm plumbing — prefer the alarm, it survives hibernation) for `ROLE_RESOLVE_DEADLINE_MS = 15_000`. On fire, any socket still `!roleResolved` gets `roleResolved: true` at its current role plus `wb:authResult` with the last reason. Belt and braces: even a bug in the retry path degrades to read-only instead of hanging.
6. `sendConnectHello` keeps its one-hello-per-socket invariant; upgrades continue to flow through `wb:role`, which already refuses demotions (`shouldApplySocketReauth`).

**The property that motivated pending is preserved.** The original concern — "never greet a real Owner as Viewer, it locks them out of the tools" — was addressed by withholding hello, which made it a *liveness* problem. It becomes a *client* concern instead: a Viewer hello with `roleResolved: false` means "not authoritative yet," and the client does not act on it (§4.3). `wb:role` already exists and already upgrades in place.

### 4.3 Client: unresolved role is a visible, bounded state

In `WhiteboardCanvas.tsx` and `whiteboard-excalidraw-roles.ts`:

1. `Connecting…` (`WhiteboardCanvas.tsx:1937`) becomes a function of the socket, not the role: show it while `!socketConnected || !helloReceived`. Hello now always arrives, so it always clears.
2. Add `roleResolved` to the roles hook state. While `helloReceived && !roleResolved`, show a small non-blocking chip (*"Checking your access…"*) — never a full-canvas overlay. The scene is visible and pannable throughout.
3. **While `!roleResolved`, the client must not act on the provisional role.** Specifically: no scene updates, no image uploads, no `claimBoardToLibrary` / Recents write, no `clearHostSecret`. This is the guard that makes an early Viewer hello safe. Route it through one predicate — `authoritativeCanEdit = roleResolved && canEdit` — and use it everywhere `canEditRef.current` currently gates a write.
4. `HELLO_EVENT` must carry `roleResolved`, because `waitForBoardWriteProof` listens for it (`whiteboard-board-write-proof.ts:92`) and must not resolve on a provisional hello.
5. **Fix the retry disarm.** `scheduleAuthRetry` must keep retrying while `!roleResolved`, even when a token was already sent. Replace `if (lastAuthTokenSent) return` (`WhiteboardCanvas.tsx:1210`) with `if (roleResolvedRef.current) return`, and re-fetch with `getToken({ skipCache: true })` so a stale cached JWT cannot pin the loop. Keep the 60 s `AUTH_RETRY_GIVE_UP_MS` budget.
6. **Terminal state instead of a hang.** On give-up, or on `wb:authResult` with `reason: 'account_not_allowed'` / `'token_invalid'`, drop to read-only with an explicit, actionable message and a **Retry sign-in** button. Different copy per reason: `clerk_unreachable` → *"Sign-in service is slow. You can view this board; retry to edit."*; `account_not_allowed` → *"This Google account cannot edit school whiteboards."*

### 4.4 Asset writes stop depending on the socket

`assertAssetWriteAccess` (`WhiteboardBoard.ts:594-633`) currently accepts a host secret or a **live socket** whose role can edit. Add a third path so a saved board's Owner can upload before (or without) a greeted socket:

- `assetRoutes.ts` → `assertBoardAssetWrite`: if there is no host secret and no session pair, verify the `Authorization: Bearer` JWT with `requireClerkWhiteboardAuth` and pass `{ accountId, ownerKey, clerkUserId, profileDegraded }` to the DO.
- `assertAssetWriteAccess` gains a `clerk` argument: allow when `clerkMatchesCloudOwner` matches, or when `readStoredRoles()` gives that account `owner`/`manager`/`editor` and `sessionCanEdit` passes. A `profileDegraded` identity may use stored roles but never `clerkMatchesCloudOwner` (§4.1).
- Then delete `waitForBoardWriteProof` from the upload path (`whiteboard-excalidraw-files.ts:558`, `:844`). Uploads attach whatever proof exists and let the server decide; the outbox already classifies 401/403 as retryable.

This is what breaks the coupling in B2. It is required before Phase 2, because an upload queue that waits on hello reintroduces the whole problem.

### 4.5 Do **not** "fix" this by keeping the host secret after claim

Tempting and wrong. `clearHostSecret` on claim exists because localStorage outlives the user on a shared Chromebook: period 2 would inherit period 1's Owner proof. `hostProvesScratchOwner` only partly covers this (it requires a Clerk match once `cloudOwnerKey` is a `google:` key — which is exactly the check that fails during a Clerk outage). Saved-board resilience comes from §4.1 (don't deny on BAPI failure), §4.2 (always greet), §4.3 (bounded retry + read-only fallback), and §4.4 (JWT-authorized uploads). Not from a long-lived local secret.

### 4.6 Phase 1 verification

Manual, on a preview URL, with DevTools WS frames open:

1. Create from `/whiteboard` signed out → hello within ~1 s, Owner via host secret, Connecting clears.
2. Create signed in → hello immediately (provisional), `wb:role` → Owner within ~2 s.
3. Open a saved board signed in → hello immediately, Owner after JWT.
4. Open a saved board with Clerk blocked (DevTools request blocking on `clerk.scsfoxchase.tech`) → hello immediately, chip times out, **read-only with a reason and a retry button**. Never Connecting.
5. UUID-only join → Viewer hello, resolved, no chip left hanging.
6. Share-code join → Editor.
7. `/api/whiteboard/version` matches the deployed SHA.

Automated coverage for the same matrix lands in Phase 3; do not treat manual passes as done.

---

## 5. Phase 2 — restructure the image path (~2–3 days)

Mostly deletion. This is the permanent fix; Phase 1 is what makes it testable.

### 5.1 Content-addressed file ids

`generateIdForFile` returns the **SHA-256 of the bytes**, hex, via `crypto.subtle.digest('SHA-256', await file.arrayBuffer())`. Excalidraw's `generateIdForFile` is already async, so this is a drop-in. Replace the body of `generateWhiteboardImageFileId` (`whiteboard-file-sync-plan.ts:61-63`) and `generateWhiteboardFileId` (`whiteboard-excalidraw-files.ts:229-231`); keep the exported names so call sites and tests move in one step.

What this buys, all locally computable and none of it requiring network state:

- PUT is idempotent — a retry after a lost response is a no-op, not a duplicate object.
- The same image inserted twice is one R2 object.
- The Worker can **verify the body against the path**: recompute SHA-256 of the received bytes and 400 on mismatch. Nobody can write to another file's key.
- Recovering bytes from IndexedDB after a crash needs no id bookkeeping — the id *is* the checksum.

**Do not stage or PUT inside `generateIdForFile`.** That was `0cfc5c2`'s insert-before-paint bug (Excalidraw's mouse image tool is click-to-place; the id is assigned before the element exists). Hashing is pure and safe; side effects are not.

R2 key format is unchanged (`boards/{boardId}/assets/{fileId}`), so existing UUID-keyed objects keep resolving. **No migration.**

### 5.1a Blocker found during Phase 3: the route rejects non-UUID file ids

Verified in code on 2026-08-27. Two facts that will silently break §5.1 unless handled in the same commit:

1. **The HTTP route is `/api/whiteboard/boards/{boardId}/assets/{fileId}`** — board id first, then `assets`. (`parseBoardAssetPath`, `assetRoutes.ts:99-110`.) An earlier draft of this plan wrote `/api/whiteboard/assets/boards/{boardId}/{fileId}`, which does not exist. (`AGENTS.md`'s route table lists only the legacy owner-key route and should gain the board-scoped one; `docs/README.md` already has it right.)

2. **`parseBoardAssetPath` requires BOTH path segments to be UUIDs**:
   ```ts
   if (!boardId || !fileId || !isAssetUuid(boardId) || !isAssetUuid(fileId)) return null
   ```
   and `isAssetUuid` is a strict UUID regex (`assetRoutes.ts:51-59`). A SHA-256 hex id is 64 hex characters with no dashes, so **every** content-addressed PUT and GET would fall through to `jsonError(400, 'Invalid board asset path')`. Images would break completely, in a way that looks like a routing bug rather than an id-format bug.

   Fix in the same commit as §5.1: introduce `isAssetFileId(value)` = strict UUID (legacy objects) **OR** `/^[0-9a-f]{64}$/` (content hash), and use it for the `fileId` segment only. `boardId` stays strictly UUID. Apply it anywhere else a `fileId` is validated — audit all `isAssetUuid` call sites, including `parseLegacyCanvasBoardContext` and `assertGoogleAssetWrite`, and change only the ones validating a file id.

3. **Non-range GETs must return 200, not 206.** The current handler passes `range: request.headers` to `R2.get` and then returns 206 whenever `object.range` has an `offset`/`length`. Miniflare populates `object.range` with the full object even when the request had no `Range` header, so a plain image GET returns `206 Content-Range: bytes 0-66/67`. Production R2 appears not to, but the handler should not depend on that difference. Gate the 206 branch on the request actually carrying a `Range` header. This un-skips the one skipped harness test (`tests/worker/board-assets.test.ts`, GET → 200).

### 5.1b Phase 1 review findings (verified 2026-08-27, no code change needed)

Two risks flagged when Phase 1 landed were chased down in the code. Both are benign; recorded so nobody "fixes" them again:

1. **The 15 s role-resolve deadline does not fire on ping.** `setWebSocketAutoResponse` is configured (`WhiteboardBoard.ts:544`) with a `ping`/`pong` pair, and Cloudflare answers those without waking DO JS — so an idle unresolved socket never reaches the on-demand deadline check. This is acceptable because the deadline is belt-and-braces: the client's own `wb:auth` retries *do* wake the DO and trip it inside the retry window, and independently the client drops to read-only with a Retry control at 60 s. The user-visible hang is gone either way. The only residual effect is that a socket whose client stopped retrying stays `roleResolved: false` server-side (and stays hidden from the People list). Moving the deadline to an alarm would cost a wake per unresolved socket to fix a cosmetic issue — don't.
2. **The instant hello cannot strand a scratch creator without proof.** `bindBoardPageScratchClaim` (`whiteboard-library.ts:661-676`) listens for hello and calls `touchBoardActive` → `claimBoardToLibrary`, which does call `clearHostSecret`. But every `clearHostSecret` site (`:249`, `:278`, `:299`) sits **after** an `await` on a Clerk-authenticated cloud write (`upsertCloudBoard` / `getEntryActive` / `markBoardSavedToLibrary`). If Clerk is failing — the exact scenario Phase 1 addresses — that write 401/503s, the promise rejects into `tryClaim`'s catch, and the host secret is preserved. `getEntryActive` returns `undefined` rather than a fabricated entry, so there is no fail-open path to a secret-clearing branch. §4.5's rule holds without needing a `roleResolved` gate in this file.

### 5.1c Legacy image hydrate — regression caught in review, fixed

Phase 2 rewrote `hydrateImage` to a single board-scoped GET and, in doing so, dropped the owner-key probe that the old planner did. That is a **user-visible data-loss regression**, not a cleanup: per `AGENTS.md` the original key layout is `assets/{ownerKey}/{assetId}` (`google:{accountId}` for saved boards, `temp:{boardId}` for scratch), so every image on an existing board would have 404'd on the board-scoped route and rendered a permanent placeholder. Keeping the legacy GET *route* (§5.6) while deleting its only caller achieves nothing.

Restored as `hydrateLegacyOwnerImage` in `whiteboard-excalidraw-files.ts`: board-scoped GET first, and on a miss, probe `ownerKeysToTry(...)` with a HEAD and read the bytes via `fetchOwnerAssetBytes` (new, read-only, in `whiteboard-assets.ts`). This mirrors what `hydrateVideo` already does.

The fallback is gated on `isContentHashFileId(fileId) === false`. A content-addressed id **cannot** exist under an owner key — those objects predate hashing — so without the gate every freshly inserted image would fire owner-key HEADs on each hydrate retry while its upload was still in flight. Legacy ids are UUIDs; hash ids skip the probe entirely.

Pinned by `tests/worker/board-assets.test.ts`: the legacy owner-key GET serves seeded bytes (if that route is ever deleted, this fails), and a content-addressed PUT 201s while byte-mismatched ids 400. The mismatch case differs from the success case only in the id, so it cannot pass without the SHA-256 verification.

### 5.2 Take the DO out of the asset read path

`assetRoutes.ts:1007-1018`: GET/HEAD go straight to `env.WHITEBOARD_ASSETS.get(key)`; 404 if absent. Drop the `getBoardAssetManifest` round trip.

Safe *because* ids are content hashes: the key fully determines the bytes, so there is nothing for the manifest to authorize on read. Keep `Cache-Control: immutable` (now honest), keep the SVG `Content-Disposition: attachment` + sandbox CSP hardening exactly as-is.

Keep `whiteboard_asset_manifest` as a **best-effort GC index only** — written after a successful PUT, never authoritative, and never able to make existing bytes unreachable. If the register RPC fails, log and return 201 anyway (today it deletes the freshly uploaded object and 503s — `assetRoutes.ts:983-991`).

Fixes B3: no DO wake per cold image, and a lost row can no longer orphan live bytes.

### 5.3 Delete the server-side scene gate

Remove `validateNewImageAssetReferences` (`WhiteboardBoard.ts:1708-1717`), its call site (`:1852`), `sceneAssetNotReadyError`, `newImageFileIds`, and the `asset_not_ready` code and message in `whiteboard-sync.ts`.

**Scene mutations always persist.** An element referencing bytes not yet in R2 renders as an Excalidraw placeholder and resolves on the next hydrate once the PUT lands.

This reverses a rule the incident file marks *"do not weaken."* Deliberately. That gate is correct in isolation and catastrophic in combination: it makes image bytes a precondition for persisting **unrelated** edits, and every band-aid since `72c22b2` has been an attempt to satisfy that precondition from the browser. The trade:

| | Old (gate) | New (no gate) |
|---|---|---|
| Image bytes never arrive | Scene edits in the same batch are **lost**; toast; client must re-derive order | Element shows a placeholder; owner sees per-element **retry / remove**; other edits persist normally |
| Failure locality | Server-side, silent to other clients, affects unrelated elements | Local to one element, visible, recoverable |
| Client complexity | Outbox + publication filter + staging machine + ack bookkeeping | Upload queue with retry |

The "bytes never arrive" case is handled where it belongs (§5.4), not by refusing to save the drawing.

### 5.4 Upload queue: small, durable, independent

`whiteboard-upload-outbox.ts` shrinks to one job:

```ts
type UploadJob = {
  boardId: string
  fileId: string      // = sha256 of blob
  blob: Blob
  mimeType: string
  state: 'pending' | 'uploading' | 'uploaded' | 'failed'
  attempts: number
  lastError?: string
}
```

- Blob is held in IndexedDB from insert until R2 confirms, then deleted.
- On board mount, resume every non-`uploaded` job for this board. PUT is idempotent, so resume is unconditional and needs no server query.
- Retry with the existing `WHITEBOARD_UPLOAD_RETRY_DELAYS_MS` backoff. 401/403 stay retryable (they mean "role not resolved yet"); 413/415 and a hash mismatch are terminal.
- Optional cheap win: `HEAD` the key before PUT and skip the body if it already exists. Free dedupe across boards for the same image.
- The queue **never** gates a scene flush and never reads `acknowledgedImageFileIds`.

Keep the "Saving N files…" strip, counting only in-flight bytes (`pending` + `uploading`) — never uploaded-waiting-for-ack. That was `0cfc5c2`'s stuck-Saving bug and `12f06f5` already fixed the accounting; preserve it.

### 5.5 Hydrate: one loop, no planner

On `scene:sync` / `scene:update`, for every referenced image `fileId` with no `dataURL` in `BinaryFiles`: GET `/api/whiteboard/boards/{boardId}/assets/{fileId}` (see §5.1a for the exact route), `addFiles`, cache the id as resolved. On 404, back off and retry — the uploader may still be in flight. That is the whole algorithm, and `hydrateImage` (`whiteboard-excalidraw-files.ts:591-632`) already does it; it just loses the branches for the owner-key fallbacks and the `planImageFileAction` decision table.

Upload vs hydrate stops being a decision: **local bytes present and not yet confirmed in R2 → upload; referenced but no local bytes → hydrate.** Both may run for different ids at once; neither blocks the other; neither blocks the scene.

### 5.6 Delete list

Remove outright once §5.3 lands (they exist only to satisfy the gate):

- `src/lib/whiteboard-scene-publication.ts` (whole file) and its imports in `WhiteboardCanvas.tsx:38-42`
- From `whiteboard-file-sync-plan.ts`: `planImageFileAction`, `stagingActionForPlan`, `shouldDeferImageUploadWhilePending`, `shouldRestoreRecoveredImage`, `shouldRestoreRecoveredImageElement`, `isRenderedImageOverlayTarget`, `RECOVER_PENDING_UPLOADS_ON_JOBS_PUBLISH`, `FORCE_FULL_FLUSH_ON_SERVER_SCENE`, `shouldForceSendReadyUploadsOnTransition`, `shouldHydrateServerSceneOnce`. Keep the MIME helpers (`resolveWhiteboardImageMime` and friends) — those are genuinely useful.
- From `WhiteboardCanvas.tsx`: `acknowledgedImageFileIdsRef`, `forceSendReadyUploads`, the `requiredElementIds` parameter of `sendSceneUpdate`, and the `asset_not_ready` branch of `handleScenePersistError` (`:885-888`).
- From `whiteboard-upload-outbox.ts`: staging (`beginStaging` / `completeStaging` / `failStaging` / `getStaging` / `updateStaging`), `WhiteboardUploadStage`, `WhiteboardUploadStaging`, `WhiteboardUploadRecovery`, element snapshots, `markSceneAcknowledged`, `markServerSceneHydrated`, `resetServerSceneHydration`, `getRecoveryData`.
- `waitForBoardWriteProof` (after §4.4). `hasBoardWriteProof` / `headersHaveBoardWriteProof` stay — they still shape outbound headers.
- Legacy asset **PUT**: `parseLegacyCanvasBoardContext`, the board-context branch of `assertGoogleAssetWrite`, and `tests/whiteboard-legacy-asset-compat.test.ts`. **Keep the legacy owner-key GET** — old boards still reference those keys.

Expected: 1,500–2,000 lines net removed. Fewer states is the deliverable, not a side effect.

### 5.7 Kill the 8 s meta poll — **deferred out of Phase 2**

Deferred deliberately. This is a quota optimisation, not part of image durability, and it is the one item in Phase 2 that straddles the client/server split: it needs a new `wb:meta` frame produced by the DO, extra fields on `wb:hello`, and a client handler, all landing together. Bundling it would put two agents in the same files during the deletion pass for no correctness gain. Do it in Phase 4, after the image path is stable and the frame contract is quiet.

Original note, still accurate:

Replace `refreshMeta`'s `setInterval(…, 8000)` (`whiteboard-excalidraw-files.ts:495-497`) with push over the socket that is already open: put `savedToLibrary` and `cloudOwnerKey` on `wb:hello`, and broadcast a `wb:meta` frame when either changes (claim, save, rename). Keep the `focus` listener as a cheap safety net.

Removes two DO wakes per minute per open tab, which is the remaining half of the quota story.

### 5.8 Phase 2 verification

1. Drop a PNG on a scratch board → paints immediately, PUT 201, reload → still there.
2. Drop a PNG and **immediately draw strokes** while it uploads → strokes persist. (This is the case the old gate silently lost.)
3. Drop the **same** PNG twice → one R2 object, both elements render.
4. Kill the tab mid-upload, reopen the board → queue resumes from IndexedDB, image lands.
5. Insert an image, then go offline and delete the local blob → element shows a placeholder with retry/remove; **no other edit is lost**.
6. Second browser (share-code Editor) sees the image after the PUT completes.
7. Saved board, signed-in Owner, socket not yet greeted → upload still succeeds via JWT (§4.4).
8. Image GET produces **no** DO invocation (check the metrics or `wrangler tail`).
9. MP4/WebM insert → `/whiteboard-player` still plays, on a scratch board and after claim.
10. Chromebook (1366×768) and iPad landscape: insert via toolbar **and** paste. The mouse image tool is click-to-place — confirm no upload starts before placement.

---

## 6. Phase 3 — tests that can fail (~1 day)

Without this, Phase 1 and 2 decay exactly like `72c22b2` → `f74692b` did.

### 6.1 Real bindings

Add `@cloudflare/vitest-pool-workers`, a second vitest project (keep the fast node project for pure helpers), and a miniflare config with the real `WHITEBOARDS` / `WHITEBOARD_ASSETS` / `WHITEBOARD_CODES` bindings. Stub `@clerk/backend` at the module boundary so failure modes are injectable.

### 6.2 The handshake matrix — one test per row, each asserting hello within a deadline

| Case | Assert |
|------|--------|
| No auth, UUID only | `wb:hello` ≤ deadline, `role: 'viewer'`, `roleResolved` true after auth frame |
| Host secret via `wb:auth` | hello, then `wb:role` → `owner` |
| Signed in, no token yet | hello immediately, `roleResolved: false`, `wb:authResult` `reason: 'awaiting_token'` |
| Signed in, valid token | hello, `wb:role` → correct role, `roleResolved: true` |
| **Signed in, invalid token** | hello, `wb:authResult` `reason: 'token_invalid'`, resolved read-only. **Never silence.** |
| **Signed in, Clerk BAPI throws / times out** | hello, `reason: 'clerk_unreachable'`, not denied, stored role honored, cloud ownership **not** reassigned |
| Allowlist rejects a real email | `reason: 'account_not_allowed'` |
| Nothing ever sent after connect | role-resolve alarm fires → `roleResolved: true` at viewer |
| Share code presented | `editor` |

The two bold rows are the live incident. They must exist before Phase 1 is called done.

### 6.3 Scene and asset invariants

1. `scene:update` referencing an unknown image fileId **persists the non-image elements** (the inverse of the old gate).
2. PUT then GET returns identical bytes, with **zero** DO invocations on the GET.
3. PUT whose body hash ≠ path fileId → 400.
4. PUT twice with the same bytes → 201/200, one object, manifest upsert clean.
5. GET of an unknown hash → 404 (not 503, not a manifest error).
6. Asset PUT authorized by host secret / live session / Clerk editor; denied for a viewer.
7. Cold DO (fresh instance, same storage): scene and image both survive.
8. **Write budget:** one socket, 60 s idle, no edits → 0 SQL writes and 0 KV writes. This is the regression test for both quota emails.
9. Full `scene:sync` excludes the writer (`sceneBroadcastPlan` → `exceptSessionId = fromSessionId`) — pins `12f06f5`'s echo fix.

### 6.3a Harness limitations to close (found while building it)

The harness works (Plan A: `@cloudflare/vitest-pool-workers@0.22.0`, peer `vitest@^4.1.0`, compatible with this repo's `vitest@^4.1.11`). Three compromises were necessary and each carries drift risk:

1. **Separate `tests/worker/wrangler.jsonc`.** The root config requires `./dist/client` to exist, which is not true in a clean checkout, so the tests use their own config that repeats the binding names. If someone adds or renames a binding in the root `wrangler.jsonc`, the tests keep passing while production breaks. **Add a test that asserts the test config's binding names are a superset of the root config's** — parse both files and compare `durable_objects`, `r2_buckets`, `kv_namespaces` binding names.
2. **`@astrojs/cloudflare/handler` is aliased to a 404 stub**, because it needs a Vite virtual module that only exists during an Astro build. Acceptable — the `/api/whiteboard/*` routes never call `handle()` — but it means the harness does not cover the asset-serving fallthrough. Do not write page-serving tests against this harness; they would be testing the stub.
3. **One skipped test:** board asset GET → 200. Miniflare sets `object.range` on a non-range request so the handler returns 206. Fixed by §5.1a item 3; un-skip it there. **Done** — the 206 branch is now gated on the request carrying a `Range` header and the test is un-skipped and passing.
4. **`tests/worker/` reports 6 type errors under the ROOT tsconfig** (5 × "Property 'WHITEBOARD*' does not exist on type 'Env'", 1 × `node:url` in `vitest.config.ts`). These do **not** affect `npm run build` or the shipped Worker, and the worker vitest project compiles and runs the same files fine. Cause: the root tsconfig does not resolve `@cloudflare/vitest-pool-workers/types`, so `env` falls back to the global `Env` and the `ProvidedEnv` augmentation in `helpers/env.d.ts` never applies. Augmenting the other module name does not help (verified — both `cloudflare:test` and `cloudflare:workers` are now declared, and the count is unchanged). Fixing it properly means teaching the root tsconfig about the pool-workers types or giving `tests/worker/` its own tsconfig; not worth doing for test-only type noise, but **do not** treat the count as a regression signal — gate on the non-`tests/worker` count instead.

Also confirmed by the harness: a board **connect** mints one share-code KV key via `ensureBoardLifetime`, while idle time and `GET /meta` add none. That is the intended mint-once behavior from `f74692b`. Worth pinning explicitly: **add a test that a second connect to the same board performs no additional KV write**, since a regression there re-creates the KV quota incident.

### 6.3b Phase 3 matrix — what landed, and the two gaps left open deliberately

Landed (2026-08-27): `tests/worker/handshake-matrix.test.ts` (11 tests), `tests/worker/bindings-drift.test.ts` (2), `tests/worker/reconnect-kv.test.ts` (1). Both items §6.3a asked for — the binding-superset assertion and the no-second-KV-write assertion — are now real tests. Every matrix row asserts `wb:hello` inside a 5 s deadline, and every row asserts **exactly one** `wb:hello` per socket, so neither a hang nor a duplicate Viewer-hello-before-Owner can return silently.

The tests were demonstrated to be capable of failing, which is the gate that matters most here: commenting out `sendConnectHello` fails all 11 handshake tests (`waitForFrame timed out after 5000ms. Seen types: scene:sync`), and adding a throwaway R2 binding to the root `wrangler.jsonc` fails the drift test. `wrangler.jsonc` was confirmed clean afterwards.

**Gap 1 — no row exercises a Clerk token that actually verifies.** The test Worker has no Clerk secret or JWKS, and `@clerk/backend` cannot be stubbed from that isolate without editing `src/` or `vitest.config.ts`. So these rows are integration-uncovered: valid token → correct cloud role; allowlist rejects a real email; valid token then a Clerk BAPI timeout → degraded. The garbage-token row asserts `token_invalid` **or** `clerk_unreachable` and in practice always takes the latter (no secrets → failure before `verifyToken`).

This is **accepted, not deferred**, because the security-relevant logic behind those rows is pure and is unit-tested with both polarities in `tests/whiteboard-auth-resolution.test.ts`: a `profileDegraded` identity does not match a real `google:{sub}` owner key *nor its own* `ownerKey` (the degraded key is `google:{clerkUserId}`, which would otherwise self-match), cannot write `META_CLOUD_OWNER_KEY`, a full profile still can, and a real non-allowlisted email is still denied. The frame-contract half is covered by the matrix. If someone wants the integration rows anyway, the route is a test-only RSA keypair: serve a local JWKS, set the issuer/secret in `tests/worker/wrangler.jsonc`, and mint tokens with `jose`. Do not weaken the allowlist or add a bypass env var to make this easier.

**Gap 2 — the reconnect test cannot count KV writes.** Miniflare exposes no write counter, so the test compares per-board `{ key, value, expiration, metadata }` before and after. A redundant PUT of byte-identical JSON to the same key would pass. To close it, wrap the `WHITEBOARD_CODES` binding in the test Worker with a counting proxy and assert the count, rather than trying to infer writes from state.

Note: the 15 s deadline row really sleeps ~15 s (the deadline is checked on demand and, per §5.1b, cannot be triggered by a ping). That is the bulk of the worker-project runtime; do not "optimise" it by shortening `ROLE_RESOLVE_DEADLINE_MS` in tests, which would stop testing the shipped value.

### 6.4 One browser smoke test

Playwright against a preview URL: sign in → create → drop a PNG → reload → assert the image element renders. This is the check that has been performed by hand every night for two weeks. Automate it and the loop ends.

---

## 7. Phase 4 — cleanup

- Retire remaining legacy owner-key **write** paths and the claim/prefix-move once no live board needs them (audit R2 for `assets/temp:*` and `assets/google:*` keys first). Keep the GET fallback indefinitely — it is 20 lines and old scenes reference it.
- Rewrite `docs/whiteboard/sync-storage.md` to the new model.
- Replace `image-r2-incident-history.md` with a short postmortem: the two silent-failure designs, the missing binding tests, and the guardrails in §8.
- Update `AGENTS.md`: asset ids are content hashes; images never gate scene persistence.

---

## 8. Guardrails for whoever touches this next

These replace the "do not" list in the incident file. Two of those rules are now inverted **on purpose** — §5.3 explains why.

**Never:**

1. Let a user-visible state clear only on a message the server may choose not to send. Every gate gets a deadline and a degraded state.
2. Return `null` from an auth check that has more than one failure mode. Return a reason.
3. Order the scene mutation stream behind an asset upload, in either direction, on either side.
4. Reintroduce a server-side gate that rejects a whole scene batch because of one element's bytes.
5. Reintroduce the writer echo (`exceptSessionId = null` on full sync) or `flushNow(true)` on every hydrate — that was the 10 Hz / 100k-writes loop.
6. Stage or PUT inside `generateIdForFile`. Hash only.
7. KV `put` on a read path (`GET /meta` must not mint a share code).
8. Poll the DO on a timer when the socket is already open.
9. Keep a host secret in localStorage past a Google claim (shared Chromebooks).
10. Count uploaded-waiting-for-ack jobs in the "Saving N files" strip.
11. Preserve a fixed bug as an exported `false` constant. Delete the branch and write the test.

**Always:**

- Confirm `/api/whiteboard/version` before believing a production observation.
- Add the binding-level test in the same commit as the protocol change.

---

## 9. Sequencing, effort, risk

| Phase | Effort | Blocks | Risk if skipped |
|-------|--------|--------|-----------------|
| 0 — instrument | ~2 h | everything | Next hang is another week of archaeology |
| 1 — handshake | ~1 day | Phase 2 verification | Boards stay unusable; images untestable |
| 2 — image path | ~2–3 days | — | Bug returns in a new shape within a month |
| 3 — tests | ~1 day | — | Phases 1–2 decay exactly like `72c22b2`…`f74692b` |
| 4 — cleanup | ~0.5 day | — | Dead paths keep confusing future diagnosis |

Phase 1 must be verified before Phase 2 can be — you cannot test image durability on a board that will not greet. But Phase 2's design decisions are what keep Phase 1 fixed, so do not defer the design.

**Land as separate commits**, each independently revertable, in this order: 0.1/0.2 → 0.3+4.1 → 4.2+4.3 → 4.4 → 5.1 → 5.2 → 5.3+5.6 → 5.4+5.5 → 5.7 → Phase 3 → Phase 4. Never combine a handshake change with an image change; that is how the last five commits became impossible to bisect.

**Rollback:** every phase is behavior-additive at the protocol level (`wb:authResult` and `roleResolved` are ignorable by an old client; `wb:hello` timing is strictly earlier). The one non-reversible-by-revert step is §5.3, since scenes persisted without the gate may reference not-yet-uploaded fileIds — which the new client renders as placeholders and the old client would too (it never rejected on read). No data migration in either direction.

**Open item to confirm before Phase 1:** whether `PUBLIC_CLERK_ALLOWED_DOMAINS` and `CLERK_SECRET_KEY` are actually set on the live Worker / Workers Builds vars, not just locally. If the allowlist is set in production, §1.1 step 5 is a live outage trigger on every slow Clerk call, and §4.1 is the highest-priority change in this document.
