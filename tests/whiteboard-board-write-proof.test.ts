import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardSessionAuth } from '../src/lib/whiteboard-participants'

const { getHostSecret, getBoardSessionAuth, getAuthHeaders } = vi.hoisted(() => ({
	getHostSecret: vi.fn((): string | null => null),
	getBoardSessionAuth: vi.fn((): BoardSessionAuth | null => null),
	getAuthHeaders: vi.fn(async (): Promise<Record<string, string>> => ({})),
}))

vi.mock('../src/scripts/whiteboard-library', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/scripts/whiteboard-library')>()
	return { ...actual, getHostSecret }
})

vi.mock('../src/lib/whiteboard-participants', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/lib/whiteboard-participants')>()
	return { ...actual, getBoardSessionAuth }
})

vi.mock('../src/lib/whiteboard-identity', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/lib/whiteboard-identity')>()
	return { ...actual, getAuthHeaders }
})

import {
	boardAssetWriteHeaders,
	uploadBoardAssetBytes,
} from '../src/lib/whiteboard-assets'
import {
	hasBoardWriteProof,
	headersHaveBoardWriteProof,
} from '../src/lib/whiteboard-board-write-proof'

const BOARD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FILE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const sessionPair = (): BoardSessionAuth => ({
	sessionId: 'live-session',
	authToken: 'live-auth-token',
	role: 'editor',
})

beforeEach(() => {
	getHostSecret.mockReturnValue(null)
	getBoardSessionAuth.mockReturnValue(null)
	getAuthHeaders.mockResolvedValue({})
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(null, { status: 201 })),
	)
})

afterEach(() => {
	vi.unstubAllGlobals()
	vi.clearAllMocks()
})

describe('hasBoardWriteProof', () => {
	it('is false without host secret or session pair', () => {
		expect(hasBoardWriteProof(BOARD_ID)).toBe(false)
	})

	it('is true when a host secret exists', () => {
		getHostSecret.mockReturnValue('scratch-host-secret')
		expect(hasBoardWriteProof(BOARD_ID)).toBe(true)
	})

	it('is true when a live session pair exists', () => {
		getBoardSessionAuth.mockReturnValue(sessionPair())
		expect(hasBoardWriteProof(BOARD_ID)).toBe(true)
	})

	it('ignores Clerk Authorization; JWT alone is not write proof', () => {
		getAuthHeaders.mockResolvedValue({ Authorization: 'Bearer clerk-jwt' })
		expect(hasBoardWriteProof(BOARD_ID)).toBe(false)
		expect(
			headersHaveBoardWriteProof({
				Authorization: 'Bearer clerk-jwt',
				'X-Board-Id': BOARD_ID,
			}),
		).toBe(false)
	})

	it('requires both session id and auth token', () => {
		getBoardSessionAuth.mockReturnValue({
			sessionId: 'live-session',
			authToken: '',
			role: 'editor',
		})
		expect(hasBoardWriteProof(BOARD_ID)).toBe(false)
	})
})

describe('boardAssetWriteHeaders / uploadBoardAssetBytes', () => {
	it('throws 401 and does not fetch without host, session, or Clerk JWT', async () => {
		await expect(boardAssetWriteHeaders(BOARD_ID)).rejects.toMatchObject({
			status: 401,
		})
		await expect(
			uploadBoardAssetBytes({
				boardId: BOARD_ID,
				fileId: FILE_ID,
				bytes: new Blob(['img'], { type: 'image/png' }),
				mimeType: 'image/png',
			}),
		).rejects.toMatchObject({ status: 401 })
		expect(fetch).not.toHaveBeenCalled()
	})

	it('attaches a Clerk JWT and fetches when that is the only proof', async () => {
		getAuthHeaders.mockResolvedValue({ Authorization: 'Bearer clerk-jwt' })
		const headers = await boardAssetWriteHeaders(BOARD_ID)
		expect(headers).toMatchObject({
			Authorization: 'Bearer clerk-jwt',
			'X-Board-Id': BOARD_ID,
		})
		expect(headersHaveBoardWriteProof(headers)).toBe(false)

		await uploadBoardAssetBytes({
			boardId: BOARD_ID,
			fileId: FILE_ID,
			bytes: new Blob(['img'], { type: 'image/png' }),
			mimeType: 'image/png',
		})
		expect(fetch).toHaveBeenCalledTimes(1)
		const [, init] = vi.mocked(fetch).mock.calls[0]!
		expect(init?.method).toBe('PUT')
		expect(init?.headers).toMatchObject({
			Authorization: 'Bearer clerk-jwt',
		})
	})

	it('attaches Clerk plus host secret and fetches when host proof exists', async () => {
		getAuthHeaders.mockResolvedValue({ Authorization: 'Bearer clerk-jwt' })
		getHostSecret.mockReturnValue('scratch-host-secret')

		const headers = await boardAssetWriteHeaders(BOARD_ID)
		expect(headers).toMatchObject({
			Authorization: 'Bearer clerk-jwt',
			'X-Board-Id': BOARD_ID,
			'X-Board-Host': 'scratch-host-secret',
		})
		expect(headers['X-Board-Session']).toBeUndefined()

		await uploadBoardAssetBytes({
			boardId: BOARD_ID,
			fileId: FILE_ID,
			bytes: new Blob(['img'], { type: 'image/png' }),
			mimeType: 'image/png',
		})
		expect(fetch).toHaveBeenCalledTimes(1)
		const [, init] = vi.mocked(fetch).mock.calls[0]!
		expect(init?.method).toBe('PUT')
		expect(init?.headers).toMatchObject({
			Authorization: 'Bearer clerk-jwt',
			'X-Board-Host': 'scratch-host-secret',
		})
	})

	it('fetches with a live session pair and without treating JWT as proof', async () => {
		getBoardSessionAuth.mockReturnValue(sessionPair())

		const headers = await boardAssetWriteHeaders(BOARD_ID)
		expect(headers).toMatchObject({
			'X-Board-Session': 'live-session',
			'X-Board-Auth': 'live-auth-token',
		})
		expect(headersHaveBoardWriteProof(headers)).toBe(true)

		await uploadBoardAssetBytes({
			boardId: BOARD_ID,
			fileId: FILE_ID,
			bytes: new Blob(['img'], { type: 'image/png' }),
			mimeType: 'image/png',
		})
		expect(fetch).toHaveBeenCalledTimes(1)
	})
})
