# Whiteboard launch ToDo

Whiteboard is not classroom-ready until the launch blockers in this list are fixed. Recents and Library are a signed-in **index** (`library/{ownerKey}/boards.json` in R2), not the live document. Live-board identity is a **client hint** on the WebSocket query string (`userId` in `buildWhiteboardConnectUrl`); it is not a verified Clerk session. Leftover tldraw SQLite tables are **not** the launch risk (see tldraw constructor wipe needs no code change).

Known user-reproduced bugs: an Owner named a board “Summer Checklist 2026-2027” while three private-tab Lucky Finch Viewers still saw **Untitled board**; Viewers still see **Name this whiteboard** and **Save**; the **Following** tag and outline are glitchy (sometimes they need a refresh; a role change can hide them and they may not return).

This list is for teachers and students launch hardening after the tldraw → Excalidraw 0.18.1 move. Help-article title cards are out of scope. There is no unit-test harness; each issue lists grep, `npm run build`, or a classroom repro for verification.

## Handoff status (2026-08-20)

Pinned model: Grok 4.6 Extra High slow (`cursor-grok-4.6-xhigh`). Branch: `fix/whiteboard-header-rename` (commit and push this branch at milestones; never push `main`).

**Wave cap:** 10 concurrent specialists. Fill every unblocked file partition; do not overlap writers.

**In flight (next wave):**

- Board title is library-index-only — **done** (`meta:title` on hello/PATCH; Viewer/Editor 403). Classroom Summer Checklist manual open.
- Student Editors cannot upload media on saved boards — **done** (session PUT; Editors may still land on `temp:` until they know the `google:` prefix). Manual paste+reload open. `local:*` writes 403.
- Last strokes vanish on tab close (flush only) — **done**. Classroom close-within-1s manual open.
- Share Open Closed rotate not role-gated — **done** (`handleCodeHttp` Owner/Manager 403; share tools hidden). Classroom Viewer-cannot-mint Manual open.
- Manager rename leftover (no Manager Recents as class title) — **done**. Manual Manager vs Owner Recents still open.
- Video player URLs after claim + temp media expiry — `worker` owns `src/worker/assetRoutes.ts`, `src/lib/whiteboard-excalidraw-files.ts` (do not edit WhiteboardBoard.ts)
- Follow Me client resubscribe after socket gap — `worker` owns `src/components/WhiteboardCanvas.tsx`, `src/lib/whiteboard-excalidraw-roles.ts` (do not edit WhiteboardBoard.ts)
- Follow Me hibernation (Durable Object) — `worker` owns `src/worker/WhiteboardBoard.ts` only (do not edit Canvas or roles)
- Share / join-code docs vs Owner-Manager gate — `doc-smith` owns `docs/whiteboard/share-codes.md`, `docs/whiteboard/people-permissions.md`, `docs/whiteboard/hub-and-board.md`

**Just closed (code-verified; classroom manuals still open):**

- Excalidraw library sidebar hidden via CSS; Chromebook visual still manual (canvas search is hidden too).
- Client `isShareCode` matches eight-character server codes.
- Docs: `A1B2C3D4` + host proof off the WS URL. Historical spec left as history. In-board copy: join is view-only until Editor on People.
- Claim, host-secret Owner rewrite, library etags/TTL, hub Assets hidden, guest visit UUID, unused Recents preview, honest Save copy.

**Sentinel on `1d63c52`:** WARN — claim and leftover host were the remaining launch blockers in that area; both now have code landings in this wave.

**AFK decisions (do not reopen unless blocked):**

- No live pointer cursors: not for classroom launch. Leave code unchanged. Docs already say live cursors are not v1.
- Share-code format: lengthen to eight characters in `A1B2C3D4` form (still typeable). Rate-limit join to stop enumeration; school NAT may share one IP, so per-IP allow a class burst (about 60/min) and keep per-code failed lookups tighter.

---

## Connect trusts client userId

### Issue

Anyone who knows a saved board’s UUID can become **Owner** without a Clerk Google session. Unauthenticated `GET /api/whiteboard/boards/{uuid}/meta` publishes `cloudOwnerKey` (`google:{accountId}`). The client then puts that account id on the WebSocket as `userId`.

### Research

`WhiteboardBoard.handleConnect` reads `userId` from the query string (`sanitizeUserId`) and passes it to `resolveConnectRole`. If `cloudOwnerKey === google:${userId}`, the socket is **Owner**. `buildWhiteboardConnectUrl` in `src/lib/whiteboard-sync.ts` always sets `userId` when the client supplies one. `handleMetaHttp` GET calls `readPublicMeta()`, which returns `cloudOwnerKey` to every caller. Clerk is used for library and `google:*` asset writes, not for `/api/whiteboard/connect/{uuid}`.

### Found / suspected bug(s)

Found. Role on connect is a client-controlled string compared to a public Owner key. Board UUID plus GET meta is enough to impersonate the Google Owner (and to pick up stored Manager/Editor roles for any guessed `userId`).

### Fixes

Verify Clerk on connect for Google identity. Never trust query `userId` as a Google account id. Keep guest `userId` as a non-Google hint only. Stop putting `cloudOwnerKey` on unauthenticated GET meta (return it only to the verified Owner/host).

### Tasks

- [x] In `src/worker/WhiteboardBoard.ts`, change `handleConnect` / `resolveConnectRole` so a Google Owner (or stored Google Manager/Editor) role is assigned only from a verified Clerk session, not from query `userId`.
- [x] Reuse `requireClerkWhiteboardAuth` in `src/worker/clerkAuth.ts` (or an equivalent connect-time check). Pass the session as a header or first WS message, not as a query string that can hit logs.
- [x] Keep guest `userId` as a non-Google hint only. `sanitizeUserId` must not be enough to match `google:{accountId}`.
- [x] Change `readPublicMeta` / `handleMetaHttp` GET so unauthenticated callers do not receive `cloudOwnerKey`. Return that key only to the verified Owner or host.
- [x] Update `buildWhiteboardConnectUrl` in `src/lib/whiteboard-sync.ts` and the connect call in `src/components/WhiteboardCanvas.tsx` so the client no longer treats a supplied `userId` as Google identity.
- [x] Grep for `cloudOwnerKey` on GET meta and for `userId` on the connect URL. Confirm a guessed `google:` id cannot become Owner.
- [x] Run `npm run build`.
- [x] Manual: open a saved board UUID in a signed-out private tab, GET meta, and confirm the socket is not Owner.

---

## Claim moves temp assets to any Clerk account

### Issue

`POST /api/whiteboard/assets/claim` accepts any signed-in user. The stock client auto-claims when `savedToLibrary` is true: it copies `temp:{boardId}` objects under the caller’s `google:` prefix and deletes the temp objects. A student who signs in on a scratch board (or any board whose temp prefix still exists) can steal the media.

### Research

