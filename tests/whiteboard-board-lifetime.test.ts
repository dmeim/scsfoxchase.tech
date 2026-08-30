import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({
	DurableObject: class DurableObject {
		ctx: unknown
		env: unknown
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx
			this.env = env
		}
	},
}))

import {
	WhiteboardBoard,
	shouldApplySocketIdentityRefresh,
	shouldApplySocketRoleUpgrade,
	shouldReplaceStorageAlarm,
	shouldSkipIdenticalScenePersist,
} from '../src/worker/WhiteboardBoard'
import {
	META_BOARD_ID_KEY,
	META_CLASS_CAN_EDIT_KEY,
	META_CREATED_AT_KEY,
	META_UNSAVED_EXPIRES_AT_KEY,
	type SceneElement,
} from '../src/lib/whiteboard-sync'

const BOARD_ID = '11111111-1111-4111-8111-111111111111'
const FILE_ID = '22222222-2222-4222-8222-222222222222'
const SHARE_CODE = '1A2B3C4D'

class FakeWebSocketRequestResponsePair {
	constructor(
		readonly request: string,
		readonly response: string,
	) {}
}

type BoardPrivate = {
	ensureBoardLifetime: (
		boardId: string,
		opts?: { mintShareCode?: boolean },
	) => Promise<void>
	ensureShareCode: (boardId: string) => Promise<{ code: string } | null>
	revokeActiveCode: () => Promise<void>
	expireUnsavedBoard: () => Promise<void>
	persistScene: (
		scene: { elements: SceneElement[]; appState: Record<string, unknown> },
		opts?: { force?: boolean },
	) => void
	scheduleNextAlarm: () => Promise<void>
	setClassCanEdit: (enabled: boolean) => Promise<void>
	applySceneUpdate: (
		fromSessionId: string,
		incoming: SceneElement[],
		databaseJson: string | undefined,
		full: boolean,
		mutationId?: string | null,
		baseRevision?: number,
	) => Promise<void>
	sendInitialScene: (ws: WebSocket) => Promise<void>
	closeAfterSceneHydrationFailure: (ws: WebSocket, cause: unknown) => void
	loadScene: () => Promise<{
		elements: SceneElement[]
		appState: Record<string, unknown>
	}>
}

function priv(board: WhiteboardBoard): BoardPrivate {
	return board as unknown as BoardPrivate
}

function isSceneInsert(query: string): boolean {
	return /INSERT INTO excalidraw_scene\b/i.test(query)
}

function isSceneTableCreate(query: string): boolean {
	return /CREATE TABLE IF NOT EXISTS excalidraw_scene\b/i.test(query)
}

