/**
 * Share-code helpers shared by Worker join lookup and WhiteboardBoard DO.
 * Format: A1B2 ([A-Z][0-9][A-Z][0-9]), TTL 12h.
 */

export const SHARE_CODE_TTL_SECONDS = 12 * 60 * 60
export const SHARE_CODE_TTL_MS = SHARE_CODE_TTL_SECONDS * 1000

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const DIGITS = '0123456789'

export const SHARE_CODE_RE = /^[A-Z][0-9][A-Z][0-9]$/

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

/** Sample unused A1B2; caller retries on collision. */
export function sampleShareCode(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(4))
	return (
		LETTERS[bytes[0]! % 26]! +
		DIGITS[bytes[1]! % 10]! +
		LETTERS[bytes[2]! % 26]! +
		DIGITS[bytes[3]! % 10]!
	)
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