`assetRoutes.ts` `handleClaim` calls `requireClerkWhiteboardAuth`, then `moveTempPrefixToOwner(env, boardId, destOwnerKey)` with **that caller’s** `ownerKey`. It does not compare to the Durable Object’s `meta:cloudOwnerKey` or require a host secret. `claimAndRewrite` in `src/lib/whiteboard-excalidraw-files.ts` runs when GET meta says `savedToLibrary` and `cloudOwnerKey` starts with `google:`; if `isSignedIn()`, it calls `claimTempCanvasAssets(boardId)`.

### Found / suspected bug(s)

Found. Claim is “any Clerk session + a board UUID,” not “the board’s Owner.” Combined with public meta, this is a media-theft path.

### Fixes

Claim only when the Clerk `ownerKey` matches the DO `cloudOwnerKey`, or when the request presents a valid host secret for that board. On the client, call claim only when the signed-in identity matches the board Owner.

### Tasks

- [x] In `src/worker/assetRoutes.ts` `handleClaim`, after `requireClerkWhiteboardAuth`, load the board’s `meta:cloudOwnerKey` and refuse the move unless the Clerk `ownerKey` matches, or the request presents a valid host secret for that board.
- [x] Do not call `moveTempPrefixToOwner` with an arbitrary caller’s `ownerKey`.
- [x] In `src/lib/whiteboard-excalidraw-files.ts` `claimAndRewrite` / `claimTempCanvasAssets`, skip the POST unless the signed-in identity is the board Owner.
- [x] Coordinate with Connect trusts client userId so GET meta is not enough to pick a destination prefix.
- [x] Grep for `handleClaim`, `claimTempCanvasAssets`, and `moveTempPrefixToOwner`. Confirm a second signed-in account cannot drain `temp:{boardId}`.
- [x] Run `npm run build`.
- [ ] Manual: student signs in on a scratch or saved board they do not own; temp media must stay put.

---

## Share codes are short and unmetered

### Issue

Share codes are four characters in `A1B2` form (26×10×26×10 ≈ 6760 values). `GET /api/whiteboard/join/{code}` is unauthenticated and unmetered. Closing a code does not revoke the board UUID; anyone who already has `/board/{uuid}` still connects.

### Research

`src/worker/shareCode.ts` documents format `A1B2`, TTL 12h, KV key `code:{A1B2}`. `codeRoutes.ts` `handleJoin` looks up KV and returns `{ id: boardId }` with no auth and no rate limit. Mint/rotate is rate-limited on the DO (`assertMintAllowed`); join is not. Hub copy in `whiteboard-hub.ts` tells people a code looks like `A1B2`.

### Found / suspected bug(s)

Found. While a class is in session with an Open code, the space is enumerable. UUID access is a durable capability independent of Open/Closed.

### Fixes

Use longer codes. Rate-limit join (per IP and per code). Treat codes as secrets in UI copy (do not project them on a board the hallway can photograph if that is the class model). Keep Closed from minting new joins; document that UUID links still work until roles/auth on connect exist (see Connect trusts client userId).

### Tasks

- [x] Lengthen the generator in `src/worker/shareCode.ts` (`sampleShareCode` / `normalizeShareCode`) and update KV key handling. Keep TTL 12h unless this issue also changes TTL.
- [x] Rate-limit `handleJoin` in `src/worker/codeRoutes.ts` per IP and per code. Leave `assertMintAllowed` on mint/rotate as a separate limit.
- [x] Update hub copy in `src/scripts/whiteboard-hub.ts` (and `docs/whiteboard/share-codes.md`) so codes are treated as secrets, not an `A1B2` example to project in the hallway.
- [x] Keep Closed from minting new joins. Document that `/board/{uuid}` still works after Closed until connect auth exists.
- [x] Grep for `A1B2` and `sampleShareCode`. Confirm join is no longer a four-character unmetered lookup.
- [x] Run `npm run build`.
- [ ] Manual: Closed code cannot be joined; an existing UUID still opens the board.

---

## Recents can show Saved while 24h TTL is armed

### Issue

The hub Recents/Library card can look **Saved** while the Durable Object still has the unsaved 24h alarm. After TTL, `expireUnsavedBoard` deletes the scene if `meta:savedToLibrary` is still false. Teachers think the board is in Google library; the canvas can still vanish.

### Research

`libraryRoutes.ts` `tryMarkSavedToLibrary` PATCHes DO meta with `savedToLibrary: true` and `cloudOwnerKey`, then **ignores the response**. PATCH 403s until the creating browser’s first WebSocket stores `meta:hostSecretHash`. `expireUnsavedBoard` in `WhiteboardBoard.ts` wipes `excalidraw_scene` when the alarm fires and saved is false. After `setBoardTitleActive`, `whiteboard-menu.ts` shows “Saved to your Google library.” Index PUT to `library/{owner}/boards.json` succeeds independently of the TTL lift.

### Found / suspected bug(s)

Found. Index write and TTL lift are decoupled. UI claims success from the index write.

### Fixes

Do not treat save as success until DO `savedToLibrary` is true. Do not list or create Recents entries as durable until the TTL is lifted. Fail the library PUT (or retry until) PATCH succeeds; surface an error instead of “Saved to your Google library.”

### Tasks

- [x] In `src/worker/libraryRoutes.ts` `tryMarkSavedToLibrary`, do not ignore the PATCH response. Fail or retry the library PUT until DO `savedToLibrary` is true.
- [x] Do not create or keep a Recents/Library row as durable while the unsaved 24h alarm is still armed.
- [x] In `src/scripts/whiteboard-menu.ts` / `src/scripts/whiteboard-library.ts` `setBoardTitleActive`, show “Saved to your Google library.” only after the DO flag is true. Surface an error if PATCH 403s or fails.
- [x] Confirm `expireUnsavedBoard` in `src/worker/WhiteboardBoard.ts` still wipes only when `savedToLibrary` is false — and that a successful save lifts that path.
- [x] Grep for `tryMarkSavedToLibrary`, `savedToLibrary`, and the Saved copy. Confirm the index write cannot succeed while TTL remains armed.
- [x] Run `npm run build`.
- [ ] Manual: Save a new board; Recents says Saved only when a later reload still has the scene after 24h would have fired.

---

## Scene persist can drop work

### Issue

The live room can keep drawing while SQLite never stores the scene. Reloads and new joiners lose work. There is no WebSocket error when persist fails.

### Research

`MAX_SCENE_JSON_BYTES` is 2_000_000 in `src/lib/whiteboard-sync.ts`. `persistScene` in `WhiteboardBoard.ts` **returns silently** if `database` or `liveJson` is over that cap. `applySceneUpdate` still `broadcastScene` afterward. Both `database_json` and `live_json` live in **one** SQLite row (`excalidraw_scene`); Cloudflare’s per-row / per-value limit can be hit even when each column is under 2MB. `parseSceneElements` stops at `MAX_SCENE_ELEMENTS` (4000) with no error. Persist JSON is built with `serializeAsJSON(..., {}, "database")` so `files` is always `{}`.

### Found / suspected bug(s)

Found. Oversize persist is a silent no-op; peers still see the stroke. Dual JSON columns in one row can fail the platform row limit after the per-column check passed. The 4000-element trim is silent.

### Fixes

