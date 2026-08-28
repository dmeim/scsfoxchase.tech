import { describe, expect, it, vi } from 'vitest'

const {
	getEntryActive,
	getHostSecret,
	getOwnerKey,
	isSignedIn,
	patchCloudBoardPreview,
	uploadCanvasBytes,
} = vi.hoisted(() => ({
	getEntryActive: vi.fn(),
	getHostSecret: vi.fn(),
	getOwnerKey: vi.fn(),
	isSignedIn: vi.fn(),
	patchCloudBoardPreview: vi.fn(),
	uploadCanvasBytes: vi.fn(),
}))

vi.mock('@excalidraw/excalidraw', () => ({
	MIME_TYPES: { jpg: 'image/jpeg' },
	exportToBlob: vi.fn(),
}))
vi.mock('../src/scripts/whiteboard-library', () => ({
	getEntryActive,
	getHostSecret,
	getOwnerKey,
}))
vi.mock('../src/lib/whiteboard-identity', () => ({ isSignedIn }))
vi.mock('../src/lib/whiteboard-assets', () => ({ uploadCanvasBytes }))
vi.mock('../src/lib/whiteboard-cloud', () => ({ patchCloudBoardPreview }))

import { uploadBoardPreview } from '../src/lib/whiteboard-preview'
import {
	bindPreviewLifecycle,
	createPreviewCoordinator,
	PREVIEW_EXPORT_RETRY_DELAYS_MS,
} from '../src/lib/whiteboard-preview'

const BOARD_ID = '11111111-1111-4111-8111-111111111111'
const PREVIEW_ID = '22222222-2222-4222-8222-222222222222'

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

function flushPromises(): Promise<void> {
	return Promise.resolve().then(() => undefined)
}

