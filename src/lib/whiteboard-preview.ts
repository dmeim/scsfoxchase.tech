/**
 * Capture a fit-to-content JPEG of the Excalidraw scene and store it as a
 * canvas R2 asset. Hub Recents/Library cards read `previewDataUrl`.
 */
import { exportToBlob, MIME_TYPES } from '@excalidraw/excalidraw'
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type {
	BinaryFiles,
	ExcalidrawImperativeAPI,
} from '@excalidraw/excalidraw/types'
import { uploadCanvasBytes } from './whiteboard-assets'
import { patchCloudBoardPreview } from './whiteboard-cloud'
import { isSignedIn } from './whiteboard-identity'
import {
	getEntryActive,
	getHostSecret,
	getOwnerKey,
} from '../scripts/whiteboard-library'
import {
	buildPreviewDataUrl,
	parsePreviewAsset,
} from './whiteboard-preview-url'

export const PREVIEW_IDLE_MS = 10_000
/** Chrome keepalive body cap is ~64 KiB; stay under it on hide/pagehide. */
export const PREVIEW_KEEPALIVE_MAX_BYTES = 50 * 1024
/**
 * Export can briefly fail while Excalidraw is applying a scene or loading an
 * image. Retries are deliberately finite and are scheduled only while the
 * page is visible by the canvas orchestration.
 */
export const PREVIEW_EXPORT_RETRY_DELAYS_MS = [1000, 2500, 5000] as const

const PREVIEW_MAX_SIDE = 800
const PREVIEW_JPEG_QUALITY = 0.7
const PREVIEW_PADDING = 16

export type PreviewUploadResult =
	| 'uploaded'
	| 'skipped-unsaved'
	| 'skipped-not-owner'
	| 'skipped-deleted'

export type PreviewCoordinator = {
	scheduleCapture(): void
	capture(): void
	persist(): void
	visible(): void
	invalidate(): void
	dispose(): void
}

type PreviewCoordinatorOptions = {
	getVersion: () => number
	canCapture: () => boolean
	exportPreview: () => Promise<Blob | null>
	uploadPreview: (
		blob: Blob,
		keepalive: boolean,
	) => Promise<PreviewUploadResult>
	isVisible: () => boolean
	setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
	clearTimer: (timer: ReturnType<typeof setTimeout>) => void
	onTerminalStatus?: (status: 'skipped-not-owner' | 'skipped-deleted') => void
}

type PreviewLifecycleTarget = {
	window: Pick<Window, 'addEventListener' | 'removeEventListener'>
	document: Pick<
		Document,
		'addEventListener' | 'removeEventListener' | 'visibilityState'
	>
}

/**
 * Bind the lifecycle events that drive the coordinator. Keeping this seam
 * separate from React makes the actual pagehide/visibility wiring testable
 * without rendering Excalidraw or matching component source text.
 */
export function bindPreviewLifecycle(
	target: PreviewLifecycleTarget,
	handlers: { persist: () => void; visible: () => void },
): () => void {
	const persist = () => handlers.persist()
	const onVisibility = () => {
		if (target.document.visibilityState === 'hidden') persist()
		else handlers.visible()
	}
	target.window.addEventListener('pagehide', persist)
	target.document.addEventListener('visibilitychange', onVisibility)
	return () => {
		target.window.removeEventListener('pagehide', persist)
		target.document.removeEventListener('visibilitychange', onVisibility)
	}
}

/**
 * Coordinate preview export/upload work without relying on browser globals.
 * The canvas supplies visibility, timer, and scene callbacks; tests can use
 * deferred promises to exercise hide/pagehide and version races directly.
 */