Store one JSON column or split live vs database into two tables/rows. If persist throws or exceeds limits, send a WS error and **do not** broadcast that update. Tell Editors the board is too large; do not drop the last minute of work quietly.

### Tasks

- [ ] In `src/worker/WhiteboardBoard.ts` `persistScene`, stop returning silently on oversize or SQLite failure. If persist throws or exceeds limits, send a WebSocket error and do not `broadcastScene` that update.
- [ ] Change `excalidraw_scene` so `database_json` and `live_json` are not two large values in one row (one JSON column, or two tables/rows).
- [ ] In `parseSceneElements` (`src/lib/whiteboard-sync.ts`), do not trim at `MAX_SCENE_ELEMENTS` (4000) without telling the Editor.
- [ ] Surface a canvas/toast error when the board is too large so Editors know the last minute was not stored. Keep `serializeAsJSON(..., {}, "database")` (`files: {}`) unless a separate media issue changes that.
- [ ] Grep for `persistScene`, `MAX_SCENE_JSON_BYTES`, and `MAX_SCENE_ELEMENTS`. Confirm a failed persist cannot broadcast.
- [ ] Run `npm run build`.
- [ ] Manual: after a persist failure (or a forced oversize), a reload must not look successful while SQLite dropped the stroke.

---

## Student Editors cannot upload media on saved boards

### Issue

On a saved `google:` board, PUT `/api/whiteboard/assets/{ownerKey}/{assetId}` requires a Clerk session whose `ownerKey` matches. Student **Editors** get 403. Images fail quietly; the scene still references `fileId`s that were never stored. After reload, pictures are gone.

### Research

`assertGoogleOwnerWrite` in `assetRoutes.ts` requires `authResult.auth.ownerKey === ownerKey`. `ownerKeyForBoardMeta` uses the Owner’s `google:` key once `savedToLibrary` is true. `putImageFile` in `whiteboard-excalidraw-files.ts` PUTs there; `syncFiles` **swallows** the error (retry map only). `serializeAsJSON` is called with `files: {}`, so binary data is not in the DO scene. Video insert shows a toast; images do not.

### Found / suspected bug(s)

Found. Durable media on a saved board is Owner-account-only. Editors can draw image elements that never land in R2.

### Fixes

Allow a connected **Editor** (and Owner/Manager) to PUT under that board’s asset prefix using the WS session token and/or host proof, not the Owner’s Clerk `ownerKey`. Keep Viewers read-only. Surface upload failures in the canvas.

### Tasks

- [x] In `src/worker/assetRoutes.ts`, stop using Owner-only `assertGoogleOwnerWrite` as the sole gate for canvas PUT on a saved `google:` board.
- [x] Allow Owner, Manager, and Editor to PUT under that board’s asset prefix when they present a live WS session token (`X-Board-Session` / `X-Board-Auth`) and/or host proof. Keep Viewers read-only.
- [x] In `src/lib/whiteboard-excalidraw-files.ts`, stop swallowing PUT failures in `syncFiles`. Surface image upload errors in the canvas the same way video insert already toasts.
- [x] Keep `serializeAsJSON` `files: {}` (binaries stay in R2). After reload, images that got 403 must not remain as dangling `fileId`s without feedback.
- [x] Grep for `assertGoogleOwnerWrite`, `putImageFile`, and `syncFiles`. Confirm an Editor session can PUT; a Viewer cannot.
- [x] Run `npm run build`.
- [ ] Manual: student Editor pastes an image on a saved board, reloads, and the picture is still there.

---

## Follow Me dies after Durable Object hibernation

### Issue

**Follow Me** (forced camera lock) and voluntary **Follow** stop working after the Durable Object hibernates. Students no longer track the teacher until someone refreshes.

### Research

The constructor calls `setWebSocketAutoResponse` so `{"type":"ping"}` is answered with pong **without waking JS**. `voluntaryFollow` is an in-memory `Map` (comment: clients resubscribe). `relaySceneBounds` uses `this.forceFollowCache ?? this.emptyForceFollow()` and **never** calls `getForceFollowState()`, so a wake with a null cache treats Follow Me as off. `hydrateSockets` restores attachments, not follow maps. Connect sends `wb:hello` + `broadcastForceFollow` only for the **new** socket, not for already-open tabs that never disconnected.

### Found / suspected bug(s)

Found. Auto-response pings keep sockets “alive” while the isolate sleeps. On the next `wb:sceneBounds`, force-follow is empty and voluntary follow is gone. Clients do not resend `wb:follow` on an already-open WebSocket.

### Fixes

In `relaySceneBounds`, load follow state with `getForceFollowState()`. Persist voluntary follow on the socket attachment (or storage). On wake / `webSocketMessage` after hydrate, resend `wb:follow` handling from attachments and rebroadcast `wb:forceFollow`. Have the client resubscribe `wb:follow` whenever the socket is open after a gap.

### Tasks

- [ ] In `src/worker/WhiteboardBoard.ts` `relaySceneBounds`, load force-follow with `getForceFollowState()` instead of `this.forceFollowCache ?? this.emptyForceFollow()`.
- [ ] Persist voluntary follow on the socket attachment or in storage so a hibernation wake does not empty `voluntaryFollow`.
- [ ] After `hydrateSockets` / on `webSocketMessage` following a wake, restore follow from attachments and rebroadcast `wb:forceFollow` to already-open tabs, not only to a newly connected socket.
- [ ] In `src/components/WhiteboardCanvas.tsx` / `src/lib/whiteboard-excalidraw-roles.ts`, resubscribe `wb:follow` whenever the socket is open after a gap, even if the tab never disconnected.
- [ ] Do not treat this as the Following overlay bug (stock FollowMode chrome). That is Following overlay is glitchy.
- [ ] Grep for `relaySceneBounds`, `forceFollowCache`, `voluntaryFollow`, and `setWebSocketAutoResponse`. Confirm a wake cannot treat Follow Me as off while sockets stayed open.
- [ ] Run `npm run build`.
- [ ] Manual: turn on Follow Me, wait for DO hibernation (ping/pong without JS), confirm students still track without a refresh.

---

## Board title is library-index-only

### Issue

Guests and private tabs show **Untitled board** even when the Owner named the board. User reproduced: Owner title “Summer Checklist 2026-2027”; three private Lucky Finch Viewer tabs stayed Untitled.

### Research

Save writes `library/{owner}/boards.json` only (`upsertCloudBoard` / `setBoardTitleActive`). `wb:hello` has role, `savedToLibrary`, owner hook, `authToken` — not title. The manage-panel title is applied from the signed-in user’s index or scratch `sessionStorage`, not from the Durable Object.

### Found / suspected bug(s)

Found. The live room has no `meta:title`. Private tabs have no Owner library, so they cannot read the name.

### Fixes

Store `meta:title` on the Durable Object. Include it on `wb:hello` and broadcast on change. The board page should set the header and tab title from hello, not from Recents.

### Tasks

