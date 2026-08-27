/**
 * Canvas image MIME helpers and content-addressed file ids.
 * Keep this module free of `@excalidraw/excalidraw` so tests can import it.
 *
 * `generateIdForFile` is SHA-256 of the bytes — no staging, no PUT, no
 * IndexedDB. Upload starts only after Excalidraw has a BinaryFiles dataURL.
 */

/** Image MIME types accepted by the Worker ALLOWED_MIME set. */
export const WHITEBOARD_IMAGE_MIME = new Set([
	'image/jpeg',
	'image/png',
	'image/gif',
	'image/webp',
	'image/svg+xml',
])

/** Types the Worker 415s. Never PUT these. */
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

export async function sha256HexOfBytes(bytes: BufferSource): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes)
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('')
}

/** Assign the image fileId. Callers must not stage or PUT from this function. */
export async function generateWhiteboardImageFileId(file: File): Promise<string> {
	return sha256HexOfBytes(await file.arrayBuffer())
}

export function hasExcalidrawImageDataURL(
	file?: { dataURL?: string | null } | null,
): boolean {
	return Boolean(file?.dataURL)
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
 * MIME for canvas image uploads. Empty Chromebook/iPad `file.type` infers
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
