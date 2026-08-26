# People and permissions

Live presence, four roles, Follow (eyes), and Follow User / force-follow. Live **cursors are not v1**.

**Follow this person** (eye icon) is voluntary: pan or zoom unfollows. **Follow User** is forced: the camera is locked to the leader until Owner/Manager turns it off. Guests cannot pan away.

## Overview

Connected sessions appear in the board manage panel under **People**. Anyone may follow another person’s camera with the eye icon. **Owner** and **Manager** can change roles (with the rules below) and force the room to follow a target (**Follow User**). Viewers cannot mutate the document. Editors can draw only while **Group Edit** is On: Excalidraw `viewModeEnabled` **and** the Durable Object drops `scene:update` writes when `sessionCanEdit` is false.

A share code (or board UUID) only **opens** the board. Role is decided on connect. Share-code joiners land as **Editor**. UUID-only stays **Viewer**. Owner or Manager can still set **Editor** on **People**. **Group Edit** (default Off) is a live draw gate: On → Editors can draw; Off → only Owner and Manager can draw (Editors keep the Editor role).

## Roles

| Role | Canvas | Roles UI | Follow force |
|------|--------|----------|--------------|
| **Owner** | Edit | Grant/revoke Manager, Editor, Viewer. Cannot be demoted. | Yes (self or someone else) |
| **Manager** | Edit | Editor/Viewer only. Cannot grant Manager or touch Owner. | Yes (self or someone else) |
| **Editor** | Edit when Group Edit is On; view-only when Off | No | Voluntary Follow only |
| **Viewer** | View only | No | Voluntary Follow only |

Only **Owner** can grant/revoke **Manager** (co-teachers / co-presenters).

How Owner is chosen:

- **Saved board:** Google account in `meta:cloudOwnerKey` (`google:{accountId}`).
- **Scratch board:** creating browser that presents the host secret (ephemeral Owner). Guests without that secret default to **Viewer** unless they joined with the share code (**Editor**).

Guest **Editor** from **People** is not sticky on a shared Chromebook. Signed-out connect `userId` is minted for this board visit (this page load) in `getBoardConnectIdentity()` — not the durable `deviceInstallId` in `localStorage`. Refresh, a new tab, or joining again from the hub is a new guest and defaults to **Viewer**, unless they join with the board’s share code (join-proof cookie, ~12h). Owner/Manager can still promote that guest for this visit only.

**Google sign-in** is how a person stays Editor (or Manager) across visits and class periods. On shared Chromebooks, sign out of Google when the period ends so the next student does not keep a signed-in role. Signed-out guests do not need a site-data clear.

Helpers: `WHITEBOARD_ROLES`, `roleCanEdit`, `sessionCanEdit`, `assignableRolesFor` in `src/lib/whiteboard-sync.ts`.

## People list

### Data path

1. On connect / disconnect / role change, the DO broadcasts `wb:participants` to connected sessions.
2. `useWhiteboardExcalidrawRoles` receives it → `scsfoxchase:whiteboard-participants` window event.
3. `whiteboard-menu.ts` renders the list.

Participant row shape (`ParticipantRow`):

| Field | Meaning |
|-------|---------|
| `sessionId` | WebSocket session id |
| `userId` | Google account id, or a per-visit guest UUID (Follow target). Not `deviceInstallId`. |
| `displayName` | Full Google name or generated guest name |
| `role` | `owner` \| `manager` \| `editor` \| `viewer` |
| `canEdit` | Live draw flag from `sessionCanEdit(role, classCanEdit)` |
| `isHost` | Session presented a valid host secret (scratch Owner proof) |

`wb:hello` also delivers `authToken` so Owner/Manager HTTP calls can prove the live session (`X-Board-Session` + `X-Board-Auth`) without copying the host secret.

### UI columns

Row: **Name** | **Role** badge/select | **Eye** (follow).

| Control | Behavior |
|---------|----------|
| **Name** | Full display name; self shown as `… (you)` |
| **Role** | Owner/Manager views use selects. Editable users offer the roles that actor may assign; protected Owner/Manager rows remain one-option selects. Editor/Viewer views use pill labels (**Edit** = `editor`) |
| **Eye** | Toggle follow this person; disabled for self; dimmed while Follow User is locking the room |

Display helpers: `peopleListLabel`, `generateGuestDisplayName` in `src/lib/whiteboard-display-name.ts`.

## Follow (voluntary)

Manage panel eye buttons dispatch `scsfoxchase:whiteboard-follow` with `{ userId }`. The canvas sets Excalidraw `appState.userToFollow` and subscribes via `wb:follow` so the target sends `wb:sceneBounds`. Followers `zoomToFitBounds` on those bounds.

Following state is published back as `scsfoxchase:whiteboard-following` so the eye shows open vs slashed.

Stock Excalidraw follow **breaks on pan/zoom**. That is the intended unfollow for voluntary Follow: `onUserFollow` with `UNFOLLOW` clears the target. Bounds messages still keep the camera aligned while the guest stays following.

Voluntary Follow is ignored while Follow User is locking this session (force-follow wins). Eyes are dimmed in the manage panel while that lock is on.