- [x] Store `meta:title` on the Durable Object in `src/worker/WhiteboardBoard.ts`. Include it on `wb:hello` and broadcast when it changes.
- [x] Add Owner/Manager PATCH for title (session token or host proof). This is the live-room source of truth; Recents is only an index.
- [x] In `src/scripts/whiteboard-menu.ts` (and the board header / tab title), set the name from `wb:hello`, not from the signed-in user’s `boards.json` or scratch `sessionStorage`.
- [x] Keep `setBoardTitleActive` / `upsertCloudBoard` as an optional Owner-index mirror, not the only write.
- [x] Grep for `wb:hello` and `setBoardTitleActive`. Confirm private-tab Viewers receive the title without the Owner library.
- [x] Run `npm run build`.
- [ ] Manual: Owner names the board “Summer Checklist 2026-2027”; three private Viewer tabs show that name without a Recents entry.

---

## Name this whiteboard and Save shown to everyone

### Issue

Every role sees **Name this whiteboard** and **Save**. A Viewer can type a name and click Save. That does not overwrite the Owner’s library today (unsigned Save is `sessionStorage` only), but it trains the wrong permission model. Once title lives on the Durable Object (see Board title is library-index-only), an ungated Save becomes a classroom bug.

### Research

`whiteboard-menu.ts` always shows `[data-wb-manage-name]`. Submit calls `setBoardTitleActive`. Unsigned: `rememberScratchTitle`. Signed-in without an index row and without host secret: throw. Follow Me is already gated to Owner/Manager (`canForceFollow`); rename is not. There is no DO title PATCH yet; library PUT is per Clerk account.

### Found / suspected bug(s)

Found for UI. Server does not yet have a title PATCH to 403; Viewer Save cannot clobber Owner `boards.json`. User reproduced the visible rename field as a Viewer.

### Fixes

Gate the name field and Save to **Owner** and **Manager**. When title is on the DO, reject title PATCH from Viewer and Editor (403). Keep Viewer/Editor from seeing a fake success state.

### Tasks

- [x] In `src/scripts/whiteboard-menu.ts`, hide `[data-wb-manage-name]` (the Header.astro form) unless the live role is Owner or Manager, matching `canForceFollow`.
- [x] Do not let Viewer or Editor submit Save or see a success state. Unsigned scratch rename may stay on `rememberScratchTitle` for the creating host only.
- [x] When a DO title PATCH exists (Board title is library-index-only), reject Viewer and Editor with 403.
- [x] Grep for `data-wb-manage-name` and `setBoardTitleActive`. Confirm Viewer markup does not include a working Save.
- [x] Run `npm run build`.
- [ ] Manual: as a Viewer, **Name this whiteboard** and **Save** are not available.

---

## Manager rename writes the wrong library

### Issue

A **Manager** who clicks Save writes **that account’s** `library/{manager}/boards.json`. The Owner’s Recents/Library title does not change. The live board name (once on the DO) would still be missing unless PATCH goes to the room.

### Research

`setBoardTitleActive` → `upsertEntryActive` → `upsertCloudBoard` authenticated as the current Clerk user. There is no write to the Owner’s index and no DO title.

### Found / suspected bug(s)

Found. Rename is “upsert my index,” not “rename this board.”

### Fixes

Owner/Manager Save should PATCH `meta:title` on the board (with session token or host proof) and broadcast. Optionally mirror into the Owner’s `boards.json`. Do not treat Manager Recents as the source of truth for the class title.

### Tasks

- [x] Change `setBoardTitleActive` in `src/scripts/whiteboard-library.ts` so Owner/Manager Save PATCHes `meta:title` on the board (session token or host proof) and relies on the DO broadcast, not `upsertCloudBoard` as the Manager.
- [x] Do not write `library/{manager}/boards.json` as the class title. Optionally mirror into the Owner’s `boards.json` only.
- [x] If `meta:title` is not on the DO yet, add the PATCH here or land Board title is library-index-only first — do not ship Manager Save as an index upsert.
- [x] Grep for `upsertCloudBoard` / `setBoardTitleActive`. Confirm a Manager Save does not create a divergent Recents title on the Manager account as source of truth.
- [x] Run `npm run build`.
- [ ] Manual: Manager renames; Owner Recents and guest tabs show the same name; Manager Recents is not the live title.

---

## Share Open Closed rotate not role-gated

### Issue

Anyone who can load `/board/{uuid}` can Open, Closed, rotate, or copy the class code — including a **Viewer**. A student can close the code mid-lesson or mint a new one.

### Research

`handleCodeHttp` GET/POST/DELETE has no Owner/Manager check (unlike `handleParticipantPatch` / `handleForceFollowPatch`). Client `src/lib/whiteboard-codes.ts` fetches those routes with no session token. Manage-panel share controls are not hidden by role. UUID remains a capability after Closed.

### Found / suspected bug(s)

Found. Share administration is unauthenticated on the DO once you have the UUID.

### Fixes

Require Owner/Manager proof (Clerk + `cloudOwnerKey`, or host secret, or `authToken` with role) on code GET of the secret value, POST, and DELETE. Hide share tools from Editor/Viewer. Copy can stay for Owner/Manager only.

### Tasks

- [x] In `src/worker/WhiteboardBoard.ts` `handleCodeHttp`, require Owner/Manager proof (Clerk + `cloudOwnerKey`, host secret, or `authToken` with role) on GET of the secret value, POST, and DELETE. Mirror `handleParticipantPatch` / `handleForceFollowPatch`.
- [x] Update `src/lib/whiteboard-codes.ts` to send the session token (or host proof) on those fetches.
- [x] Hide Open / Closed / rotate / copy in the manage panel unless the live role is Owner or Manager.
- [x] Closed still stops new joins; UUID access remains a separate capability (see Connect trusts client userId).
- [x] Grep for `handleCodeHttp` and whiteboard-codes fetches. Confirm a Viewer GET/POST/DELETE is 403.
- [x] Run `npm run build`.
- [ ] Manual: Viewer cannot close or mint a code mid-lesson; Owner still can.

---

## Temp and local asset writes have no auth

### Issue

`PUT` and `DELETE` under `temp:*` and `local:*` do not require Clerk, host secret, or a can-edit session token. File ids appear in the scene JSON. Anyone who sees an asset URL can overwrite or delete that object.

### Research

`assetRoutes.ts` header comment: `temp:*` / `local:*` keep capability-URL behavior. `assertGoogleOwnerWrite` returns immediately unless `ownerKey` starts with `google:`. Scene elements carry `fileId` (and video `playerPath` includes `owner` + `id`).

### Found / suspected bug(s)

Found. Capability URLs are guessable once ids leak in the collab scene (every connected client has them).

### Fixes

Require host secret or a can-edit session token for `temp:*` / `local:*` writes. Keep GET for connected players if needed, but do not leave PUT/DELETE open.

### Tasks

