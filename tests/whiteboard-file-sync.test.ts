import { describe, expect, it, vi } from 'vitest'
import {
	FORCE_FULL_FLUSH_ON_SERVER_SCENE,
	generateWhiteboardImageFileId,
	hasExcalidrawImageDataURL,
	isAllowedWhiteboardImageMime,
	planImageFileAction,
	RECOVER_PENDING_UPLOADS_ON_JOBS_PUBLISH,
	resolveWhiteboardImageMime,
	shouldDeferImageUploadWhilePending,
	shouldForceSendReadyUploadsOnTransition,
	shouldHydrateServerSceneOnce,
	shouldRestoreRecoveredImage,
	shouldRestoreRecoveredImageElement,
	stagingActionForPlan,
	WHITEBOARD_IMAGE_MIME,
	type PlanImageFileActionInput,
} from '../src/lib/whiteboard-file-sync-plan'
import {
	FULL_RESYNC_EVERY,
	sceneBroadcastPlan,
} from '../src/lib/whiteboard-sync'

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
	it('uploads Excalidraw dataURL even when hydrate is in flight', () => {
		expect(
			plan({ hasDataURL: true, hydrateInflight: true }),
		).toBe('upload')
	})

	it('treats an outbox blob as NOT hasDataURL and hydrates', () => {
		expect(hasExcalidrawImageDataURL(undefined)).toBe(false)
		expect(hasExcalidrawImageDataURL({ dataURL: null })).toBe(false)
		expect(
			hasExcalidrawImageDataURL({ dataURL: 'data:image/png;base64,abc' }),
		).toBe(true)
		expect(plan({ hasDataURL: false, r2Ready: false })).toBe('hydrate')
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

describe('generateWhiteboardImageFileId', () => {
	it('returns a UUID and does not stage', () => {
		const beginStaging = vi.fn()
		const file = new File(['png'], 'photo.png', { type: 'image/png' })
		const fileId = generateWhiteboardImageFileId(file)
		expect(fileId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
		)
		expect(beginStaging).not.toHaveBeenCalled()
		expect(generateWhiteboardImageFileId()).not.toBe(fileId)
	})
})

describe('shouldDeferImageUploadWhilePending', () => {
	it('skips upload while pendingImageElementId is that image', () => {
		expect(
			shouldDeferImageUploadWhilePending({
				fileId: FILE_A,
				pendingImageElementId: 'img-1',
				elements: [{ id: 'img-1', type: 'image', fileId: FILE_A }],
			}),
		).toBe(true)
		expect(
			shouldDeferImageUploadWhilePending({
				fileId: FILE_A,
				pendingImageElementId: null,
				elements: [{ id: 'img-1', type: 'image', fileId: FILE_A }],
			}),
		).toBe(false)
		expect(
			shouldDeferImageUploadWhilePending({
				fileId: FILE_A,
				pendingImageElementId: 'img-other',
				elements: [{ id: 'img-other', type: 'image', fileId: 'other' }],
			}),
		).toBe(false)
	})
})

describe('stagingActionForPlan', () => {
	it('completes leftover staging on skip', () => {
		expect(stagingActionForPlan('skip')).toBe('complete')
		expect(stagingActionForPlan('upload')).toBe('begin')
		expect(stagingActionForPlan('hydrate')).toBe('none')
	})
})

describe('server scene recover and flush policy', () => {
	it('does not enqueue flushNow(true) on recover or scene:sync hydrate', () => {
		expect(FORCE_FULL_FLUSH_ON_SERVER_SCENE).toBe(false)
		expect(RECOVER_PENDING_UPLOADS_ON_JOBS_PUBLISH).toBe(false)
		expect(shouldHydrateServerSceneOnce(false)).toBe(true)
		expect(shouldHydrateServerSceneOnce(true)).toBe(false)
	})

	it('force-sends ready uploads only on pending|uploading → uploaded', () => {
		expect(
			shouldForceSendReadyUploadsOnTransition('pending', 'uploaded'),
		).toBe(true)
		expect(
			shouldForceSendReadyUploadsOnTransition('uploading', 'uploaded'),
		).toBe(true)
		expect(
			shouldForceSendReadyUploadsOnTransition(undefined, 'uploaded'),
		).toBe(false)
		expect(
			shouldForceSendReadyUploadsOnTransition('uploaded', 'uploaded'),
		).toBe(false)
	})
})

describe('shouldRestoreRecoveredImageElement', () => {
	it('skips tombstones and live fileId matches', () => {
		expect(
			shouldRestoreRecoveredImageElement({
				snapshotIsDeleted: true,
				liveIsDeleted: false,
				liveHasSameFileId: false,
				hasLocalDataURL: true,
			}),
		).toBe(false)
		expect(
			shouldRestoreRecoveredImageElement({
				snapshotIsDeleted: false,
				liveIsDeleted: true,
				liveHasSameFileId: false,
				hasLocalDataURL: true,
			}),
		).toBe(false)
		expect(
			shouldRestoreRecoveredImageElement({
				snapshotIsDeleted: false,
				liveIsDeleted: false,
				liveHasSameFileId: true,
				hasLocalDataURL: true,
			}),
		).toBe(false)
		expect(
			shouldRestoreRecoveredImageElement({
				snapshotIsDeleted: false,
				liveIsDeleted: false,
				liveHasSameFileId: false,
				hasLocalDataURL: true,
			}),
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
