# Whiteboard image R2 incident history (handoff)

> **Final status (2026-08-27): PLAN ABANDONED / ROLLBACK IMPLEMENTED.** The post-`81242d2` board-scoped R2 upload redesign was rolled back after the image and board-loading incidents. New image/video insertion is temporarily disabled. Existing media remains readable from legacy `assets/{ownerKey}/{assetId}` and from read-only board-scoped `boards/{boardId}/assets/{fileId}` objects; board-scoped GET/HEAD works, while PUT/DELETE return `405`. The live scene remains in DO SQLite. The retained fixes are share-code mint-once, GET `/meta` no-mint, alarm no-op avoidance, identical-scene persist skipping, and writer exclusion from full scene broadcasts. This file remains historical evidence; the current architecture is documented in [sync-storage.md](./sync-storage.md).

**Purpose:** hand this file to another engineer or coding agent. Production is **still broken**. As of **`a1e9489`** (deployed and live, 2026-08-27 ~14:30 UTC), opening a pre-existing ("old") board still stays on the green **Connecting…** toast.

> **Read §9 before anything else.** §9 documents a large four-phase change (`a1e9489`) that was supposed to make this hang architecturally impossible and did not. It lists exactly what was changed, what was actually verified, what was *not* verified, and the ranked hypotheses for why the hang survived. Several "Do not" rules in §8 were **deliberately reversed** in `a1e9489`; §9.6 lists the corrections. Following §8 blindly will send you backwards.

**HEAD:** `a1e9489` (`fix(whiteboard): make images durable by removing the scene/R2 gate`, 2026-08-27), committed and pushed to `main`; Workers Builds `6086c3a7-0f37-413b-98ec-69a5c8fa1d32` succeeded and deployed it. Previous HEAD was `f74692b`.

**Do not re-investigate** myths listed in §7. Open DevTools WebSocket frames first (§5, §9.5).

**Who wrote which code**

| Source | What |
|--------|------|
| Earlier Cursor work (Aug 13–20) | First R2 images (`657a896`) and owner-key/auth lock-down (`1d63c52` … `7511a5c`). Commits carry `Co-authored-by: Cursor`. |
| **Codex** (Aug 26, separate chats) | Durability rewrite **`72c22b2`** and Worker-only legacy PUT bridge **`2a612f7`**. No `Co-authored-by: Cursor`. Codex’s leftover-tab diagnosis was real; after a refresh it was the wrong layer. Codex also reported a Worker version (`aba6c7c4-…`) that was **not** the live script — see dual-deploy below. |
| **This Cursor session** (Aug 26–27) | Parallel Grok 4.6 Extra High Fast research, then **`0cfc5c2`**, **`12f06f5`**, **`f74692b`**. Those three are Cursor-coauthored. The Connecting hang after `f74692b` is **not** closed. |

**Dual-deploy (always):** `npx wrangler deploy` from a laptop, then GitHub **Workers Builds** on `main` rebuilds and deploys the same commit ~70s later. The live Worker version UUID changes even when git SHA does not. Codex’s `aba6c7c4-4089-46b1-a428-01f959056767` at `2a612f7` was the CLI version; live after Builds was `4c7975b6-…`. Later deploys in this session: `0cfc5c2` → `3adec87a-8d98-439f-8944-3c22b97804d2`; `12f06f5` → `1474dd01-ecf5-4606-bbfb-62ffcd0c6b80`; `f74692b` → **`4bb3d26f-f7f9-4f90-9985-3d073973db88`**. Builds may already have overwritten that last UUID with the same commit.

Canonical live architecture (not this incident): [sync-storage.md](./sync-storage.md), [auth-libraries.md](./auth-libraries.md), [README.md](./README.md).

---

## 1. Product / stack (short)

St. Cecilia Technology PWA: **Astro 7** + Cloudflare Worker **`scsfoxchase-tech`** (`src/worker.ts`). Pages prerendered; Worker handles `/api/whiteboard/*`.

| Piece | Fact |
|-------|------|
| Editor | Stock **Excalidraw 0.18.1** (`WhiteboardCanvas.tsx`, `client:only="react"`). Product name is Whiteboard. **No tldraw.** |
| Live scene | Durable Object class **`WhiteboardBoard`**, binding `WHITEBOARDS`. One SQLite row `excalidraw_scene.id = 1`, column `scene_json`. Native WebSocket `/api/whiteboard/connect/{uuid}`. |
| Images | R2 binding **`WHITEBOARD_ASSETS`** (bucket `scsfoxchase-tech-whiteboards`). Current PUT: `boards/{boardId}/assets/{fileId}`. Legacy: `assets/{ownerKey}/{assetId}`. Binaries are **not** in scene JSON (`serializeAsJSON(..., {}, "database")` → `files: {}`). |
| Share codes | KV **`WHITEBOARD_CODES`**. Mint once; join by `1A2B3C4D` (legacy `1A2B` still works). |
| Auth | Clerk Google via `@clerk/react` header island (`ClerkAuth.tsx`). Frontend API `clerk.scsfoxchase.tech`. Scratch create stores a **host secret** in `localStorage` (`persistHostSecret` in `whiteboard-library.ts`). Host proof is first-message **`wb:auth`**, not the WebSocket query string. |
| PWA | `public/sw.js` **never intercepts `/api/*`**. |

**Connecting… overlay** is **only** `!roles.helloReceived` in `WhiteboardCanvas.tsx`. `helloReceived` becomes true on inbound **`wb:hello`** (`whiteboard-excalidraw-roles.ts`) and is not cleared on that page load. `wb:error` / `persist_failed` / `asset_not_ready` toast via Excalidraw; they **cannot** pin Connecting. The DO sends `scene:sync` on upgrade **before** hello. Excalidraw mounts view-only until hello.

---

## 2. Timeline of commits

