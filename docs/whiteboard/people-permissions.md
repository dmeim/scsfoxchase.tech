# People and permissions

Live presence, Follow, Edit switches, Everyone follows me (force-follow), and how readonly is enforced.

## Overview

Connected sessions appear in the board manage panel under **People**. Anyone can follow another user’s camera. The **host** (browser with the board’s host secret) can turn off editing per guest and force all guests to follow the host camera. Guests without edit permission see a view-only banner; the DO also blocks document writes server-side.

## People list

### Data path

1. On connect / disconnect / canEdit change, the DO broadcasts `wb:participants` (custom message) to Connected sessions.
2. `TldrawBoard` receives it → `scsfoxchase:whiteboard-participants` window event.
3. `whiteboard-menu.ts` renders the list.

Participant row shape (`ParticipantPublic` / `ParticipantRow`):

| Field | Meaning |
|-------|---------|
| `sessionId` | Sync session id |
| `userId` | tldraw user id (needed for Follow) |
| `displayName` | Full name from connect query (Google) or empty |
| `canEdit` | Whether the session may edit |
| `isHost` | Session presented a valid host secret |

### UI columns

Header: **Name** | **Follow** | **Edit**.

| Column | Behavior |
|--------|----------|
| **Name** | Full display name, or `Guest {last6}` for anonymous; self shown as `… (you)` |
| **Follow** | Button Follow / Following; disabled for self or missing `userId` |
| **Edit** | Switch; host’s own always on; guests’ switches host-only |

Display helpers: `peopleListLabel`, `shortDisplayName` in `src/lib/whiteboard-display-name.ts`.

Cursors use the **short** form (`First L.`) via `applyPresenceName` in `TldrawBoard`; the People list uses the **full** name from the DO.

## Follow (voluntary)

Manage panel Follow buttons dispatch `scsfoxchase:whiteboard-follow` with `{ userId }`. `TldrawBoard` calls `editor.startFollowingUser` / `stopFollowingUser`.

Following state is published back as `scsfoxchase:whiteboard-following` so Follow buttons show **Following**.

While force-follow is on, guests cannot stay on another camera — unfollow / follow-other is re-asserted back to the host (see below).

## Edit permissions (host)

### API

```
PATCH /api/whiteboard/boards/:uuid/participants/:sessionId
Authorization: Bearer <hostSecret>
X-Board-Host: <hostSecret>
Content-Type: application/json

{ "canEdit": true | false }
```

Worker: `src/worker/participantRoutes.ts` → DO `handleParticipantPatch`.  
Client: `setParticipantCanEdit` in `src/lib/whiteboard-participants.ts`.

### Rules

- Host secret required (**401** / **403** if missing or wrong).
- Host session cannot be demoted (`canEdit: false` → **400**).
- Default for new connects: `canEdit: true` (host always editable).
- DO sets room session `isReadonly`, updates socket attachment, sends `wb:canEdit` to that session, then rebroadcasts People.

### Client readonly

On `wb:canEdit`, `TldrawBoard` sets the collaboration mode atom to `readonly` / `readwrite` (`applyReadonly`). That keeps `useSync` from overwriting instance `isReadonly`. A green **View only** banner appears when demoted.

## Follow Me (force-follow)

Host-only toggle beside the **People** heading in the manage panel (label **Follow Me**; same force-follow API as former “Everyone follows me”). Hidden when the browser has no host secret. Only visible while Share is Open (right column).

### API

```
PATCH /api/whiteboard/boards/:uuid/force-follow
Authorization: Bearer <hostSecret>
X-Board-Host: <hostSecret>
Content-Type: application/json

{ "forceFollow": true | false }
```

Worker: `src/worker/forceFollowRoutes.ts` → DO `handleForceFollowPatch`.  
Client: `setForceFollow` in `src/lib/whiteboard-participants.ts`.

### DO state

- Storage key `meta:forceFollow` (present when on).
- Broadcast `wb:forceFollow` with `{ forceFollow, hostUserId }` to Connected sessions (`hostUserId` from a connected host session’s tldraw `userId`).
- Also sent on connect / when a session becomes Connected.

### Guest camera lock

In `TldrawBoard`:

- Host with local secret ignores force-follow (does not lock own camera).
- Guests call `startFollowingUser(hostUserId)` when force-follow is enabled.
- A store listener re-asserts follow if the guest pans away or tries to unfollow.
- Voluntary Follow handlers refuse to leave the host camera while force-follow is on.
- Turning force-follow off stops force-following (does not clear an unrelated voluntary follow unless the force-follow path had been active).

Manage panel listens for `scsfoxchase:whiteboard-force-follow` to keep the On/Off switch in sync.

## Host secret model

| Fact | Detail |
|------|--------|
| Created | On **Create** board — 32 random bytes as hex |
| Stored | `localStorage['scsfoxchase.whiteboard.host.' + boardId]` |
| Sent | Connect query `hostSecret`; People/force-follow as Bearer + `X-Board-Host` |
| Verified | DO SHA-256 hash at `meta:hostSecretHash`; first secret wins as host |
| Scope | Host Edit + force-follow only; share codes are UUID-capability |

See [hub-and-board.md](./hub-and-board.md).

## Default permissions summary

| Action | Who |
|--------|-----|
| Open board by UUID / code | Anyone with link or open code |
| Edit canvas (default) | All connected sessions until host demotes |
| Toggle Edit for guests | Host only |
| Follow Me (force-follow) | Host only |
| Voluntary Follow | Any session (subject to force-follow) |
| Open/Close share code | Anyone with board UUID |

## Key files

| Path | Role |
|------|------|
| `src/worker/WhiteboardBoard.ts` | Participants, canEdit, force-follow, broadcasts |
| `src/worker/participantRoutes.ts` | PATCH canEdit edge |
| `src/worker/forceFollowRoutes.ts` | PATCH force-follow edge |
| `src/lib/whiteboard-participants.ts` | Client PATCH helpers + payload guards |
| `src/lib/whiteboard-display-name.ts` | Full / short / guest labels |
| `src/components/TldrawBoard.tsx` | Readonly, Follow, force-follow camera |
| `src/scripts/whiteboard-menu.ts` | People UI, Edit + force-follow toggles |
| `src/components/Header.astro` | People / force-follow markup |
