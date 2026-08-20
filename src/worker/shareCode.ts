/**
 * Share-code helpers shared by Worker join lookup and WhiteboardBoard DO.
 * Format: eight characters, letter-digit four times, TTL 12h.
 * Treat live codes as secrets (do not project them where a hallway can see).
 */

export const SHARE_CODE_TTL_SECONDS = 12 * 60 * 60
export const SHARE_CODE_TTL_MS = SHARE_CODE_TTL_SECONDS * 1000

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const DIGITS = '0123456789'
const SHARE_CODE_PAIRS = 4

/** Letter-digit repeated four times (eight characters). */
export const SHARE_CODE_RE = /^([A-Z][0-9]){4}$/

export type ShareCodeRecord = {
	boardId: string
	exp: string
}

export function normalizeShareCode(raw: string): string | null {
	const code = raw.trim().toUpperCase()
	return SHARE_CODE_RE.test(code) ? code : null
}

export function kvCodeKey(code: string): string {
	return `code:${code}`
}

/** Sample an unused eight-character code; caller retries on collision. */
export function sampleShareCode(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(SHARE_CODE_PAIRS * 2))
	let code = ''
	for (let i = 0; i < SHARE_CODE_PAIRS; i++) {
		code += LETTERS[bytes[i * 2]! % 26]!
		code += DIGITS[bytes[i * 2 + 1]! % 10]!
	}
	return code
}

export function parseShareCodeRecord(raw: string | null): ShareCodeRecord | null {
	if (!raw) return null
	try {
		const parsed = JSON.parse(raw) as Partial<ShareCodeRecord>
		if (
			typeof parsed.boardId !== 'string' ||
			typeof parsed.exp !== 'string' ||
			!parsed.boardId ||
			!parsed.exp
		) {
			return null
		}
		return { boardId: parsed.boardId, exp: parsed.exp }
	} catch {
		return null
	}
}

export function isExpiredIso(exp: string, now = Date.now()): boolean {
	const t = Date.parse(exp)
	return Number.isNaN(t) || t <= now
}