Range: first Excalidraw R2 persist **`657a896`** (2026-08-13) through HEAD **`f74692b`** (2026-08-27). Nearby owner-key/auth commits are included because they did **not** change paint-then-PUT.

| SHA | Date | Claimed fix | What actually changed | What it did **not** fix |
|-----|------|-------------|----------------------|-------------------------|
| **`657a896`** | Aug 13 | Persist Excalidraw images and video in R2 | Owner-key objects `assets/{ownerKey}/{assetId}` (`temp:{boardId}` scratch, `google:{accountId}` saved). Same-origin `/whiteboard-player` for MP4/WebM. `generateWhiteboardFileId(_file)` = `crypto.randomUUID()` — **File unused**. Client paints from in-memory `BinaryFiles`, then PUT. Persist uses `serializeAsJSON(..., {}, "database")` so `files: {}`; bytes never live in DO JSON. | Leave/re-enter durability. No board-scoped keys, no DO manifest, no IndexedDB outbox. Image can paint locally and never exist on the server. |
| **`1d63c52`** | Aug 20 | Verify Clerk on connect; lock down assets | Google roles from Clerk session / first-message JWT, not query `userId`. Asset PUT/DELETE for temp/local need host or editor proof. SVG GET attachment-only. | Paint still local-first. Owner-key PUT path unchanged for “image survives reload.” |
| **`506a21b`** | Aug 20 | Allow Editor session PUTs on saved boards | `google:` canvas PUT accepts a live can-edit session. Viewers stay read-only. Image PUT failures toast. | Still owner-key namespace. Still paint then PUT. Still no fail-closed manifest. |
| **`7511a5c`** | Aug 20 | Give Editors `google:` prefix for saved-board uploads | `wb:hello` / GET meta reveal `cloudOwnerKey` so PUT/hydrate do not land on `temp:`. | Same local-first paint. Saved-board files could still vanish if PUT never happened or scene referenced a `fileId` with no object. |
| Other Aug 20–25 | Share codes, Group Edit, Recents JPEG snapshots, rebuild merge | Orthogonal. `81242d2` (Aug 25) permanent share code + Group Edit gate. | Image durability. |
| **`72c22b2`** | Aug 26 **Codex** | Make asset uploads durable | **Board-scoped** R2 `boards/{boardId}/assets/{fileId}` + DO `whiteboard_asset_manifest` + **fail-closed `asset_not_ready`**. IndexedDB outbox (`whiteboard-upload-outbox.ts`). “Saving N files” UI. Canvas PUT needs host secret or live session pair — **Clerk JWT is not write proof**. `generateIdForFile` **still UUID-only** (`generateWhiteboardFileId(_file)`). **`markServerSceneApplied` → `flushNow(true)` on every inbound `scene:sync`.** Full `scene:sync` broadcast used **`exceptSessionId = null`** (echo to the writer). Persist is **one UPSERT of the whole `scene_json`**, not per-element rows. Client **default-allowed** live scene `fileId`s (`pendingFlushRef` / onChange) — no `whiteboard-scene-publication.ts` yet. | Images still vanished after leave/re-enter: client published `fileId` **before** the outbox staged/PUT, DO correctly rejected (`asset_not_ready`). **This commit is the 10 Hz `rows_written` loop** (~1 UPSERT per WebSocket RTT; ~100k writes in ~3h on **one tab**). |
| **`2a612f7`** | Aug 26 **Codex** | Bridge leftover owner-key PUTs | **Worker-only.** A legacy PUT `/api/whiteboard/assets/{ownerKey}/{assetId}` with `X-Board-Id` also wrote `boards/{boardId}/assets/{fileId}` and registered the manifest. Tests in `whiteboard-legacy-asset-compat.test.ts`. | **Did not help a refreshed current client.** Current JS already used the board-scoped route. Wrong layer after refresh. **Later removed** in `12f06f5` (plan D / leftover-tab mirror). |
| **`0cfc5c2`** | Aug 26 Cursor | Persist images only after R2 is ready | Default-**deny** publication (`whiteboard-scene-publication.ts`). Board write-proof helper. File-sync planner. **`generateIdForFile` staged the original `File` into IndexedDB (`beginStaging` / `stage`) before Excalidraw `addMissingFiles`.** | **Broke insert-to-canvas.** Leftover staging + **Saving counted `uploaded` jobs waiting for `scene:ack`**. Mouse image-tool is click-to-place (0×0 pending until click) while PUT already ran. Echo loop from `72c22b2` still live → empty canvas, flash “Uploads saved”, 7–10 Hz flicker, hard to delete. |
| **`12f06f5`** | Aug 26 Cursor | Stop upload-before-paint and scene:sync echo | UUID-only `generateIdForFile` again (`generateWhiteboardImageFileId`). Upload only after BinaryFiles has a `dataURL` **and** the image is placed (not `pendingImageElementId`). Saving counts in-flight bytes only (`pending`/`uploading`/leftover staging), **not** uploaded-waiting-ack. **No `flushNow(true)` on every `scene:sync`.** Writer excluded from full sync (`sceneBroadcastPlan` → `exceptSessionId = fromSessionId`). Recover **once** per socket (`shouldHydrateServerSceneOnce`). **Removed** the `2a612f7` owner-key PUT mirror. | **Did not change hello / `wb:auth` / Clerk wait.** Connecting overlay unchanged. `sendConnectAuth` still `await whenAuthReady()` then `waitForSessionToken` **before** any `wb:auth`. That hang is why CREATE stayed Connecting after this deploy. Echo is **dead** here — do not “fix” it again. |
| **`f74692b`** | Aug 27 Cursor | Stop hello hang and idle KV/DO write spam | First `wb:auth` on WS `open` **without** waiting `whenAuthReady` (host secret + `signedIn` if known + cached token via `peekSessionToken`). Clerk `getToken` **2s** race (`AUTH_GET_TOKEN_SETTLE_MS`); `markAuthResolvedAfterTokenSettle` always resolves. Repeatable `wb:auth` after hello → **`wb:role`**, not a second hello. KV **mint-once**: `ensureShareCode` returns existing code with **no KV PUT**; `GET /meta` does **not** mint (`ensureBoardLifetime(..., { mintShareCode: false })`). Persist skips identical `scene_json` (`shouldSkipIdenticalScenePersist`). `setAlarm` skipped if already on target (`shouldReplaceStorageAlarm`). Idle 30s full flush skipped unless version moved; **`persist_failed` still retries**. | **User still Connecting after this deploy**, with limits already reset. Either first `wb:auth` still not going out, host secret missing, DO staying pending, stale JS/SW, another cap, or a hole this commit missed. **Verify with WS frames before editing.** |

