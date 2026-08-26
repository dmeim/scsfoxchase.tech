/**
 * Client helpers for share codes.
 * Routes: /api/whiteboard/join/:code, /api/whiteboard/boards/:uuid/code
 *
 * Join is unauthenticated. Board code GET/POST send host proof,
 * live session token, and/or Clerk session — Owner/Manager only on the DO.
 * One code per board, minted once, no Open/Closed/rotate.
 */

import { getAuthHeaders } from './whiteboard-identity'
import { getBoardSessionAuth } from './whiteboard-participants'
import { getHostSecret } from '../scripts/whiteboard-library'

export type ShareCodeState = {
  code: string | null
}

const JOIN_UNAVAILABLE =
  "That code isn't available. Ask for a new code or open the board link."

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

async function shareAdminHeaders(boardId: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {}
  const hostSecret = getHostSecret(boardId)
  if (hostSecret) {
    headers['X-Board-Host'] = hostSecret
  }
  const sessionAuth = getBoardSessionAuth(boardId)
  if (sessionAuth) {
    headers['X-Board-Session'] = sessionAuth.sessionId
    headers['X-Board-Auth'] = sessionAuth.authToken
  }
  const clerkHeaders = await getAuthHeaders()
  if (clerkHeaders.Authorization) {
    headers.Authorization = clerkHeaders.Authorization
  } else if (hostSecret) {
    headers.Authorization = `Bearer ${hostSecret}`
  }
  return headers
}

export async function lookupShareCode(code: string): Promise<string> {
  const res = await fetch(`/api/whiteboard/join/${encodeURIComponent(code)}`)
  const body = await readJson(res)
  if (!res.ok) {
    throw new Error(errorMessage(body, JOIN_UNAVAILABLE))
  }
  if (typeof body.id !== 'string' || !body.id) {
    throw new Error(JOIN_UNAVAILABLE)
  }
  return body.id
}

export async function fetchBoardShareCode(boardId: string): Promise<ShareCodeState> {
  const res = await fetch(`/api/whiteboard/boards/${encodeURIComponent(boardId)}/code`, {
    headers: await shareAdminHeaders(boardId),
  })
  const body = await readJson(res)
  if (!res.ok) {
    throw new Error(errorMessage(body, 'Could not load share code.'))
  }
  const code = typeof body.code === 'string' ? body.code : null
  return { code }
}

/** Mint if the board has no code yet; otherwise return the existing code. */
export async function ensureBoardShareCode(boardId: string): Promise<ShareCodeState> {
  const res = await fetch(
    `/api/whiteboard/boards/${encodeURIComponent(boardId)}/code`,
    {
      method: 'POST',
      headers: await shareAdminHeaders(boardId),
    },
  )
  const body = await readJson(res)
  if (!res.ok) {
    throw new Error(errorMessage(body, 'Could not load share code.'))
  }
  const code = typeof body.code === 'string' ? body.code : null
  if (!code) {
    throw new Error('Could not load share code.')
  }
  return { code }
}