## Role changes (Owner / Manager)

### API

```
PATCH /api/whiteboard/boards/:uuid/participants/:sessionId
Authorization: Bearer <hostSecret>   # scratch Owner, optional
X-Board-Host: <hostSecret>
X-Board-Session: <sessionId>
X-Board-Auth: <authToken>
Content-Type: application/json

{ "role": "manager" | "editor" | "viewer" }
```

Worker: `src/worker/participantRoutes.ts` → DO `handleParticipantPatch`.  
Client: `setParticipantRole` in `src/lib/whiteboard-participants.ts`.

Legacy `{ "canEdit": true | false }` maps to Editor / Viewer.

### Rules

- Proof required: host secret **or** live Owner/Manager session token (**401** / **403** otherwise).
- Owner session cannot be demoted (**400**).
- Manager cannot assign Manager or change Owner / another Manager.
- Default for new guest connects: **Viewer** (UUID-only always). Share-code joiners land as **Editor**. **Group Edit** Off still leaves them Editor but view-only.
- DO updates socket attachment, sends `wb:role` to that session, then rebroadcasts People.

### Client readonly

`viewModeEnabled={!canEdit}` (`sessionCanEdit`). A **View only** banner appears when the session cannot edit. The DO ignores Viewer writes and Editor writes while Group Edit is Off.

## Follow User (force-follow)

Owner/Manager toggle under **Sharing Features** (label **Follow User**). Target select: self or another connected person (a student showing work). Hidden unless this session may force-follow.

### API

```
PATCH /api/whiteboard/boards/:uuid/force-follow
Authorization: Bearer <hostSecret>
X-Board-Host: <hostSecret>
X-Board-Session: <sessionId>
X-Board-Auth: <authToken>
Content-Type: application/json

{ "forceFollow": true | false, "targetUserId"?: string, "subjectUserId"?: string }
```

Worker: `src/worker/forceFollowRoutes.ts` → DO `handleForceFollowPatch`.  
Client: `setForceFollow` in `src/lib/whiteboard-participants.ts`.

### DO state

- Storage key `meta:forceFollow`.
- Broadcast `wb:forceFollow` with `{ forceFollow, targetUserId, targetSessionId, subjects }` to connected sessions.
- Also sent on connect / when a session becomes connected.

### Camera lock (PR #7)

Voluntary Follow and Follow User are **not** the same camera path. Follow User must survive Excalidraw’s pan-to-unfollow.

In `whiteboard-excalidraw-roles.ts` + `WhiteboardCanvas.tsx`:

- Forced target for this user comes from room-wide `targetUserId` or per-user `subjects`. `forceFollowLocked` is true when this session is forced onto someone else.
- On enable, snap immediately with **cached** `wb:sceneBounds` for that leader (`zoomToFitBounds`), then keep applying new bounds.
- `onScrollChange` schedules a rAF re-assert; `onUserFollow` UNFOLLOW is ignored and the forced target is restored.
- Pointer/wheel/touch/gesture events on the canvas wrapper are stopped in the capture phase. A transparent overlay (`touch-action: none`, `z-index: 6`) sits above Excalidraw so guests cannot pan or zoom away.
- Turning Follow User off stops the forced camera (it does not restore an unrelated voluntary follow that Follow User had cleared).

Manage panel listens for `scsfoxchase:whiteboard-force-follow` to keep the On/Off switch in sync.

## Default permissions summary

| Action | Who |
|--------|-----|
| Open board by UUID / share code | Anyone with the link, or `GET /api/whiteboard/join/:code` (unauthenticated, rate-limited) |
| Edit canvas | Owner, Manager; Editor only while Group Edit is On |
| View only | Viewer; Editor while Group Edit is Off |
| Grant/revoke Manager | Owner only |
| Set Editor / Viewer | Owner or Manager (per person on People) |
| Group Edit | Owner or Manager. Live draw gate for Editors. Default Off. UUID-only stays Viewer. |
| Follow User / force-follow | Owner or Manager |
| Voluntary Follow (eyes) | Any session (subject to force-follow) |
| Read / copy share code | Owner or Manager. Viewer **403**. Leftover host on a Google-owned board is not enough. One permanent code per board. |

## Key files

| Path | Role |
|------|------|
| `src/worker/WhiteboardBoard.ts` | Roles, Follow broadcasts, `sessionCanEdit` write drop |
| `src/worker/participantRoutes.ts` | PATCH role edge |
| `src/worker/forceFollowRoutes.ts` | PATCH force-follow edge |
| `src/lib/whiteboard-participants.ts` | Client PATCH helpers + payload guards |
| `src/lib/whiteboard-display-name.ts` | Guest names / People labels |
| `src/lib/whiteboard-excalidraw-roles.ts` | `viewModeEnabled`, `userToFollow`, Follow User snap + `forceFollowLocked` |
| `src/components/WhiteboardCanvas.tsx` | Wires Excalidraw props; overlay + capture-phase pan block while locked |
| `src/scripts/whiteboard-menu.ts` | People UI, role + Follow User controls |
| `src/components/Header.astro` | People / Follow User markup |
