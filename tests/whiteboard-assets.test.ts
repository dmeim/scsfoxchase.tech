import { describe, expect, it } from 'vitest'
import { parsePlayerPath } from '../src/lib/whiteboard-assets'

const BOARD_ID = '11111111-1111-4111-8111-111111111111'
const FILE_ID = '22222222-2222-4222-8222-222222222222'
const HASH_ID = 'a'.repeat(64)

describe('whiteboard player compatibility links', () => {
	it('parses legacy owner-key player links', () => {
		expect(
			parsePlayerPath(
				`/whiteboard-player?owner=${encodeURIComponent(`temp:${BOARD_ID}`)}&id=${FILE_ID}`,
			),
		).toEqual({
			ownerKey: `temp:${BOARD_ID}`,
			fileId: FILE_ID,
			boardId: '',
		})
	})

	it('parses board-scoped content-hash player links', () => {
		expect(
			parsePlayerPath(`/whiteboard-player?board=${BOARD_ID}&id=${HASH_ID}`),
		).toEqual({ ownerKey: '', fileId: HASH_ID, boardId: BOARD_ID })
	})

	it('rejects a player link without an owner or board capability', () => {
		expect(parsePlayerPath(`/whiteboard-player?id=${FILE_ID}`)).toBeNull()
	})
})
