/**
 * Phase 3.2 — Excalidraw canvas file hooks (images/GIF → R2, MP4/WebM → player).
 * Does not touch the WebSocket protocol, reconcileElements, or scene persist.
 */
import {
	createElement,
	useCallback,
	useEffect,
	useRef,
	type RefObject,
} from 'react'
import {
	CaptureUpdateAction,
	convertToExcalidrawElements,
} from '@excalidraw/excalidraw'
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawEmbeddableElement } from '@excalidraw/excalidraw/element/types'
import type {
	AppState,
	BinaryFileData,
	BinaryFiles,
	DataURL,
	ExcalidrawImperativeAPI,
	FileId,
} from '@excalidraw/excalidraw/types'
import {
	claimTempCanvasAssets,
	fetchBoardAssetMeta,
	fetchCanvasBytes,
	ownerKeyForBoardMeta,
	parsePlayerPath,
	playerPath,
	registerTempAssetPrefix,
	tempOwnerKey,
	uploadCanvasBytes,
	type BoardAssetMeta,
} from './whiteboard-assets'
import { isSignedIn } from './whiteboard-identity'

const IMAGE_MIME = new Set([
	'image/jpeg',
	'image/png',
	'image/gif',
	'image/webp',
	'image/svg+xml',
	'image/bmp',
	'image/x-icon',
	'image/avif',
	'image/jfif',
])

const VIDEO_MIME = new Set(['video/mp4', 'video/webm'])

const YOUTUBE_RE =
	/^(https?:\/\/)?(www\.|m\.)?(youtube\.com|youtube-nocookie\.com|youtu\.be)\//i
const VIMEO_RE = /^(https?:\/\/)?(www\.)?(vimeo\.com|player\.vimeo\.com)\//i

function asFileId(id: string): FileId {
	return id as FileId
}

function asDataURL(value: string): DataURL {
	return value as DataURL
}

function asImageMime(mime: string): BinaryFileData['mimeType'] {
	if (IMAGE_MIME.has(mime)) return mime as BinaryFileData['mimeType']
	return 'image/png'
}

function referencedImageFileIds(
	elements: readonly { type?: string; isDeleted?: boolean; fileId?: unknown }[],
): string[] {
	const ids: string[] = []
	for (const el of elements) {
		if (el.isDeleted) continue
		if (el.type === 'image' && typeof el.fileId === 'string' && el.fileId) {
			ids.push(el.fileId)
		}
	}
	return ids
}

function isSelfPlayerLink(link: string): boolean {
	return parsePlayerPath(link) !== null
}

export function validateWhiteboardEmbeddable(
	link: string,
): boolean | undefined {
	if (isSelfPlayerLink(link)) return true
	if (YOUTUBE_RE.test(link) || VIMEO_RE.test(link)) return undefined
	return false
}

export function renderWhiteboardEmbeddable(
	element: ExcalidrawEmbeddableElement,
): ReturnType<typeof createElement> | null {
	const link = element.link
	if (!link || !isSelfPlayerLink(link)) return null
	return createElement('iframe', {
		src: link,
		title: 'Video',
		allow: 'fullscreen',
		referrerPolicy: 'no-referrer',
		style: {
			border: 0,
			width: '100%',
			height: '100%',
			background: '#000',
		},
	})
}

export async function generateWhiteboardFileId(_file: File): Promise<string> {
	return crypto.randomUUID()
}

async function blobToDataURL(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () => {
			if (typeof reader.result === 'string') resolve(reader.result)
			else reject(new Error('Failed to read file'))
		}
		reader.onerror = () => reject(reader.error ?? new Error('File read failed'))
		reader.readAsDataURL(blob)
	})
}

async function dataURLToBlob(dataURL: string): Promise<Blob> {
	const res = await fetch(dataURL)
	return res.blob()
}

function viewportCenter(
	appState: AppState,
	width: number,
	height: number,
): { x: number; y: number } {
	const zoom =
		typeof appState.zoom === 'number'
			? appState.zoom
			: (appState.zoom?.value ?? 1)
	return {
		x: appState.scrollX + appState.width / 2 / zoom - width / 2,
		y: appState.scrollY + appState.height / 2 / zoom - height / 2,
	}
}

function ownerKeysToTry(boardId: string, meta: BoardAssetMeta): string[] {
	const primary = ownerKeyForBoardMeta(boardId, meta)
	const temp = tempOwnerKey(boardId)
	const google =
		typeof meta.cloudOwnerKey === 'string' &&
		meta.cloudOwnerKey.startsWith('google:')
			? meta.cloudOwnerKey
			: null
	return [...new Set([primary, temp, google].filter(Boolean) as string[])]
}

