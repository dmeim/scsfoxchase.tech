/**
 * Phase 3.2 — Excalidraw canvas file hooks (images/GIF → R2, MP4/WebM → player).
 * Does not touch the WebSocket protocol, reconcileElements, or scene persist.
 */
import {
	createElement,
	newElementWith,
	useCallback,
	useEffect,
	useRef,
	useState,
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
	assetResolveUrl,
	boardPlayerPath,
	uploadBoardAssetBytes,
	claimTempCanvasAssets,
	fetchBoardAssetBytes,
	fetchBoardAssetMeta,
	hasBoardAsset,
	fetchCanvasBytes,
	ownerKeyForBoardMeta,
	parsePlayerPath,
	registerTempAssetPrefix,
	tempOwnerKey,
	type BoardAssetMeta,
} from './whiteboard-assets'
import { getActiveIdentity, getAuthHeaders } from './whiteboard-identity'
import { getBoardSessionAuth } from './whiteboard-participants'
import {
	useWhiteboardUploadOutbox,
	type WhiteboardUploadElementSnapshot,
	type WhiteboardServerSceneHydration,
	type UseWhiteboardUploadOutboxResult,
} from './whiteboard-upload-outbox'

/** Same event `whiteboard-excalidraw-roles` publishes after `wb:hello`. */
const HELLO_EVENT = 'scsfoxchase:whiteboard-hello'

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

function imageElementSnapshots(
	elements: readonly OrderedExcalidrawElement[],
	fileId: string,
): WhiteboardUploadElementSnapshot[] {
	return elements
		.filter(
			(element) =>
				!element.isDeleted &&
				element.type === 'image' &&
				element.fileId === fileId,
		)
		.map((element) => ({
			elementId: element.id,
			element,
			elementVersion: element.version,
		}))
}

function sceneVersionForElements(
	elements: readonly OrderedExcalidrawElement[],
): number {
	return elements.reduce(
		(version, element) => Math.max(version, element.version),
		0,
	)
}

function removeLiveImageElements(
	api: ExcalidrawImperativeAPI,
	fileId: string,
): void {
	const elements = api.getSceneElementsIncludingDeleted()
	const next = elements.map((element) =>
		element.type === 'image' &&
			element.fileId === fileId &&
			!element.isDeleted
			? newElementWith(element, { isDeleted: true })
			: element,
	)
	if (next.some((element, index) => element !== elements[index])) {
		api.updateScene({
			elements: next,
			captureUpdate: CaptureUpdateAction.IMMEDIATELY,
		})
	}
}

function referencedPlayerFiles(
	 elements: readonly { type?: string; isDeleted?: boolean; link?: string | null }[],
): { fileId: string; ownerKey: string; boardId?: string }[] {
	const out: { fileId: string; ownerKey: string; boardId?: string }[] = []
	for (const el of elements) {
		if (el.isDeleted || el.type !== 'embeddable') continue
		const parsed = parsePlayerPath(el.link || '')
		if (parsed) out.push(parsed)
	}
	return out
}

