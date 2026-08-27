import { describe, expect, it } from 'vitest'
import {
	isAllowedWhiteboardImageMime,
	planImageFileAction,
	resolveWhiteboardImageMime,
	shouldRestoreRecoveredImage,
	WHITEBOARD_IMAGE_MIME,
	type PlanImageFileActionInput,
} from '../src/lib/whiteboard-file-sync-plan'

const FILE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function plan(
	partial: Partial<PlanImageFileActionInput> = {},
): ReturnType<typeof planImageFileAction> {
	return planImageFileAction({
		fileId: FILE_A,
		hasDataURL: false,
		r2Ready: false,
		uploadInflight: false,
		hydrateInflight: false,
		...partial,
	})
}

describe('planImageFileAction', () => {
	it('uploads local dataURL even when hydrate is in flight', () => {
		expect(
			plan({ hasDataURL: true, hydrateInflight: true }),
		).toBe('upload')
	})

	it('treats an outbox blob as local bytes (hasDataURL) and uploads', () => {
		expect(plan({ hasDataURL: true, r2Ready: false })).toBe('upload')
	})

	it('skips when a local upload is already in flight', () => {
		expect(
			plan({ hasDataURL: true, uploadInflight: true }),
		).toBe('skip')
	})

	it('skips upload-inflight even before a dataURL exists', () => {
		expect(
			plan({ hasDataURL: false, uploadInflight: true }),
		).toBe('skip')
	})

	it('skips when the file is already r2-ready, even with a dataURL', () => {
		expect(plan({ hasDataURL: true, r2Ready: true })).toBe('skip')
	})

	it('hydrates when there are no local bytes', () => {
		expect(plan({ hasDataURL: false })).toBe('hydrate')
	})

	it('does not start a second hydrate while one is in flight', () => {
		expect(
			plan({ hasDataURL: false, hydrateInflight: true }),
		).toBe('skip')
	})

	it('hydrates r2-ready files that still have no local bytes', () => {
		expect(plan({ hasDataURL: false, r2Ready: true })).toBe('hydrate')
	})

	it('prefers upload over hydrate when both inflight flags are set and bytes exist', () => {
		expect(
			plan({
				hasDataURL: true,
				uploadInflight: false,
				hydrateInflight: true,
			}),
		).toBe('upload')
	})
})

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

describe('shouldRestoreRecoveredImage', () => {
	it('restores only when BinaryFiles has a dataURL after addFiles', () => {
		expect(
			shouldRestoreRecoveredImage({
				hasLocalDataURL: true,
				hasBlob: true,
				conversionOk: true,
			}),
		).toBe(true)
	})

	it('does not restore when the blob is missing', () => {
		expect(
			shouldRestoreRecoveredImage({
				hasLocalDataURL: false,
				hasBlob: false,
				conversionOk: false,
			}),
		).toBe(false)
	})

	it('does not restore when conversion failed, even if a blob exists', () => {
		expect(
			shouldRestoreRecoveredImage({
				hasLocalDataURL: false,
				hasBlob: true,
				conversionOk: false,
			}),
		).toBe(false)
	})

	it('does not restore an uploaded file that still has no local dataURL', () => {
		expect(
			shouldRestoreRecoveredImage({
				hasLocalDataURL: false,
				hasBlob: false,
				conversionOk: false,
			}),
		).toBe(false)
	})
})
