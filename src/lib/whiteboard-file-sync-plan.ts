/**
 * Pure upload-vs-hydrate planner for canvas images.
 * Keep this module free of `@excalidraw/excalidraw` so tests can import it.
 *
 * Local bytes (Excalidraw dataURL or an outbox blob) always prefer upload,
 * even if a hydrate GET is already in flight. Hydrate cannot suppress PUT.
 * An upload already in flight always skips, including before local bytes
 * exist (`generateIdForFile` stages before Excalidraw has a dataURL).
 * Uploaded / r2-ready without local bytes still hydrates so GET can
 * restore pixels.
 */

/** Image MIME types accepted by the Worker ALLOWED_MIME set. */
export const WHITEBOARD_IMAGE_MIME = new Set([
	'image/jpeg',
	'image/png',
	'image/gif',
	'image/webp',
	'image/svg+xml',
])

/** Types the Worker 415s. Never stage or PUT these. */
export const REJECTED_WHITEBOARD_IMAGE_MIME = new Set([
	'image/bmp',
	'image/x-ms-bmp',
	'image/x-bmp',
	'image/x-icon',
	'image/vnd.microsoft.icon',
	'image/avif',
	'image/heic',
	'image/heif',
	'image/jfif',
])

const IMAGE_EXTENSION_MIME: Record<string, string> = {
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	bmp: 'image/bmp',
	ico: 'image/x-icon',
	avif: 'image/avif',
	heic: 'image/heic',
	heif: 'image/heif',
	jfif: 'image/jfif',
}

export type PlanImageFileAction = 'upload' | 'hydrate' | 'skip'

export type PlanImageFileActionInput = {
	fileId: string
	/** True when BinaryFiles has a dataURL or the outbox already holds a blob. */
	hasDataURL: boolean
	r2Ready: boolean
	uploadInflight: boolean
	hydrateInflight: boolean
}

export function normalizeWhiteboardImageMime(
	value: string | undefined,
): string {
	return (value || '').split(';')[0].trim().toLowerCase()
}

export function isAllowedWhiteboardImageMime(mime: string): boolean {
	return WHITEBOARD_IMAGE_MIME.has(normalizeWhiteboardImageMime(mime))
}

function extensionOfFileName(fileName: string | undefined): string {
	if (!fileName) return ''
	const base = fileName.split(/[/\\]/).pop() || ''
	const dot = base.lastIndexOf('.')
	if (dot < 0 || dot === base.length - 1) return ''
	return base.slice(dot + 1).toLowerCase()
}

/**
 * MIME for canvas image staging. Empty Chromebook/iPad `file.type` infers
 * from the filename or defaults to `image/png`. Known-bad types return null.
 */
export function resolveWhiteboardImageMime(input: {
	mimeType?: string
	fileName?: string
}): string | null {
	const mime = normalizeWhiteboardImageMime(input.mimeType)
	if (REJECTED_WHITEBOARD_IMAGE_MIME.has(mime)) return null
	if (WHITEBOARD_IMAGE_MIME.has(mime)) return mime
	if (mime && mime !== 'application/octet-stream') return null
	const fromExt = IMAGE_EXTENSION_MIME[extensionOfFileName(input.fileName)]
	if (fromExt) {
		if (REJECTED_WHITEBOARD_IMAGE_MIME.has(fromExt)) return null
		if (WHITEBOARD_IMAGE_MIME.has(fromExt)) return fromExt
		return null
	}
	return 'image/png'
}

export function planImageFileAction(
	input: PlanImageFileActionInput,
): PlanImageFileAction {
	if (input.uploadInflight) return 'skip'
	if (input.hasDataURL) {
		if (input.r2Ready) return 'skip'
		return 'upload'
	}
	if (input.hydrateInflight) return 'skip'
	return 'hydrate'
}

/**
 * Recovery may `updateScene` an outbox image snapshot only after
 * `addFiles` left a real BinaryFiles `dataURL`. Missing blobs and failed
 * conversions leave the job and do not restore, so hydrate GET can still run.
 */
export function shouldRestoreRecoveredImage(input: {
	hasLocalDataURL: boolean
	hasBlob: boolean
	conversionOk: boolean
}): boolean {
	return input.hasLocalDataURL
}
