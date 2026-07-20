/**
 * Client helpers for Phase 6 per-session edit permissions + force-follow.
 * PATCH /api/whiteboard/boards/:uuid/participants/:sessionId
 * PATCH /api/whiteboard/boards/:uuid/force-follow
 */

import { getHostSecret } from '../scripts/whiteboard-library'

export type ParticipantRow = {
  sessionId: string
  userId: string
  displayName: string
  canEdit: boolean
  isHost: boolean
}

export type ParticipantsPayload = {
  type: 'wb:participants'
  yourSessionId: string
  participants: ParticipantRow[]
}

export type CanEditPayload = {
  type: 'wb:canEdit'
  canEdit: boolean
}

export type ForceFollowPayload = {
  type: 'wb:forceFollow'
  forceFollow: boolean
  hostUserId: string
}

export function isParticipantsPayload(data: unknown): data is ParticipantsPayload {
  if (!data || typeof data !== 'object') return false
  const d = data as Record<string, unknown>
  return d.type === 'wb:participants' && Array.isArray(d.participants)
}

export function isCanEditPayload(data: unknown): data is CanEditPayload {
  if (!data || typeof data !== 'object') return false
  const d = data as Record<string, unknown>
  return d.type === 'wb:canEdit' && typeof d.canEdit === 'boolean'
}

export function isForceFollowPayload(data: unknown): data is ForceFollowPayload {
  if (!data || typeof data !== 'object') return false
  const d = data as Record<string, unknown>
  return (
    d.type === 'wb:forceFollow' &&
    typeof d.forceFollow === 'boolean' &&
    typeof d.hostUserId === 'string'
  )
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

function errorMessage(body: Record<string, unknown>, fallback: string): string {
  return typeof body.error === 'string' && body.error ? body.error : fallback
}

/** Host-only: set canEdit for a connected session. */
export async function setParticipantCanEdit(
  boardId: string,
  sessionId: string,
  canEdit: boolean,
): Promise<ParticipantRow> {
  const hostSecret = getHostSecret(boardId)
  if (!hostSecret) {
    throw new Error('Only the board host can change edit permissions.')
  }

  const res = await fetch(
    `/api/whiteboard/boards/${encodeURIComponent(boardId)}/participants/${encodeURIComponent(sessionId)}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hostSecret}`,
        'X-Board-Host': hostSecret,
      },
      body: JSON.stringify({ canEdit }),
    },
  )
  const body = await readJson(res)
  if (!res.ok) {
    throw new Error(errorMessage(body, 'Could not update edit permission.'))
  }

  return {
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : sessionId,
    userId: typeof body.userId === 'string' ? body.userId : '',
    displayName: typeof body.displayName === 'string' ? body.displayName : '',
    canEdit: Boolean(body.canEdit),
    isHost: Boolean(body.isHost),
  }
}

/** Host-only: force all guests to follow the host camera. */
export async function setForceFollow(
  boardId: string,
  forceFollow: boolean,
): Promise<{ forceFollow: boolean; hostUserId: string }> {
  const hostSecret = getHostSecret(boardId)
  if (!hostSecret) {
    throw new Error('Only the board host can force follow.')
  }

  const res = await fetch(
    `/api/whiteboard/boards/${encodeURIComponent(boardId)}/force-follow`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hostSecret}`,
        'X-Board-Host': hostSecret,
      },
      body: JSON.stringify({ forceFollow }),
    },
  )
  const body = await readJson(res)
  if (!res.ok) {
    throw new Error(errorMessage(body, 'Could not update force follow.'))
  }

  return {
    forceFollow: Boolean(body.forceFollow),
    hostUserId: typeof body.hostUserId === 'string' ? body.hostUserId : '',
  }
}
