# Whiteboard / Excalidraw Reliability Audit

**Audit date:** August 30, 2026
**Scope:** Whiteboard and Excalidraw client, Worker routes, Durable Object synchronization, authentication, storage, operational limits, tests, and build guardrails
**Audit type:** Initial read-only review followed by tracked stabilization work and separately recorded releases

## Executive Summary

The whiteboard is in a reasonably strong state. A broad refactor before the school year is not recommended. The important persistence, authorization, payload-size, WebSocket hibernation, media-serving, and reconnect controls are already thoughtful and substantially tested.

The audit found:

- One high-priority confirmed synchronization bug
- Four medium-priority robustness or operational concerns
- One medium-priority verification gap
- No known production dependency vulnerabilities
- No committed credentials surfaced
- A successful production build

The safest implementation order is:

1. Fix the Group Edit synchronization bug.
2. Make public metadata reads write-free.
3. Attach important background work to the Cloudflare event lifetime.
4. Repair the date-dependent alarm tests.
5. If classroom clients are unavailable, size layered connection limits from the deterministic maximum-board model and keep the IP-wide abuse ceiling.
6. Add a scoped whiteboard type-checking guardrail.

---

## Issue 1 — Group Edit Changes Can Strand the Synchronization Queue

**Priority:** High
**Classification:** Confirmed code-path bug
**Status:** Completed

### Issue

If an Editor submits a scene mutation at roughly the same time an Owner disables Group Edit, the server can silently discard that mutation without acknowledging or rejecting it. The client then retains it as the current in-flight mutation and may stop sending later edits until the socket reconnects or the page reloads.

A second, closely related problem is that a locally queued—but not yet transmitted—edit can be cleared during the edit-to-view remount without telling the user that their latest change was not saved.

This is a normal classroom scenario: a teacher turns Group Edit off while students are finishing edits.

### Research & Found/Suspected Bug(s)