function createHarness(options?: {
	expiresAt?: string
	alarm?: number | null
	sceneTable?:
		| 'current'
		| 'legacy-v2'
		| 'legacy-live-only'
		| 'legacy-database-only'
		| 'partial-canonical-v2'
		| 'v2'
		| 'missing'
	sceneJson?: string
	v2SceneJson?: string
	legacyLiveJson?: string
	legacyDatabaseJson?: string
	extraTables?: string[]
	sceneReadFailure?: boolean
}) {
	const meta = new Map<string, unknown>()
	if (options?.expiresAt) {
		meta.set(META_BOARD_ID_KEY, BOARD_ID)
		meta.set(META_CREATED_AT_KEY, '2026-01-01T00:00:00.000Z')
		meta.set(META_UNSAVED_EXPIRES_AT_KEY, options.expiresAt)
	}

	let alarm: number | null =
		options?.alarm === undefined ? null : options.alarm
	const sceneTable = options?.sceneTable ?? 'current'
	let sceneJson: string | null = options?.sceneJson ?? null
	const v2SceneJson: string | null = options?.v2SceneJson ?? null
	const kv = new Map<string, string>()
	let initPromise = Promise.resolve()

	const sqlExec = vi.fn((query: string, ...binds: unknown[]) => {
		const q = String(query)
		if (
			options?.sceneReadFailure &&
			/PRAGMA table_info\(excalidraw_scene\)/i.test(q)
		) {
			throw new Error('injected scene read failure')
		}
		if (/sqlite_master/i.test(q)) {
			const sceneNames =
				sceneTable === 'legacy-v2'
					? ['excalidraw_scene', 'excalidraw_scene_v2']
					: sceneTable === 'partial-canonical-v2'
						? ['excalidraw_scene', 'excalidraw_scene_v2']
					: sceneTable === 'current'
						? ['excalidraw_scene']
						: sceneTable === 'v2'
							? ['excalidraw_scene_v2']
							: []
			const names = [...sceneNames, ...(options?.extraTables ?? [])]
			return { toArray: () => names.map((name) => ({ name })) }
		}
		if (/PRAGMA table_info\(excalidraw_scene\)/i.test(q)) {
			return {
				toArray: () =>
					sceneTable === 'current' ||
						sceneTable === 'partial-canonical-v2'
						? [
								{ name: 'id' },
								{ name: 'scene_json' },
								{ name: 'updated_at' },
							]
						: sceneTable === 'legacy-v2'
							? [
									{ name: 'id' },
									{ name: 'live_json' },
									{ name: 'database_json' },
									{ name: 'updated_at' },
								  ]
							: sceneTable === 'legacy-live-only'
								? [
										{ name: 'id' },
										{ name: 'live_json' },
										{ name: 'updated_at' },
									  ]
								: sceneTable === 'legacy-database-only'
									? [
											{ name: 'id' },
											{ name: 'database_json' },
											{ name: 'updated_at' },
										  ]
						: [],
			}
		}
		if (/PRAGMA table_info\(excalidraw_scene_v2\)/i.test(q)) {
			return {
				toArray: () =>
					sceneTable === 'v2' ||
					sceneTable === 'legacy-v2' ||
					sceneTable === 'partial-canonical-v2'
						? [
								{ name: 'id' },
								{ name: 'scene_json' },
								{ name: 'updated_at' },
							]
						: [],
			}
		}
		if (/SELECT scene_json FROM excalidraw_scene_v2/i.test(q)) {
			return {
				toArray: () =>
					(v2SceneJson ?? sceneJson)
						? [{ scene_json: v2SceneJson ?? sceneJson }]
						: [],
			}
		}
		if (/SELECT scene_json FROM excalidraw_scene/i.test(q)) {
			return {
				toArray: () => (sceneJson ? [{ scene_json: sceneJson }] : []),
			}
		}
		if (/^SELECT (?:live_json(?:, database_json)?|database_json)(?:, updated_at)? FROM excalidraw_scene/i.test(q)) {
			return {
				toArray: () =>
					{
						const row: Record<string, unknown> = {}
						if (q.includes('live_json')) {
							row.live_json = options?.legacyLiveJson ?? null
						}
						if (q.includes('database_json')) {
							row.database_json = options?.legacyDatabaseJson ?? null
						}
						return options?.legacyLiveJson || options?.legacyDatabaseJson
							? [row]
							: []
					},
			}
		}
		if (isSceneInsert(q)) {
			sceneJson = typeof binds[0] === 'string' ? binds[0] : sceneJson
		}
		return { toArray: () => [] }
	})

	const codes = {
		get: vi.fn(async (key: string) => kv.get(key) ?? null),
		put: vi.fn(async (key: string, value: string) => {
			kv.set(key, value)
		}),
		delete: vi.fn(async (key: string) => {
			kv.delete(key)
		}),
	}

	const storage = {
		sql: { exec: sqlExec },
		get: vi.fn(async (key: string) => meta.get(key)),
		put: vi.fn(async (key: string, value: unknown) => {
			meta.set(key, value)
		}),
		delete: vi.fn(async (key: string) => {
			meta.delete(key)
		}),
		getAlarm: vi.fn(async () => alarm),
		setAlarm: vi.fn(async (when: number) => {
			alarm = when
		}),
		deleteAlarm: vi.fn(async () => {
			alarm = null
		}),
		deleteAll: vi.fn(async () => {
			meta.clear()
		}),
	}

	const ctx = {
		storage,
		setWebSocketAutoResponse: vi.fn(),
		blockConcurrencyWhile: (fn: () => Promise<void> | void) => {
			initPromise = Promise.resolve().then(fn)
			return initPromise
		},
		getWebSockets: () => [] as WebSocket[],
	}

	const env = {
		WHITEBOARD_CODES: codes,
	} as unknown as Env

	return {
		meta,
		kv,
		codes,
		storage,
		ctx,
		env,
		sqlExec,
		getInit: () => initPromise,
	}
}