---

## 3. User-visible incidents (in order)

### 3.1 Image gone after leave / re-enter (post-`72c22b2` / `2a612f7`)

Photo appeared on the canvas (crop handles, selection). After leaving the board and coming back: gone.

**What was true:** Excalidraw had in-memory `BinaryFiles`. Durable save never happened. The current client published the image `fileId` before the outbox staged it. The DO fail-closed with `asset_not_ready` and did not persist or broadcast that mutation. Toast: *This image is still uploading. The change was not stored.* (`SCENE_ASSET_NOT_READY_MESSAGE`).

`2a612f7` only helped **leftover tabs** still PUTting the old owner-key URL. After a hard refresh, the live client already used board-scoped PUT. Codex’s first diagnosis was real for those leftover tabs; it was the wrong layer for the refreshed path.

### 3.2 Dual toasts

Same insert: **Image upload failed** (PUT never 201 — MIME/size/network, or leftover pre-`72c22b2` JS) **and** **This image is still uploading. The change was not stored.** (`wb:error` `asset_not_ready`). Two failures, not one toast with two lines. Board-scoped 401/403 on the new client **hang waiting for proof** rather than toasting; a brief “image upload failed” pointed more at 413/415 or old JS.

### 3.3 After `0cfc5c2`: Saving stuck, empty canvas, flicker

- Status strip **Saving 1 file… / Saving 2 files…** (our UI, not Excalidraw). At this commit it counted staging + pending/uploading **and every `uploaded` job waiting for `scene:ack`**. PUT 201 did **not** clear it.
- Brief **Uploads saved** (1.5s strip) or overlay `aria-label="Upload saved"` (150ms). Neither meant pixels were on the canvas.
- Image tool on **mouse/trackpad** (Chromebook counts as mouse): Excalidraw inserts a 0×0 pending element and does **not** draw until click. `generateIdForFile` had already staged the `File` and started PUT — **upload-before-paint**.
- Click → image flashes, then **7–10 Hz** in/out. Delete was unreliable.
- Cause: leftover `beginStaging` + `scene:sync` echo (`72c22b2`) → recover → `flushNow(true)` → DO echo → repeat at RTT.

### 3.4 After `12f06f5`: Connecting forever + DO 90% email

Create board → green **Connecting…** never clears. Same night: Cloudflare email that Durable Object **`rows_written` was ~90% of 100k/day**.

**Two bugs, not one.** Echo (`72c22b2`) burned writes; `12f06f5` killed the echo but **not** hello. Connecting is **`!helloReceived` only**. 90% is a **warning**; the hard fail is after **100%**. A never-OPEN / 500 upgrade is what quota-at-100% looks like — not an OPEN socket that already received `scene:sync`.

Math that matched the email: ~9 Hz × 1 UPSERT/hop × one tab ≈ **100k writes in ~3 hours**. Reset **2026-08-27 00:00 UTC**.

### 3.5 KV operations 50% daily cap email (night before)

**Second meter**, not DO `rows_written`. Free KV writes ~**1,000/day**. Client `refreshMeta` **GET `/api/whiteboard/boards/{uuid}/meta` every 8s** (`whiteboard-excalidraw-files.ts`). Before `f74692b`, that GET called `ensureShareCode` which **PUT** the share-code KV key even when `meta:activeCode` already existed. One open board ≈ **450 writes/hour** vs ~1000/day → **50% in about an hour**. Matches the email. `f74692b` was supposed to stop that (mint-once, GET `/meta` does not mint).

### 3.6 Next morning: still Connecting after reset + `f74692b`

Limits reset. Worker **`4bb3d26f-f7f9-4f90-9985-3d073973db88`** (`f74692b`) deployed. User still cannot load a board; stuck on **Connecting…** on create/load. **This is the live incident for the next agent.** Do not assume the echo loop is back. Do not assume quota is exhausted. Discriminate with WebSocket frames (§4 table, §8).

---

## 4. Research program (this Cursor chat)

Multiple parallel **Grok 4.6 Extra High Fast** rounds, read-only unless implementing a named commit. Consensus below is what survived adversarial review. Do not re-run the same git archaeology unless HEAD moved.

### Round: image vanish (HEAD `2a612f7`)

Angles: client outbox, server manifests, git archaeology, Excalidraw `files` model, production Worker version.

**Consensus**

- `2a612f7` is the **wrong layer after refresh**. Current client PUTs board-scoped. The bridge only helped leftover owner-key tabs.
- Default-**allow** persist: live `pendingFlushRef` / `onChange` sent `fileId`s the outbox had not staged (investigation shorthand “informMutation” — there is no function by that name). DO `asset_not_ready` was **correct**.
- Hydrate (GET into `BinaryFiles`) is **not** upload (PUT). A hydrate in flight must not suppress a later upload when local bytes appear.
- Clerk JWT is **never** board-scoped PUT proof (`X-Board-Host` or `X-Board-Session` + `X-Board-Auth`).
- Production Worker at that moment matched git `2a612f7` after the Builds overwrite, not Codex’s CLI version UUID.

**Fix shipped:** `0cfc5c2` (default-deny) — then immediately caused §3.3.

