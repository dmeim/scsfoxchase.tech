import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { handleAdminRequest } from '../../src/worker/adminRoutes'
import { handleAdminLibraryRequest } from '../../src/worker/adminLibraryRoutes'
import {
	deleteLibraryBoard,
	ensureOwnerImported,
	listLibraryAssets,
	listLibraryBoards,
	upsertLibraryAsset,
	upsertLibraryBoard,
	type LibraryAsset,
	type LibraryBoard,
} from '../../src/worker/libraryStore'
import { bootWorker } from './helpers/harness'

const bindings = {
	WHITEBOARD_ASSETS: env.WHITEBOARD_ASSETS,
	WHITEBOARD_LIBRARY: env.WHITEBOARD_LIBRARY,
	WHITEBOARD_ADMIN_SECRET: 'operator-test-secret',
} as unknown as Env
const ORIGIN = 'https://scsfoxchase.tech'

function board(id: string, title = 'Board'): LibraryBoard {
	return {
		id,
		title,
		lastAccessedAt: '2026-08-27T12:00:00.000Z',
	}
}

function asset(id: string, ownerKey: string, title = 'Asset'): LibraryAsset {
	return {
		id,
		title,
		createdAt: '2026-08-27T11:00:00.000Z',
		lastAccessedAt: '2026-08-27T12:00:00.000Z',
		mimeType: 'image/jpeg',
		size: 12,
		r2Key: `assets/${ownerKey}/${id}`,
		ownerKey,
	}
}

async function putJson(key: string, value: unknown): Promise<void> {
	await env.WHITEBOARD_ASSETS.put(key, JSON.stringify(value), {
		httpMetadata: { contentType: 'application/json' },
	})
}

async function call(
	body: unknown,
	path = '/api/whiteboard/admin/library',
	options: { auth?: string; origin?: string | null; contentType?: string } = {},
): Promise<{ response: Response; body: any }> {
	const headers = new Headers({
		Authorization: `Bearer ${options.auth ?? 'operator-test-secret'}`,
		'Content-Type': options.contentType ?? 'application/json',
	})
	if (options.origin !== null) headers.set('Origin', options.origin ?? ORIGIN)
	const response = await handleAdminLibraryRequest(
		new Request(`${ORIGIN}${path}`, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		}),
		bindings,
	)
	if (!response) throw new Error('admin library route did not match')
	let parsed: any = null
	try {
		parsed = await response.json()
	} catch {
		// OPTIONS has no JSON body.
	}
	return { response, body: parsed }
}

async function scanSummary(key: string): Promise<any> {
	let cursor: string | null = null
	for (let page = 0; page < 20; page += 1) {
		const result = await call({ operation: 'scan', ...(cursor ? { cursor } : {}) })
		const summary = result.body.objects.find((object: any) => object.key === key)
		if (summary) return summary
		cursor = result.body.nextCursor
		if (!cursor) break
	}
	throw new Error(`scan did not return ${key}`)
}