- [x] In `src/worker/assetRoutes.ts`, require host secret or a can-edit session token for PUT/DELETE when `ownerKey` is `temp:*` or `local:*`. Do not return early from `assertGoogleOwnerWrite` in a way that leaves those prefixes open.
- [x] Keep GET available for connected players if playback still needs it. Do not leave PUT/DELETE as capability URLs.
- [x] Update the `assetRoutes.ts` header comment so it no longer describes unauthenticated capability-URL writes.
- [x] Grep for `isTempOwnerKey`, `local:`, and PUT/DELETE handlers. Confirm a guessed `fileId` from the scene cannot overwrite the object.
- [x] Run `npm run build`.
- [x] Manual: Viewer (or a signed-out tab that only has the asset URL) cannot PUT/DELETE temp media.

---

## Host secret still rewrites Owner after Save

### Issue

The creating browser stores the host secret in `localStorage` and still sends it on the WebSocket query string after Save. On a shared Chromebook, the next student with that leftover secret can still prove **host** and PATCH `cloudOwnerKey` to a new Google account.

### Research

`persistHostSecret` / `getHostSecret` in `whiteboard-library.ts`. `WhiteboardCanvas` passes `hostSecret: getHostSecret(boardId)` into `buildWhiteboardConnectUrl`. `handleMetaHttp` PATCH accepts any valid host secret and can set `cloudOwnerKey`. `resolveHost` keeps the hash for the life of the DO; Save does not rotate or drop it.

### Found / suspected bug(s)

Found. Host secret is a durable Owner-equivalent on that device after the board is a Google library item.

### Fixes

After a successful Google claim, stop sending host secret on connect; drop it from `localStorage` or scope it so it cannot rewrite `cloudOwnerKey`. Reject cloud-owner PATCH unless Clerk matches the existing `google:` owner (or a one-time claim). Do not leave host proof in the WS URL (query strings hit logs).

### Tasks

- [x] After a successful Google claim / `savedToLibrary`, stop sending `hostSecret` from `src/components/WhiteboardCanvas.tsx` into `buildWhiteboardConnectUrl`. Drop or scope `localStorage` via `persistHostSecret` / `getHostSecret` in `src/scripts/whiteboard-library.ts`.
- [x] In `handleMetaHttp` PATCH, reject `cloudOwnerKey` changes unless Clerk matches the existing `google:` owner (or a one-time claim). A leftover host secret must not rewrite Owner.
- [x] Move remaining host proof off the WebSocket query string (query strings hit logs). Prefer header or first-message proof for unsaved scratch boards.
- [x] Grep for `getHostSecret(boardId)` on connect and for PATCH of `cloudOwnerKey`. Confirm Save does not leave a durable host Owner-equivalent on the device.
- [x] Run `npm run build`.
- [ ] Manual: shared Chromebook, next student, leftover secret cannot steal Owner on a saved board.

---

## Unauthenticated asset GET and SVG XSS

### Issue

Asset GET is unauthenticated. CORS reflects **any** `Origin`. SVG is allowed (`image/svg+xml`) and served with that content type, so a scripted SVG can run in the document and read `localStorage` host secrets.

### Research

`corsHeaders` in `assetRoutes.ts` sets `Access-Control-Allow-Origin` to the request Origin. `ALLOWED_MIME` includes `image/svg+xml`. GET uses `object.writeHttpMetadata` without forcing `Content-Disposition: attachment` or a safer type. Host secrets live in `localStorage` (`scsfoxchase.whiteboard.host.*`).

### Found / suspected bug(s)

Found. Cross-origin GET plus inline SVG is an XSS path to device-local Owner secrets.

### Fixes

Serve SVG as attachment with `X-Content-Type-Options: nosniff` (or sandbox/disallow SVG). Restrict CORS to the site origin (`scsfoxchase.tech`). Prefer not to execute SVG as `image/svg+xml` in a navigable response.

### Tasks

- [x] In `src/worker/assetRoutes.ts` GET, serve SVG as `Content-Disposition: attachment` with `X-Content-Type-Options: nosniff`, or disallow `image/svg+xml` in `ALLOWED_MIME`. Do not execute SVG as a navigable `image/svg+xml` response.
- [x] Restrict `corsHeaders` to the site origin (`scsfoxchase.tech`, plus local dev origin). Do not reflect any `Origin`.
- [x] Keep host secrets (`scsfoxchase.whiteboard.host.*`) out of reach of a cross-origin scripted SVG.
- [x] Grep for `ALLOWED_MIME`, `corsHeaders`, and `writeHttpMetadata`. Confirm SVG is not served inline with open CORS.
- [x] Run `npm run build`.
- [x] Manual: a cross-origin page cannot GET an SVG asset and run script against `localStorage`.

---

## Video player URLs stay on temp after claim

### Issue

After claim copies objects to `google:` and **deletes** `temp:`, embeddable video links can still point at `/whiteboard-player?owner=temp:{boardId}&id=…`. Playback 404s.

### Research

`claimAndRewrite` rewrites `embeddable` links from `tempOwnerKey(boardId)` to `googleOwner` only on clients that run that effect (signed-in, meta already saved). Other tabs keep old links. Images use `fileId` + `ownerKeysToTry` (temp and google); videos bake the prefix into the URL.

### Found / suspected bug(s)

Found. Claim deletes the only prefix the old player URL can fetch. Rewrite is best-effort and local to one client.

### Fixes

Rewrite player URLs in the **persisted scene** on the DO (or always resolve player GET through board meta). Keep temp objects until all references are rewritten. Hydrate video the same way as images (try google then temp).

### Tasks

- [ ] Rewrite embeddable `/whiteboard-player` URLs in the persisted scene on the Durable Object when claim moves `temp:` → `google:`, or resolve player GET through board meta so the prefix is not baked into the URL.
- [ ] Do not delete `temp:` objects until references are rewritten (coordinate with Claim moves temp assets to any Clerk account and Temp media expiry not tied to savedToLibrary).
- [ ] In `src/lib/whiteboard-excalidraw-files.ts`, hydrate video like images (`fileId` + `ownerKeysToTry`: google then temp). Stop relying on `claimAndRewrite` on a single signed-in tab.
- [ ] Grep for `whiteboard-player`, `claimAndRewrite`, and `tempOwnerKey`. Confirm other tabs do not keep `owner=temp:` after claim.
- [ ] Run `npm run build`.
- [ ] Manual: insert video on scratch, Save/claim, reload a second tab; playback must not 404.

---

## Temp media expiry not tied to savedToLibrary

### Issue

R2 `temp:*` objects expire on a 24h upload clock even if the board was later saved but claim never moved them. Saved boards can lose images/video that still point at temp.

### Research

`isExpiredUpload` uses `UNSAVED_BOARD_TTL_MS` from object `uploaded` time, not DO `savedToLibrary`. PUT on temp schedules `expireTempR2Objects`. DO `expireUnsavedBoard` also deletes the temp prefix when the **board** TTL fires — a different clock.

### Found / suspected bug(s)

Found. Two 24h timers (object age vs board unsaved alarm) and claim can disagree.

### Fixes

Do not expire `temp:{boardId}` while the board is `savedToLibrary` and still referenced, or only expire after a successful move to `google:`. Tie prefix cleanup to the same flag as `expireUnsavedBoard`.

### Tasks