### Round: Saving / flicker (HEAD `0cfc5c2`)

Angles: Saving strip, reconcile loop, git from first R2 through `0cfc5c2`, `generateIdForFile` → outbox → filter → `scene:ack`.

**Consensus**

- Saving strip counted **uploaded-waiting-ack**.
- Leftover `beginStaging` inside `generateIdForFile` consumed the `File` before Excalidraw `addMissingFiles`.
- Mouse image-tool is **click-to-place**.
- Loop: `scene:sync` → recover → `flushNow(true)` → DO full sync with `exceptSessionId = null` → ~7–10 Hz.

**Fix shipped:** `12f06f5`. Keep it. Do not reintroduce staging-in-`generateIdForFile` or writer echo.

### Round: Connecting / quota (HEAD `12f06f5`)

Round 1 (hang, write amplification, leftover loops, persist git) → **adversarial round 2** (try to falsify: did `12f06f5` break hello? is write accounting wrong? is CREATE handshake stuck?) → **confirmation round 3** (independent TRUE/FALSE votes).

**Round 2 + 3 voted TRUE** on:

1. Connecting overlay iff `!roles.helloReceived`.
2. `helloReceived` set only on `wb:hello`, not cleared on this page load.
3. `persist_failed` / `wb:error` **cannot** keep Connecting up.
4. `12f06f5` did **not** change hello/auth/roles in a way that blocks `wb:hello`.
5. CREATE with `persistHostSecret`: first `wb:auth` **with `hostSecret`** mints Owner and `sendConnectHello` even if signed-in JWT is missing (`roleCanEdit` short-circuits pending).
6. 10 Hz writes = `72c22b2` echo (1 whole-scene UPSERT per persist), not per-element rows.
7. 90% email is a **warning**; fail after 100%.
8. Most likely hang at `12f06f5`: **`whenAuthReady` / `getToken` never resolved**, so **no `wb:auth`** while WS is OPEN and `scene:sync` already arrived. Host secret sat in `localStorage` unsent.

Quota email and OPEN-socket Connecting are **two bugs**. Treating them as one is why this slipped.

### WebSocket discriminator (use this first)

| What you see | Meaning |
|--------------|---------|
| **OPEN + inbound `scene:sync`, no outbound `wb:auth`, no `wb:hello`** | Auth never sent. At `12f06f5` this was `whenAuthReady` hang. At `f74692b` this means first `wb:auth` still is not leaving the tab (stale JS, `sendConnectAuth` not reached, or WS closed before send). |
| **OPEN + `wb:auth` with `hostSecret` + `wb:hello` owner** | Healthy CREATE. Connecting must clear. If UI still says Connecting, it is not this socket / not this JS. |
| **OPEN + `wb:auth` without `hostSecret`, `signedIn: true`, no hello** | DO **pending** on purpose (signed-in, no JWT, no can-edit role yet). Overlay stays until JWT `wb:auth` or host proof. Expected for UUID join while Clerk loads; **not** expected for hub CREATE if `persistHostSecret` ran. |
| **Never OPEN / HTTP 500 on upgrade** | Constructor / quota **100%** / DO cannot accept the socket. Not the overlay-with-OPEN-sync case. |
| **`wb:hello` then `wb:error` `persist_failed`** | **Not** Connecting overlay. Scene toast only. |

---

## 5. What production should be now (`f74692b`)

**Intended behavior (what the commit tried to ship)**

- On WebSocket `open`, `sendConnectAuth` immediately `sendAuthFrame` with `peekSessionToken()` (often empty) **plus `hostSecret` if present** and `signedIn: true` if `isSignedIn()`. It does **not** await `whenAuthReady` first. A follow-up frame runs after `whenAuthReady` + 2s-bounded `getToken`.
- Hub **Create** writes `localStorage` host secret **before** navigation (`createBoardActive` / `createBoard` → `persistHostSecret`). First `wb:auth` with that secret should mint scratch Owner and send **one** `wb:hello`. Connecting should clear even if Clerk is still loading.
- Signed-in, no JWT, **no** host secret, no can-edit role → socket stays pending (no Viewer hello that would lock out a real Owner). Client retries JWT; late token upgrades via **`wb:role`**, never a second hello, never a demotion.
- `ClerkAuth` `AuthBridge`: `markAuthResolvedAfterTokenSettle` races `getToken` at 2s then **always** `markAuthResolved`, so `whenAuthReady` cannot hang forever.
- Share code: mint on connect / Owner-Manager GET|POST `/code` **once**. Existing `meta:activeCode` → no KV PUT. `GET /meta` is read-only for codes (still may start unsaved TTL). 8s meta poll must not burn KV.
- `persistScene` skips SQLite if serialized JSON equals `lastPersistedJson` unless the merge accepted elements (`force`).
- `scheduleNextAlarm` does not `setAlarm` when the existing alarm is within 1s of the target.
- Idle 30s full flush skipped when scene version has not moved, **except** `persist_failed` sets a retry flag that bypasses the watermark.
- Image path from `12f06f5` **unchanged**: paint-first, UUID-only `generateIdForFile`, default-deny persist, fail-closed `asset_not_ready`, no writer echo, recover once.

**Reality:** the user reports **Connecting still broken** after this Worker. Hypotheses for the next agent (check in this order, with frames):