describe('authenticated D1 library operator', () => {
	beforeAll(async () => {
		await bootWorker()
	})

	it('enforces auth, same-origin, methods, JSON, and security headers', async () => {
		const unauthorized = await call({ operation: 'scan' }, '/api/whiteboard/admin/library', { auth: 'wrong' })
		expect(unauthorized.response.status).toBe(401)
		expect(unauthorized.response.headers.get('Cache-Control')).toBe('no-store')
		expect(unauthorized.response.headers.get('X-Content-Type-Options')).toBe('nosniff')

		const hostile = await call({ operation: 'scan' }, '/api/whiteboard/admin/library', { origin: 'https://evil.example' })
		expect(hostile.response.status).toBe(403)
		const wrongType = await call({ operation: 'scan' }, '/api/whiteboard/admin/library', { contentType: 'text/plain' })
		expect(wrongType.response.status).toBe(415)

		const options = await handleAdminLibraryRequest(
			new Request(`${ORIGIN}/api/whiteboard/admin/library`, {
				method: 'OPTIONS',
				headers: { Origin: ORIGIN },
			}),
			bindings,
		)
		expect(options?.status).toBe(204)
		expect(options?.headers.get('Access-Control-Allow-Methods')).toContain('POST')

		const method = await handleAdminLibraryRequest(
			new Request(`${ORIGIN}/api/whiteboard/admin/library`, {
				method: 'GET',
				headers: { Authorization: 'Bearer operator-test-secret', Origin: ORIGIN },
			}),
			bindings,
		)
		expect(method?.status).toBe(405)

		const oversized = await call('x'.repeat(300_000))
		expect(oversized.response.status).toBe(413)
	})

	it('scans only exact library index objects in bounded pages with validation metadata', async () => {
		const prefix = `google:test-operator-page-${crypto.randomUUID()}`
		for (let index = 0; index < 26; index += 1) {
			await putJson(`library/${prefix}-${index}/boards.json`, [])
		}
		await putJson(`library/${prefix}/ignored.txt`, 'not an index')
		const first = await call({ operation: 'scan' })
		expect(first.response.status).toBe(200)
		expect(first.body.counts.listed).toBeLessThanOrEqual(25)
		expect(first.body.objects.length).toBeLessThanOrEqual(25)
		expect(first.body.objects[0]).toEqual(expect.objectContaining({
		kind: 'boards',
		valid: true,
		version: 1,
		entryCount: 0,
		etag: expect.any(String),
		sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
		ownerKeyHash: expect.stringMatching(/^[0-9a-f]{64}$/),
	}))
		expect(JSON.stringify(first.body)).not.toContain('not an index')
		if (first.body.nextCursor) {
			const second = await call({ operation: 'scan', cursor: first.body.nextCursor })
			expect(second.response.status).toBe(200)
			expect(second.body.objects.length).toBeGreaterThan(0)
			expect(second.body.objects.length).toBeLessThanOrEqual(25)
		}

		const owner = `google:test-operator-invalid-${crypto.randomUUID()}`
		const id = crypto.randomUUID()
		await putJson(`library/${owner}/boards.json`, [board(id), board(id, 'Duplicate')])
		const malformed = await call({ operation: 'scan' })
		const summary = malformed.body.objects.find((object: any) => object.key === `library/${owner}/boards.json`)
		expect(summary).toEqual(expect.objectContaining({
			valid: false,
			duplicateCount: 1,
			invalidEntryCount: 0,
			reasonCodes: ['duplicate_id'],
		}))
	})

	it('does not checkpoint an exact index page when R2 read state is unavailable or drifts', async () => {
		const request = (assets: unknown) => handleAdminLibraryRequest(
			new Request(`${ORIGIN}/api/whiteboard/admin/library`, {
				method: 'POST',
				headers: {
					Authorization: 'Bearer operator-test-secret',
					Origin: ORIGIN,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ operation: 'scan' }),
			}),
			{ ...bindings, WHITEBOARD_ASSETS: assets } as unknown as Env,
		)
		const listed = { objects: [{ key: 'library/google:gone/boards.json' }], truncated: false, cursor: null }
		const unavailable = await request({ list: async () => { throw new Error('R2 unavailable') } })
		expect(unavailable?.status).toBe(503)
		const readFailure = await request({ list: async () => listed, get: async () => { throw new Error('R2 read failed') } })
		expect(readFailure?.status).toBe(503)
		const drift = await request({ list: async () => listed, get: async () => null })
		expect(drift?.status).toBe(409)
	})

	it('rechecks source hashes, imports conflict-safely, respects tombstones, and is idempotent', async () => {
		const owner = `google:test-operator-import-${crypto.randomUUID()}`
		const boardId = crypto.randomUUID()
		const assetId = crypto.randomUUID()
		const boardsKey = `library/${owner}/boards.json`
		const assetsKey = `library/${owner}/assets.json`
		await putJson(boardsKey, [board(boardId, 'Imported')])
		await putJson(assetsKey, [asset(assetId, owner, 'Imported asset')])
		const manifest = [await scanSummary(boardsKey), await scanSummary(assetsKey)]
		expect(manifest).toHaveLength(2)

		await putJson(boardsKey, [board(boardId, 'Changed after scan')])
		const drift = await call({ operation: 'import', objects: manifest })
		expect(drift.response.status).toBe(409)
		expect(drift.body.reasonCodes).toContain('source_drift')
		const noMarker = await env.WHITEBOARD_LIBRARY.prepare(
			' SELECT owner_key FROM library_owner_imports WHERE owner_key = ?',
		).bind(owner).first()
		expect(noMarker).toBeNull()

		await putJson(boardsKey, [board(boardId, 'Imported')])
		const imported = await call({ operation: 'import', objects: manifest })
		expect(imported.response.status).toBe(200)
		expect(imported.body.owners[0]).toEqual(expect.objectContaining({ inserted: 2, conflicts: 0 }))
		expect(imported.body.owners[0]).not.toHaveProperty('markerWritten')
		expect(await env.WHITEBOARD_LIBRARY.prepare(
			'SELECT owner_key FROM library_owner_imports WHERE owner_key = ?',
		).bind(owner).first()).toBeNull()
		const rerun = await call({ operation: 'import', objects: manifest })
		expect(rerun.response.status).toBe(200)
		expect(rerun.body.owners[0]).toEqual(expect.objectContaining({ inserted: 0, conflicts: 2 }))
		expect(rerun.body.owners[0]).not.toHaveProperty('alreadyImported')

		const conflictOwner = `google:test-operator-conflict-${crypto.randomUUID()}`
		const conflictId = crypto.randomUUID()
		await env.WHITEBOARD_LIBRARY.prepare(
			`INSERT INTO library_boards (owner_key, board_id, title, last_accessed_at, preview_data_url)
			 VALUES (?, ?, ?, ?, NULL)`,
		).bind(conflictOwner, conflictId, 'Existing', '2026-08-27T12:00:00.000Z').run()
		const conflictKey = `library/${conflictOwner}/boards.json`
		await putJson(conflictKey, [board(conflictId, 'Must not overwrite')])
		const conflictManifest = await scanSummary(conflictKey)
		const conflictImport = await call({ operation: 'import', objects: [conflictManifest] })
		expect(conflictImport.response.status).toBe(200)
		expect(conflictImport.body.owners[0]).toEqual(expect.objectContaining({ conflicts: 1 }))
		expect(await env.WHITEBOARD_LIBRARY.prepare(
			'SELECT title FROM library_boards WHERE owner_key = ? AND board_id = ?',
		).bind(conflictOwner, conflictId).first<{ title: string }>()).toEqual({ title: 'Existing' })

		const tombstoneOwner = `google:test-operator-tombstone-${crypto.randomUUID()}`
		const tombstoneId = crypto.randomUUID()
		await env.WHITEBOARD_LIBRARY.prepare(
			`INSERT INTO library_board_tombstones (owner_key, board_id, deleted_at)
			 VALUES (?, ?, ?)`,
		).bind(tombstoneOwner, tombstoneId, '2026-08-27T12:00:00.000Z').run()
		const tombstoneKey = `library/${tombstoneOwner}/boards.json`
		await putJson(tombstoneKey, [board(tombstoneId)])
		const tombstoneManifest = await scanSummary(tombstoneKey)
		const tombstoneImport = await call({ operation: 'import', objects: [tombstoneManifest] })
		expect(tombstoneImport.response.status).toBe(200)
		expect(tombstoneImport.body.owners[0]).toEqual(expect.objectContaining({ tombstoned: 1, inserted: 0 }))
		expect(await env.WHITEBOARD_LIBRARY.prepare(
			'SELECT board_id FROM library_boards WHERE owner_key = ? AND board_id = ?',
		).bind(tombstoneOwner, tombstoneId).first()).toBeNull()
	})

	it('rejects unresolved owners and does not import or mark them', async () => {
		const owner = `temp:operator-${crypto.randomUUID()}`
		const key = `library/${owner}/boards.json`
		await putJson(key, [board(crypto.randomUUID())])
		const manifest = await scanSummary(key)
		const result = await call({ operation: 'import', objects: [manifest] })
		expect(result.response.status).toBe(422)
		expect(result.body.reasonCodes).toEqual(['unresolved_owner'])
		expect(await env.WHITEBOARD_LIBRARY.prepare(
			'SELECT owner_key FROM library_owner_imports WHERE owner_key = ?',
		).bind(owner).first()).toBeNull()
	})

	it('keeps pre-seeding marker-free across split 13-owner batches, then lazy import finalizes canonical ownership', async () => {
		const suffix = crypto.randomUUID()
		const owners = Array.from({ length: 13 }, (_, index) => `google:test-operator-split-${suffix}-${index}`)
		const expectedBoards: string[] = []
		const expectedAssets: string[] = []
		for (const owner of owners) {
			const boardId = crypto.randomUUID()
			const assetId = crypto.randomUUID()
			expectedBoards.push(boardId)
			expectedAssets.push(assetId)
			await putJson(`library/${owner}/boards.json`, [board(boardId, 'Split board')])
			await putJson(`library/${owner}/assets.json`, [asset(assetId, owner, 'Split asset')])
		}

		const manifests: any[] = []
		let cursor: string | null = null
		for (let page = 0; page < 10; page += 1) {
			const result = await call({ operation: 'scan', ...(cursor ? { cursor } : {}) })
			manifests.push(...result.body.objects.filter((object: any) => owners.some((owner) => object.key.startsWith(`library/${owner}/`))))
			cursor = result.body.nextCursor
			if (!cursor) break
		}
		expect(manifests).toHaveLength(26)
		const first = await call({ operation: 'import', objects: manifests.slice(0, 25) })
		const second = await call({ operation: 'import', objects: manifests.slice(25) })
		expect(first.response.status).toBe(200)
		expect(second.response.status).toBe(200)
		const ownerPlaceholders = owners.map(() => '?').join(', ')
		const markerCount = await env.WHITEBOARD_LIBRARY.prepare(
			`SELECT COUNT(*) AS count FROM library_owner_imports WHERE owner_key IN (${ownerPlaceholders})`,
		).bind(...owners).first<{ count: number }>()
		expect(markerCount?.count).toBe(0)
		const boardCount = await env.WHITEBOARD_LIBRARY.prepare(
			`SELECT COUNT(*) AS count FROM library_boards WHERE owner_key IN (${ownerPlaceholders})`,
		).bind(...owners).first<{ count: number }>()
		expect(boardCount?.count).toBe(13)

		const canonical = owners[0]
		const legacy = `google:test-operator-legacy-${suffix}`
		const legacyBoardId = crypto.randomUUID()
		const legacyAssetId = crypto.randomUUID()
		await putJson(`library/${legacy}/boards.json`, [board(legacyBoardId, 'Legacy board')])
		await putJson(`library/${legacy}/assets.json`, [asset(legacyAssetId, legacy, 'Legacy asset')])
		await ensureOwnerImported(env, canonical, [legacy])
		expect(await env.WHITEBOARD_LIBRARY.prepare(
			'SELECT owner_key FROM library_owner_imports WHERE owner_key = ?',
		).bind(canonical).first()).toEqual({ owner_key: canonical })
		expect((await listLibraryBoards(env, canonical, [legacy])).map((entry) => entry.id)).toEqual(expect.arrayContaining([expectedBoards[0], legacyBoardId]))
		expect((await listLibraryAssets(env, canonical, [legacy])).map((entry) => entry.id)).toEqual(expect.arrayContaining([expectedAssets[0], legacyAssetId]))
	})

	it('exports live D1 rows in keyset pages without touching R2', async () => {
		const owner = `google:test-operator-export-${crypto.randomUUID()}`
		const firstBoard = board(crypto.randomUUID(), 'First')
		const secondBoard = board(crypto.randomUUID(), 'Second')
		const firstAsset = asset(crypto.randomUUID(), owner, 'First asset')
		await upsertLibraryBoard(env, owner, firstBoard)
		await upsertLibraryBoard(env, owner, secondBoard)
		await upsertLibraryAsset(env, owner, firstAsset)
		const before = await env.WHITEBOARD_ASSETS.list({ prefix: `library/${owner}/` })
		const first = await call({ operation: 'export', kind: 'boards', ownerKey: owner, limit: 1 })
		expect(first.response.status).toBe(200)
		expect(first.body.rows).toHaveLength(1)
		expect(first.body.rows[0]).toEqual(expect.objectContaining({ ownerKey: owner }))
		expect(first.body.rows[0].title).toBeTruthy()
		expect(first.body.nextCursor).toEqual(expect.objectContaining({ ownerKey: owner, id: expect.any(String) }))
		const second = await call({ operation: 'export', kind: 'boards', ownerKey: owner, limit: 1, cursor: first.body.nextCursor })
		expect(second.body.rows).toHaveLength(1)
		expect(second.body.done).toBe(false)
		const final = await call({ operation: 'export', kind: 'boards', ownerKey: owner, limit: 1, cursor: second.body.nextCursor })
		expect(final.body.rows).toEqual([])
		expect(final.body.done).toBe(true)
		const assets = await call({ operation: 'export', kind: 'assets', ownerKey: owner })
		expect(assets.body.rows).toEqual([expect.objectContaining({ ownerKey: owner, id: firstAsset.id })])
		const after = await env.WHITEBOARD_ASSETS.list({ prefix: `library/${owner}/` })
		expect(after.objects.map((object) => object.key)).toEqual(before.objects.map((object) => object.key))
	})

	it('delegates through the existing admin router without changing wipe behavior', async () => {
		const response = await handleAdminRequest(
			new Request(`${ORIGIN}/api/whiteboard/admin/library`, {
				method: 'POST',
				headers: {
					Authorization: 'Bearer operator-test-secret',
					Origin: ORIGIN,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ operation: 'export', kind: 'boards', limit: 1 }),
			}),
			bindings,
		)
		expect(response?.status).toBe(200)
	})

	it('reports D1 failures as 503 rather than a successful empty export', async () => {
		const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		const failing = {
			...bindings,
			WHITEBOARD_LIBRARY: {
				prepare() {
					throw new Error('D1 service unavailable')
				},
			} as unknown as D1Database,
		} as unknown as Env
		const response = await handleAdminLibraryRequest(
			new Request(`${ORIGIN}/api/whiteboard/admin/library`, {
				method: 'POST',
				headers: {
					Authorization: 'Bearer operator-test-secret',
					Origin: ORIGIN,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ operation: 'export', kind: 'boards' }),
			}),
			failing,
		)
		expect(response?.status).toBe(503)
		expect(warnings).toHaveBeenCalled()
		for (const [line] of warnings.mock.calls) {
			const event = JSON.parse(String(line))
			if (event.event === 'storage_failure') {
				expect(event).toEqual(expect.objectContaining({
					component: 'whiteboard-worker',
					event: 'storage_failure',
					backend: 'd1',
					operation: 'query',
					retryable: true,
				}))
				expect(JSON.stringify(event)).not.toContain('service unavailable')
			}
		}
		warnings.mockRestore()
	})
})
