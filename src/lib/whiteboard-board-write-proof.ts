/**
 * Board-scoped write proof for canvas asset PUTs.
 *
 * Clerk `Authorization` is never enough on its own for host/session proof
 * helpers. The Worker accepts `X-Board-Host`, a live `X-Board-Session` +
 * `X-Board-Auth` pair, or a Clerk JWT that the server authorizes. Missing
 * every proof fails closed as 401.
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