| | Hypothesis | How to confirm |
|---|-------------|----------------|
| **(a)** | First `wb:auth` still not sent / still blocked | Discriminator row 1. Read `sendConnectAuth` at `f74692b` — if frames show no `wb:auth`, the 2s timeout is irrelevant because the first frame should not wait. |
| **(b)** | Host secret missing after hub → `/board/{uuid}` | `wb:auth` present but **no `hostSecret`**. Check `getHostSecret(boardId)` vs `persistHostSecret` key; private mode; different subdomain; create from a path that skipped `createBoard`. |
| **(c)** | DO still pending despite `hostSecret` | Outbound `wb:auth` **includes** `hostSecret`, no `wb:hello`. Then `finishPendingConnectAuth` / `hostProvesScratchOwner` / `signedInWithoutClerk && !roleCanEdit`. |
| **(d)** | Service worker or old JS | Network panel: board island hash ≠ `f74692b` build. `sw.js` skips `/api/*` but **can cache the page/JS**. Hard-refresh / unregister SW. |
| **(e)** | Quota or another request cap | Never-OPEN / 500. DO `rows_written` / Worker request limits **after** reset should be low unless something else is writing. Do not blame 90% from the previous UTC day. |
| **(f)** | Something `f74692b` missed | e.g. `authSentRef` / signed-in-without-token skipping `authSentRef.current = true`; identity module duplicated across Vite entries; hello delivered but `helloReceived` not set (roles island vs canvas). Only after (a)–(e). |

**Next agent: DevTools WS frames FIRST**, then read `sendConnectAuth` / `finishPendingConnectAuth` / `ClerkAuth` **at `f74692b`**. Do **not** assume the `72c22b2` echo is still running. `12f06f5` already excluded the writer.

---

## 6. Files that matter

| Path | Why |
|------|-----|
| `src/components/WhiteboardCanvas.tsx` | Overlay `!helloReceived`; `sendConnectAuth` / `sendAuthFrame`; scene flush; recover-once; upload status. **Start here for Connecting.** |
| `src/components/ClerkAuth.tsx` | `AuthBridge`: identity, `setSessionTokenGetter`, `markAuthResolvedAfterTokenSettle`. |
| `src/lib/whiteboard-identity.ts` | `whenAuthReady`, `peekSessionToken`, `getSessionTokenSettled`, 2s `AUTH_GET_TOKEN_SETTLE_MS`, window-scoped auth store (Vite entry duplication). |
| `src/worker/WhiteboardBoard.ts` | `finishPendingConnectAuth`, `resolveAuthMessage` (pending if `signedIn` without JWT and no can-edit role), `sendConnectHello`, `persistScene`, `ensureShareCode`, `ensureBoardLifetime`, `scheduleNextAlarm`, `validateNewImageAssetReferences`, `broadcastScene`. |
| `src/lib/whiteboard-excalidraw-files.ts` | `generateIdForFile` (UUID only at HEAD), `syncFiles` / planner, **8s `refreshMeta`**. |
| `src/lib/whiteboard-scene-publication.ts` | Default-deny clone/filter for `scene:update` images. **Do not weaken.** |
| `src/lib/whiteboard-file-sync-plan.ts` | Upload vs hydrate; defer while `pendingImageElementId`; `shouldHydrateServerSceneOnce`. |
| `src/lib/whiteboard-upload-outbox.ts` | IndexedDB queue; publication watches `state === 'uploaded'`. |
| `src/worker/assetRoutes.ts` | Board-scoped PUT/GET/DELETE + leftover owner-key GET. **No dual-write** after `12f06f5`. |
| `src/scripts/whiteboard-library.ts` | Hub `createBoardActive` / `createBoard` → `persistHostSecret` / `getHostSecret`. |
| `src/lib/whiteboard-excalidraw-roles.ts` | `helloReceived` ← `wb:hello` only. |
| `src/lib/whiteboard-sync.ts` | `sceneBroadcastPlan` (writer excluded), `shouldSkipIdleFullFlush`, `asset_not_ready` message. |
| `src/lib/whiteboard-board-write-proof.ts` | Host/session proof; Clerk JWT insufficient. |
| `public/sw.js` | Early return for `/api/*`. Can still cache HTML/JS. |
| `docs/whiteboard/sync-storage.md` | Canonical sync/R2/outbox doc (kept in sync with `12f06f5` / `f74692b`). |

Tests worth reading: `tests/whiteboard-identity.test.ts`, `tests/whiteboard-board-lifetime.test.ts`, `tests/whiteboard-scene-publication.test.ts`, `tests/whiteboard-file-sync.test.ts`. `sendConnectAuth` itself is **not** unit-tested (live WS + Clerk islands).

---

## 7. Explicitly ruled out

Do not reopen these as the Connecting cause or as the live image path:

| Ruled out | Why |
|-----------|-----|
| **R2 itself** | Connecting is hello-gated. R2/manifest bugs show as missing images / `asset_not_ready` / PUT errors, not a pinned Connecting toast. |
| **DigitalOcean** | This app is Cloudflare Workers + DO + R2 + KV. |
| **tldraw** | Removed. Excalidraw 0.18.1. No tldraw license key. |
| **SW intercepting `/api` PUT or the WebSocket** | `public/sw.js` returns before handling `/api/*`. SW **can** still serve stale **page JS** — that is hypothesis (d), not PUT interception. |
| **Clerk JWT as board-scoped PUT proof** | PUT requires `X-Board-Host` or live session pair. JWT is for library APIs and `google:*` account-global legacy writes, not the current canvas PUT. |
| **`2a612f7` as the live image path after refresh** | Worker-only owner-key mirror. Removed in `12f06f5`. Current client is board-scoped. |
| **`persist_failed` as the Connecting overlay** | Overlay is `!helloReceived`. Hello then `wb:error` is a scene toast. |
| **`12f06f5` as the hello regression** | Adversarial + confirmation rounds: that commit did not sit on the auth path. It killed echo. Connecting at that HEAD was `whenAuthReady` blocking `wb:auth`. |
| **Per-element SQLite rows as the 100k writes** | Always one `scene_json` UPSERT per persist. |
| **90% email as a hard fail** | Warning. Hard fail after 100%. OPEN + `scene:sync` means the DO accepted the upgrade. |
| **Re-weakening `asset_not_ready`** | That invariant is the correct server gate. Client must default-deny until PUT 201 + manifest `ready`. |

---

## 8. Next agent brief (≈15 minutes)

