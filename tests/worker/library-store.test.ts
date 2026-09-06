import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import {
	deleteLibraryAsset,
	deleteLibraryBoard,
	ensureOwnerImported,
	getLibraryBoard,
	isLibraryAssetEntry,
	isLibraryBoardEntry,
	isLibraryTimestamp,
	listLibraryAssets,
	listLibraryBoards,
	patchLibraryBoardPreview,
	touchLibraryBoard,
	upsertLibraryAsset,
	upsertLibraryBoard,
	LibraryStoreError,
	LIBRARY_IMPORT_VERSION,
} from '../../src/worker/libraryStore'
import { bootWorker } from './helpers/harness'

const workerEnv = env as unknown as {
	WHITEBOARD_ASSETS: R2Bucket
	WHITEBOARD_LIBRARY: D1Database
}

function board(id: string, overrides: Partial<{
	title: string
	lastAccessedAt: string
	previewDataUrl: string
}> = {}) {
	return {
		id,
		title: overrides.title ?? 'Board',
		lastAccessedAt:
			overrides.lastAccessedAt ?? '2026-08-27T12:00:00.000Z',
		...(overrides.previewDataUrl !== undefined
			? { previewDataUrl: overrides.previewDataUrl }
			: {}),
	}
}

function asset(id: string, ownerKey: string, overrides: Partial<{
	title: string
	lastAccessedAt: string
	sourceBoardIds: string[]
}> = {}) {
	return {
		id,
		title: overrides.title ?? 'Asset',
		createdAt: '2026-08-27T11:00:00.000Z',
		lastAccessedAt:
			overrides.lastAccessedAt ?? '2026-08-27T12:00:00.000Z',
		mimeType: 'image/jpeg',
		size: 12,
		r2Key: `assets/${ownerKey}/${id}`,
		ownerKey,
		...(overrides.sourceBoardIds !== undefined
			? { sourceBoardIds: overrides.sourceBoardIds }
			: {}),
	}
}

async function putJson(key: string, value: unknown): Promise<void> {
	await workerEnv.WHITEBOARD_ASSETS.put(key, JSON.stringify(value), {
		httpMetadata: { contentType: 'application/json' },
	})
}

async function putRawJson(key: string, value: string): Promise<void> {
	await workerEnv.WHITEBOARD_ASSETS.put(key, value, {
		httpMetadata: { contentType: 'application/json' },
	})
}

function sourceBody(value: unknown): { size: number; arrayBuffer: () => Promise<ArrayBuffer> } {
	const bytes = new TextEncoder().encode(JSON.stringify(value))
	return {
		size: bytes.byteLength,
		arrayBuffer: async () => bytes.buffer as ArrayBuffer,
	}
}

async function marker(ownerKey: string): Promise<{
	owner_key: string
	imported_at: string
	import_version: number
} | null> {
	return workerEnv.WHITEBOARD_LIBRARY
		.prepare(
			`SELECT owner_key, imported_at, import_version
			 FROM library_owner_imports WHERE owner_key = ?`,
		)
		.bind(ownerKey)
		.first()
}

function databaseThatFailsOnRun(
	database: D1Database,
	failOnRun: number,
): D1Database {
	let runCount = 0
	return {
		prepare(query: string) {
			const statement = database.prepare(query)
			return {
				bind(...values: unknown[]) {
					const bound = statement.bind(...values)
					return {
						first: (columnName?: string) =>
							columnName === undefined
								? bound.first()
								: bound.first(columnName),
						all: () => bound.all(),
						run: async () => {
							runCount += 1
							if (runCount === failOnRun) {
								throw new Error('injected library write failure')
							}
							return bound.run()
						},
					}
				},
			} as unknown as D1PreparedStatement
		},
	} as unknown as D1Database
}