export function useWhiteboardExcalidrawFiles(
	boardId: string,
	apiRef: RefObject<ExcalidrawImperativeAPI | null>,
): {
	generateIdForFile: (file: File) => Promise<string>
	validateEmbeddable: (link: string) => boolean | undefined
	renderEmbeddable: (
		element: ExcalidrawEmbeddableElement,
		appState: AppState,
	) => ReturnType<typeof createElement> | null
	onPaste: (
		data: { files?: File[] | null },
		event: ClipboardEvent | null,
	) => boolean
	syncFiles: (
		elements: readonly OrderedExcalidrawElement[],
		files: BinaryFiles,
	) => void
} {
	const metaRef = useRef<BoardAssetMeta>({
		savedToLibrary: false,
		cloudOwnerKey: null,
	})
	const readyRef = useRef(new Set<string>())
	const inflightRef = useRef(new Set<string>())
	const prefixRegisteredRef = useRef(false)
	const claimedOwnerRef = useRef<string | null>(null)

	useEffect(() => {
		if (!boardId) return
		let cancelled = false

		const refreshMeta = async () => {
			const meta = await fetchBoardAssetMeta(boardId)
			if (cancelled) return
			metaRef.current = meta
			if (
				!meta.savedToLibrary &&
				!prefixRegisteredRef.current
			) {
				prefixRegisteredRef.current = true
				void registerTempAssetPrefix(boardId).catch(() => {
					prefixRegisteredRef.current = false
				})
			}
			if (
				meta.savedToLibrary &&
				meta.cloudOwnerKey?.startsWith('google:') &&
				claimedOwnerRef.current !== meta.cloudOwnerKey
			) {
				void claimAndRewrite(meta.cloudOwnerKey)
			}
		}

		const claimAndRewrite = async (googleOwner: string) => {
			if (isSignedIn()) {
				await claimTempCanvasAssets(boardId).catch(() => null)
			}
			const api = apiRef.current
			if (!api) return
			const elements = api.getSceneElementsIncludingDeleted()
			if (elements.length === 0) return
			const from = tempOwnerKey(boardId)
			let changed = false
			const next = elements.map((el) => {
				if (el.type !== 'embeddable') return el
				const parsed = parsePlayerPath(el.link || '')
				if (!parsed || parsed.ownerKey !== from) return el
				changed = true
				return {
					...el,
					link: playerPath(googleOwner, parsed.fileId),
					version: el.version + 1,
					versionNonce: Math.floor(Math.random() * 2147483647),
				}
			})
			if (changed) {
				api.updateScene({
					elements: next,
					captureUpdate: CaptureUpdateAction.NEVER,
				})
			}
			claimedOwnerRef.current = googleOwner
		}

		void refreshMeta()
		const timer = window.setInterval(() => {
			void refreshMeta()
		}, 8000)
		const onFocus = () => {
			void refreshMeta()
		}
		window.addEventListener('focus', onFocus)
		return () => {
			cancelled = true
			window.clearInterval(timer)
			window.removeEventListener('focus', onFocus)
		}
	}, [apiRef, boardId])

	const putImageFile = useCallback(
		async (fileId: string, file: BinaryFileData) => {
			const meta = metaRef.current
			const ownerKey = ownerKeyForBoardMeta(boardId, meta)
			if (ownerKey.startsWith('temp:') && !prefixRegisteredRef.current) {
				prefixRegisteredRef.current = true
				void registerTempAssetPrefix(boardId).catch(() => {
					prefixRegisteredRef.current = false
				})
			}
			const blob = await dataURLToBlob(file.dataURL)
			await uploadCanvasBytes({
				ownerKey,
				fileId,
				bytes: blob,
				mimeType: file.mimeType,
			})
		},
		[boardId],
	)

	const failedAtRef = useRef(new Map<string, number>())

	const hydrateImage = useCallback(
		async (fileId: string) => {
			const api = apiRef.current
			if (!api) return false
			const found = await fetchCanvasBytes(
				ownerKeysToTry(boardId, metaRef.current),
				fileId,
			)
			if (!found || !IMAGE_MIME.has(found.mimeType)) return false
			const dataURL = await blobToDataURL(found.blob)
			api.addFiles([
				{
					id: asFileId(fileId),
					mimeType: asImageMime(found.mimeType),
					dataURL: asDataURL(dataURL),
					created: Date.now(),
				},
			])
			return true
		},
		[apiRef, boardId],
	)

	const syncFiles = useCallback(
		(
			elements: readonly OrderedExcalidrawElement[],
			files: BinaryFiles,
		) => {
			if (!boardId) return
			const referenced = referencedImageFileIds(elements)
			const now = Date.now()
			for (const fileId of referenced) {
				if (readyRef.current.has(fileId) || inflightRef.current.has(fileId)) {
					continue
				}
				const failedAt = failedAtRef.current.get(fileId) ?? 0
				if (now - failedAt < 1000) continue
				inflightRef.current.add(fileId)
				const existing = files[fileId]
				void (async () => {
					try {
						if (existing?.dataURL) {
							await putImageFile(fileId, existing)
						} else {
							const ok = await hydrateImage(fileId)
							if (!ok) throw new Error('asset not in R2 yet')
						}
						readyRef.current.add(fileId)
						failedAtRef.current.delete(fileId)
					} catch {
						failedAtRef.current.set(fileId, Date.now())
						readyRef.current.delete(fileId)
					} finally {
						inflightRef.current.delete(fileId)
					}
				})()
			}
		},
		[boardId, hydrateImage, putImageFile],
	)

	const insertVideos = useCallback(
		async (videoFiles: File[]) => {
			const api = apiRef.current
			if (!api || videoFiles.length === 0) return
			const meta = metaRef.current
			const ownerKey = ownerKeyForBoardMeta(boardId, meta)
			if (ownerKey.startsWith('temp:') && !prefixRegisteredRef.current) {
				prefixRegisteredRef.current = true
				void registerTempAssetPrefix(boardId).catch(() => {
					prefixRegisteredRef.current = false
				})
			}
			const appState = api.getAppState()
			const existing = api.getSceneElementsIncludingDeleted()
			const added = []
			for (const [index, file] of videoFiles.entries()) {
				const fileId = crypto.randomUUID()
				try {
					await uploadCanvasBytes({
						ownerKey,
						fileId,
						bytes: file,
						mimeType: (file.type || 'video/mp4').split(';')[0].trim(),
					})
				} catch {
					api.setToast?.({ message: 'Video upload failed', duration: 4000 })
					continue
				}
				const origin = viewportCenter(appState, 640, 360)
				const link = playerPath(ownerKey, fileId)
				added.push(
					...convertToExcalidrawElements([
						{
							type: 'embeddable',
							x: origin.x + index * 24,
							y: origin.y + index * 24,
							width: 640,
							height: 360,
							link,
						},
					]).map((el) =>
						el.type === 'embeddable'
							? { ...el, link, validated: true }
							: el,
					),
				)
			}
			if (added.length === 0) return
			api.updateScene({
				elements: [...existing, ...added],
				captureUpdate: CaptureUpdateAction.IMMEDIATELY,
			})
		},
		[apiRef, boardId],
	)

	useEffect(() => {
		if (!boardId) return
		const onDragOver = (event: DragEvent) => {
			const files = event.dataTransfer?.files
			if (!files?.length) return
			if (![...files].every((file) => VIDEO_MIME.has(file.type))) return
			event.preventDefault()
		}
		const onDrop = (event: DragEvent) => {
			const list = event.dataTransfer?.files
			if (!list?.length) return
			const files = [...list]
			if (!files.every((file) => VIDEO_MIME.has(file.type))) return
			event.preventDefault()
			event.stopPropagation()
			void insertVideos(files)
		}
		document.addEventListener('dragover', onDragOver, true)
		document.addEventListener('drop', onDrop, true)
		return () => {
			document.removeEventListener('dragover', onDragOver, true)
			document.removeEventListener('drop', onDrop, true)
		}
	}, [boardId, insertVideos])

	const onPaste = useCallback(
		(data: { files?: File[] | null }, _event: ClipboardEvent | null) => {
			const files = data.files ? [...data.files] : []
			if (files.length === 0) return true
			if (!files.every((file) => VIDEO_MIME.has(file.type))) return true
			void insertVideos(files)
			return false
		},
		[insertVideos],
	)

	const renderEmbeddable = useCallback(
		(element: ExcalidrawEmbeddableElement, _appState: AppState) => {
			return renderWhiteboardEmbeddable(element)
		},
		[],
	)

	return {
		generateIdForFile: generateWhiteboardFileId,
		validateEmbeddable: validateWhiteboardEmbeddable,
		renderEmbeddable,
		onPaste,
		syncFiles,
	}
}