**Goal:** get a created board past Connecting, without regressing image persist or write caps.

1. **Hard-refresh** (or unregister SW) so JS matches `f74692b`. Confirm the Worker version if possible; remember Builds overwrites the UUID.
2. **Create a board from `/whiteboard`.** Immediately open DevTools → Network → WS `connect/{uuid}` → frames. Classify with the §4 table. **Do not edit code until you have a row.**
3. If **no `wb:auth`**: read `sendConnectAuth` / `sendAuthFrame` in `WhiteboardCanvas.tsx` at `f74692b` (should send on `open` without `whenAuthReady`). If the source does that but the browser does not, it is stale JS or `open` never firing — not a Clerk hang.
4. If **`wb:auth` without `hostSecret`**: trace `createBoard` → `persistHostSecret` → `getHostSecret(boardId)` in `whiteboard-library.ts`. Hub navigation must not drop the key.
5. If **`wb:auth` with `hostSecret` but no hello**: read `finishPendingConnectAuth` / `resolveAuthMessage` in `WhiteboardBoard.ts`. Host proof should mint Owner (`mintHost: true`) and hello even when `signedIn: true` and token empty.
6. If **never OPEN**: quota/constructor — `wrangler tail`, Cloudflare DO metrics for **today’s** UTC day. Do not use yesterday’s 90% email.
7. Only after the board greets: drop a PNG, leave/re-enter. Image path should still be paint → PUT 201 → default-deny flush → persist. Saving only while bytes in flight.

> **§8 is superseded in places by §9.** It was written at `f74692b`, before the `a1e9489` surgery. The two struck-through rules below were reversed on purpose; see §9.6.

**Do not**

- ~~Weaken `validateNewImageAssetReferences` / `asset_not_ready`.~~ **REVERSED at `a1e9489`** — both are deleted on purpose (§9.6). Do not restore the gate.
- Reintroduce writer `scene:sync` echo (`exceptSessionId = null` on full sync) or `flushNow(true)` on every hydrate.
- KV PUT on every `GET /meta` or rewrite `ensureShareCode` to always `put`.
- ~~Treat Clerk `Authorization` as canvas PUT proof.~~ **REVERSED at `a1e9489`** — a Clerk JWT now authorizes board-scoped asset PUTs (§9.6). Still true for the `hasBoardWriteProof` header helper only.
- Restore the `2a612f7` owner-key dual-write.
- Stage the `File` inside `generateIdForFile` (`0cfc5c2` insert-before-paint).
- Commit, push, or deploy unless the human asks.

**If Connecting is actually fixed in frames but the user still sees the toast:** `helloReceived` not flipping — `whiteboard-excalidraw-roles.ts` `wb:hello` handler vs a second canvas instance. That is (f), not echo and not R2.

---

## 9. Round 4 — the four-phase surgery at `a1e9489`, and why it did not fix Connecting

**Status: FAILED for the reported symptom.** The user's first test after deploy was step 1 of the verification list — open an old board — and it still showed **Connecting…**. Everything below is what was changed and what was proven, so the next agent does not repeat it.

This round was run from a written plan, `docs/whiteboard/image-r2-fix-plan.md`, which is committed alongside the code. **Read that plan** — it contains the full diagnosis, the per-phase specs, and (in §5.1b, §5.1c, §6.3a, §6.3b) the review findings and accepted limitations. This section is the summary and the post-mortem.

### 9.1 The diagnosis the round was built on

Three causes were identified, and the plan treated only the first as the hang:

- **Cause A — the handshake was architecturally *able* to hang.** The DO could resolve a `wb:auth` to "no decision" and then go silent; the client's overlay waited on `wb:hello` forever; Clerk verification collapsed every distinct failure (no token / bad signature / BAPI unreachable / not allowlisted) into a single `null`, so nothing could tell "still loading" from "denied".
- **Cause B — image durability was a distributed transaction.** The DO refused to persist *any* scene mutation whose new image references were not already in R2 (`validateNewImageAssetReferences` → `asset_not_ready`). That made image bytes a precondition for saving **unrelated** edits, and every band-aid since `72c22b2` was an attempt to satisfy that precondition from the browser.
- **Cause C — nothing in the loop could fail a bad fix.** No integration tests against real bindings; no way to tell which commit was live.

### 9.2 What was changed (all in `a1e9489`)

Roughly **+2175 / −3300** lines across 46 files, net ~1.1k removed. Four workstreams:

**Phase 0 — observability and one deploy path**
- Added `GET /api/whiteboard/version` → `{ sha, builtAt }` (`src/worker.ts`, `astro.config.mjs` Vite `define` of `__BUILD_SHA__` / `__BUILD_TIME__`). Verified by dry-run that the substitution reaches the deployed bundle via `.wrangler/deploy/config.json` → `dist/server/entry.mjs`.
- Removed the `deploy` script from `package.json`; added `preview:upload` (`wrangler versions upload`). Docs (`AGENTS.md`, `DEPLOYMENT.md`, `docs/deployment.md`) now state Workers Builds on `main` is the **only** production deployer. This kills the dual-deploy confusion described in this file's header.

