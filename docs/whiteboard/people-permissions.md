# People and permissions

Live presence, four roles, Follow, and Follow Me / force-follow. Live **cursors are not v1**.

**Follow this person** is voluntary: pan or zoom unfollows. **Follow Me** is forced: the camera is locked to the leader until Owner/Manager turns it off. Guests cannot pan away.

## Overview

Connected sessions appear in the board manage panel under **People**. Anyone may follow another person’s camera. **Owner** and **Manager** can change roles (with the rules below) and force the room — or one person — to follow a target. Viewers cannot mutate the document: Excalidraw `viewModeEnabled` **and** the Durable Object drops their `scene:update` writes.

## Roles

| Role | Canvas | Roles UI | Follow force |
|------|--------|----------|--------------|
| **Owner** | Edit | Grant/revoke Manager, Editor, Viewer. Cannot be demoted. | Yes (self or someone else) |
| **Manager** | Edit | Editor/Viewer only. Cannot grant Manager or touch Owner. | Yes (self or someone else) |
| **Editor** | Edit | No | Voluntary Follow only |
| **Viewer** | View only | No | Voluntary Follow only |

Only **Owner** can grant/revoke **Manager** (co-teachers / co-presenters).

How Owner is chosen:

- **Saved board:** Google account in `meta:cloudOwnerKey` (`google:{accountId}`).
- **Scratch board:** creating browser that presents the host secret (ephemeral Owner). Guests without that secret default to **Viewer**.

Guest identity sticks on that browser (`deviceInstallId` + generated display name). New browser = new guest. Owner/Manager can promote/demote that person on this board.

Helpers: `WHITEBOARD_ROLES`, `roleCanEdit`, `assignableRolesFor` in `src/lib/whiteboard-sync.ts`.

## People list

### Data path

1. On connect / disconnect / role change, the DO broadcasts `wb:participants` to connected sessions.
2. `useWhiteboardExcalidrawRoles` receives it → `scsfoxchase:whiteboard-participants` window event.
3. `whiteboard-menu.ts` renders the list.

Participant row shape (`ParticipantRow`):

| Field | Meaning |
|-------|---------|
| `sessionId` | WebSocket session id |
| `userId` | Google account id or guest `deviceInstallId` (Follow target) |
| `displayName` | Full Google name or generated guest name |
| `role` | `owner` \| `manager` \| `editor` \| `viewer` |
| `canEdit` | Derived from role (`roleCanEdit`) |
| `isHost` | Session presented a valid host secret (scratch Owner proof) |

`wb:hello` also delivers `authToken` so Owner/Manager HTTP calls can prove the live session (`X-Board-Session` + `X-Board-Auth`) without copying the host secret.

### UI columns

Header: **Name** | **Follow** | **Role**.

| Column | Behavior |
|--------|----------|
| **Name** | Full display name; self shown as `… (you)` |
| **Follow** | Button Follow / Following; disabled for self |
| **Role** | Select for Owner/Manager (allowed targets only); otherwise a label |

Display helpers: `peopleListLabel`, `generateGuestDisplayName` in `src/lib/whiteboard-display-name.ts`.

## Follow (voluntary)

Manage panel Follow buttons dispatch `scsfoxchase:whiteboard-follow` with `{ userId }`. The canvas sets Excalidraw `appState.userToFollow` and subscribes via `wb:follow` so the target sends `wb:sceneBounds`. Followers `zoomToFitBounds` on those bounds.

Following state is published back as `scsfoxchase:whiteboard-following` so Follow buttons show **Following**.

Stock Excalidraw follow **breaks on pan/zoom**. That is the intended unfollow for voluntary Follow: `onUserFollow` with `UNFOLLOW` clears the target. Bounds messages still keep the camera aligned while the guest stays following.

Voluntary Follow is ignored while Follow Me is locking this session (force-follow wins).

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
- Default for new guest connects: **Viewer**.
- DO updates socket attachment, sends `wb:role` to that session, then rebroadcasts People.

### Client readonly

`viewModeEnabled={role === 'viewer' || !canEdit}`. A **View only** banner appears when the session cannot edit. The DO still ignores Viewer `scene:update` messages.

## Follow Me (force-follow)

Owner/Manager toggle beside the **People** heading (label **Follow Me**). Target select: self or another connected person (a student showing work). Hidden unless this session may force-follow. Only visible while Share is Open (right column).

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

Voluntary Follow and Follow Me are **not** the same camera path. Follow Me must survive Excalidraw’s pan-to-unfollow.

In `whiteboard-excalidraw-roles.ts` + `WhiteboardCanvas.tsx`:

- Forced target for this user comes from room-wide `targetUserId` or per-user `subjects`. `forceFollowLocked` is true when this session is forced onto someone else.
- On enable, snap immediately with **cached** `wb:sceneBounds` for that leader (`zoomToFitBounds`), then keep applying new bounds.
- `onScrollChange` schedules a rAF re-assert; `onUserFollow` UNFOLLOW is ignored and the forced target is restored.
- Pointer/wheel/touch/gesture events on the canvas wrapper are stopped in the capture phase. A transparent overlay (`touch-action: none`, `z-index: 6`) sits above Excalidraw so guests cannot pan or zoom away.
- Turning Follow Me off stops the forced camera (it does not restore an unrelated voluntary follow that Follow Me had cleared).

Manage panel listens for `scsfoxchase:whiteboard-force-follow` to keep the On/Off switch in sync.

## Default permissions summary

| Action | Who |
|--------|-----|
| Open board by UUID / code | Anyone with link or open code |
| Edit canvas | Owner, Manager, Editor |
| View only | Viewer (default for guests) |
| Grant/revoke Manager | Owner only |
| Set Editor / Viewer | Owner or Manager |
| Follow Me / force-follow | Owner or Manager |
| Voluntary Follow | Any session (subject to force-follow) |
| Open/Close share code | Anyone with board UUID |

## Key files

| Path | Role |
|------|------|
| `src/worker/WhiteboardBoard.ts` | Roles, Follow broadcasts, Viewer write drop |
| `src/worker/participantRoutes.ts` | PATCH role edge |
| `src/worker/forceFollowRoutes.ts` | PATCH force-follow edge |
| `src/lib/whiteboard-participants.ts` | Client PATCH helpers + payload guards |
| `src/lib/whiteboard-display-name.ts` | Guest names / People labels |
| `src/lib/whiteboard-excalidraw-roles.ts` | `viewModeEnabled`, `userToFollow`, Follow Me snap + `forceFollowLocked` |
| `src/components/WhiteboardCanvas.tsx` | Wires Excalidraw props; overlay + capture-phase pan block while locked |
| `src/scripts/whiteboard-menu.ts` | People UI, role + Follow Me controls |
| `src/components/Header.astro` | People / Follow Me markup |