- [ ] In `src/worker/assetRoutes.ts`, stop expiring `temp:{boardId}` from `isExpiredUpload` / `expireTempR2Objects` while the board is `savedToLibrary` and objects are still referenced.
- [ ] Expire temp objects only after a successful move to `google:`, or tie prefix cleanup to the same `savedToLibrary` flag as `expireUnsavedBoard` in `WhiteboardBoard.ts`.
- [ ] Do not leave two independent 24h clocks (object `uploaded` vs board unsaved alarm) that can delete media on a saved board.
- [ ] Grep for `UNSAVED_BOARD_TTL_MS`, `isExpiredUpload`, and `expireTempR2Objects`. Confirm a saved board’s temp media is not deleted on upload age alone.
- [ ] Run `npm run build`.
- [ ] Manual: save a board without claim completing; images/video that still point at temp survive the 24h upload clock.

---

## Last strokes vanish on tab close

### Issue

The last ~1s of drawing, or work done while the WebSocket is down, never reaches the Durable Object if the tab closes. Teachers think **Save** persisted the canvas; Save only names the index.

### Research

`SCENE_FLUSH_MS` is 1000. `handleChange` in `WhiteboardCanvas.tsx` debounces `sendSceneUpdate`. Unmount `clearTimeout`s the flush timer **without** flushing `pendingFlushRef`. There is no `beforeunload` / `pagehide` handler. Save is `setBoardTitleActive` (library title), not `persistScene`.

### Found / suspected bug(s)

Found. Debounce + unmount drop + no unload flush. Product copy (“Saved to your Google library”) does not mean the scene was checkpointed.

### Fixes

Flush pending strokes on `pagehide`/`visibilitychange` and before WS close. Do not clear the timer without sending. Keep Save copy honest: index vs scene persist. Optionally persist immediately on disconnect.

### Tasks

- [x] In `src/components/WhiteboardCanvas.tsx`, flush `pendingFlushRef` on `pagehide` / `visibilitychange` and before WebSocket close. Do not `clearTimeout` the `SCENE_FLUSH_MS` (1000) timer on unmount without sending.
- [x] Optionally persist immediately on disconnect so work done while the socket is down is not lost.
- [x] Keep Save copy honest in `whiteboard-menu.ts`: “Saved to your Google library.” is the index, not `persistScene`. Do not imply Save checkpointed the canvas.
- [x] Grep for `SCENE_FLUSH_MS`, `pendingFlushRef`, and unmount cleanup. Confirm a close cannot drop the last debounce window.
- [x] Run `npm run build`.
- [ ] Manual: draw, close the tab within ~1s, reopen; the last stroke is on the board. Save without drawing does not claim the scene was stored.

---

## Library JSON read-modify-write has no etag

### Issue

`boards.json` and `assets.json` are whole-file read-modify-write with no etag / If-Match. Two tabs or a Manager plus Owner can lose an entry.

### Research

`libraryRoutes.ts` `readJsonArray` then `writeJsonArray` with no `etag` from R2 `put`. Concurrent PUT of Recents (`lastAccessedAt`) vs rename is a lost-update.

### Found / suspected bug(s)

Found. Classic RMW without conditional write.

### Fixes

Use R2 etags (If-Match) and retry. Or per-board objects instead of one array file.

### Tasks

- [x] In `src/worker/libraryRoutes.ts`, add R2 etags on `readJsonArray` / `writeJsonArray` (`If-Match`) and retry on conflict for both `boards.json` and `assets.json`.
- [x] Cover concurrent Recents `lastAccessedAt` vs rename so one PUT cannot drop the other entry.
- [x] Alternative allowed by the fix: per-board objects instead of one array file — pick one approach, do not leave unconditioned RMW.
- [x] Grep for `writeJsonArray` and R2 `put`. Confirm there is no unconditioned whole-file write.
- [x] Run `npm run build`.
- [ ] Manual or two-tab check: Owner rename and Recents touch at the same time; both entries survive.

---

## Share-code joiners default to Viewer

### Issue

Students who join with a class code land as **Viewer**. They cannot draw unless an Owner/Manager promotes each person in People. There is no class-wide Editor switch.

### Research

`resolveConnectRole` returns `viewer` unless `userId` matches Google Owner, scratch host secret (unsaved), or a stored per-user role. Join only returns a UUID; it does not set role. Docs describe default Viewer as intentional; classroom use needs a one-click “everyone who joins this code can edit.”

### Found / suspected bug(s)

Found as product default, not a logic accident. Blocks a normal lesson without per-student role clicks.

### Fixes

Add an Owner/Manager setting: joiners of the active code get **Editor** (or a “class can edit” flag on the DO). Keep default Viewer for public UUID links if that remains the safety model. Train teachers either way (see Guests default Viewer is also a training issue).

### Tasks

- [ ] Add an Owner/Manager setting on the Durable Object (joiners of the active code get Editor, or a “class can edit” flag). Wire it through `resolveConnectRole` in `src/worker/WhiteboardBoard.ts`.
- [ ] Keep default Viewer for public UUID links if that remains the safety model. Join still returns a UUID; role is decided on connect.
- [ ] Expose the setting in the manage panel to Owner/Manager only (same gate as Follow Me / share admin once those are role-gated).
- [ ] Do not fold training copy into this change; that is Guests default Viewer is also a training issue.
- [ ] Grep for `resolveConnectRole` and join handling. Confirm a code joiner can land as Editor when the flag is on, and Viewer when it is off.
- [ ] Run `npm run build`.
- [ ] Manual: teacher turns on class-can-edit, students join with the code, they can draw without per-person People clicks.

---

## Following overlay is glitchy

### Issue

The **Following XX** badge and green canvas outline are glitchy. They sometimes need a refresh. After an Owner/Manager changes a role, they can disappear and not return. Camera lock can still work while that chrome is gone.

### Research

Two overlays exist. The reported chrome is stock Excalidraw FollowMode (`.follow-mode`, `.follow-mode__badge`) driven by `appState.userToFollow`, not our lock sheet (`forceFollowLocked` in `WhiteboardCanvas.tsx`). Role PATCH does not reconnect: `WhiteboardBoard.applyRoleToUser` sends `wb:role` to that socket and `broadcastParticipants` to everyone. Files: `src/lib/whiteboard-excalidraw-roles.ts`, `src/components/WhiteboardCanvas.tsx`, `src/worker/participantRoutes.ts`, `WhiteboardBoard.ts`, Excalidraw 0.18.1 FollowMode (`node_modules`).

`WhiteboardCanvas` passes `collaborators={roles.collaborators}`, but Excalidraw 0.18.1 `collaborators` is SceneData only; `ExcalidrawBase` drops the React prop, so the App collaborators Map stays empty. `componentDidUpdate` treats `userToFollow && !collaborators.has(socketId)` as `hasFollowedPersonLeft` and calls `maybeUnfollowRemoteUser`, which unmounts FollowMode. The repo never calls `updateScene({ collaborators })`. Role PATCH rebuilds the people Map, busts the memo, and that didUpdate unfollow runs; `reassertFollow()` in the WebSocket handler is too early (before React paint). The `onUserFollow` React prop is unused in 0.18.1; the real API is `api.onUserFollow(cb)`. Optional gap: `applyUserToFollow` returns if `!api` with no queue.