**Phase 1 — "the handshake cannot hang"** (the part that was supposed to fix the reported bug)
- `src/worker/clerkAuth.ts`: added `ClerkVerifyResult` / `verifyClerkWhiteboardTokenResult` so failures are discriminated (`no_token` / `token_invalid` / `clerk_unreachable` / `account_not_allowed`). **An empty Clerk email is no longer an allowlist denial**; such identities are marked `profileDegraded` and may not claim or write cloud ownership. `requireClerkWhiteboardAuth` returns 503 for degraded identities.
- `src/worker/WhiteboardBoard.ts`: `SocketAttachment` gained `roleResolved` and `connectedAt`. `wb:hello` is sent at connect with `roleResolved: false` instead of waiting for auth. Non-auth frames are no longer silently dropped while auth is pending: ping / `scene:request` / follow are always handled, and `scene:update` while unresolved gets `wb:error` code `role_unresolved`. **Every** `wb:auth` now gets a `wb:authResult` carrying a typed reason. Late tokens upgrade the role via `wb:role`. A 15 s role-resolve deadline is checked on demand.
- `src/components/WhiteboardCanvas.tsx`: the Connecting overlay condition became `!socketConnected || !roles.helloReceived`; added a non-blocking "Checking your access…" strip and an `authoritativeCanEdit` (`roleResolved && canEdit`) used at every write site; auth retry stays armed while unresolved and refetches a fresh JWT.
- Asset writes stopped depending on the socket: `waitForBoardWriteProof` was removed from the image/video upload paths and a Clerk Bearer JWT can authorize a board-scoped asset PUT (`src/worker/assetRoutes.ts`).