async function createBoard(options?: {
	expiresAt?: string
	alarm?: number | null
	sceneTable?:
		| 'current'
		| 'legacy-v2'
		| 'legacy-live-only'
		| 'legacy-database-only'
		| 'partial-canonical-v2'
		| 'v2'
		| 'missing'
	sceneJson?: string
	v2SceneJson?: string
	legacyLiveJson?: string
	legacyDatabaseJson?: string
	extraTables?: string[]
	sceneReadFailure?: boolean
}) {
	const harness = createHarness(options)
	const board = new WhiteboardBoard(
		harness.ctx as unknown as DurableObjectState,
		harness.env,
	)
	await harness.getInit()
	return { board, ...harness }
}

function sceneInsertCount(sqlExec: { mock: { calls: unknown[][] } }): number {
	return sqlExec.mock.calls.filter((call) => isSceneInsert(String(call[0])))
		.length
}

function deferred<T>(): {
	promise: Promise<T>
		resolve: (value: T | PromiseLike<T>) => void
} {
	let resolve!: (value: T | PromiseLike<T>) => void
	const promise = new Promise<T>((res) => {
		resolve = res
	})
	return { promise, resolve }
}

beforeEach(() => {
	vi.stubGlobal(
		'WebSocketRequestResponsePair',
		FakeWebSocketRequestResponsePair,
	)
})

describe('shouldSkipIdenticalScenePersist', () => {
	it('skips identical blobs unless the merge accepted elements', () => {
		expect(shouldSkipIdenticalScenePersist('{"a":1}', '{"a":1}')).toBe(true)
		expect(shouldSkipIdenticalScenePersist('{"a":1}', '{"a":1}', true)).toBe(
			false,
		)
		expect(shouldSkipIdenticalScenePersist(null, '{"a":1}')).toBe(false)
	})
})

describe('shouldReplaceStorageAlarm', () => {
	it('skips setAlarm when the existing alarm is already that time', () => {
		expect(shouldReplaceStorageAlarm(1_000_000, 1_000_400)).toBe(false)
		expect(shouldReplaceStorageAlarm(null, 1_000_000)).toBe(true)
		expect(shouldReplaceStorageAlarm(1_000_000, 1_002_000)).toBe(true)
	})
})

describe('shouldApplySocketRoleUpgrade', () => {
	it('allows authoritative upgrades without allowing re-auth demotions', () => {
		expect(shouldApplySocketRoleUpgrade('viewer', 'editor')).toBe(true)
		expect(shouldApplySocketRoleUpgrade('editor', 'manager')).toBe(true)
		expect(shouldApplySocketRoleUpgrade('editor', 'owner')).toBe(true)
		expect(shouldApplySocketRoleUpgrade('owner', 'viewer')).toBe(false)
		expect(shouldApplySocketRoleUpgrade('manager', 'editor')).toBe(false)
		expect(shouldApplySocketRoleUpgrade('editor', 'editor')).toBe(false)
	})
})

describe('shouldApplySocketIdentityRefresh', () => {
	it('accepts a verified Clerk name on a same-role socket', () => {
		expect(
			shouldApplySocketIdentityRefresh(
				{ userId: 'guest-id', displayName: 'Curious Falcon' },
				{ userId: 'google-id', displayName: 'Updated Teacher' },
				true,
			),
		).toBe(true)
	})

	it('does not trust an unverified identity change', () => {
		expect(
			shouldApplySocketIdentityRefresh(
				{ userId: 'google-id', displayName: 'Teacher' },
				{ userId: '', displayName: 'Random Guest' },
				false,
			),
		).toBe(false)
	})
})

