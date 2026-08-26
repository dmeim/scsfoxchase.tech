/**
 * Share-code helpers shared by Worker join lookup and WhiteboardBoard DO.
 * Format: eight characters, digit-letter four times (`1A2B3C4D`). Join also
 * accepts legacy four-character `1A2B` codes. Codes last for the life of the
 * board (no KV TTL). Treat them as classroom PINs — do not project them
 * where a hallway can see.
 */

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const DIGITS = '0123456789'
const SHARE_CODE_PAIRS = 4

/** New mints: digit-letter four times (eight characters, `1A2B3C4D`). */
export const SHARE_CODE_RE = /^([0-9][A-Z]){4}$/

/** Hub / cookie / join: current 8-char or leftover 4-char (`1A2B`). */
export const SHARE_CODE_JOIN_RE = /^([0-9][A-Z]){2}(([0-9][A-Z]){2})?$/

export type ShareCodeRecord = {
	boardId: string
	exp?: string
}

export function normalizeShareCode(raw: string): string | null {
	const code = raw.trim().toUpperCase()
	return SHARE_CODE_JOIN_RE.test(code) ? code : null
}

export function kvCodeKey(code: string): string {
	return `code:${code}`
}

/** Sample an unused `1A2B3C4D`-form code; caller retries on collision. */
export function sampleShareCode(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(SHARE_CODE_PAIRS * 2))
	let code = ''
	for (let i = 0; i < SHARE_CODE_PAIRS; i++) {
		code += DIGITS[bytes[i * 2]! % 10]!
		code += LETTERS[bytes[i * 2 + 1]! % 26]!
	}
	return code
}

export function parseShareCodeRecord(raw: string | null): ShareCodeRecord | null {
	if (!raw) return null
	try {
		const parsed = JSON.parse(raw) as Partial<ShareCodeRecord>
		if (typeof parsed.boardId !== 'string' || !parsed.boardId) {
			return null
		}
		const exp =
			typeof parsed.exp === 'string' && parsed.exp ? parsed.exp : undefined
		return exp ? { boardId: parsed.boardId, exp } : { boardId: parsed.boardId }
	} catch {
		return null
	}
}

export function isExpiredIso(exp: string, now = Date.now()): boolean {
	const t = Date.parse(exp)
	return Number.isNaN(t) || t <= now
}