**Phase 2 — image path restructure** (Cause B)
- Image file ids are now the **SHA-256 hex of the bytes** (`generateWhiteboardImageFileId`, `generateWhiteboardFileId`), so PUT is idempotent, the same image dedupes, and the Worker verifies body-against-path (400 on mismatch, 64-hex ids only). Hashing is pure — no staging or upload inside `generateIdForFile` (that was `0cfc5c2`'s insert-before-paint bug).
- `isAssetFileId` (UUID **or** 64-hex) is used for the *fileId* segment only; `boardId` stays strictly UUID. Without this every content-addressed PUT/GET would have 400'd.
- Non-range GETs return 200 (the 206 branch is gated on the request carrying a `Range` header; Miniflare populates `object.range` regardless).
- Asset GET/HEAD go straight to R2; the DO manifest is a best-effort GC index that can no longer orphan bytes or 503 a good upload.
- **`validateNewImageAssetReferences` and `asset_not_ready` were deleted.** Scene mutations always persist. See §9.6 — this reverses a §8 "Do not".
- Deleted `whiteboard-scene-publication.ts` wholesale, plus the planner decision table, the staging machine, element snapshots, and scene-ack bookkeeping in `whiteboard-upload-outbox.ts`.

**Phase 3 — tests that can fail** (Cause C)
- Real-bindings harness: `@cloudflare/vitest-pool-workers` + Miniflare under `tests/worker/`, with its own `wrangler.jsonc` and an `@astrojs/cloudflare/handler` stub.
- 14 new worker tests: an 11-row handshake matrix (every row asserts `wb:hello` within 5 s **and** exactly one hello per socket), a binding-config drift test (test config must be a superset of root `wrangler.jsonc`), and a reconnect-no-KV-write test.
- Proven able to fail: commenting out `sendConnectHello` fails all 11 handshake rows; adding a throwaway R2 binding to root `wrangler.jsonc` fails the drift test.

### 9.3 What was actually verified

| Gate | Result |
|---|---|
| `npm test` | 99 passed, 0 skipped, 14 files |
| `npm run build` | exit 0, `[build] Complete!` |
| `npx tsc --noEmit` excluding `tests/worker/` | **157** (pre-existing baseline was 159) |
| `WhiteboardBoard.ts` / `assetRoutes.ts` / `clerkAuth.ts` / `whiteboard-sync.ts` | 0 type errors each |
| Dangling refs to deleted symbols | none (`asset_not_ready`, `planImageFileAction`, `waitForBoardWriteProof`, `acknowledgedImageFileIds`, `markSceneAcknowledged`, `whiteboard-scene-publication`) |
| Deploy | Workers Builds `6086c3a7` success on `a1e9489` |

Two regressions were caught in review *before* deploy and fixed, both documented in the plan:
- **Legacy image hydrate (plan §5.1c).** Phase 2 reduced `hydrateImage` to a single board-scoped GET, dropping the owner-key probe. Since `assets/{ownerKey}/{assetId}` is the original key layout, that would have turned every image on every pre-existing board into a permanent placeholder. Restored as `hydrateLegacyOwnerImage`, gated to non-hash ids, and pinned with a test that the legacy route still serves seeded bytes.
- **Phase 1 self-reported risks (plan §5.1b).** Both chased down and shown benign: the 15 s deadline genuinely cannot fire on a ping (`setWebSocketAutoResponse` at `WhiteboardBoard.ts:544` means Cloudflare answers pings without waking DO JS), and the now-instant hello cannot strand a scratch creator because every `clearHostSecret` site sits behind an `await` on a Clerk-authenticated write that fails closed.

### 9.4 Why the verification did not catch the surviving hang — read this

This is the important part, and it is the same trap as Rounds 1–3.

**Every gate above ran in Node or Miniflare. Nothing exercised production.** Specifically:

1. **No test can produce a Clerk token that verifies.** The test Worker has no Clerk secret or JWKS, and `@clerk/backend` cannot be stubbed from that isolate without editing `src/` or `vitest.config.ts`. So the rows "valid token → correct cloud role", "allowlist rejects a real email", and "valid token then Clerk BAPI times out" are **integration-uncovered** (plan §6.3b). The garbage-token row always resolves to `clerk_unreachable`, never `token_invalid`, because verification fails before signature checking.
2. **No test uses an *old* board.** Every harness test creates a fresh board id, so the DO has trivial stored state: no large scene, no `meta:activeCode`, no cloud owner, no stored roles, no hibernated sockets, no asset manifest rows. **The reported failure is specific to old boards, and that is exactly the state no test covers.**
3. **No browser test.** Plan §6.4 (Playwright against a preview URL) was never written. The service worker, Clerk islands, React mount order, and IndexedDB migration are all untested.
4. The handshake matrix asserts hello arrives *in Miniflare*. It cannot detect a production-only failure to reach the 101.

### 9.5 Ranked hypotheses for the surviving hang

The overlay is `!socketConnected || !roles.helloReceived` (`WhiteboardCanvas.tsx:1545`). **The component clearly mounted, because the toast renders at all** — so this is not a mount crash. The single most valuable fact to obtain is *which of those two flags is false*; it halves the search space. Get that before touching code.

**H1 (strongest) — the 101 is never returned for an old board, so the socket never opens.** In `handleConnect`:

```ts
await this.sendConnectHello(serverWebSocket, attachment)
await this.sendFullScene(serverWebSocket)
return new Response(null, { status: 101, webSocket: clientWebSocket })
```

`sendConnectHello` awaits four storage reads (`readOwnerHook`, `isSavedToLibrary`, `readBoardTitle`, `readClassCanEdit`) and `sendFullScene` loads the entire persisted scene — **all before the 101 is returned**. If any read throws or stalls, the browser's `WebSocket` never opens, `socketConnected` stays `false`, and the client reconnect loop repeats it forever. An old board has a large scene and populated metadata; a fresh board (every test) has almost none. This fits "old board fails" exactly.

Note the irony and the lesson: Phase 1 moved hello earlier in the *message* order but left it *inside the pre-101 critical path*. It is the same structural mistake as Cause B — fallible work placed ahead of the thing that unblocks the UI.

*Confirm:* DevTools → Network → the `connect/{uuid}` request. If it never reaches **101 Switching Protocols** (stays pending, or fails), H1 is right. `wrangler tail` during the attempt should show a DO exception or a long invocation. *Fix direction:* return the 101 first and send hello/scene after, or make hello depend on nothing that can fail (defaults + a follow-up frame for metadata). Do **not** simply widen a try/catch — an old board silently losing its title/owner is a different bug.

**H2 — stale client JS.** If the browser ran a cached bundle, the old hang behaviour is expected and the whole diagnosis is void. **Rule this out first, it is nearly free:** load `/api/whiteboard/version` and confirm `sha` is `a1e9489`, then hard-reload / unregister the service worker and retest. (Note: a Cloudflare managed challenge fronts the site, so this must be checked in a real browser, not curl.)

**H3 — hello is sent but the client never applies it.** The handler is permissive (`data.type === 'wb:hello'` → `setHelloReceived(true)`, `whiteboard-excalidraw-roles.ts:511-552`), so this requires the frame never reaching `handleSocketMessage` — e.g. two canvas instances, or the message listener wired after the frame arrives. *Confirm:* WS frames show `wb:hello` inbound but the toast persists.

**H4 — old hibernated sockets / attachment-shape skew.** `fetch()` runs `hydrateSockets()` + `restoreFollowAfterWake()` **before routing** (`WhiteboardBoard.ts:976-977`). Old boards may hold hibernated sockets whose attachments predate `roleResolved`/`connectedAt`. `normalizeAttachment` takes a `Partial`, so this *should* be safe, but a throw here fails the upgrade the same way as H1. Also note `listParticipants` / `participantFromSession` now skip sockets with `!roleResolved` (`:2410`, `:2428`), so pre-deploy sockets may be invisible in People.

**H5 — an old board's DO is in a state the constructor rejects.** `blockConcurrencyWhile` runs `migrateExcalidrawSceneTable` + `ASSET_MANIFEST_TABLE_SQL`, and `hasTldrawSqlTables` triggers `clearAllStorage()`. Table SQL and migrations were **not** modified in `a1e9489` (verified by diff) and `CREATE TABLE IF NOT EXISTS` is idempotent, so this is unlikely — but a constructor throw is indistinguishable from H1 at the network layer, so H1's confirm step covers it.

### 9.6 Corrections to §8 — instructions that `a1e9489` deliberately reversed

Two §8 "Do not" rules are now **wrong** and will undo this round if followed:

1. ~~"Weaken `validateNewImageAssetReferences` / `asset_not_ready`."~~ **Both are deleted, on purpose** (plan §5.3). The gate is correct in isolation and catastrophic in combination: it made image bytes a precondition for persisting unrelated edits. Scene mutations must always persist; a missing image renders as a placeholder and resolves on hydrate. **Do not restore the gate.**
2. ~~"Treat Clerk `Authorization` as canvas PUT proof."~~ A Clerk JWT **is** now accepted for board-scoped asset PUTs (plan §4.4), so uploads no longer wait on the WebSocket handshake. `hasBoardWriteProof` still ignores JWTs for the *header-shaping* helper — that narrower statement is still true.

Still valid from §8: no writer `scene:sync` echo, no KV PUT per `GET /meta`, no `2a612f7` owner-key dual-write, and never stage the `File` inside `generateIdForFile`.

### 9.7 Do not redo these

- **Do not rebuild the test harness.** `tests/worker/` works. Its limitations are catalogued in plan §6.3a.
- **Do not re-litigate the degraded-Clerk logic.** `tests/whiteboard-auth-resolution.test.ts` covers it with both polarities: a `profileDegraded` identity matches neither a real `google:{sub}` key nor its own `ownerKey`, cannot write `META_CLOUD_OWNER_KEY`, a full profile can, and a non-allowlisted real email is still denied.
- **Do not move the 15 s deadline to an alarm** to "fix" it not firing on ping (plan §5.1b) — it costs a DO wake per unresolved socket to fix something cosmetic.
- **Do not delete the legacy owner-key GET route or `hydrateLegacyOwnerImage`** (plan §5.1c). Pre-existing boards' images depend on it.
- **Do not re-add the 8 s meta poll work.** Killing it (plan §5.7) was deliberately deferred to Phase 4; the poll still runs today and is a quota concern, not a correctness one.

### 9.8 The meta-lesson

Three rounds now have shipped a green test suite and a broken board. The gap is always the same: **the tests model the codebase, not the deployment.** The highest-value next investment is not another refactor — it is one Playwright smoke test against a real preview URL with real Clerk, opening a *pre-existing* board with images, because that is the exact combination that has never once been exercised automatically. Everything in §9.4 explains why 99 passing tests said nothing about the reported symptom.
