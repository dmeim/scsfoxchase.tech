import { describe, expect, it, vi } from 'vitest'
import {
	generateWhiteboardImageFileId,
	hasExcalidrawImageDataURL,
	isAllowedWhiteboardImageMime,
	resolveWhiteboardImageMime,
	WHITEBOARD_IMAGE_MIME,
} from '../src/lib/whiteboard-file-sync-plan'
import {
	FULL_RESYNC_EVERY,
	sceneBroadcastPlan,
} from '../src/lib/whiteboard-sync'

describe('whiteboard image MIME allowlist', () => {
	it('matches Worker image types: jpeg, png, gif, webp, svg', () => {
		expect([...WHITEBOARD_IMAGE_MIME].sort()).toEqual(
			[
				'image/gif',
				'image/jpeg',
				'image/png',
				'image/svg+xml',
				'image/webp',
			].sort(),
		)
		for (const mime of WHITEBOARD_IMAGE_MIME) {
			expect(isAllowedWhiteboardImageMime(mime)).toBe(true)
		}
		expect(isAllowedWhiteboardImageMime('image/jpeg; charset=utf-8')).toBe(
			true,
		)
	})

	it('rejects types that 415 on the Worker (bmp, ico, avif, heic, jfif)', () => {
		expect(isAllowedWhiteboardImageMime('image/bmp')).toBe(false)
		expect(isAllowedWhiteboardImageMime('image/x-icon')).toBe(false)
		expect(isAllowedWhiteboardImageMime('image/vnd.microsoft.icon')).toBe(
			false,
		)
		expect(isAllowedWhiteboardImageMime('image/avif')).toBe(false)
		expect(isAllowedWhiteboardImageMime('image/heic')).toBe(false)
		expect(isAllowedWhiteboardImageMime('image/heif')).toBe(false)
		expect(isAllowedWhiteboardImageMime('image/jfif')).toBe(false)
	})
})

describe('resolveWhiteboardImageMime', () => {
	it('keeps an allowed MIME from file.type', () => {
		expect(
			resolveWhiteboardImageMime({
				mimeType: 'image/jpeg; charset=utf-8',
				fileName: 'photo.png',
			}),
		).toBe('image/jpeg')
	})

	it('infers from filename when Chromebook/iPad file.type is empty', () => {
		expect(
			resolveWhiteboardImageMime({ mimeType: '', fileName: 'Screenshot.png' }),
		).toBe('image/png')
		expect(
			resolveWhiteboardImageMime({
				mimeType: 'application/octet-stream',
				fileName: 'photo.JPG',
			}),
		).toBe('image/jpeg')
		expect(
			resolveWhiteboardImageMime({ mimeType: '', fileName: 'clip.webp' }),
		).toBe('image/webp')
	})

	it('defaults empty MIME with no usable filename to image/png', () => {
		expect(resolveWhiteboardImageMime({ mimeType: '' })).toBe('image/png')
		expect(resolveWhiteboardImageMime({ mimeType: '', fileName: 'image' })).toBe(
			'image/png',
		)
	})

	it('rejects known-bad types even when the filename would otherwise match', () => {
		expect(
			resolveWhiteboardImageMime({
				mimeType: 'image/heic',
				fileName: 'photo.jpg',
			}),
		).toBeNull()
		expect(
			resolveWhiteboardImageMime({ mimeType: '', fileName: 'scan.bmp' }),
		).toBeNull()
		expect(
			resolveWhiteboardImageMime({ mimeType: '', fileName: 'photo.avif' }),
		).toBeNull()
		expect(
			resolveWhiteboardImageMime({ mimeType: '', fileName: 'img.heic' }),
		).toBeNull()
		expect(
			resolveWhiteboardImageMime({ mimeType: 'image/avif' }),
		).toBeNull()
	})
})

describe('generateWhiteboardImageFileId', () => {
	it('returns the SHA-256 hex of the file bytes and does not stage', async () => {
		const beginStaging = vi.fn()
		const file = new File([new Uint8Array([1, 2, 3, 4])], 'photo.png', {
			type: 'image/png',
		})
		const fileId = await generateWhiteboardImageFileId(file)
		expect(fileId).toMatch(/^[0-9a-f]{64}$/)
		expect(beginStaging).not.toHaveBeenCalled()
		expect(await generateWhiteboardImageFileId(file)).toBe(fileId)

		const other = new File([new Uint8Array([9, 9, 9])], 'other.png', {
			type: 'image/png',
		})
		expect(await generateWhiteboardImageFileId(other)).not.toBe(fileId)
	})
})

describe('hasExcalidrawImageDataURL', () => {
	it('is true only when BinaryFiles has a dataURL', () => {
		expect(hasExcalidrawImageDataURL(undefined)).toBe(false)
		expect(hasExcalidrawImageDataURL({ dataURL: null })).toBe(false)
		expect(
			hasExcalidrawImageDataURL({ dataURL: 'data:image/png;base64,abc' }),
		).toBe(true)
	})
})

describe('sceneBroadcastPlan', () => {
	it('excludes the writer from full scene:sync broadcasts', () => {
		expect(
			sceneBroadcastPlan({
				full: true,
				updatesSinceFullSync: 1,
				fromSessionId: 'writer-session',
			}),
		).toEqual({ type: 'scene:sync', exceptSessionId: 'writer-session' })
		expect(
			sceneBroadcastPlan({
				full: false,
				updatesSinceFullSync: FULL_RESYNC_EVERY,
				fromSessionId: 'writer-session',
			}),
		).toEqual({ type: 'scene:sync', exceptSessionId: 'writer-session' })
		expect(
			sceneBroadcastPlan({
				full: false,
				updatesSinceFullSync: 1,
				fromSessionId: 'writer-session',
			}),
		).toEqual({ type: 'scene:update', exceptSessionId: 'writer-session' })
	})
})
