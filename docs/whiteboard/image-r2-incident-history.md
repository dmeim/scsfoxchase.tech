# Whiteboard image R2 incident history (handoff)

**Purpose:** hand this file to another engineer or coding agent. Production is still broken: after **`f74692b`** (Worker **`4bb3d26f-f7f9-4f90-9985-3d073973db88`**), creating or loading a board stays on the green **Connecting…** toast. Durable Object / KV daily limits had already reset (next UTC day, 2026-08-27). Do not re-investigate myths listed in §7. Open DevTools WebSocket frames first (§5, §8).

**HEAD:** `f74692b` (`fix(whiteboard): stop hello hang and idle KV/DO write spam`, 2026-08-27). This file is uncommitted documentation only — no git commit, push, or deploy was requested with it.

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

**Do not**

- Weaken `validateNewImageAssetReferences` / `asset_not_ready`.
- Reintroduce writer `scene:sync` echo (`exceptSessionId = null` on full sync) or `flushNow(true)` on every hydrate.
- KV PUT on every `GET /meta` or rewrite `ensureShareCode` to always `put`.
- Treat Clerk `Authorization` as canvas PUT proof.
- Restore the `2a612f7` owner-key dual-write.
- Stage the `File` inside `generateIdForFile` (`0cfc5c2` insert-before-paint).
- Commit, push, or deploy unless the human asks.

**If Connecting is actually fixed in frames but the user still sees the toast:** `helloReceived` not flipping — `whiteboard-excalidraw-roles.ts` `wb:hello` handler vs a second canvas instance. That is (f), not echo and not R2.