export function createPreviewCoordinator(
	options: PreviewCoordinatorOptions,
): PreviewCoordinator {
	let disposed = false
	let generation = 0
	let timer: ReturnType<typeof setTimeout> | null = null
	let captureFlight: Promise<void> | null = null
	let uploadFlight: Promise<void> | null = null
	let uploadVersion = 0
	let retryKeepalive = false
	let retryState: { version: number; attempts: number } | null = null
	let cachedBlob: Blob | null = null
	let cachedVersion = 0
	let uploadedVersion = 0
	let keepaliveIntent: number | null = null

	const clearScheduled = () => {
		if (timer == null) return
		options.clearTimer(timer)
		timer = null
	}

	/**
	 * Invalidate every result belonging to the previous Excalidraw API or role
	 * generation. Promises cannot be cancelled, so their callbacks also check
	 * this epoch before touching cache or starting an upload.
	 */
	function invalidate() {
		generation += 1
		clearScheduled()
		captureFlight = null
		uploadFlight = null
		retryKeepalive = false
		retryState = null
		cachedBlob = null
		cachedVersion = 0
		uploadedVersion = 0
		keepaliveIntent = null
	}

	const uploadCached = (keepalive: boolean) => {
		if (disposed) return
		if (!options.canCapture()) {
			invalidate()
			return
		}
		if (!cachedBlob || cachedVersion === 0) return
		const version = cachedVersion
		if (version === uploadedVersion) {
			if (keepaliveIntent === version) keepaliveIntent = null
			return
		}
		if (keepalive && cachedBlob.size > PREVIEW_KEEPALIVE_MAX_BYTES) {
			if (keepaliveIntent === version) keepaliveIntent = null
			return
		}

		if (uploadFlight) {
			if (uploadVersion !== version && keepalive) retryKeepalive = true
			return
		}

		uploadVersion = version
		const flightGeneration = generation
		const flight = options
			.uploadPreview(cachedBlob, keepalive)
			.then((status) => {
				if (disposed || flightGeneration !== generation) return
				if (status === 'skipped-not-owner' || status === 'skipped-deleted') {
					if (keepaliveIntent === version) keepaliveIntent = null
					options.onTerminalStatus?.(status)
					invalidate()
					return
				}
				if (status === 'uploaded') {
					uploadedVersion = version
					if (keepaliveIntent === version) keepaliveIntent = null
				}
			})
			.catch(() => {
				// Preserve the cached blob for the next visible or lifecycle pass.
			})
			.finally(() => {
				if (uploadFlight !== flight) return
				uploadFlight = null
				if (disposed || flightGeneration !== generation) return
				const shouldKeepalive =
					retryKeepalive || keepaliveIntent === cachedVersion
				retryKeepalive = false
				if (
					cachedVersion !== version &&
					(shouldKeepalive || options.isVisible())
				) {
					uploadCached(shouldKeepalive)
				}
			})
		uploadFlight = flight
	}

	const scheduleRetry = (version: number) => {
		if (disposed || !options.isVisible()) return
		const retryGeneration = generation
		let state = retryState
		if (!state || state.version !== version) {
			state = { version, attempts: 0 }
			retryState = state
		}
		if (state.attempts >= PREVIEW_EXPORT_RETRY_DELAYS_MS.length) return
		const delay = PREVIEW_EXPORT_RETRY_DELAYS_MS[state.attempts]
		state.attempts += 1
		clearScheduled()
		timer = options.setTimer(() => {
			timer = null
			if (disposed || retryGeneration !== generation) return
			if (options.isVisible()) capture()
		}, delay)
	}

	function capture() {
		if (disposed) return
		if (!options.canCapture()) {
			invalidate()
			return
		}
		const version = options.getVersion()
		if (version === 0) return
		if (cachedBlob && cachedVersion === version) {
			const keepalive = keepaliveIntent === version
			if (options.isVisible() || keepalive) uploadCached(keepalive)
			return
		}
		if (captureFlight) return

		const flightGeneration = generation
		const flight = options
			.exportPreview()
			.then((blob) => {
				if (disposed || flightGeneration !== generation) return
				if (!options.canCapture()) {
					invalidate()
					return
				}
				const currentVersion = options.getVersion()
				if (!blob) {
					if (currentVersion === version) scheduleRetry(version)
					return
				}
				// A slower export for an older scene must never replace a newer
				// cached preview or be uploaded as the current one.
				if (
					version < cachedVersion ||
					version < currentVersion
				) {
					return
				}
				cachedBlob = blob
				cachedVersion = version
				retryState = null
				const keepalive = keepaliveIntent === version
				if (options.isVisible() || keepalive) uploadCached(keepalive)
			})
			.catch(() => {
				if (disposed || flightGeneration !== generation) return
				if (!options.canCapture()) {
					invalidate()
					return
				}
				if (options.getVersion() === version) scheduleRetry(version)
			})
			.finally(() => {
				if (captureFlight !== flight) return
				captureFlight = null
				if (disposed || flightGeneration !== generation) return
				const nextVersion = options.getVersion()
				if (
					nextVersion !== version &&
					nextVersion !== 0 &&
					options.isVisible()
				) {
					capture()
				}
			})
		captureFlight = flight
	}

	const scheduleCapture = () => {
		if (disposed) return
		if (!options.canCapture()) {
			invalidate()
			return
		}
		clearScheduled()
		timer = options.setTimer(() => {
			timer = null
			if (options.isVisible()) capture()
		}, PREVIEW_IDLE_MS)
	}

	const persist = () => {
		if (disposed) return
		if (!options.canCapture()) {
			invalidate()
			return
		}
		const version = options.getVersion()
		if (version && version !== uploadedVersion) {
			keepaliveIntent = Math.max(keepaliveIntent ?? 0, version)
		}
		uploadCached(true)
	}

	const visible = () => {
		if (disposed) return
		if (!options.canCapture()) {
			invalidate()
			return
		}
		uploadCached(false)
		capture()
	}

	const dispose = () => {
		if (disposed) return
		invalidate()
		disposed = true
	}

	return {
		scheduleCapture,
		capture,
		persist,
		visible,
		invalidate,
		dispose,
	}
}

function sceneImageFilesReady(
	elements: readonly OrderedExcalidrawElement[],
	files: BinaryFiles,
): boolean {
	for (const element of elements) {
		if (element.isDeleted || element.type !== 'image') continue
		const fileId = 'fileId' in element ? element.fileId : null
		if (!fileId) continue
		if (!files[fileId]?.dataURL) return false
	}
	return true
}

