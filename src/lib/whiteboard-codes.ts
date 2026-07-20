/**
 * Client helpers for Phase 5 share codes.
 * Routes: /api/whiteboard/join/:code, /api/whiteboard/boards/:uuid/code
 */

export type ShareCodeState = {
  code: string | null
  expiresAt: string | null
  open: boolean
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
  const res = await fetch(`/api/whiteboard/boards/${encodeURIComponent(boardId)}/code`)
  const body = await readJson(res)
  if (!res.ok) {
    throw new Error(errorMessage(body, 'Could not load share code.'))
  }
  const code = typeof body.code === 'string' ? body.code : null
  const expiresAt = typeof body.expiresAt === 'string' ? body.expiresAt : null
  return {
    code,
    expiresAt,
    open: Boolean(body.open && code),
  }
}

/** Open: mint if none, else keep current. Pass rotate to mint a new code. */
export async function openBoardShareCode(
  boardId: string,
  options: { rotate?: boolean } = {},
): Promise<ShareCodeState> {
  const qs = options.rotate ? '?rotate=1' : ''
  const res = await fetch(
    `/api/whiteboard/boards/${encodeURIComponent(boardId)}/code${qs}`,
    { method: 'POST' },
  )
  const body = await readJson(res)
  if (!res.ok) {
    throw new Error(errorMessage(body, 'Could not open share code.'))
  }
  const code = typeof body.code === 'string' ? body.code : null
  const expiresAt = typeof body.expiresAt === 'string' ? body.expiresAt : null
  if (!code || !expiresAt) {
    throw new Error('Could not open share code.')
  }
  return { code, expiresAt, open: true }
}

export async function closeBoardShareCode(boardId: string): Promise<ShareCodeState> {
  const res = await fetch(`/api/whiteboard/boards/${encodeURIComponent(boardId)}/code`, {
    method: 'DELETE',
  })
  const body = await readJson(res)
  if (!res.ok) {
    throw new Error(errorMessage(body, 'Could not close share code.'))
  }
  return { code: null, expiresAt: null, open: false }
}

/** Human remaining duration, e.g. "11h 42m". */
export function formatShareExpiry(expiresAt: string, now = Date.now()): string {
  const end = Date.parse(expiresAt)
  if (Number.isNaN(end)) return ''
  const ms = end - now
  if (ms <= 0) return 'Expired'
  const totalMin = Math.floor(ms / 60000)
  const hours = Math.floor(totalMin / 60)
  const minutes = totalMin % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m`
  return 'under a minute'
}
