/**
 * Board-scoped write proof for canvas asset PUTs.
 *
 * Clerk `Authorization` is never enough. The Worker requires `X-Board-Host`
 * (scratch Owner secret) or a live `X-Board-Session` + `X-Board-Auth` pair
 * from hello. Missing proof must fail closed as auth-blocked (401), not hang
 * and not look like a permanent upload failure.
 */
import { getHostSecret } from '../scripts/whiteboard-library'
import { getBoardSessionAuth } from './whiteboard-participants'

export const WHITEBOARD_HELLO_EVENT = 'scsfoxchase:whiteboard-hello'
export const WHITEBOARD_AUTH_EVENT = 'scsfoxchase:whiteboard-auth'
export const WHITEBOARD_AUTH_READY_EVENT = 'scsfoxchase:whiteboard-auth-ready'

export const BOARD_WRITE_PROOF_REQUIRED_STATUS = 401
export const BOARD_WRITE_PROOF_REQUIRED_MESSAGE =
	'Board host or session proof is required to upload.'

export function boardWriteProofRequiredError(
	message = BOARD_WRITE_PROOF_REQUIRED_MESSAGE,
): Error & { status: number } {
	const error = new Error(message) as Error & { status: number }
	error.status = BOARD_WRITE_PROOF_REQUIRED_STATUS
	return error
}

function nonEmpty(value: string | null | undefined): string | null {
	const trimmed = value?.trim() ?? ''
	return trimmed || null
}

/** True when this board has a host secret or a live session id + auth token. */
export function hasBoardWriteProof(boardId: string): boolean {
	if (!boardId) return false
	if (nonEmpty(getHostSecret(boardId))) return true
	const session = getBoardSessionAuth(boardId)
	return Boolean(nonEmpty(session?.sessionId) && nonEmpty(session?.authToken))
}

/**
 * Whether outbound headers include Worker write proof.
 * `Authorization` (Clerk JWT) is ignored.
 */
export function headersHaveBoardWriteProof(
	headers: Record<string, string>,
): boolean {
	if (nonEmpty(headers['X-Board-Host'])) return true
	return Boolean(
		nonEmpty(headers['X-Board-Session']) && nonEmpty(headers['X-Board-Auth']),
	)
}

function getBrowserWindow(): EventTarget | undefined {
	if (typeof window !== 'undefined') return window
	const nested = (globalThis as { window?: EventTarget }).window
	if (nested && typeof nested.addEventListener === 'function') return nested
	return undefined
}

/**
 * Resolves once host secret or live session pair exists for `boardId`.
 * Listens for hello / auth / auth-ready (the same events that resume the
 * upload outbox). Timeout rejects with 401 so callers classify as
 * auth-blocked, never permanent-failure.
 */
export function waitForBoardWriteProof(
	boardId: string,
	timeoutMs: number,
): Promise<void> {
	if (hasBoardWriteProof(boardId)) return Promise.resolve()
	const target = getBrowserWindow()
	if (!target || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		return Promise.reject(boardWriteProofRequiredError())
	}
	return new Promise((resolve, reject) => {
		let settled = false
		let timer: ReturnType<typeof setTimeout> | undefined
		const finish = (error?: Error) => {
			if (settled) return
			settled = true
			if (timer !== undefined) globalThis.clearTimeout(timer)
			target.removeEventListener(WHITEBOARD_HELLO_EVENT, onEvent)
			target.removeEventListener(WHITEBOARD_AUTH_EVENT, onEvent)
			target.removeEventListener(WHITEBOARD_AUTH_READY_EVENT, onEvent)
			if (error) reject(error)
			else resolve()
		}
		const onEvent = () => {
			if (hasBoardWriteProof(boardId)) finish()
		}
		target.addEventListener(WHITEBOARD_HELLO_EVENT, onEvent)
		target.addEventListener(WHITEBOARD_AUTH_EVENT, onEvent)
		target.addEventListener(WHITEBOARD_AUTH_READY_EVENT, onEvent)
		if (hasBoardWriteProof(boardId)) {
			finish()
			return
		}
		timer = globalThis.setTimeout(() => {
			finish(boardWriteProofRequiredError())
		}, timeoutMs)
	})
}