async function probeCanvasOwner(
	ownerKeys: string[],
	fileId: string,
): Promise<string | null> {
	for (const ownerKey of ownerKeys) {
		if (!ownerKey) continue
		try {
			const res = await fetch(assetResolveUrl(ownerKey, fileId), {
				method: 'HEAD',
			})
			if (res.ok) return ownerKey
		} catch {
			// try next owner
		}
	}
	return null
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
	options?: { boardId?: string; ownerKey?: string },
): ReturnType<typeof createElement> | null {
	const link = element.link
	if (!link || !isSelfPlayerLink(link)) return null
	const parsed = parsePlayerPath(link)
	if (!parsed) return null
	const ownerKey = options?.ownerKey || parsed.ownerKey
	const boardId = options?.boardId || parsed.boardId
	const params = new URLSearchParams({ id: parsed.fileId })
	if (ownerKey) params.set('owner', ownerKey)
	if (boardId) params.set('board', boardId)
	return createElement('iframe', {
		src: `/whiteboard-player?${params.toString()}`,
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

/**
 * GET meta with live session and/or Clerk so Owner/Manager/Editor learn the
 * board `google:` prefix. Unsigned GET still omits it.
 */
async function fetchBoardAssetMetaForCanvas(
	boardId: string,
): Promise<BoardAssetMeta> {
	const headers: Record<string, string> = { ...(await getAuthHeaders()) }
	const sessionAuth = getBoardSessionAuth(boardId)
	if (sessionAuth) {
		headers['X-Board-Session'] = sessionAuth.sessionId
		headers['X-Board-Auth'] = sessionAuth.authToken
	}
	if (Object.keys(headers).length === 0) {
		return fetchBoardAssetMeta(boardId)
	}
	const res = await fetch(
		`/api/whiteboard/boards/${encodeURIComponent(boardId)}/meta`,
		{ headers },
	)
	if (!res.ok) {
		return { savedToLibrary: false, cloudOwnerKey: null }
	}
	const body = (await res.json()) as {
		savedToLibrary?: unknown
		cloudOwnerKey?: unknown
	}
	return {
		savedToLibrary: body.savedToLibrary === true,
		cloudOwnerKey:
			typeof body.cloudOwnerKey === 'string' ? body.cloudOwnerKey : null,
	}
}

function waitForBoardSession(boardId: string, timeoutMs: number): Promise<void> {
	if (typeof window === 'undefined') return Promise.resolve()
	if (getBoardSessionAuth(boardId)) return Promise.resolve()
	return new Promise((resolve) => {
		let settled = false
		const finish = () => {
			if (settled) return
			settled = true
			window.clearTimeout(timer)
			window.removeEventListener(HELLO_EVENT, onHello)
			resolve()
		}
		const onHello = () => {
			if (getBoardSessionAuth(boardId)) finish()
		}
		const timer = window.setTimeout(finish, timeoutMs)
		window.addEventListener(HELLO_EVENT, onHello)
	})
}

function isGoogleOwnerKey(value: string | null | undefined): value is string {
	return typeof value === 'string' && value.startsWith('google:')
}

function googleOwnerFromElements(
	elements: readonly { type?: string; link?: string | null }[],
): string | null {
	for (const el of elements) {
		if (el.type !== 'embeddable') continue
		const parsed = parsePlayerPath(el.link || '')
		if (parsed && isGoogleOwnerKey(parsed.ownerKey)) return parsed.ownerKey
	}
	return null
}

function ownerKeysToTry(
	boardId: string,
	meta: BoardAssetMeta,
	extraGoogle?: string | null,
	bakedOwner?: string | null,
): string[] {
	const temp = tempOwnerKey(boardId)
	const google = isGoogleOwnerKey(meta.cloudOwnerKey)
		? meta.cloudOwnerKey
		: isGoogleOwnerKey(extraGoogle)
			? extraGoogle
			: isGoogleOwnerKey(bakedOwner)
				? bakedOwner
				: null
	const baked =
		typeof bakedOwner === 'string' &&
		bakedOwner &&
		bakedOwner !== google &&
		bakedOwner !== temp
			? bakedOwner
			: null
	return [...new Set([google, temp, baked].filter(Boolean) as string[])]
}

export type WhiteboardFileSyncOptions = {
	sceneVersion?: number
	sceneState?: unknown
}

export type WhiteboardExcalidrawFilesApi = {
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
		options?: WhiteboardFileSyncOptions,
	) => void
	/** Durable upload state and controls for WhiteboardCanvas/UI integration. */
	uploadOutbox: UseWhiteboardUploadOutboxResult
	markServerSceneHydrated: (
		input?: WhiteboardServerSceneHydration,
	) => Promise<string[]>
	resetServerSceneHydration: () => void
	getRecoveryData: UseWhiteboardUploadOutboxResult['getRecoveryData']
	updatePendingElementSnapshots: UseWhiteboardUploadOutboxResult['updateElementSnapshots']
	getUploadState: UseWhiteboardUploadOutboxResult['getUploadState']
	markSceneAcknowledged: UseWhiteboardUploadOutboxResult['markSceneAcknowledged']
	retryUpload: UseWhiteboardUploadOutboxResult['retryUpload']
	retryAllUploads: UseWhiteboardUploadOutboxResult['retryAllUploads']
	removeUpload: UseWhiteboardUploadOutboxResult['removeUpload']
}

export function useWhiteboardExcalidrawFiles(
	boardId: string,
	apiRef: RefObject<ExcalidrawImperativeAPI | null>,
): WhiteboardExcalidrawFilesApi {
	const uploadOutbox = useWhiteboardUploadOutbox(boardId)
	const metaRef = useRef<BoardAssetMeta>({
		savedToLibrary: false,
		cloudOwnerKey: null,
	})
	const googleOwnerRef = useRef<string | null>(null)
	const readyRef = useRef(new Set<string>())
	const inflightRef = useRef(new Set<string>())
	const prefixRegisteredRef = useRef(false)
	const claimedOwnerRef = useRef<string | null>(null)
	const toastedUploadRef = useRef(new Set<string>())
	const resolvedVideoOwnerRef = useRef(new Map<string, string>())
	const metaEpochRef = useRef('')
	const [videoEpoch, setVideoEpoch] = useState(0)

	const rememberGoogleOwner = (key: string | null | undefined) => {
		if (isGoogleOwnerKey(key)) googleOwnerRef.current = key
	}

	const resolveCanvasOwnerKey = useCallback((): string => {
		const meta = metaRef.current
		rememberGoogleOwner(meta.cloudOwnerKey)
		const api = apiRef.current
		if (api) {
			rememberGoogleOwner(
				googleOwnerFromElements(api.getSceneElementsIncludingDeleted()),
			)
		}
		if (meta.savedToLibrary && googleOwnerRef.current) {
			return googleOwnerRef.current
		}
		return ownerKeyForBoardMeta(boardId, meta)
	}, [apiRef, boardId])

	const loadCanvasOwnerKey = useCallback(async (): Promise<string> => {
		let ownerKey = resolveCanvasOwnerKey()
		if (isGoogleOwnerKey(ownerKey)) return ownerKey
		if (!metaRef.current.savedToLibrary) return ownerKey
		if (!getBoardSessionAuth(boardId)) {
			await waitForBoardSession(boardId, 2500)
		}
		const meta = await fetchBoardAssetMetaForCanvas(boardId)
		metaRef.current = meta
		rememberGoogleOwner(meta.cloudOwnerKey)
		return resolveCanvasOwnerKey()
	}, [boardId, resolveCanvasOwnerKey])

	useEffect(() => {
		if (!boardId) return
		let cancelled = false
		googleOwnerRef.current = null

		const refreshMeta = async () => {
			const identity = getActiveIdentity()
			const meta = await fetchBoardAssetMetaForCanvas(boardId)
			if (cancelled) return
			metaRef.current = meta
			rememberGoogleOwner(meta.cloudOwnerKey)
			const api = apiRef.current
			if (api) {
				rememberGoogleOwner(
					googleOwnerFromElements(api.getSceneElementsIncludingDeleted()),
				)
			}
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
				identity?.ownerKey === meta.cloudOwnerKey &&
				claimedOwnerRef.current !== meta.cloudOwnerKey
			) {
				void claimTempAssets(meta.cloudOwnerKey)
			}
			const token = `${meta.savedToLibrary}:${googleOwnerRef.current ?? ''}`
			if (token !== metaEpochRef.current) {
				metaEpochRef.current = token
				setVideoEpoch((n) => n + 1)
			}
		}

		const claimTempAssets = async (googleOwner: string) => {
			if (getActiveIdentity()?.ownerKey !== googleOwner) return
			await claimTempCanvasAssets(boardId).catch(() => null)
			claimedOwnerRef.current = googleOwner
			rememberGoogleOwner(googleOwner)
			for (const key of [...readyRef.current]) {
				if (key.startsWith('video:')) readyRef.current.delete(key)
			}
			setVideoEpoch((n) => n + 1)
		}

		void refreshMeta()
		const timer = window.setInterval(() => {
			void refreshMeta()
		}, 8000)
		const onFocus = () => {
			void refreshMeta()
		}
		const onHello = () => {
			void refreshMeta()
		}
		window.addEventListener('focus', onFocus)
		window.addEventListener(HELLO_EVENT, onHello)
		return () => {
			cancelled = true
			window.clearInterval(timer)
			window.removeEventListener('focus', onFocus)
			window.removeEventListener(HELLO_EVENT, onHello)
		}
	}, [apiRef, boardId])

	const putImageFile = useCallback(
		async (
			fileId: string,
			file: BinaryFileData,
			elementSnapshots: readonly WhiteboardUploadElementSnapshot[],
			options: WhiteboardFileSyncOptions,
		) => {
			let durablyStaged = false
			try {
				const blob = await dataURLToBlob(file.dataURL)
				const latestStaging = uploadOutbox.outbox.getStaging(fileId)
				// The element may have been deleted while DataURL conversion was in
				// flight. Do not create an orphaned uploaded job after that deletion;
				// the tombstone will be persisted and can clear any already-durable
				// job after its scene acknowledgement or server hydration.
				if (latestStaging && latestStaging.latestElementSnapshots?.length === 0) {
					uploadOutbox.outbox.completeStaging(fileId)
					return
				}
				await uploadOutbox.outbox.stage({
					boardId,
					fileId,
					blob,
					mimeType: file.mimeType,
					latestElementSnapshots:
						latestStaging?.latestElementSnapshots ?? elementSnapshots,
					latestElementState:
						latestStaging?.latestElementState ?? options.sceneState,
					sceneVersion:
						latestStaging?.sceneVersion ?? options.sceneVersion,
				})
				durablyStaged = true
				uploadOutbox.outbox.completeStaging(fileId)
				await uploadOutbox.outbox.waitForUpload(fileId)
			} catch (error) {
				if (!durablyStaged) {
					uploadOutbox.outbox.failStaging(fileId)
					const api = apiRef.current
					if (api) removeLiveImageElements(api, fileId)
				}
				throw error
			}
		},
		[apiRef, boardId, uploadOutbox.outbox],
	)

	const failedAtRef = useRef(new Map<string, number>())

	const hydrateImage = useCallback(
		async (fileId: string) => {
			const api = apiRef.current
			if (!api) return false
			const boardFound = await fetchBoardAssetBytes(boardId, fileId)
			if (boardFound && IMAGE_MIME.has(boardFound.mimeType)) {
				const dataURL = await blobToDataURL(boardFound.blob)
				api.addFiles([
					{
						id: asFileId(fileId),
						mimeType: asImageMime(boardFound.mimeType),
						dataURL: asDataURL(dataURL),
						created: Date.now(),
					},
				])
				return true
			}
			if (
				metaRef.current.savedToLibrary &&
				!isGoogleOwnerKey(metaRef.current.cloudOwnerKey)
			) {
				await loadCanvasOwnerKey()
			}
			const found = await fetchCanvasBytes(
				ownerKeysToTry(boardId, metaRef.current, googleOwnerRef.current),
				fileId,
			)
			if (!found || !IMAGE_MIME.has(found.mimeType)) return false
			rememberGoogleOwner(found.ownerKey)
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
		[apiRef, boardId, loadCanvasOwnerKey],
	)

	const hydrateVideo = useCallback(
		async (fileId: string, bakedOwner: string, bakedBoardId?: string) => {
			if (bakedBoardId) {
				// Board-scoped links must never be redirected through a different
				// board's manifest. Links to another board remain readable as
				// already-persisted embeds and need no local upload probe.
				return bakedBoardId === boardId
					? hasBoardAsset(boardId, fileId)
					: true
			}
			if (
				metaRef.current.savedToLibrary &&
				!isGoogleOwnerKey(metaRef.current.cloudOwnerKey)
			) {
				await loadCanvasOwnerKey()
			}
			const foundOwner = await probeCanvasOwner(
				ownerKeysToTry(
					boardId,
					metaRef.current,
					googleOwnerRef.current,
					bakedOwner,
				),
				fileId,
			)
			if (!foundOwner) return false
			rememberGoogleOwner(foundOwner)
			if (resolvedVideoOwnerRef.current.get(fileId) !== foundOwner) {
				resolvedVideoOwnerRef.current.set(fileId, foundOwner)
				setVideoEpoch((n) => n + 1)
			}
			return true
		},
		[boardId, loadCanvasOwnerKey],
	)

	const syncFiles = useCallback(
		(
			elements: readonly OrderedExcalidrawElement[],
			files: BinaryFiles,
			options: WhiteboardFileSyncOptions = {},
		) => {
			if (!boardId) return
			rememberGoogleOwner(googleOwnerFromElements(elements))
			const referenced = referencedImageFileIds(elements)
			const sceneVersion =
				options.sceneVersion ?? sceneVersionForElements(elements)
			const now = Date.now()
			for (const fileId of referenced) {
				const elementSnapshots = imageElementSnapshots(elements, fileId)
				const existing = files[fileId]
				const alreadyInflight = inflightRef.current.has(fileId)
				const failedAt = failedAtRef.current.get(fileId) ?? 0
				if (
					existing?.dataURL &&
					!readyRef.current.has(fileId) &&
					(alreadyInflight || now - failedAt >= 1000)
				) {
					uploadOutbox.outbox.beginStaging({
						boardId,
						fileId,
						latestElementSnapshots: elementSnapshots,
						latestElementState: options.sceneState,
						sceneVersion,
					})
				}
				void uploadOutbox.outbox
					.updateElementSnapshots(fileId, {
						latestElementSnapshots: elementSnapshots,
						latestElementState: options.sceneState,
						sceneVersion: options.sceneVersion,
					})
					.catch(() => undefined)
				if (readyRef.current.has(fileId) || inflightRef.current.has(fileId)) {
					continue
				}
				if (now - failedAt < 1000) continue
				inflightRef.current.add(fileId)
				void (async () => {
					try {
						if (existing?.dataURL) {
							try {
								await putImageFile(
									fileId,
									existing,
									elementSnapshots,
									{ ...options, sceneVersion },
								)
							} catch {
								if (!toastedUploadRef.current.has(fileId)) {
									toastedUploadRef.current.add(fileId)
									apiRef.current?.setToast?.({
										message: 'Image upload failed',
										duration: 4000,
									})
								}
								throw new Error('image upload failed')
							}
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

			// A deletion can occur while DataURL conversion is still pending.
			// Keep that transient file blocked until the conversion either stages
			// durably or removes the local element.
			for (const fileId of uploadOutbox.outbox.getStagingFileIds()) {
				if (referenced.includes(fileId)) continue
				uploadOutbox.outbox.updateStaging(fileId, {
					latestElementSnapshots: [],
					latestElementState: options.sceneState,
					sceneVersion,
				})
			}

			for (const parsed of referencedPlayerFiles(elements)) {
				const readyKey = `video:${parsed.fileId}`
				if (
					readyRef.current.has(readyKey) ||
					inflightRef.current.has(readyKey)
				) {
					continue
				}
				const failedAt = failedAtRef.current.get(readyKey) ?? 0
				if (now - failedAt < 1000) continue
				inflightRef.current.add(readyKey)
					void (async () => {
						try {
							const ok = await hydrateVideo(
								parsed.fileId,
								parsed.ownerKey,
								parsed.boardId,
							)
						if (!ok) throw new Error('video asset not in R2 yet')
						readyRef.current.add(readyKey)
						failedAtRef.current.delete(readyKey)
					} catch {
						failedAtRef.current.set(readyKey, Date.now())
						readyRef.current.delete(readyKey)
					} finally {
						inflightRef.current.delete(readyKey)
					}
				})()
			}
		},
		[apiRef, boardId, hydrateImage, hydrateVideo, putImageFile],
	)

	const insertVideos = useCallback(
		async (videoFiles: File[]) => {
			const api = apiRef.current
			if (!api || videoFiles.length === 0) return
			const appState = api.getAppState()
			const existing = api.getSceneElementsIncludingDeleted()
			const added = []
			for (const [index, file] of videoFiles.entries()) {
				const fileId = crypto.randomUUID()
				try {
					await uploadBoardAssetBytes({
						boardId,
						fileId,
						bytes: file,
						mimeType: (file.type || 'video/mp4').split(';')[0].trim(),
					})
				} catch {
					api.setToast?.({ message: 'Video upload failed', duration: 4000 })
					continue
				}
				const origin = viewportCenter(appState, 640, 360)
				const link = boardPlayerPath(boardId, fileId)
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
			const parsed = parsePlayerPath(element.link || '')
			if (!parsed) return renderWhiteboardEmbeddable(element)
			if (parsed.boardId) {
				return renderWhiteboardEmbeddable(element, {
					boardId: parsed.boardId,
				})
			}
			const resolved =
				resolvedVideoOwnerRef.current.get(parsed.fileId) ||
				(isGoogleOwnerKey(googleOwnerRef.current)
					? googleOwnerRef.current
					: null) ||
				parsed.ownerKey
			return renderWhiteboardEmbeddable(element, {
				boardId,
				ownerKey: resolved,
			})
		},
		[boardId, videoEpoch],
	)

	return {
		generateIdForFile: generateWhiteboardFileId,
		validateEmbeddable: validateWhiteboardEmbeddable,
		renderEmbeddable,
		onPaste,
		syncFiles,
		uploadOutbox,
		markServerSceneHydrated: uploadOutbox.markServerSceneHydrated,
		resetServerSceneHydration: uploadOutbox.resetServerSceneHydration,
		getRecoveryData: uploadOutbox.getRecoveryData,
		updatePendingElementSnapshots: uploadOutbox.updateElementSnapshots,
		getUploadState: uploadOutbox.getUploadState,
		markSceneAcknowledged: uploadOutbox.markSceneAcknowledged,
		retryUpload: uploadOutbox.retryUpload,
		retryAllUploads: uploadOutbox.retryAllUploads,
		removeUpload: uploadOutbox.removeUpload,
	}
}