describe('D1 whiteboard library store', () => {
	beforeAll(async () => {
		await bootWorker()
	})

  it('touches recents without overwriting names, crossing owners, or resurrecting deleted boards', async () => {
    const owner = `google:touch-${crypto.randomUUID()}`
    const other = `google:other-${crypto.randomUUID()}`
    const id = crypto.randomUUID()
    const old = '2020-01-01T00:00:00.000Z'
    await upsertLibraryBoard(workerEnv, owner, board(id, { title: 'Renamed in another tab', lastAccessedAt: old }))
    expect(await touchLibraryBoard(workerEnv, other, id)).toBe(false)
    expect(await touchLibraryBoard(workerEnv, owner, id)).toBe(true)
    const result = await getLibraryBoard(workerEnv, owner, id)
    expect(result?.title).toBe('Renamed in another tab')
    expect(Date.parse(result!.lastAccessedAt)).toBeGreaterThan(Date.parse(old))
    await deleteLibraryBoard(workerEnv, owner, id)
    expect(await touchLibraryBoard(workerEnv, owner, id)).toBe(false)
    expect(await getLibraryBoard(workerEnv, owner, id)).toBeNull()
  })

	it('supports owner-isolated CRUD, monotonic recents, preview retention, and asset DTO fields', async () => {
		const owner = `google:test-${crypto.randomUUID()}`
		const other = `google:test-${crypto.randomUUID()}`
		const boardId = crypto.randomUUID()
		const assetId = crypto.randomUUID()
		const preview = `/api/whiteboard/assets/${encodeURIComponent(owner)}/${crypto.randomUUID()}`

		await upsertLibraryBoard(workerEnv, owner, board(boardId, { previewDataUrl: preview }))
		await upsertLibraryBoard(
			workerEnv,
			owner,
			board(boardId, { title: 'Older', lastAccessedAt: '2026-08-26T12:00:00.000Z' }),
		)
		await upsertLibraryAsset(
			workerEnv,
			owner,
			asset(assetId, owner, { sourceBoardIds: [boardId] }),
		)

		const boards = await listLibraryBoards(workerEnv, owner)
		expect(boards).toHaveLength(1)
		expect(boards[0]).toMatchObject({
			id: boardId,
			title: 'Older',
			lastAccessedAt: '2026-08-27T12:00:00.000Z',
			previewDataUrl: preview,
		})
		expect(await listLibraryBoards(workerEnv, other)).toEqual([])

		const assets = await listLibraryAssets(workerEnv, owner)
		expect(assets).toEqual([
			expect.objectContaining({
				id: assetId,
				ownerKey: owner,
				sourceBoardIds: [boardId],
				r2Key: `assets/${owner}/${assetId}`,
			}),
		])
	})

	it('compares offset timestamps by instant and preserves the winning API string', async () => {
		const owner = `google:test-offset-${crypto.randomUUID()}`
		const boardId = crypto.randomUUID()
		const assetId = crypto.randomUUID()
		const current = '2026-08-27T12:00:00.000Z'
		const olderOffset = '2026-08-27T13:00:00.000+02:00'
		const newerOffset = '2026-08-27T11:00:00.000-02:00'

		// These are the exact timestamp forms used in the UPSERT comparison.
		expect(isLibraryTimestamp(current)).toBe(true)
		expect(isLibraryTimestamp(olderOffset)).toBe(true)
		expect(isLibraryTimestamp(newerOffset)).toBe(true)
		expect(isLibraryTimestamp('not-a-timestamp')).toBe(false)
		expect(
			await workerEnv.WHITEBOARD_LIBRARY
				.prepare('SELECT julianday(?) AS z, julianday(?) AS offset')
				.bind(current, olderOffset)
				.first<{ z: number; offset: number }>(),
		).toMatchObject({ z: expect.any(Number), offset: expect.any(Number) })

		await upsertLibraryBoard(
			workerEnv,
			owner,
			board(boardId, { lastAccessedAt: current }),
		)
		await upsertLibraryAsset(
			workerEnv,
			owner,
			asset(assetId, owner, { lastAccessedAt: current }),
		)

		// Remove the marker to force a lazy R2 import against existing D1 rows.
		await workerEnv.WHITEBOARD_LIBRARY
			.prepare('DELETE FROM library_owner_imports WHERE owner_key = ?')
			.bind(owner)
			.run()
		await putJson(`library/${owner}/boards.json`, [
			board(boardId, { title: 'Lazy older', lastAccessedAt: olderOffset }),
		])
		await putJson(`library/${owner}/assets.json`, [
			asset(assetId, owner, { title: 'Lazy older', lastAccessedAt: olderOffset }),
		])

		expect(await listLibraryBoards(workerEnv, owner)).toEqual([
			expect.objectContaining({
				id: boardId,
				title: 'Lazy older',
				lastAccessedAt: current,
			}),
		])
		expect(await listLibraryAssets(workerEnv, owner)).toEqual([
			expect.objectContaining({
				id: assetId,
				title: 'Lazy older',
				lastAccessedAt: current,
			}),
		])

		// An actually newer offset has a lexicographically smaller clock field;
		// explicit PUT must still retain that exact newer representation.
		await upsertLibraryBoard(
			workerEnv,
			owner,
			board(boardId, { title: 'Explicit newer', lastAccessedAt: newerOffset }),
		)
		await upsertLibraryAsset(
			workerEnv,
			owner,
			asset(assetId, owner, { title: 'Explicit newer', lastAccessedAt: newerOffset }),
		)
		const latestBoardId = crypto.randomUUID()
		const latestOffset = '2026-08-27T11:30:00.000-02:00'
		await upsertLibraryBoard(
			workerEnv,
			owner,
			board(latestBoardId, { lastAccessedAt: latestOffset }),
		)
		expect((await getLibraryBoard(workerEnv, owner, boardId))?.lastAccessedAt).toBe(
			newerOffset,
		)
		expect((await listLibraryBoards(workerEnv, owner))[0]?.id).toBe(latestBoardId)
		expect((await listLibraryAssets(workerEnv, owner))[0]?.lastAccessedAt).toBe(
			newerOffset,
		)
	})

	it('rejects malformed timestamps in source entries before import', async () => {
		const owner = `google:test-malformed-timestamp-${crypto.randomUUID()}`
		const boardId = crypto.randomUUID()
		const assetId = crypto.randomUUID()
		const malformedBoard = board(boardId, { lastAccessedAt: 'not-a-date' })
		const malformedAsset = asset(assetId, owner, {
			lastAccessedAt: '2026-08-27T25:00:00.000Z',
		})

		expect(isLibraryBoardEntry(malformedBoard)).toBe(false)
		expect(isLibraryAssetEntry(malformedAsset)).toBe(false)
		await putJson(`library/${owner}/boards.json`, [malformedBoard])
		await putJson(`library/${owner}/assets.json`, [malformedAsset])
		await expect(listLibraryBoards(workerEnv, owner)).rejects.toMatchObject({
			kind: 'source',
		})
		expect(await marker(owner)).toBeNull()
	})

	it('rejects impossible calendar dates and sub-millisecond timestamps for boards and assets', async () => {
		const owner = `google:test-strict-timestamp-${crypto.randomUUID()}`
		const boardId = crypto.randomUUID()
		const assetId = crypto.randomUUID()
		const invalidDates = [
			'2026-02-29T12:00:00.000Z',
			'2026-04-31T12:00:00.000Z',
			'2026-13-01T12:00:00.000Z',
			'2026-01-01T12:00:00.0001Z',
			'2026-01-01T12:00:00.00Z',
		]
		for (const timestamp of invalidDates) {
			expect(isLibraryTimestamp(timestamp)).toBe(false)
			expect(isLibraryBoardEntry(board(boardId, { lastAccessedAt: timestamp }))).toBe(false)
			expect(
				isLibraryAssetEntry(asset(assetId, owner, { lastAccessedAt: timestamp })),
			).toBe(false)
		}
		const validLeapDay = '2028-02-29T12:00:00.000+00:00'
		expect(isLibraryTimestamp(validLeapDay)).toBe(true)
		expect(isLibraryBoardEntry(board(boardId, { lastAccessedAt: validLeapDay }))).toBe(true)
		expect(isLibraryAssetEntry(asset(assetId, owner, { lastAccessedAt: validLeapDay }))).toBe(true)

		await expect(
			upsertLibraryBoard(workerEnv, owner, board(boardId, { lastAccessedAt: invalidDates[0] })),
		).rejects.toMatchObject({ kind: 'configuration' })
		await expect(
			upsertLibraryAsset(workerEnv, owner, asset(assetId, owner, { lastAccessedAt: invalidDates[3] })),
		).rejects.toMatchObject({ kind: 'configuration' })

		await putJson(`library/${owner}/boards.json`, [
			board(boardId, { lastAccessedAt: invalidDates[1] }),
		])
		await putJson(`library/${owner}/assets.json`, [
			asset(assetId, owner, { lastAccessedAt: invalidDates[2] }),
		])
		await expect(listLibraryBoards(workerEnv, owner)).rejects.toMatchObject({ kind: 'source' })
		expect(await marker(owner)).toBeNull()
	})

	it('merges canonical and legacy R2 indexes with canonical precedence and imports only once', async () => {
		const owner = `google:test-${crypto.randomUUID()}`
		const legacy = `google:test-legacy-${crypto.randomUUID()}`
		const canonicalBoardId = crypto.randomUUID()
		const legacyBoardId = crypto.randomUUID()
		const canonicalAssetId = crypto.randomUUID()
		const legacyAssetId = crypto.randomUUID()
		await putJson(`library/${owner}/boards.json`, [
			board(canonicalBoardId, { title: 'Canonical' }),
		])
		await putJson(`library/${legacy}/boards.json`, [
			board(canonicalBoardId, { title: 'Legacy duplicate' }),
			board(legacyBoardId, { title: 'Legacy only' }),
		])
		await putJson(`library/${owner}/assets.json`, [asset(canonicalAssetId, owner)])
		await putJson(`library/${legacy}/assets.json`, [
			asset(canonicalAssetId, legacy, { title: 'Legacy duplicate' }),
			asset(legacyAssetId, legacy, { title: 'Legacy only' }),
		])

		const boards = await listLibraryBoards(workerEnv, owner, [legacy])
		expect(boards.map(({ id, title }) => ({ id, title }))).toEqual([
			{ id: canonicalBoardId, title: 'Canonical' },
			{ id: legacyBoardId, title: 'Legacy only' },
		])
		const assets = await listLibraryAssets(workerEnv, owner, [legacy])
		expect(assets.map(({ id, title }) => ({ id, title }))).toEqual([
			{ id: canonicalAssetId, title: 'Asset' },
			{ id: legacyAssetId, title: 'Legacy only' },
		])
		expect((await marker(owner))?.import_version).toBe(LIBRARY_IMPORT_VERSION)

		await deleteLibraryBoard(workerEnv, owner, legacyBoardId, [legacy])
		// The untouched legacy source still contains this row, but the marker
		// makes D1 authoritative and prevents deletion from being resurrected.
		expect(
			(await listLibraryBoards(workerEnv, owner, [legacy])).some(
				(entry) => entry.id === legacyBoardId,
			),
		).toBe(false)
	})

	it('does not mark malformed sources and preserves existing D1 rows', async () => {
		const owner = `google:test-malformed-${crypto.randomUUID()}`
		const existingId = crypto.randomUUID()
		await upsertLibraryBoard(workerEnv, owner, board(existingId))
		// Remove the marker to model a partial/import-in-progress owner while
		// retaining the D1 row that must never be erased by a bad source.
		await workerEnv.WHITEBOARD_LIBRARY
			.prepare('DELETE FROM library_owner_imports WHERE owner_key = ?')
			.bind(owner)
			.run()
		await putJson(`library/${owner}/boards.json`, { not: 'an array' })

		await expect(listLibraryBoards(workerEnv, owner)).rejects.toMatchObject({
			kind: 'source',
		})
		expect(await marker(owner)).toBeNull()
		const row = await workerEnv.WHITEBOARD_LIBRARY
			.prepare('SELECT board_id FROM library_boards WHERE owner_key = ?')
			.bind(owner)
			.first<{ board_id: string }>()
		expect(row?.board_id).toBe(existingId)
	})

	it('rejects oversized lazy R2 sources before JSON parsing and never marks success', async () => {
		const owner = `google:test-oversize-${crypto.randomUUID()}`
		const boardId = crypto.randomUUID()
		const oversizedBoard = JSON.stringify([
			board(boardId, { title: 'x'.repeat(4 * 1024 * 1024) }),
		])
		expect(new TextEncoder().encode(oversizedBoard).byteLength).toBeGreaterThan(4 * 1024 * 1024)
		await putRawJson(`library/${owner}/boards.json`, oversizedBoard)
		await putJson(`library/${owner}/assets.json`, [])
		await expect(listLibraryBoards(workerEnv, owner)).rejects.toMatchObject({ kind: 'source' })
		expect(await marker(owner)).toBeNull()
	})

	it('reruns a partial import safely and writes its marker last', async () => {
		const owner = `google:test-partial-${crypto.randomUUID()}`
		const boardId = crypto.randomUUID()
		const assetId = crypto.randomUUID()
		await putJson(`library/${owner}/boards.json`, [board(boardId)])
		await putJson(`library/${owner}/assets.json`, [asset(assetId, owner)])

		await expect(
			ensureOwnerImported(
				{
					WHITEBOARD_LIBRARY: databaseThatFailsOnRun(
						workerEnv.WHITEBOARD_LIBRARY,
						2,
					),
					WHITEBOARD_ASSETS: workerEnv.WHITEBOARD_ASSETS,
				},
				owner,
			),
		).rejects.toMatchObject({ name: 'LibraryStoreError' })
		expect(await marker(owner)).toBeNull()

		const rerunBoards = await listLibraryBoards(workerEnv, owner)
		const rerunAssets = await listLibraryAssets(workerEnv, owner)
		expect(rerunBoards.map(({ id }) => id)).toEqual([boardId])
		expect(rerunAssets.map(({ id }) => id)).toEqual([assetId])
		expect((await marker(owner))?.import_version).toBe(LIBRARY_IMPORT_VERSION)
	})

	it('updates preview conditionally and never recreates a deleted board', async () => {
		const owner = `google:test-preview-${crypto.randomUUID()}`
		const boardId = crypto.randomUUID()
		await upsertLibraryBoard(workerEnv, owner, board(boardId))
		const updated = await patchLibraryBoardPreview(
			workerEnv,
			owner,
			boardId,
			'/api/whiteboard/assets/google%3Apreview/id',
		)
		expect(updated?.previewDataUrl).toContain('google%3Apreview')
		await deleteLibraryBoard(workerEnv, owner, boardId)
		expect(
			await patchLibraryBoardPreview(
				workerEnv,
				owner,
				boardId,
				'/api/whiteboard/assets/google%3Apreview/id-2',
			),
		).toBeNull()
	})

	it('uses the D1 tombstone barrier when a stale import crosses an isolate DELETE', async () => {
		const owner = `google:test-race-${crypto.randomUUID()}`
		const boardId = crypto.randomUUID()
		let sourceReadStarted!: () => void
		const sourceStarted = new Promise<void>((resolve) => {
			sourceReadStarted = resolve
		})
		let releaseSource!: () => void
		const sourceDeferred = new Promise<void>((resolve) => {
			releaseSource = resolve
		})
		let deferredOnce = true
		const sourceBucket = {
			get: async (key: string) => {
				if (key === `library/${owner}/boards.json`) {
					if (deferredOnce) {
						deferredOnce = false
						sourceReadStarted()
						await sourceDeferred
					}
					return sourceBody([board(boardId)])
				}
				return null
			},
		} as unknown as R2Bucket
		const storeEnv = {
			WHITEBOARD_LIBRARY: workerEnv.WHITEBOARD_LIBRARY,
			WHITEBOARD_ASSETS: sourceBucket,
		}

		// Vite query imports intentionally create a second module instance so
		// this test bypasses the first isolate's in-memory owner lock.
		const isolatedImport = await import(
			// @ts-expect-error Vite resolves query-suffixed module imports at test time.
			'../../src/worker/libraryStore?stale-import-isolate'
		)
		const isolatedDelete = await import(
			// @ts-expect-error Vite resolves query-suffixed module imports at test time.
			'../../src/worker/libraryStore?delete-isolate'
		)
		const importing = isolatedImport.ensureOwnerImported(storeEnv, owner)
		await sourceStarted
		const deleting = isolatedDelete.deleteLibraryBoard(
			storeEnv,
			owner,
			boardId,
		)
		await deleting
		releaseSource()
		await importing
		expect(await getLibraryBoard(workerEnv, owner, boardId)).toBeNull()
		const tombstone = await workerEnv.WHITEBOARD_LIBRARY
			.prepare(
				`SELECT owner_key, board_id, deleted_at
				 FROM library_board_tombstones
				 WHERE owner_key = ? AND board_id = ?`,
			)
			.bind(owner, boardId)
			.first()
		expect(tombstone).toMatchObject({ owner_key: owner, board_id: boardId })
	})

	it('uses the D1 asset tombstone barrier when stale import crosses an isolate DELETE', async () => {
		const owner = `google:test-asset-race-${crypto.randomUUID()}`
		const assetId = crypto.randomUUID()
		let sourceReadStarted!: () => void
		const sourceStarted = new Promise<void>((resolve) => {
			sourceReadStarted = resolve
		})
		let releaseSource!: () => void
		const sourceDeferred = new Promise<void>((resolve) => {
			releaseSource = resolve
		})
		let deferredOnce = true
		const sourceBucket = {
			get: async (key: string) => {
				if (key === `library/${owner}/assets.json`) {
					if (deferredOnce) {
						deferredOnce = false
						sourceReadStarted()
						await sourceDeferred
					}
					return sourceBody([asset(assetId, owner)])
				}
				return null
			},
		} as unknown as R2Bucket
		const storeEnv = {
			WHITEBOARD_LIBRARY: workerEnv.WHITEBOARD_LIBRARY,
			WHITEBOARD_ASSETS: sourceBucket,
		}

		const isolatedImport = await import(
			// @ts-expect-error Vite resolves query-suffixed module imports at test time.
			'../../src/worker/libraryStore?stale-asset-import-isolate'
		)
		const isolatedDelete = await import(
			// @ts-expect-error Vite resolves query-suffixed module imports at test time.
			'../../src/worker/libraryStore?delete-asset-isolate'
		)
		const importing = isolatedImport.ensureOwnerImported(storeEnv, owner)
		await sourceStarted
		await isolatedDelete.deleteLibraryAsset(storeEnv, owner, assetId)
		releaseSource()
		await importing
		expect(await listLibraryAssets(workerEnv, owner)).toEqual([])
		const tombstone = await workerEnv.WHITEBOARD_LIBRARY
			.prepare(
				`SELECT owner_key, asset_id, deleted_at
				 FROM library_asset_tombstones
				 WHERE owner_key = ? AND asset_id = ?`,
			)
			.bind(owner, assetId)
			.first()
		expect(tombstone).toMatchObject({ owner_key: owner, asset_id: assetId })
	})

	it('keeps a stale preview PATCH update-only after a cross-isolate DELETE', async () => {
		const owner = `google:test-preview-race-${crypto.randomUUID()}`
		const boardId = crypto.randomUUID()
		let sourceReadStarted!: () => void
		const sourceStarted = new Promise<void>((resolve) => {
			sourceReadStarted = resolve
		})
		let releaseSource!: () => void
		const sourceDeferred = new Promise<void>((resolve) => {
			releaseSource = resolve
		})
		let deferredOnce = true
		const sourceBucket = {
			get: async (key: string) => {
				if (key === `library/${owner}/boards.json`) {
					if (deferredOnce) {
						deferredOnce = false
						sourceReadStarted()
						await sourceDeferred
					}
					return sourceBody([board(boardId)])
				}
				return null
			},
		} as unknown as R2Bucket
		const storeEnv = {
			WHITEBOARD_LIBRARY: workerEnv.WHITEBOARD_LIBRARY,
			WHITEBOARD_ASSETS: sourceBucket,
		}
		const isolatedPatch = await import(
			// @ts-expect-error Vite resolves query-suffixed module imports at test time.
			'../../src/worker/libraryStore?preview-isolate'
		)
		const isolatedDelete = await import(
			// @ts-expect-error Vite resolves query-suffixed module imports at test time.
			'../../src/worker/libraryStore?preview-delete-isolate'
		)
		const patching = isolatedPatch.patchLibraryBoardPreview(
			storeEnv,
			owner,
			boardId,
			'/api/whiteboard/assets/google%3Apreview-race/id',
		)
		await sourceStarted
		await isolatedDelete.deleteLibraryBoard(storeEnv, owner, boardId)
		releaseSource()
		expect(await patching).toBeNull()
		expect(await getLibraryBoard(workerEnv, owner, boardId)).toBeNull()
	})

	it('clears board and asset tombstones only for an explicit PUT restore', async () => {
		const owner = `google:test-restore-${crypto.randomUUID()}`
		const boardId = crypto.randomUUID()
		const assetId = crypto.randomUUID()
		await deleteLibraryBoard(workerEnv, owner, boardId)
		await deleteLibraryAsset(workerEnv, owner, assetId)
		expect(
			await workerEnv.WHITEBOARD_LIBRARY
				.prepare(
					`SELECT COUNT(*) AS count
					 FROM library_board_tombstones
					 WHERE owner_key = ? AND board_id = ?`,
				)
				.bind(owner, boardId)
				.first<{ count: number }>(),
		).toEqual({ count: 1 })
		await upsertLibraryBoard(
			workerEnv,
			owner,
			board(boardId, { title: 'Restored board' }),
		)
		await upsertLibraryAsset(
			workerEnv,
			owner,
			asset(assetId, owner, { title: 'Restored asset' }),
		)
		expect(await getLibraryBoard(workerEnv, owner, boardId)).toMatchObject({
			id: boardId,
			title: 'Restored board',
		})
		expect(
			await listLibraryAssets(workerEnv, owner),
		).toEqual([expect.objectContaining({ id: assetId, title: 'Restored asset' })])
		expect(
			await workerEnv.WHITEBOARD_LIBRARY
				.prepare(
					`SELECT COUNT(*) AS count
					 FROM library_board_tombstones
					 WHERE owner_key = ? AND board_id = ?`,
				)
				.bind(owner, boardId)
				.first<{ count: number }>(),
		).toEqual({ count: 0 })
		expect(
			await workerEnv.WHITEBOARD_LIBRARY
				.prepare(
					`SELECT COUNT(*) AS count
					 FROM library_asset_tombstones
					 WHERE owner_key = ? AND asset_id = ?`,
				)
				.bind(owner, assetId)
				.first<{ count: number }>(),
		).toEqual({ count: 0 })
	})

	it('reruns imports without resurrecting tombstoned board and asset rows', async () => {
		const owner = `google:test-rerun-tombstone-${crypto.randomUUID()}`
		const boardId = crypto.randomUUID()
		const assetId = crypto.randomUUID()
		await putJson(`library/${owner}/boards.json`, [board(boardId)])
		await putJson(`library/${owner}/assets.json`, [asset(assetId, owner)])
		await ensureOwnerImported(workerEnv, owner)
		await deleteLibraryBoard(workerEnv, owner, boardId)
		await deleteLibraryAsset(workerEnv, owner, assetId)
		await workerEnv.WHITEBOARD_LIBRARY
			.prepare('DELETE FROM library_owner_imports WHERE owner_key = ?')
			.bind(owner)
			.run()
		await ensureOwnerImported(workerEnv, owner)
		expect(await getLibraryBoard(workerEnv, owner, boardId)).toBeNull()
		expect(await listLibraryAssets(workerEnv, owner)).toEqual([])
		expect((await marker(owner))?.import_version).toBe(LIBRARY_IMPORT_VERSION)
	})

	it('fails clearly when the D1 binding is absent', async () => {
		await expect(listLibraryBoards({ WHITEBOARD_ASSETS: workerEnv.WHITEBOARD_ASSETS }, 'google:none')).rejects.toEqual(
			expect.objectContaining({
				name: 'LibraryStoreError',
				kind: 'configuration',
			}),
		)
	})
})