describe('board preview upload', () => {
	it('uses the fetched board row for the metadata PUT without another list read', async () => {
		const existing = {
			id: BOARD_ID,
			title: 'Science board',
			lastAccessedAt: '2026-08-27T12:00:00.000Z',
			previewDataUrl: `/api/whiteboard/assets/google:teacher/${PREVIEW_ID}?v=1`,
		}
		isSignedIn.mockReturnValue(true)
		getEntryActive.mockResolvedValue(existing)
		getHostSecret.mockReturnValue(null)
		getOwnerKey.mockReturnValue('google:teacher')
		uploadCanvasBytes.mockResolvedValue(undefined)
		patchCloudBoardPreview.mockResolvedValue(existing)

		const blob = new Blob(['preview'], { type: 'image/jpeg' })
		await expect(
			uploadBoardPreview({ boardId: BOARD_ID, blob }),
		).resolves.toBe('uploaded')

		expect(getEntryActive).toHaveBeenCalledTimes(1)
		expect(uploadCanvasBytes).toHaveBeenCalledWith(
			expect.objectContaining({
				ownerKey: 'google:teacher',
				fileId: PREVIEW_ID,
				bytes: blob,
				kind: 'preview',
			}),
		)
		expect(patchCloudBoardPreview).toHaveBeenCalledTimes(1)
		expect(patchCloudBoardPreview).toHaveBeenCalledWith(
		BOARD_ID,
		expect.stringContaining(PREVIEW_ID),
		{ keepalive: undefined },
		)
	})

	it('does not claim membership when the conditional preview patch sees a deletion', async () => {
		const existing = {
			id: BOARD_ID,
			title: 'Science board',
			lastAccessedAt: '2026-08-27T12:00:00.000Z',
		}
		isSignedIn.mockReturnValue(true)
		getEntryActive.mockResolvedValue(existing)
		getHostSecret.mockReturnValue(null)
		getOwnerKey.mockReturnValue('google:teacher')
		uploadCanvasBytes.mockResolvedValue(undefined)
		patchCloudBoardPreview.mockResolvedValue(null)

		const result = await uploadBoardPreview({
			boardId: BOARD_ID,
			blob: new Blob(['preview'], { type: 'image/jpeg' }),
		})

		expect(result).toBe('skipped-deleted')
		expect(patchCloudBoardPreview).toHaveBeenCalledTimes(1)
	})

	it('reuses one deterministic R2 key when metadata patch retry follows an upload', async () => {
		const existing = {
			id: BOARD_ID,
			title: 'Science board',
			lastAccessedAt: '2026-08-27T12:00:00.000Z',
		}
		isSignedIn.mockReturnValue(true)
		getEntryActive.mockResolvedValue(existing)
		getHostSecret.mockReturnValue(null)
		getOwnerKey.mockReturnValue('google:teacher')
		uploadCanvasBytes.mockResolvedValue(undefined)
		patchCloudBoardPreview
			.mockRejectedValueOnce(new Error('transient ETag failure'))
			.mockResolvedValue(existing)

		const blob = new Blob(['preview'], { type: 'image/jpeg' })
		const coordinator = createPreviewCoordinator({
			getVersion: () => 12,
			canCapture: () => true,
			exportPreview: async () => blob,
			uploadPreview: (preview, keepalive) =>
				uploadBoardPreview({
					boardId: BOARD_ID,
					blob: preview,
					keepalive,
				}),
			isVisible: () => true,
			setTimer: (callback, delay) => setTimeout(callback, delay),
			clearTimer: (timer) => clearTimeout(timer),
		})

		coordinator.capture()
		await vi.waitFor(() => expect(patchCloudBoardPreview).toHaveBeenCalledTimes(1))
		expect(patchCloudBoardPreview).toHaveBeenCalledTimes(1)

		coordinator.visible()
		await vi.waitFor(() => expect(patchCloudBoardPreview).toHaveBeenCalledTimes(2))

		expect(uploadCanvasBytes).toHaveBeenCalledTimes(2)
		const firstPut = uploadCanvasBytes.mock.calls[0]?.[0]
		const secondPut = uploadCanvasBytes.mock.calls[1]?.[0]
		expect(firstPut?.fileId).toBeTruthy()
		expect(secondPut?.fileId).toBe(firstPut?.fileId)
		expect(patchCloudBoardPreview).toHaveBeenCalledTimes(2)
		coordinator.dispose()
	})

	it('drains a hidden keepalive intent through one in-flight upload', async () => {
		const exported = deferred<Blob | null>()
		const uploaded = deferred<'uploaded'>()
		let visible = true
		let version = 7
		const upload = vi.fn(() => uploaded.promise)
		const coordinator = createPreviewCoordinator({
			getVersion: () => version,
			canCapture: () => true,
			exportPreview: () => exported.promise,
			uploadPreview: upload,
			isVisible: () => visible,
			setTimer: (callback, delay) => setTimeout(callback, delay),
			clearTimer: (timer) => clearTimeout(timer),
		})

		coordinator.capture()
		visible = false
		coordinator.persist()
		exported.resolve(new Blob(['preview'], { type: 'image/jpeg' }))
		await flushPromises()
		await flushPromises()

		expect(upload).toHaveBeenCalledTimes(1)
		expect(upload).toHaveBeenCalledWith(expect.any(Blob), true)
		coordinator.persist()
		expect(upload).toHaveBeenCalledTimes(1)

		uploaded.resolve('uploaded')
		await flushPromises()
		coordinator.dispose()
	})

	it('discards an older export and uploads only the newer scene version', async () => {
		const first = deferred<Blob | null>()
		const second = deferred<Blob | null>()
		let version = 1
		const upload = vi.fn(async () => 'uploaded' as const)
		const coordinator = createPreviewCoordinator({
			getVersion: () => version,
			canCapture: () => true,
			exportPreview: vi
				.fn()
				.mockImplementationOnce(() => first.promise)
				.mockImplementationOnce(() => second.promise),
			uploadPreview: upload,
			isVisible: () => true,
			setTimer: (callback, delay) => setTimeout(callback, delay),
			clearTimer: (timer) => clearTimeout(timer),
		})

		coordinator.capture()
		version = 2
		first.resolve(new Blob(['old'], { type: 'image/jpeg' }))
		await flushPromises()
		await flushPromises()
		expect(upload).not.toHaveBeenCalled()

		second.resolve(new Blob(['new'], { type: 'image/jpeg' }))
		await flushPromises()
		await flushPromises()
		expect(upload).toHaveBeenCalledTimes(1)
		expect(await upload.mock.results[0]?.value).toBe('uploaded')
		coordinator.dispose()
	})

	it('discards an export from a remounted API generation', async () => {
		const exported = deferred<Blob | null>()
		const upload = vi.fn(async () => 'uploaded' as const)
		const coordinator = createPreviewCoordinator({
			getVersion: () => 3,
			canCapture: () => true,
			exportPreview: () => exported.promise,
			uploadPreview: upload,
			isVisible: () => true,
			setTimer: (callback, delay) => setTimeout(callback, delay),
			clearTimer: (timer) => clearTimeout(timer),
		})

		coordinator.capture()
		coordinator.invalidate()
		exported.resolve(new Blob(['old-api'], { type: 'image/jpeg' }))
		await flushPromises()
		await flushPromises()
		expect(upload).not.toHaveBeenCalled()
		coordinator.dispose()
	})

	it('discards an export that completes after dispose', async () => {
		const exported = deferred<Blob | null>()
		const upload = vi.fn(async () => 'uploaded' as const)
		const coordinator = createPreviewCoordinator({
			getVersion: () => 3,
			canCapture: () => true,
			exportPreview: () => exported.promise,
			uploadPreview: upload,
			isVisible: () => true,
			setTimer: (callback, delay) => setTimeout(callback, delay),
			clearTimer: (timer) => clearTimeout(timer),
		})

		coordinator.capture()
		coordinator.dispose()
		exported.resolve(new Blob(['disposed'], { type: 'image/jpeg' }))
		await flushPromises()
		await flushPromises()
		expect(upload).not.toHaveBeenCalled()
	})

	it('invalidates a pending export when capture becomes disallowed', async () => {
		const exported = deferred<Blob | null>()
		let allowed = true
		const upload = vi.fn(async () => 'uploaded' as const)
		const coordinator = createPreviewCoordinator({
			getVersion: () => 3,
			canCapture: () => allowed,
			exportPreview: () => exported.promise,
			uploadPreview: upload,
			isVisible: () => true,
			setTimer: (callback, delay) => setTimeout(callback, delay),
			clearTimer: (timer) => clearTimeout(timer),
		})

		coordinator.capture()
		allowed = false
		exported.resolve(new Blob(['locked'], { type: 'image/jpeg' }))
		await flushPromises()
		await flushPromises()
		expect(upload).not.toHaveBeenCalled()
		coordinator.dispose()
	})

	it('retries transient null exports with bounded backoff for an unchanged version', async () => {
		vi.useFakeTimers()
		try {
			const exportPreview = vi
				.fn()
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce(new Blob(['preview'], { type: 'image/jpeg' }))
			const upload = vi.fn(async () => 'uploaded' as const)
			const coordinator = createPreviewCoordinator({
				getVersion: () => 4,
				canCapture: () => true,
				exportPreview,
				uploadPreview: upload,
				isVisible: () => true,
				setTimer: (callback, delay) => setTimeout(callback, delay),
				clearTimer: (timer) => clearTimeout(timer),
			})

			coordinator.capture()
			for (const delay of PREVIEW_EXPORT_RETRY_DELAYS_MS) {
				await flushPromises()
				await vi.advanceTimersByTimeAsync(delay)
				await flushPromises()
				await flushPromises()
			}
			await flushPromises()
			expect(exportPreview).toHaveBeenCalledTimes(4)
			expect(upload).toHaveBeenCalledTimes(1)
			vi.advanceTimersByTime(60_000)
			expect(exportPreview).toHaveBeenCalledTimes(4)
			coordinator.dispose()
		} finally {
			vi.useRealTimers()
		}
	})

	it('wires pagehide and visibility transitions through the lifecycle seam', () => {
		const windowListeners = new Map<string, unknown>()
		const documentListeners = new Map<string, unknown>()
		let visibilityState: 'visible' | 'hidden' = 'visible'
		const target = {
			window: {
				addEventListener: vi.fn((type: string, listener: unknown) => {
					windowListeners.set(type, listener)
				}),
				removeEventListener: vi.fn((type: string) => {
					windowListeners.delete(type)
				}),
			},
			document: {
				get visibilityState() {
					return visibilityState
				},
				addEventListener: vi.fn((type: string, listener: unknown) => {
					documentListeners.set(type, listener)
				}),
				removeEventListener: vi.fn((type: string) => {
					documentListeners.delete(type)
				}),
			},
		} as unknown as Parameters<typeof bindPreviewLifecycle>[0]
		const persist = vi.fn()
		const visible = vi.fn()
		const unbind = bindPreviewLifecycle(target, { persist, visible })

		;(windowListeners.get('pagehide') as () => void)()
		visibilityState = 'hidden'
		;(documentListeners.get('visibilitychange') as () => void)()
		visibilityState = 'visible'
		;(documentListeners.get('visibilitychange') as () => void)()

		expect(persist).toHaveBeenCalledTimes(2)
		expect(visible).toHaveBeenCalledTimes(1)
		unbind()
		expect(windowListeners.has('pagehide')).toBe(false)
		expect(documentListeners.has('visibilitychange')).toBe(false)
	})
})