export function previewExportBlockReason(
	api: ExcalidrawImperativeAPI,
): 'empty' | 'files' | null {
	const elements = api.getSceneElements()
	if (elements.length === 0) return 'empty'
	if (!sceneImageFilesReady(elements, api.getFiles())) return 'files'
	return null
}

export function canExportBoardPreview(api: ExcalidrawImperativeAPI): boolean {
	return previewExportBlockReason(api) === null
}

export async function exportBoardPreview(
	api: ExcalidrawImperativeAPI,
): Promise<Blob | null> {
	if (!canExportBoardPreview(api)) return null
	try {
		const blob = await exportToBlob({
			elements: api.getSceneElements(),
			appState: {
				...api.getAppState(),
				exportBackground: true,
				exportWithDarkMode: false,
			},
			files: api.getFiles(),
			maxWidthOrHeight: PREVIEW_MAX_SIDE,
			exportPadding: PREVIEW_PADDING,
			mimeType: MIME_TYPES.jpg,
			quality: PREVIEW_JPEG_QUALITY,
		})
		if (!blob || blob.size === 0) return null
		return blob
	} catch {
		return null
	}
}

function uuidFromDigest(digest: Uint8Array): string {
	const hex = Array.from(digest)
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
		.slice(0, 32)
		.split('')
	// UUID v5-shaped bytes keep the existing UUID-only preview URL contract;
	// the value is content-addressed, not randomly regenerated per retry.
	hex[12] = '5'
	hex[16] = ((Number.parseInt(hex[16] || '0', 16) & 0x3) | 0x8)
		.toString(16)
	return [
		hex.slice(0, 8).join(''),
		hex.slice(8, 12).join(''),
		hex.slice(12, 16).join(''),
		hex.slice(16, 20).join(''),
		hex.slice(20, 32).join(''),
	].join('-')
}

function fallbackPreviewDigest(input: string): Uint8Array {
	// This is only for runtimes without SubtleCrypto. It remains deterministic
	// and local, so a retry cannot fall back to a fresh UUID/object key.
	const words = [2166136261, 2246822519, 3266489917, 668265263]
	for (let index = 0; index < input.length; index += 1) {
		const code = input.charCodeAt(index)
		for (let word = 0; word < words.length; word += 1) {
			words[word] = Math.imul(words[word] ^ (code + word), 16777619) >>> 0
		}
	}
	const digest = new Uint8Array(16)
	words.forEach((word, index) => {
		digest[index * 4] = word >>> 24
		digest[index * 4 + 1] = word >>> 16
		digest[index * 4 + 2] = word >>> 8
		digest[index * 4 + 3] = word
	})
	return digest
}

async function stablePreviewAssetId(boardId: string, blob: Blob): Promise<string> {
	const bytes = await blob.arrayBuffer()
	const boardBytes = new TextEncoder().encode(`${boardId}\u0000`)
	const input = new Uint8Array(boardBytes.byteLength + bytes.byteLength)
	input.set(boardBytes)
	input.set(new Uint8Array(bytes), boardBytes.byteLength)
	const subtle = globalThis.crypto?.subtle
	if (subtle) {
		try {
			return uuidFromDigest(
				new Uint8Array(await subtle.digest('SHA-256', input)),
			)
		} catch {
			// Fall through to the deterministic local digest.
		}
	}
	return uuidFromDigest(fallbackPreviewDigest(`${boardId}\u0000${blob.size}:${blob.type}`))
}

export async function uploadBoardPreview(opts: {
	boardId: string
	blob: Blob
	keepalive?: boolean
}): Promise<PreviewUploadResult> {
	if (!isSignedIn()) return 'skipped-not-owner'

	const existing = await getEntryActive(opts.boardId)
	if (!existing) {
		return getHostSecret(opts.boardId) ? 'skipped-unsaved' : 'skipped-not-owner'
	}

	const ownerKey = getOwnerKey()
	if (!ownerKey.startsWith('google:')) return 'skipped-unsaved'

	const parsed = parsePreviewAsset(existing?.previewDataUrl)
	const assetId = parsed?.assetId ?? (await stablePreviewAssetId(opts.boardId, opts.blob))
	const previewDataUrl = buildPreviewDataUrl(ownerKey, assetId, Date.now())

	await uploadCanvasBytes({
		ownerKey,
		fileId: assetId,
		bytes: opts.blob,
		mimeType: MIME_TYPES.jpg,
		kind: 'preview',
		keepalive: opts.keepalive,
	})

	// The metadata operation is intentionally conditional. The initial GET is
	// only used to select the existing preview asset id; a concurrent DELETE
	// must not be turned back into a library row by this upload.
	const patched = await patchCloudBoardPreview(
		opts.boardId,
		previewDataUrl,
		{ keepalive: opts.keepalive },
	)
	if (!patched) return 'skipped-deleted'

	return 'uploaded'
}