### Found / suspected bug(s)

Found, confirmed. Separate from Follow Me dies after Durable Object hibernation (in-memory `voluntaryFollow` / `forceFollowCache` on the Durable Object) — same classroom symptom possible, different layer.

### Fixes

On every `wb:participants`, call `api.updateScene({ collaborators: map, captureUpdate: NEVER })` keyed by session ids matching `userToFollow.socketId`. In `handleApi`, subscribe `api.onUserFollow(onUserFollow)` and unsubscribe on teardown; do not rely on the React prop. Reassert follow after paint (`useEffect` / rAF), not only in the WS handler. Queue follow if the API is not ready. In `applyRemoteBounds`, always write `userToFollow` even when `alreadyFitted`. Optional: do not cover FollowMode with the z-index 6 lock sheet.

### Tasks

- [x] In `src/lib/whiteboard-excalidraw-roles.ts`, on every `wb:participants`, call `api.updateScene({ collaborators: map, captureUpdate: NEVER })` with session ids that match `userToFollow.socketId`. The repo must actually populate Excalidraw’s App collaborators Map.
- [x] In `handleApi` (`WhiteboardCanvas.tsx` / roles hook), subscribe `api.onUserFollow(onUserFollow)` and unsubscribe on teardown. Remove reliance on the unused React `onUserFollow` prop.
- [x] Reassert follow after paint (`useEffect` / rAF), not only in the WebSocket handler. Queue `applyUserToFollow` if `!api`.
- [x] In `applyRemoteBounds`, always write `userToFollow` even when `alreadyFitted`. Optional: do not cover FollowMode (`.follow-mode`) with the z-index 6 lock sheet.
- [x] Do not treat this as Follow Me dies after Durable Object hibernation. Do not change `voluntaryFollow` / `forceFollowCache` here.
- [x] Grep for `updateScene`, `onUserFollow`, `reassertFollow`, and `collaborators=`. Confirm the React collaborators prop is not the only path.
- [x] Run `npm run build`.
- [ ] Manual: Following badge and green outline survive a refresh-free session and a role change; they return without a reload.

---

## Shared Chromebooks reuse guest userId

### Issue

Signed-out identity is `deviceInstallId` in `localStorage`. That string is the guest `userId` used for People roles and Follow. The next student on the same Chromebook inherits the previous guest’s **Editor** (or other) assignment.

### Research

`getDeviceInstallId()` / `DEVICE_INSTALL_ID_KEY` in `whiteboard-library.ts`. `getBoardConnectIdentity()` uses `deviceId` as `userId` when Clerk is signed out. `applyRoleToUser` stores roles keyed by that `userId`. Clearing site data mints a new id; a normal next-period login does not.

### Found / suspected bug(s)

Found. Guest role is device-sticky, not person-sticky.

### Fixes

Bind guest role to session id (tab) instead of install id, or rotate guest `userId` per board visit. Prefer Google sign-in for anyone who should stay Editor. Document shared-Chromebook sign-out.

### Tasks

- [x] Change `getBoardConnectIdentity()` in `src/lib/whiteboard-excalidraw-roles.ts` so signed-out `userId` is not the durable `deviceInstallId` from `getDeviceInstallId()` / `DEVICE_INSTALL_ID_KEY`.
- [x] Bind guest role to tab session id, or rotate guest `userId` per board visit, so the next student does not inherit Editor.
- [x] Keep Google sign-in as the way a person stays Editor across visits. Update `docs/whiteboard/people-permissions.md` for shared-Chromebook sign-out.
- [x] Grep for `getDeviceInstallId` on the connect identity path. Confirm `applyRoleToUser` is not keyed by a Chromebook-lifetime guest id.
- [x] Run `npm run build`.
- [ ] Manual: period 1 guest promoted to Editor; period 2 student on the same Chromebook (no site-data clear) is not still Editor.

---

## Hub Assets never indexes canvas uploads

### Issue

The hub **Assets** strip does not list images/video placed on a board. Teachers looking for “what we uploaded in class” see an empty row.

### Research

`whiteboard-assets.ts` comment: “Hub index is not updated.” Canvas PUT goes to `assets/{ownerKey}/{fileId}` only. Hub Assets reads `library/{ownerKey}/assets.json`. `whiteboard.astro` empty copy vs that comment.

### Found / suspected bug(s)

Found. Two pipelines; canvas never writes the hub index.

### Fixes

On successful canvas PUT (Owner library), upsert `assets.json`, or drop hub Assets until that exists. Do not imply hub Assets is the canvas media library.

### Tasks

- [x] Either upsert `library/{ownerKey}/assets.json` on successful canvas PUT (Owner library) in the asset PUT path, or remove/hide hub Assets until that write exists.
- [x] Update `src/lib/whiteboard-assets.ts` (the “Hub index is not updated.” comment) and empty copy on `src/pages/whiteboard.astro` so the strip does not imply it is the canvas media library.
- [x] Do not invent a second store. Canvas files stay at `assets/{ownerKey}/{fileId}`.
- [x] Grep for `assets.json` and hub Assets rendering. Confirm canvas PUT and hub index match the chosen approach.
- [x] Run `npm run build`.
- [ ] Manual: upload on a saved board; hub Assets either lists it or is not shown as an empty class-media library.

---

## Recents and Library have no thumbnails

### Issue

Recents/Library cards have no preview of the board. `previewDataUrl` exists on the type and hub card markup but is unused in the live save path.

### Research

`WhiteboardLibraryEntry.previewDataUrl` is optional. `upsert` passes through an existing preview and does not capture the Excalidraw canvas. Hub `whiteboard-hub.ts` will render an `<img>` if present.

### Found / suspected bug(s)

Found. Field is leftover from the design spec; nothing generates it.

### Fixes

Capture a small preview on Save (or periodically) into the index, or remove the unused img branch until then.

### Tasks

- [x] Either capture a small preview on Save (or periodically) into `previewDataUrl` on the index, or remove the unused `<img>` branch in `src/scripts/whiteboard-hub.ts`.
- [x] If capturing: wire it through `upsert` in `src/scripts/whiteboard-library.ts` / `src/worker/libraryRoutes.ts` so the field is no longer pass-through-only.
- [x] If removing: delete dead markup and keep the optional type only if still needed.
- [x] Grep for `previewDataUrl`. Confirm the hub does not render an empty preview slot that nothing fills, or that Save actually fills it.
- [x] Run `npm run build`.
- [ ] Manual: Recents cards either show a real thumbnail or no preview chrome.

---

## No live pointer cursors

### Issue

Students cannot see other people’s cursors. Follow is camera-only.

### Research

Port leftover; documented as out of the Excalidraw collab slice (people list + Follow, not Excalidraw pointer broadcast). `collaboratorsFromPeople` sets id/username only.

### Found / suspected bug(s)

Found as an omitted feature, not a regression from a working cursor layer.

### Fixes