The client maintains one in-flight mutation and one pending mutation in [`WhiteboardCanvas.tsx`](../../src/components/WhiteboardCanvas.tsx#L369) and [`WhiteboardCanvas.tsx`](../../src/components/WhiteboardCanvas.tsx#L532).

On the server, the scene-update handler performs its permission check in [`WhiteboardBoard.ts`](../../src/worker/WhiteboardBoard.ts#L3192). If editing has just been disabled, it returns immediately without:

- Reading the mutation ID
- Sending `scene:ack`
- Sending a mutation-specific `wb:error`

The client only retires an in-flight mutation after a matching acknowledgement or mutation-specific error in [`WhiteboardCanvas.tsx`](../../src/components/WhiteboardCanvas.tsx#L784) and [`WhiteboardCanvas.tsx`](../../src/components/WhiteboardCanvas.tsx#L813).

When Group Edit changes, the role controller immediately changes `canEdit` in [`whiteboard-excalidraw-roles.ts`](../../src/lib/whiteboard-excalidraw-roles.ts#L554), and the Excalidraw component remounts because its key changes in [`WhiteboardCanvas.tsx`](../../src/components/WhiteboardCanvas.tsx#L1026).

That remount clears pending state but preserves the in-flight mutation. The reconnect/replay path only resends it when the socket object changes, so the same still-open socket can remain permanently blocked.

### Possible/Proposed Fix(s)

- Parse and validate the mutation ID before the edit-permission check.
- Send an explicit terminal response such as `wb:error { code: "edit_not_allowed", mutationId }`.
- Do not acknowledge the rejected mutation as successfully persisted.
- Have the client retire that exact mutation, request the authoritative scene, and show a short “Your last edit was not saved because Group Edit was turned off” message.
- Decide explicitly what to do with a pending debounced edit during downgrade. At minimum, do not discard it without user feedback.

### Actionable Task List

- [x] Reproduce: Editor submits a mutation, then Owner disables Group Edit before the server processes it.
- [x] Confirm the mutation currently receives no terminal server frame.
- [x] Add a mutation-specific rejection from the Worker.
- [x] Update the outbox to retire a rejected in-flight mutation and request a fresh scene.
- [x] Handle locally pending edits during the edit-to-view remount.
- [x] Test an in-flight mutation rejected during Group Edit shutdown.
- [x] Test that the outbox cannot remain permanently stuck.
- [x] Test that editing works normally after Group Edit is re-enabled.
- [x] Test that pending debounce content is either preserved or clearly reported as unsaved.
- [x] Test that a rejected edit is never represented as persisted.

---

## Issue 2 — Public Board Metadata Reads Can Initialize Durable Object State

**Priority:** Medium
**Classification:** Confirmed unnecessary write path
**Status:** Completed

### Issue

An unauthenticated `GET /meta` request can initialize a previously unused board Durable Object. That can create metadata, a database table, an expiration timestamp, and an alarm before the requester proves that they are the board’s creator.

The WebSocket admission path was deliberately designed so that merely guessing a valid UUID does not create stored state. The public metadata endpoint currently weakens that property.

### Research & Found/Suspected Bug(s)

The Worker exposes metadata reads in [`worker.ts`](../../src/worker.ts#L152).

The Durable Object metadata handler calls `ensureBoardLifetime()` even for `GET` requests in [`WhiteboardBoard.ts`](../../src/worker/WhiteboardBoard.ts#L1272).

For a fresh object, initialization in [`WhiteboardBoard.ts`](../../src/worker/WhiteboardBoard.ts#L1652) can:

- Create or migrate SQLite structures
- Store the board ID
- Store creation and expiration metadata
- Schedule an alarm

The client requests metadata early in [`whiteboard-excalidraw-files.ts`](../../src/lib/whiteboard-excalidraw-files.ts#L369), while the board menu has another metadata/title path in [`whiteboard-menu.ts`](../../src/lib/whiteboard-menu.ts#L99).

Existing tests verify that public metadata reads do not mint a share-code mapping, but they do not assert that the Durable Object remains entirely write-free.

### Possible/Proposed Fix(s)

- Make `GET /meta` genuinely read-only.
- Return default metadata for a fresh board using storage reads only.
- Keep real initialization in the trusted first `wb:auth` creator flow, where it already belongs.
- If possible, consolidate the client’s duplicate metadata reads after the authenticated hello rather than issuing independent early requests.

### Actionable Task List

- [x] Record storage keys, SQL tables, and alarm state before and after a fresh unauthenticated `GET /meta`.
- [x] Remove `ensureBoardLifetime()` from the GET path.
- [x] Return a stable default response when no board metadata exists.
- [x] Verify that authenticated creator admission still initializes the board exactly once.
- [x] Test that a fresh public metadata read creates no metadata writes.
- [x] Test that a fresh public metadata read creates no user SQL tables.
- [x] Test that a fresh public metadata read creates no alarm.
- [x] Test that a fresh public metadata read creates no KV share-code entry.
- [x] Verify that an existing board’s metadata remains publicly readable as intended without rewriting it.

---

## Issue 3 — Background Authentication and Follow-State Work Is Not Attached to Request Lifetime

**Priority:** Medium
**Classification:** Confirmed lifecycle defect; user-facing impact suspected
**Status:** Completed

### Issue

Several asynchronous operations are started with `void` and are neither awaited nor attached to `waitUntil()`. Cloudflare can terminate untracked work once a request or event handler completes.

The most important example is Clerk profile refresh. Concurrent requests for the same stale profile can also start duplicate Clerk API calls because there is no per-user in-flight refresh deduplication.

### Research & Found/Suspected Bug(s)

The stale-profile branch in [`clerkAuth.ts`](../../src/worker/clerkAuth.ts#L224) launches a Clerk request and KV write in the background at [`clerkAuth.ts`](../../src/worker/clerkAuth.ts#L238), then immediately returns the stale profile.

While the cached `fetchedAt` remains stale, multiple authentication requests can all launch their own refresh. If the runtime terminates the background promise, later requests can repeat that pattern.

The Durable Object also starts untracked follow/follower updates in several places, including:

- [`WhiteboardBoard.ts`](../../src/worker/WhiteboardBoard.ts#L1230)
- [`WhiteboardBoard.ts`](../../src/worker/WhiteboardBoard.ts#L1268)
- [`WhiteboardBoard.ts`](../../src/worker/WhiteboardBoard.ts#L2584)
- [`WhiteboardBoard.ts`](../../src/worker/WhiteboardBoard.ts#L2724)
- [`WhiteboardBoard.ts`](../../src/worker/WhiteboardBoard.ts#L3331)

Cloudflare’s guidance is to await important work or explicitly extend event lifetime with `waitUntil()`. The existing use of hibernation attachments elsewhere is correct. See [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) and [Durable Object WebSocket guidance](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

### Possible/Proposed Fix(s)

- Add a per-user `profileRefreshInFlight` map so concurrent requests share one refresh promise.
- Add a short retry cooldown after Clerk refresh failures.
- Pass an execution-context/wait function into the authentication helper, or await the refresh when appropriate.
- Await follow-state broadcasts from asynchronous handlers, or attach them using `this.ctx.waitUntil()`.
- Avoid turning every incidental broadcast into a blocking operation; attach non-response-critical work to event lifetime.

### Actionable Task List

- [x] Run concurrent stale-profile authentication requests and count Clerk API calls.
- [x] Add in-flight refresh deduplication by user ID.
- [x] Define refresh failure and retry behavior.
- [x] Attach the refresh promise to request lifetime.
- [x] Audit every `void` promise in the whiteboard Worker.
- [x] Classify each promise as intentionally disposable, required to be awaited, or required to use `waitUntil()`.
- [x] Test that simultaneous stale-profile requests trigger one refresh.
- [x] Test that one successful KV update occurs.
- [x] Test that refresh failures do not cause immediate request storms.
- [x] Test that follow/follower state messages complete before their event lifetime ends.
- [x] Verify the hibernation rebroadcast path awaits the same work and test socket-close follow cleanup.

---

## Issue 4 — IP-Only Rate Limiting May Throttle Legitimate School-Wide Reconnects

**Priority:** Medium
**Classification:** Suspected operational risk; mitigated from a deterministic capacity model
**Status:** Completed with theoretical sizing

### Issue

The original connection limit used only the public client IP. Many school devices commonly share one public NAT address.

Normal use likely stayed under the original limit, but a Wi-Fi interruption, Worker restart, or simultaneous class transition could cause dozens of Chromebooks to reconnect several times inside one minute and consume the shared IP allowance.

### Research & Found/Suspected Bug(s)

Before the mitigation, the Cloudflare rate-limit binding was configured for 120 connections per 60 seconds in [`wrangler.jsonc`](../../wrangler.jsonc#L54).

The connection limiter uses trusted `CF-Connecting-IP` for the school-wide key. The layered board key combines the canonical board UUID with that trusted IP in [`connectAdmission.ts`](../../src/worker/connectAdmission.ts).

Share-code joins have a separate 60-per-minute IP limiter in [`codeRoutes.ts`](../../src/worker/codeRoutes.ts#L216).

The client reconnect schedule starts aggressively and then backs off. A group of 30–60 devices behind one public IP can therefore produce a significant burst after a short outage.

Cloudflare specifically cautions against relying exclusively on IP addresses because many legitimate users can share one IP. Rate-limit binding counters are also local to a Cloudflare location, so they should be treated as abuse controls rather than exact global quotas. See [Cloudflare Rate Limiting bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

The audit did not find production traffic or rejection metrics proving that users encountered this. Classroom clients were not available for a staged NAT test, so the final thresholds were selected from the deterministic model at the user’s direction.

### Original Local Risk Model — August 30, 2026

A deterministic single-location model was run with two boards behind one public IP and reconnect attempts at cumulative 0.5, 1.5, and 3.5 seconds. It models the strict local fallback; Cloudflare’s deployed binding is permissive and eventually consistent, so staging results may differ.

| Devices | Requests after two attempts | Allowed | Rejected before the third wave |
|---:|---:|---:|---:|
| 30 | 60 | 60 | 0 |
| 60 | 120 | 120 | 0; the 60-request third wave is over budget |
| 120 | 240 | 120 | 120; the third wave is also over budget |

The original model established that 120 was too close to an ordinary synchronized burst. A composite `IP + board` key could not replace the IP-wide key because rotating valid UUIDs would create fresh board buckets.

### Implemented Fix

- `WHITEBOARD_CONNECT_LIMITER` now allows 600 attempts per 60 seconds per trusted public IP. Three completely full 64-socket boards reconnecting three times produce 576 attempts, leaving a small practical margin.
- `WHITEBOARD_BOARD_CONNECT_LIMITER` independently allows 240 attempts per 60 seconds per canonical board plus IP. One full board reconnecting three times produces 192 attempts, leaving 25% headroom.
- The IP-wide gate runs first, so rotating valid board UUIDs still consumes the same 600-request school-wide allowance.
- Both production bindings must exist; a partial or failed binding configuration returns 503 rather than silently bypassing a layer.
- The bounded local/test fallback enforces the same two ceilings.
- Rejection logs include the low-cardinality configured limit (`600` or `240`) without recording the IP or board ID.
- The Durable Object’s 64-total-socket and 32-pending-auth limits remain unchanged.
- Share-code lookup remains a separate 60-per-minute IP limiter. Reconnects use the resolved board UUID and do not repeat share-code lookup.

### Actionable Task List

- [x] Simulate 30 clients behind one IP with the deterministic local limiter model.
- [x] Simulate 60 clients behind one IP with the deterministic local limiter model.
- [x] Simulate 120 clients behind one IP with the deterministic local limiter model.
- [x] Simulate a brief outage followed by synchronized reconnect attempts.
- [x] Model two classrooms/boards behind the same IP.
- [x] Verify rotating board IDs still consume the IP-wide admission limit and document why a board-only key is unsafe.
- [x] Record that live classroom/NAT measurements are unavailable and use deterministic theoretical sizing instead.
- [x] Set the IP-wide threshold to 600 attempts per 60 seconds.
- [x] Add a separate 240-per-60-second canonical board plus IP threshold.
- [x] Keep the IP-wide gate authoritative when board UUIDs rotate.
- [x] Make partial production binding configuration fail closed.
- [x] Mirror both layers in the bounded local/test fallback.
- [x] Distinguish IP-wide and board-specific rejection logs without emitting identifiers.
- [x] Document the expected capacity: three full 64-seat boards, each reconnecting three times behind one public IP.

---

## Issue 5 — Alarm Lifetime Tests Are Date-Dependent and the Suite Is Failing

**Priority:** Medium
**Classification:** Confirmed test defect, not a production alarm defect
**Status:** Completed

### Issue

One whiteboard alarm test contains a hard-coded expiration date that has now passed. The full test suite consequently fails based on the current calendar date.

A neighboring test using the same timestamp can pass for the wrong reason because it only asserts that an alarm was not set; it does not assert that the existing alarm was not deleted.

### Research & Found/Suspected Bug(s)

At the time of the audit, `npm test` produced:

- 158 tests passed
- 1 test failed
- 23 test files passed
- 1 test file failed

The failing case is in [`whiteboard-board-lifetime.test.ts`](../../tests/whiteboard-board-lifetime.test.ts#L898). It uses an expiration timestamp of August 28, 2026, which was in the past when this audit ran.

The production scheduler in [`WhiteboardBoard.ts`](../../src/worker/WhiteboardBoard.ts#L2991) correctly treats expired timestamps differently, so its behavior is reasonable. The test fixture is the problem.

### Possible/Proposed Fix(s)

- Freeze system time in this test group with Vitest fake timers.
- Alternatively, calculate the expiration relative to a fixed test clock.
- Assert both sides of the same-alarm behavior: no `setAlarm` and no `deleteAlarm`.
- Add an explicit expired-board test that expects alarm cleanup.

### Actionable Task List

- [x] Add `vi.useFakeTimers()` and `vi.setSystemTime()` to the lifetime test group.
- [x] Restore real timers after the group.
- [x] Make every “future” expiration relative to the frozen time.
- [x] Strengthen the neighboring no-op assertion to include `deleteAlarm`.
- [x] Add a distinct expired-timestamp case.
- [x] Rerun the full test suite.
- [x] Search the whiteboard suite for other fixed dates that will eventually expire.

---

## Issue 6 — Production Builds Do Not Validate the Excalidraw TypeScript Contract

**Priority:** Medium
**Classification:** Confirmed verification gap; present runtime impact appears low
**Status:** Completed

### Issue

The production build succeeds even though tracked whiteboard code contains TypeScript errors. One involves an unsupported Excalidraw component prop; another passes a broader partial application state than the API accepts.

Neither currently appears to be causing the reported runtime behavior, but they weaken future refactoring safety around the highest-risk feature.

### Research & Found/Suspected Bug(s)

`npm run build` succeeds, but `npx tsc --noEmit` reports two whiteboard-specific problems:

1. [`WhiteboardCanvas.tsx`](../../src/components/WhiteboardCanvas.tsx#L1044) passes `collaborators` as an Excalidraw component prop. In the pinned Excalidraw API, collaborators belong to scene data supplied through `updateScene()`, not the component’s prop surface.

   The code already performs the correct imperative update in [`whiteboard-excalidraw-roles.ts`](../../src/lib/whiteboard-excalidraw-roles.ts#L629), so the invalid component prop appears redundant.

2. [`whiteboard-excalidraw-roles.ts`](../../src/lib/whiteboard-excalidraw-roles.ts#L336) spreads a broad partial `appState` into a camera update. Optional members such as `contextMenu` make that object incompatible with the accepted update type.

The public Excalidraw API documents the supported component props and imperative API behavior in [Excalidraw API props](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/).

The repository’s build script only runs `astro build`; there is no required CI workflow or scoped whiteboard type-check. A whole-project type check cannot safely become a blocking check immediately because it currently includes unrelated baseline errors and untracked iCloud duplicate files.

### Possible/Proposed Fix(s)

- Remove the redundant `collaborators` component prop.
- Continue updating collaborators through `api.updateScene()`.
- Construct the camera patch from only the exact accepted fields, such as `scrollX`, `scrollY`, and `zoom`.
- Add a scoped `tsconfig.whiteboard.json`.
- Add `typecheck:whiteboard` and `verify:whiteboard` scripts.
- Make the scoped check required before merging whiteboard changes.
- Do not make the entire current repository-wide `tsc` run a required gate until the existing baseline is cleaned up.

### Actionable Task List

- [x] Remove the unsupported `collaborators` prop.
- [x] Verify collaborator cursors still update through `updateScene()`.
- [x] Replace the broad application-state spread with an explicit camera-state object.
- [x] Create a scoped type-check covering `WhiteboardCanvas.tsx`.
- [x] Include `src/lib/whiteboard-*` in the scoped type-check.
- [x] Include `src/worker/WhiteboardBoard.ts` and whiteboard Worker route modules in the scoped type-check.
- [x] Add a verification command combining the scoped type-check, whiteboard tests, and production build.
- [x] Add that command to the pre-merge preview workflow.
- [x] Review the untracked `* 2.*`, `* 3.*`, and `* 4.*` iCloud copies separately; leave them untouched and excluded from the scoped type-check.

---

## Validation Results

| Check | Result |
|---|---|
| Production build | Passed |
| Test suite | 167 passed, 0 failed after layered admission work |
| Scoped whiteboard type-check | Passed |
| Focused post-implementation regression pass | Passed: 41 unit/protocol checks and 21 Worker integration checks; no corrective code changes required |
| Layered connection admission | Passed: 10 focused admission tests; Wrangler dry run exposes 600/IP and 240/IP+board bindings |
| Repository-wide type-check | Remains outside the gate because unrelated baseline and untracked duplicate-file errors still exist |
| Production dependency audit | 0 known vulnerabilities |
| Secret scan of tracked content | No committed credential surfaced; test secrets were false positives |
| Deployment | Issues 1, 2, 3, 5, and 6 shipped in `b6ed9b2`; the Issue 4 layered admission change remains local until separately approved |
| Stabilization implementation | Issues 1–6 completed; Issue 4 uses explicitly approved theoretical sizing because classroom clients were unavailable |

The build reported large JavaScript chunks. The board and Excalidraw bundles are substantial, but some of the largest dependencies are dynamically loaded. Without measurements from a real Chromebook, this is not classified as a performance bug. Measure board startup, time-to-canvas, and memory on an 11.6-inch Chromebook before attempting bundle changes.

## Positive Findings

The audit also confirmed several areas that should be preserved rather than reworked:

- Scene messages have bounded UTF-8 and element limits.
- Scene persistence happens before acknowledgements.
- In-flight mutation replay is bounded and keeps immutable mutation data.
- Application-state changes are revision-aware.
- R2 operations are gated and size-bounded.
- Authentication uses fixed authorized parties.
- Administrative bearer comparison is timing-safe.
- WebSocket hibernation and attachments are in use.
- The service worker bypasses `/api/*` requests.
- Random unauthenticated WebSocket upgrades are designed to remain write-free.
- Media reads support ranges, ETags, and `nosniff`; SVG responses are forced to download.

## Overall Recommendation

The original stabilization release containing Issues 1, 2, 3, 5, and 6 shipped successfully. Keep the Issue 4 layered rate-limit change as its own focused release and verify the generated Cloudflare bindings before deployment.

Avoid dependency upgrades, architectural rewrites, or Excalidraw loading changes in the same release. `npm audit` is clean, and the immediate priority should be protecting the working behavior that exists now.
