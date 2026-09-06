/**
 * Cloud board / asset library client (Phase 3.1).
 * Library metadata lives in D1. Legacy R2 indexes under
 * library/{ownerKey}/boards.json|assets.json are imported read-only by the
 * server store. Recents / Library / Assets are signed-in cloud only — no
 * localStorage board index.
 *
 * Save / claim lifts the Phase 2 24h scratch TTL via
 * GET/PATCH /api/whiteboard/boards/:uuid/meta (`savedToLibrary`).
 */
import {
	getAuthHeaders,
	isSignedIn,
} from './whiteboard-identity'
import type { WhiteboardAssetEntry } from './whiteboard-assets'
import type { WhiteboardLibraryEntry } from '../scripts/whiteboard-library'

export type BoardPublicMeta = {
	savedToLibrary: boolean
	cloudOwnerKey: string | null
	createdAt: string | null
	unsavedExpiresAt: string | null
}

const META_CLAIM_ATTEMPTS = 8
const META_CLAIM_DELAY_MS = 250

async function libraryFetch(
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	const auth = await getAuthHeaders()
	const headers = new Headers(init.headers)
	for (const [key, value] of Object.entries(auth)) {
		headers.set(key, value)
	}
	if (init.body && !headers.has('Content-Type')) {
		headers.set('Content-Type', 'application/json')
	}
	return fetch(path, { ...init, headers })
}

async function readJson<T>(res: Response): Promise<T> {
	if (!res.ok) {
		let message = `Request failed (${res.status})`
		try {
			const body = (await res.json()) as { error?: string }
			if (body.error) message = body.error
		} catch {
			// ignore
		}
		throw new Error(message)
	}
	return (await res.json()) as T
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function fetchCloudBoards(): Promise<WhiteboardLibraryEntry[]> {
	if (!isSignedIn()) return []
	const res = await libraryFetch('/api/whiteboard/library/boards')
	const body = await readJson<{ boards: WhiteboardLibraryEntry[] }>(res)
	return Array.isArray(body.boards) ? body.boards : []
}

export async function upsertCloudBoard(
	entry: WhiteboardLibraryEntry,
	options: { hostSecret?: string | null; keepalive?: boolean } = {},
): Promise<WhiteboardLibraryEntry> {
	const headers = new Headers()
	if (options.hostSecret) {
		headers.set('X-Board-Host', options.hostSecret)
	}
	const res = await libraryFetch('/api/whiteboard/library/boards', {
		method: 'PUT',
		headers,
		body: JSON.stringify(entry),
		keepalive: options.keepalive === true,
	})
	const body = await readJson<{ board: WhiteboardLibraryEntry }>(res)
	return body.board
}

/**
 * Update preview metadata for a board that is already in this owner's
 * library. Unlike `upsertCloudBoard`, this endpoint never creates membership:
 * a concurrent delete wins and is reported as `null`.
 */
export async function patchCloudBoardPreview(
	boardId: string,
	previewDataUrl: string,
	options: { keepalive?: boolean } = {},
): Promise<WhiteboardLibraryEntry | null> {
	const res = await libraryFetch(
		`/api/whiteboard/library/boards/${encodeURIComponent(boardId)}/preview`,
		{
			method: 'PATCH',
			body: JSON.stringify({ previewDataUrl }),
			keepalive: options.keepalive === true,
		},
	)
	if (res.status === 404) return null
	const body = await readJson<{ board: WhiteboardLibraryEntry }>(res)
	return body.board
}

export async function touchCloudBoard(boardId: string): Promise<void> {
  const response = await libraryFetch(`/api/whiteboard/library/boards/${encodeURIComponent(boardId)}/access`, { method: 'PATCH' })
  if (response.status === 404) return // A deletion must win over a late page-open.
  await readJson(response)
}

export async function deleteCloudBoard(boardId: string): Promise<void> {
	await readJson(
		await libraryFetch(
			`/api/whiteboard/library/boards/${encodeURIComponent(boardId)}`,
			{ method: 'DELETE' },
		),
	)
}

export async function fetchCloudAssets(): Promise<WhiteboardAssetEntry[]> {
	if (!isSignedIn()) return []
	const res = await libraryFetch('/api/whiteboard/library/assets')
	const body = await readJson<{ assets: WhiteboardAssetEntry[] }>(res)
	return Array.isArray(body.assets) ? body.assets : []
}

export async function upsertCloudAsset(
	entry: WhiteboardAssetEntry,
): Promise<WhiteboardAssetEntry> {
	const res = await libraryFetch('/api/whiteboard/library/assets', {
		method: 'PUT',
		body: JSON.stringify(entry),
	})
	const body = await readJson<{ asset: WhiteboardAssetEntry }>(res)
	return body.asset
}

export async function deleteCloudAsset(assetId: string): Promise<void> {
	await readJson(
		await libraryFetch(
			`/api/whiteboard/library/assets/${encodeURIComponent(assetId)}`,
			{ method: 'DELETE' },
		),
	)
}

export async function fetchBoardMeta(boardId: string): Promise<BoardPublicMeta> {
	const res = await fetch(
		`/api/whiteboard/boards/${encodeURIComponent(boardId)}/meta`,
	)
	return readJson<BoardPublicMeta>(res)
}

export async function patchBoardMeta(
	boardId: string,
	patch: {
		savedToLibrary?: boolean
		cloudOwnerKey?: string | null
		tempAssetPrefix?: string | null
	},
	hostSecret: string,
): Promise<BoardPublicMeta> {
	const res = await fetch(
		`/api/whiteboard/boards/${encodeURIComponent(boardId)}/meta`,
		{
			method: 'PATCH',
			headers: {
				'Content-Type': 'application/json',
				'X-Board-Host': hostSecret,
			},
			body: JSON.stringify(patch),
		},
	)
	return readJson<BoardPublicMeta>(res)
}

/**
 * Lift the 24h scratch TTL and record Google Owner on the Durable Object.
 * First connect stores the host-secret hash; PATCH 403s until then, so we retry.
 */
export async function markBoardSavedToLibrary(
	boardId: string,
	cloudOwnerKey: string,
	hostSecret: string,
): Promise<BoardPublicMeta> {
	try {
		const current = await fetchBoardMeta(boardId)
		if (
			current.savedToLibrary &&
			current.cloudOwnerKey === cloudOwnerKey
		) {
			return current
		}
	} catch {
		// DO may not exist yet; PATCH below creates the lifetime on first success.
	}

	let lastError: Error | null = null
	for (let attempt = 0; attempt < META_CLAIM_ATTEMPTS; attempt++) {
		try {
			const meta = await patchBoardMeta(
				boardId,
				{ savedToLibrary: true, cloudOwnerKey },
				hostSecret,
			)
			if (meta.savedToLibrary) return meta
			lastError = new Error('Board meta did not record savedToLibrary')
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err))
		}
		await sleep(META_CLAIM_DELAY_MS)
	}
	throw lastError ?? new Error('Could not save board to the cloud library')
}
