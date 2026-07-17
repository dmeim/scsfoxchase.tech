/**
 * Cloud board / asset library client (Phase 4b).
 * Indexes live in R2 under library/{ownerKey}/boards.json|assets.json
 * (same WHITEBOARD_ASSETS bucket as media binaries).
 */
import {
	getAuthHeaders,
	isSignedIn,
} from './whiteboard-identity'
import type { WhiteboardAssetEntry } from './whiteboard-assets'
import type { WhiteboardLibraryEntry } from '../scripts/whiteboard-library'

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

export async function fetchCloudBoards(): Promise<WhiteboardLibraryEntry[]> {
	if (!isSignedIn()) return []
	const res = await libraryFetch('/api/whiteboard/library/boards')
	const body = await readJson<{ boards: WhiteboardLibraryEntry[] }>(res)
	return Array.isArray(body.boards) ? body.boards : []
}

export async function upsertCloudBoard(
	entry: WhiteboardLibraryEntry,
): Promise<WhiteboardLibraryEntry> {
	const res = await libraryFetch('/api/whiteboard/library/boards', {
		method: 'PUT',
		body: JSON.stringify(entry),
	})
	const body = await readJson<{ board: WhiteboardLibraryEntry }>(res)
	return body.board
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