describe('WhiteboardBoard share-code and persist lifetime', () => {
	it('closes a socket with a reconnectable code after initial scene hydration fails', async () => {
		const { board } = await createBoard({ sceneReadFailure: true })
		const ws = {
			send: vi.fn(),
			close: vi.fn(),
		} as unknown as WebSocket

		await priv(board).sendInitialScene(ws)

		expect(ws.send).toHaveBeenCalledTimes(1)
		const error = JSON.parse(
			String((ws.send as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]),
		) as Record<string, unknown>
		expect(error).toMatchObject({
			type: 'wb:error',
			code: 'persist_failed',
			mutationId: null,
			terminal: false,
		})
		expect(ws.close).toHaveBeenCalledWith(4001, 'scene hydration failed')
	})

	it('does not inspect or mutate storage in the constructor', async () => {
		const harness = createHarness()
		new WhiteboardBoard(
			harness.ctx as unknown as DurableObjectState,
			harness.env,
		)
		await harness.getInit()

		expect(harness.sqlExec).not.toHaveBeenCalled()
		expect(harness.storage.get).not.toHaveBeenCalled()
		expect(harness.storage.put).not.toHaveBeenCalled()
	})

	it('initializes scene storage once on the first trusted lifetime request', async () => {
		const { board, sqlExec } = await createBoard()

		expect(sqlExec).not.toHaveBeenCalled()
		await priv(board).ensureBoardLifetime(BOARD_ID, { mintShareCode: false })
		expect(
			sqlExec.mock.calls.filter((call) => isSceneTableCreate(String(call[0]))),
		).toHaveLength(1)

		await priv(board).ensureBoardLifetime(BOARD_ID, { mintShareCode: false })
		expect(
			sqlExec.mock.calls.filter((call) => isSceneTableCreate(String(call[0]))),
		).toHaveLength(1)
	})

	it('does not write schema or metadata on a second object lifetime', async () => {
		const first = await createBoard()
		await priv(first.board).ensureBoardLifetime(BOARD_ID, {
			mintShareCode: false,
		})
		const sqlCalls = first.sqlExec.mock.calls.length
		const storagePutCalls = first.storage.put.mock.calls.length

		const secondBoard = new WhiteboardBoard(
			first.ctx as unknown as DurableObjectState,
			first.env,
		)
		await first.getInit()
		await priv(secondBoard).ensureBoardLifetime(BOARD_ID, {
			mintShareCode: false,
		})

		expect(first.sqlExec.mock.calls).toHaveLength(sqlCalls)
		expect(first.storage.put.mock.calls).toHaveLength(storagePutCalls)
	})

	it('keeps historical tldraw tables and the Excalidraw scene on initialization', async () => {
		const sceneJson = JSON.stringify({
			elements: [
				{
					id: 'excalidraw-survivor',
					type: 'rectangle',
					version: 2,
					versionNonce: 11,
				},
			],
			appState: { viewBackgroundColor: '#ffffff' },
		})
		const { board, storage, sqlExec } = await createBoard({
			sceneTable: 'current',
			sceneJson,
			extraTables: ['tldraw_document', 'tldraw_snapshot'],
		})

		const response = await board.fetch(
			new Request(
				`https://scsfoxchase.tech/api/whiteboard/boards/${BOARD_ID}/meta`,
			),
		)
		expect(response.status).toBe(200)
		expect(storage.deleteAll).not.toHaveBeenCalled()
		expect(
			sqlExec.mock.calls.some((call) =>
				/\b(?:ALTER|DROP|DELETE)\b/i.test(String(call[0])),
			),
		).toBe(false)

		const scene = await priv(board).loadScene()
		expect(scene.elements.map((element) => element.id)).toEqual([
			'excalidraw-survivor',
		])
		expect(scene.appState).toEqual({ viewBackgroundColor: '#ffffff' })
	})

	it('reads an interrupted v2 scene without schema writes', async () => {
		const sceneJson = JSON.stringify({
			elements: [
				{
					id: 'v2-rectangle',
					type: 'rectangle',
					version: 1,
					versionNonce: 7,
				},
			],
			appState: { viewBackgroundColor: '#ffffff' },
		})
		const { board, sqlExec } = await createBoard({
			sceneTable: 'v2',
			sceneJson,
		})

		const scene = await priv(board).loadScene()

		expect(scene.elements.map((element) => element.id)).toEqual([
			'v2-rectangle',
		])
		expect(scene.appState).toEqual({ viewBackgroundColor: '#ffffff' })
		expect(
			sqlExec.mock.calls.some((call) =>
				/\b(?:CREATE|ALTER|DROP|INSERT|DELETE)\b/i.test(String(call[0])),
			),
		).toBe(false)
	})

	it('prefers an authoritative legacy scene over a partial v2 table', async () => {
		const legacyLiveJson = JSON.stringify({
			elements: [
				{
					id: 'legacy-authoritative',
					type: 'rectangle',
					version: 4,
					versionNonce: 9,
				},
			],
			appState: {},
		})
		const partialV2Json = JSON.stringify({ elements: [], appState: {} })
		const { board, sqlExec } = await createBoard({
			sceneTable: 'legacy-v2',
			sceneJson: partialV2Json,
			legacyLiveJson,
		})

		const scene = await priv(board).loadScene()

		expect(scene.elements.map((element) => element.id)).toEqual([
			'legacy-authoritative',
		])
		expect(
			sqlExec.mock.calls.some((call) =>
				/PRAGMA table_info\(excalidraw_scene_v2\)/i.test(String(call[0])),
			),
		).toBe(false)
	})

	it('reads a mixed legacy Excalidraw and tldraw schema without wake writes', async () => {
		const legacyLiveJson = JSON.stringify({
			elements: [
				{
					id: 'legacy-with-tldraw',
					type: 'ellipse',
					version: 3,
					versionNonce: 13,
				},
			],
			appState: { viewBackgroundColor: '#fefefe' },
		})
		const { board, sqlExec } = await createBoard({
			expiresAt: '2026-08-28T12:00:00.000Z',
			sceneTable: 'legacy-v2',
			legacyLiveJson,
			extraTables: ['tldraw_document'],
		})

		const scene = await priv(board).loadScene()
		expect(scene.elements.map((element) => element.id)).toEqual([
			'legacy-with-tldraw',
		])
		expect(scene.appState).toEqual({ viewBackgroundColor: '#fefefe' })
		expect(
			sqlExec.mock.calls.some((call) =>
				/\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i.test(String(call[0])),
			),
		).toBe(false)
	})

	it('reads a partial legacy live_json schema without selecting database_json', async () => {
		const legacyLiveJson = JSON.stringify({
			elements: [
				{ id: 'legacy-live-only', type: 'rectangle', version: 1, versionNonce: 2 },
			],
			appState: { viewBackgroundColor: '#abcabc' },
		})
		const { board, sqlExec } = await createBoard({
			sceneTable: 'legacy-live-only',
			legacyLiveJson,
		})

		const scene = await priv(board).loadScene()

		expect(scene.elements.map((element) => element.id)).toEqual([
			'legacy-live-only',
		])
		expect(
			sqlExec.mock.calls.some((call) =>
				/^SELECT .*database_json.*FROM excalidraw_scene/i.test(String(call[0])),
			),
		).toBe(false)
	})

	it('reads a partial legacy database_json schema without selecting live_json', async () => {
		const legacyDatabaseJson = JSON.stringify({
			type: 'excalidraw',
			version: 2,
			source: 'https://scsfoxchase.tech',
			elements: [
				{ id: 'legacy-database-only', type: 'ellipse', version: 2, versionNonce: 3 },
			],
			appState: { viewBackgroundColor: '#defdef' },
		})
		const { board, sqlExec } = await createBoard({
			sceneTable: 'legacy-database-only',
			legacyDatabaseJson,
		})

		const scene = await priv(board).loadScene()

		expect(scene.elements.map((element) => element.id)).toEqual([
			'legacy-database-only',
		])
		expect(scene.appState).toEqual({ viewBackgroundColor: '#defdef' })
		expect(
			sqlExec.mock.calls.some((call) =>
				/^SELECT .*live_json.*FROM excalidraw_scene/i.test(String(call[0])),
			),
		).toBe(false)
	})

	it('falls back to a valid v2 row after a partial canonical migration', async () => {
		const v2SceneJson = JSON.stringify({
			elements: [
				{
					id: 'partial-migration-survivor',
					type: 'diamond',
					version: 2,
					versionNonce: 17,
				},
			],
			appState: { viewBackgroundColor: '#ededed' },
		})
		const { board, sqlExec } = await createBoard({
			expiresAt: '2026-08-28T12:00:00.000Z',
			sceneTable: 'partial-canonical-v2',
			sceneJson: 'not-json',
			v2SceneJson,
		})

		const scene = await priv(board).loadScene()

		expect(scene.elements.map((element) => element.id)).toEqual([
			'partial-migration-survivor',
		])
		expect(scene.appState).toEqual({ viewBackgroundColor: '#ededed' })
		expect(
			sqlExec.mock.calls.some((call) =>
				/\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i.test(
					String(call[0]),
				),
			),
		).toBe(false)
	})

	it('ensureShareCode with an existing code does not KV put', async () => {
		const { board, codes, storage, meta } = await createBoard()
		meta.set('meta:activeCode', SHARE_CODE)

		const state = await priv(board).ensureShareCode(BOARD_ID)

		expect(state).toEqual({ code: SHARE_CODE })
		expect(codes.put).not.toHaveBeenCalled()
		expect(storage.delete).not.toHaveBeenCalledWith('meta:codeExpiresAt')
	})

	it('coalesces concurrent first-time share-code mints', async () => {
		const { board, codes } = await createBoard()

		const results = await Promise.all(
			Array.from({ length: 8 }, () => priv(board).ensureShareCode(BOARD_ID)),
		)

		expect(results.every((result) => result?.code === results[0]?.code)).toBe(
			true,
		)
		expect(results[0]?.code).toMatch(/^[0-9A-Z]{8}$/)
		expect(codes.put).toHaveBeenCalledTimes(1)
		expect(codes.put).toHaveBeenCalledWith(
			`code:${results[0]?.code}`,
			JSON.stringify({ boardId: BOARD_ID }),
		)
	})

	it('does not return a code when revoke races a deferred mint', async () => {
		const { board, codes, kv, meta } = await createBoard()
		const putStarted = deferred<{ key: string }>()
		const releasePut = deferred<void>()
		codes.put.mockImplementationOnce(async (key: string, value: string) => {
			kv.set(key, value)
			putStarted.resolve({ key })
			await releasePut.promise
		})

		const pendingMint = priv(board).ensureShareCode(BOARD_ID)
		const { key } = await putStarted.promise
		const pendingRevoke = priv(board).revokeActiveCode()
		releasePut.resolve()

		expect(await pendingMint).toBeNull()
		await pendingRevoke
		expect(meta.has('meta:activeCode')).toBe(false)
		expect(kv.has(key)).toBe(false)
		expect(codes.delete).toHaveBeenCalledWith(key)
	})

	it('cleans up an ambiguous KV put failure before retrying', async () => {
		const { board, codes, kv, meta } = await createBoard()
		codes.put.mockImplementationOnce(async (key: string, value: string) => {
			kv.set(key, value)
			throw new Error('KV put failed after commit')
		})

		await expect(priv(board).ensureShareCode(BOARD_ID)).rejects.toThrow(
			'KV put failed after commit',
		)
		const failedKey = String(codes.put.mock.calls[0]?.[0])
		expect(codes.delete).toHaveBeenCalledWith(failedKey)
		expect(kv.has(failedKey)).toBe(false)
		expect(meta.has('meta:activeCode')).toBe(false)

		const retry = await priv(board).ensureShareCode(BOARD_ID)
		expect(retry?.code).toMatch(/^[0-9A-Z]{8}$/)
		expect(kv.get(`code:${retry?.code}`)).toBe(
			JSON.stringify({ boardId: BOARD_ID }),
		)
	})

	it('compensates an active-code write failure and permits a clean retry', async () => {
		const { board, codes, kv, meta, storage } = await createBoard()
		let failActiveWrite = true
		storage.put.mockImplementation(async (key: string, value: unknown) => {
			if (key === 'meta:activeCode' && failActiveWrite) {
				failActiveWrite = false
				throw new Error('active-code write failed')
			}
			meta.set(key, value)
		})

		await expect(priv(board).ensureShareCode(BOARD_ID)).rejects.toThrow(
			'active-code write failed',
		)
		const failedKey = String(codes.put.mock.calls[0]?.[0])
		expect(codes.delete).toHaveBeenCalledWith(failedKey)
		expect(kv.has(failedKey)).toBe(false)
		expect(meta.has('meta:activeCode')).toBe(false)

		const retry = await priv(board).ensureShareCode(BOARD_ID)
		expect(retry?.code).toMatch(/^[0-9A-Z]{8}$/)
		expect(meta.get('meta:activeCode')).toBe(retry?.code)
		expect(kv.size).toBe(1)
	})

	it('serializes expiry behind an in-flight mint', async () => {
		const { board, codes, kv, meta } = await createBoard()
		const putStarted = deferred<{ key: string }>()
		const releasePut = deferred<void>()
		codes.put.mockImplementationOnce(async (key: string, value: string) => {
			kv.set(key, value)
			putStarted.resolve({ key })
			await releasePut.promise
		})

		const pendingMint = priv(board).ensureShareCode(BOARD_ID)
		const { key } = await putStarted.promise
		const pendingExpiry = priv(board).expireUnsavedBoard()
		releasePut.resolve()

		expect(await pendingMint).toBeNull()
		await pendingExpiry
		expect(kv.has(key)).toBe(false)
		expect(meta.has('meta:activeCode')).toBe(false)
	})

	it('deletes leftover codeExpiresAt only when that key exists', async () => {
		const { board, codes, storage, meta } = await createBoard()
		meta.set('meta:activeCode', SHARE_CODE)
		meta.set('meta:codeExpiresAt', '2026-01-02T00:00:00.000Z')

		await priv(board).ensureShareCode(BOARD_ID)

		expect(codes.put).not.toHaveBeenCalled()
		expect(storage.delete).toHaveBeenCalledWith('meta:codeExpiresAt')
	})

	it('GET /meta is read-only for a fresh board', async () => {
		const { board, codes, meta, sqlExec, storage } = await createBoard()

		const response = await board.fetch(
			new Request(
				`https://scsfoxchase.tech/api/whiteboard/boards/${BOARD_ID}/meta`,
			),
		)

		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({
			savedToLibrary: false,
			cloudOwnerKey: null,
			createdAt: null,
			unsavedExpiresAt: null,
			title: 'Untitled board',
			classCanEdit: false,
		})
		expect(meta.size).toBe(0)
		expect(sqlExec).not.toHaveBeenCalled()
		expect(storage.put).not.toHaveBeenCalled()
		expect(storage.delete).not.toHaveBeenCalled()
		expect(storage.setAlarm).not.toHaveBeenCalled()
		expect(storage.deleteAlarm).not.toHaveBeenCalled()
		expect(codes.put).not.toHaveBeenCalled()
		expect(codes.get).not.toHaveBeenCalled()
	})

	it('GET /meta returns existing lifetime metadata without rewriting it', async () => {
		const expiresAt = '2026-08-28T12:00:00.000Z'
		const { board, codes, sqlExec, storage } = await createBoard({ expiresAt })
		sqlExec.mockClear()
		storage.put.mockClear()
		storage.delete.mockClear()
		storage.setAlarm.mockClear()
		storage.deleteAlarm.mockClear()

		const response = await board.fetch(
			new Request(
				`https://scsfoxchase.tech/api/whiteboard/boards/${BOARD_ID}/meta`,
			),
		)

		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({
			createdAt: '2026-01-01T00:00:00.000Z',
			unsavedExpiresAt: expiresAt,
		})
		expect(sqlExec).not.toHaveBeenCalled()
		expect(storage.put).not.toHaveBeenCalled()
		expect(storage.delete).not.toHaveBeenCalled()
		expect(storage.setAlarm).not.toHaveBeenCalled()
		expect(storage.deleteAlarm).not.toHaveBeenCalled()
		expect(codes.put).not.toHaveBeenCalled()
		expect(codes.get).not.toHaveBeenCalled()
	})

	it('skips sql exec when scene_json is unchanged', async () => {
		const { board, sqlExec } = await createBoard()
		const empty = { elements: [] as SceneElement[], appState: {} }

		priv(board).persistScene(empty)
		expect(sceneInsertCount(sqlExec)).toBe(1)
		expect(
			sqlExec.mock.calls.some((call) => isSceneTableCreate(String(call[0]))),
		).toBe(false)

		priv(board).persistScene(empty)
		expect(sceneInsertCount(sqlExec)).toBe(1)

		await priv(board).applySceneUpdate(
			'writer-session',
			[],
			JSON.stringify({
				type: 'excalidraw',
				version: 2,
				source: 'https://scsfoxchase.tech',
				elements: [],
				appState: {},
			}),
			false,
		)
		expect(sceneInsertCount(sqlExec)).toBe(1)
	})

	it('force persist writes even when the blob is unchanged', async () => {
		const { board, sqlExec } = await createBoard()
		const empty = { elements: [] as SceneElement[], appState: {} }
		priv(board).persistScene(empty)
		expect(sceneInsertCount(sqlExec)).toBe(1)
		priv(board).persistScene(empty)
		expect(sceneInsertCount(sqlExec)).toBe(1)
		priv(board).persistScene(empty, { force: true })
		expect(sceneInsertCount(sqlExec)).toBe(2)
	})

	it('persists when merge accepted.length > 0', async () => {
		const { board, sqlExec } = await createBoard()
		priv(board).persistScene({ elements: [], appState: {} })
		const inserts = sceneInsertCount(sqlExec)

		await priv(board).applySceneUpdate(
			'writer-session',
			[
				{
					id: 'rect-1',
					type: 'rectangle',
					version: 1,
					versionNonce: 1,
				},
			],
			undefined,
			false,
		)

		expect(sceneInsertCount(sqlExec)).toBe(inserts + 1)
	})

	it('keeps a failed mutation retryable without advancing its scene revision', async () => {
		const { board, sqlExec } = await createBoard()
		priv(board).persistScene({ elements: [], appState: {} })
		const original = sqlExec.getMockImplementation()
		if (!original) throw new Error('missing SQL harness implementation')
		sqlExec.mockImplementationOnce((query: string, ...binds: unknown[]) => {
			if (isSceneInsert(query)) throw new Error('injected scene write failure')
			return original(query, ...binds)
		})
		const element = {
			id: 'retryable-scene-element',
			type: 'rectangle',
			version: 1,
			versionNonce: 1,
		}
		const mutationId = crypto.randomUUID()
		await expect(
			priv(board).applySceneUpdate(
				'writer-session',
				[element],
				undefined,
				false,
				mutationId,
				1,
			),
		).rejects.toThrow()
		await expect(
			priv(board).applySceneUpdate(
				'writer-session',
				[element],
				undefined,
				false,
				mutationId,
				1,
			),
		).resolves.toBe('applied')
	})

	describe('alarm scheduling', () => {
		beforeEach(() => {
			vi.useFakeTimers()
			vi.setSystemTime(new Date('2026-08-30T12:00:00.000Z'))
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		it('skips alarm changes when an alarm is already at the future expiry', async () => {
			const expiresAt = new Date(Date.now() + 60_000).toISOString()
			const target = Date.parse(expiresAt)
			const { board, storage } = await createBoard({
				expiresAt,
				alarm: target,
			})

			await priv(board).scheduleNextAlarm()

			expect(storage.setAlarm).not.toHaveBeenCalled()
			expect(storage.deleteAlarm).not.toHaveBeenCalled()
		})

		it('sets an alarm when the future expiry has no alarm', async () => {
			const expiresAt = new Date(Date.now() + 60_000).toISOString()
			const { board, storage } = await createBoard({
				expiresAt,
				alarm: null,
			})

			await priv(board).scheduleNextAlarm()

			expect(storage.setAlarm).toHaveBeenCalledTimes(1)
			expect(storage.setAlarm).toHaveBeenCalledWith(Date.parse(expiresAt))
			expect(storage.deleteAlarm).not.toHaveBeenCalled()
		})

		it('deletes an existing alarm when the expiry has passed', async () => {
			const expiresAt = new Date(Date.now() - 60_000).toISOString()
			const { board, storage } = await createBoard({
				expiresAt,
				alarm: Date.parse(expiresAt),
			})

			await priv(board).scheduleNextAlarm()

			expect(storage.deleteAlarm).toHaveBeenCalledTimes(1)
			expect(storage.setAlarm).not.toHaveBeenCalled()
		})
	})

	it('skips repeated writes for an unchanged Group Edit setting', async () => {
		const { board, storage } = await createBoard()

		await priv(board).setClassCanEdit(false)
		expect(storage.delete).not.toHaveBeenCalledWith(META_CLASS_CAN_EDIT_KEY)

		await priv(board).setClassCanEdit(true)
		await priv(board).setClassCanEdit(true)
		expect(storage.put).toHaveBeenCalledTimes(1)
		expect(storage.put).toHaveBeenCalledWith(META_CLASS_CAN_EDIT_KEY, true)

		await priv(board).setClassCanEdit(false)
		await priv(board).setClassCanEdit(false)
		expect(storage.delete).toHaveBeenCalledTimes(1)
		expect(storage.delete).toHaveBeenCalledWith(META_CLASS_CAN_EDIT_KEY)
	})

	it('persists a scene that references an image not yet in R2', async () => {
		const { board, sqlExec } = await createBoard()
		priv(board).persistScene({ elements: [], appState: {} })
		const inserts = sceneInsertCount(sqlExec)

		await priv(board).applySceneUpdate(
			'writer-session',
			[
				{
					id: 'img-1',
					type: 'image',
					version: 1,
					versionNonce: 1,
					fileId: FILE_ID,
				},
			],
			undefined,
			false,
		)
		expect(sceneInsertCount(sqlExec)).toBe(inserts + 1)
	})
})