If classroom needs it, broadcast pointer in the existing WS and map onto Excalidraw `collaborators`. Otherwise keep documenting that cursors are not live.

### Tasks

- [x] Confirm with the product owner whether live cursors are needed for classroom launch. If not, leave the code unchanged and keep `docs/whiteboard/people-permissions.md` (cursors are not v1).
- [x] If yes: broadcast pointer on the existing WebSocket, map onto Excalidraw `collaborators` (this likely depends on Following overlay is glitchy actually calling `updateScene({ collaborators })`).
- [x] Extend `collaboratorsFromPeople` beyond id/username only if implementing cursors.
- [x] Do not treat missing cursors as a regression from tldraw.
- [x] Grep / docs check: either the feature exists end-to-end, or docs still say live cursors are not in this slice.
- [x] Run `npm run build` only if code changed.

---

## Unused tldraw.png

### Issue

`public/images/tldraw.png` is unused after the editor swap. It is leftover branding.

### Research

Glob finds only `public/images/tldraw.png`. Product name is Whiteboard; editor is Excalidraw.

### Found / suspected bug(s)

Found. Dead static asset.

### Fixes

Delete the file and any leftover references if they appear in templates.

### Tasks

- [x] Delete `public/images/tldraw.png`.
- [x] Grep and glob the repo for `tldraw.png` and leftover tldraw branding in templates. Remove references if any appear.
- [x] Do not touch Durable Object tldraw SQL cleanup (see tldraw constructor wipe needs no code change).
- [x] Run `npm run build`.
- [x] Confirm the hub and board do not 404 a missing image.

---

## Dead r2AssetStore and local API surface

### Issue

Legacy `r2AssetStore` / `local:{deviceInstallId}` hub-upload helpers still exist beside the live `temp:` / `google:` canvas path. Extra API surface to audit and confuse.

### Research

`whiteboard-assets.ts` exports `r2AssetStore` and deprecated `localBlobAssetStore`. `assetRoutes.ts` still accepts `local:*` keys. Docs call `local:` leftover hub uploads.

### Found / suspected bug(s)

Found. Dead or legacy path still writable (see Temp and local asset writes have no auth).

### Fixes

Remove or lock down `local:*` once hub leftovers are gone. Keep one asset store for canvas files.

### Tasks

- [x] Remove or lock down `local:*` in `src/worker/assetRoutes.ts` once hub leftover uploads are gone.
- [x] Delete or stop exporting `r2AssetStore` and deprecated `localBlobAssetStore` from `src/lib/whiteboard-assets.ts` if nothing live imports them. Keep one asset store for canvas `temp:` / `google:` files.
- [x] Update docs that still describe `local:` leftover hub uploads.
- [x] If PUT/DELETE on `local:*` remains even briefly, it must not stay unauthenticated (Temp and local asset writes have no auth).
- [x] Grep for `r2AssetStore`, `localBlobAssetStore`, and `local:`. Confirm no live hub path still writes that prefix.
- [x] Run `npm run build`.

---

## Excalidraw library sidebar blocked by CSP

### Issue

Stock Excalidraw library fetch to `json.excalidraw.com` is blocked by Content-Security-Policy. The sidebar looks broken.

### Research

`public/_headers` `connect-src` is `'self'` plus Clerk, n8n, insights — not `json.excalidraw.com`. Self-hosted fonts via `EXCALIDRAW_ASSET_PATH = '/excalidraw/'` are intentional; the shape library CDN is not allowed.

### Found / suspected bug(s)

Found. CSP is working as deployed; Excalidraw’s default library URL is not in the allowlist.

### Fixes

Disable or hide the Excalidraw library UI, or self-host a school-safe library JSON on `'self'`. Do not open `json.excalidraw.com` unless that is an accepted dependency.

### Tasks

- [x] Disable or hide the stock Excalidraw library sidebar, or self-host a school-safe library JSON on `'self'`.
- [x] Do not add `json.excalidraw.com` to `connect-src` in `public/_headers` unless that CDN is an accepted dependency.
- [x] Leave self-hosted fonts (`EXCALIDRAW_ASSET_PATH = '/excalidraw/'`) as they are.
- [x] Grep for `json.excalidraw.com` and `connect-src`. Confirm the sidebar does not look broken because of a blocked fetch.
- [x] Run `npm run build`.
- [ ] Manual: open the board on a Chromebook; library UI is hidden, self-hosted, or otherwise not a failed request.

---

## Guests default Viewer is also a training issue

### Issue

Teachers may think a join code means students can draw. They cannot until promoted (see Share-code joiners default to Viewer).

### Research

Same default as Share-code joiners default to Viewer. Hub/help copy already explains scratch vs Save; it does not explain “code join = view only.”

### Found / suspected bug(s)

Suspected as documentation/training, not a separate code defect.

### Fixes

When shipping the class-Editor setting, update hub and in-board copy. Until then, tell teachers to set Editor on the People list.

### Tasks

- [ ] Update hub and in-board copy (and `docs/whiteboard/share-codes.md` / `docs/whiteboard/people-permissions.md`) so a join code is not described as “students can draw.”
- [x] Until Share-code joiners default to Viewer ships a class-Editor setting, tell teachers to set Editor on the People list.
- [ ] When that setting ships, update the same copy to match (default Viewer vs class can edit).
- [x] Do not change `resolveConnectRole` in this issue.
- [x] Grep hub/help strings for join-code wording. Confirm they do not imply draw access.
- [x] Manual: a teacher reading the hub can tell that code join is view-only unless they promote or turn on class-can-edit.

---

## tldraw constructor wipe needs no code change

### Issue

No product change is required. Leftover tldraw SQLite tables are not a launch risk. Do not treat this as a board to fix in code.

The Durable Object constructor still detects `tldraw_*` SQL tables and runs wipe-first (`deleteAll`), then creates an empty `excalidraw_scene`. Dual-table loss applies only to **old UUIDs** that woke between **13 Aug 23:43 UTC and 14 Aug 04:01 UTC** and were **never opened since**. New boards are safe.

### Research

The constructor wipe-first path is intentional migration for old tldraw tables. `POST /api/whiteboard/admin/wipe-storage` is Bearer `WHITEBOARD_ADMIN_SECRET` plus **explicit Durable Object hex IDs**. Wiping every listed ID would blank live Excalidraw rooms.

### Found / suspected bug(s)

Not a bug in current boards. Historical dual-table loss is limited to those old UUIDs that never opened after the window above.

### Fixes

Do **not** bulk-run `POST /api/whiteboard/admin/wipe-storage`. Leave leftover tldraw cleanup as a one-off for known-dead IDs only.

### Tasks

- [x] Do not change the Durable Object constructor wipe-first path for this issue.
- [x] Do not bulk-run `POST /api/whiteboard/admin/wipe-storage`. If a known-dead ID must be cleaned, use that route with explicit hex IDs only.
- [x] Confirm new boards do not use `tldraw_*` tables (grep `WhiteboardBoard.ts` constructor / `deleteAll`).
- [x] No `npm run build` required unless someone edits code by mistake; revert that edit.
