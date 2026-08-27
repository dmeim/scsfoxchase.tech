import { beforeEach, describe, expect, it, vi } from 'vitest'

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
	ensureShareCode: (boardId: string) => Promise<{ code: string } | null>
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
	) => Promise<void>
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
	sceneTable?: 'current' | 'legacy-v2' | 'v2' | 'missing'
	sceneJson?: string
	legacyLiveJson?: string
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
	const kv = new Map<string, string>()
	let initPromise = Promise.resolve()

	const sqlExec = vi.fn((query: string, ...binds: unknown[]) => {
		const q = String(query)
		if (/sqlite_master/i.test(q)) {
			const names =
				sceneTable === 'legacy-v2'
					? ['excalidraw_scene', 'excalidraw_scene_v2']
					: sceneTable === 'current'
						? ['excalidraw_scene']
						: sceneTable === 'v2'
							? ['excalidraw_scene_v2']
							: []
			return { toArray: () => names.map((name) => ({ name })) }
		}
		if (/PRAGMA table_info\(excalidraw_scene\)/i.test(q)) {
			return {
				toArray: () =>
					sceneTable === 'current'
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
						: [],
			}
		}
		if (/PRAGMA table_info\(excalidraw_scene_v2\)/i.test(q)) {
			return {
				toArray: () =>
					sceneTable === 'v2' || sceneTable === 'legacy-v2'
						? [
								{ name: 'id' },
								{ name: 'scene_json' },
								{ name: 'updated_at' },
							]
						: [],
			}
		}
		if (/SELECT scene_json FROM excalidraw_scene(?:_v2)?/i.test(q)) {
			return {
				toArray: () => (sceneJson ? [{ scene_json: sceneJson }] : []),
			}
		}
		if (/SELECT live_json, database_json FROM excalidraw_scene/i.test(q)) {
			return {
				toArray: () =>
					options?.legacyLiveJson
						? [
								{
									live_json: options.legacyLiveJson,
									database_json: '',
								},
							]
						: [],
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

	return { meta, codes, storage, ctx, env, sqlExec, getInit: () => initPromise }
}

async function createBoard(options?: {
	expiresAt?: string
	alarm?: number | null
	sceneTable?: 'current' | 'legacy-v2' | 'v2' | 'missing'
	sceneJson?: string
	legacyLiveJson?: string
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

describe('WhiteboardBoard share-code and persist lifetime', () => {
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

	it('initializes scene storage once on the first board lifetime request', async () => {
		const { board, sqlExec } = await createBoard()
		const request = () =>
			new Request(
				`https://scsfoxchase.tech/api/whiteboard/boards/${BOARD_ID}/meta`,
			)

		expect(sqlExec).not.toHaveBeenCalled()
		expect((await board.fetch(request())).status).toBe(200)
		expect(
			sqlExec.mock.calls.filter((call) => isSceneTableCreate(String(call[0]))),
		).toHaveLength(1)

		expect((await board.fetch(request())).status).toBe(200)
		expect(
			sqlExec.mock.calls.filter((call) => isSceneTableCreate(String(call[0]))),
		).toHaveLength(1)
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

	it('ensureShareCode with an existing code does not KV put', async () => {
		const { board, codes, storage, meta } = await createBoard()
		meta.set('meta:activeCode', SHARE_CODE)

		const state = await priv(board).ensureShareCode(BOARD_ID)

		expect(state).toEqual({ code: SHARE_CODE })
		expect(codes.put).not.toHaveBeenCalled()
		expect(storage.delete).not.toHaveBeenCalledWith('meta:codeExpiresAt')
	})

	it('deletes leftover codeExpiresAt only when that key exists', async () => {
		const { board, codes, storage, meta } = await createBoard()
		meta.set('meta:activeCode', SHARE_CODE)
		meta.set('meta:codeExpiresAt', '2026-01-02T00:00:00.000Z')

		await priv(board).ensureShareCode(BOARD_ID)

		expect(codes.put).not.toHaveBeenCalled()
		expect(storage.delete).toHaveBeenCalledWith('meta:codeExpiresAt')
	})

	it('GET /meta does not mint or KV-put a share code', async () => {
		const { board, codes } = await createBoard()

		const response = await board.fetch(
			new Request(
				`https://scsfoxchase.tech/api/whiteboard/boards/${BOARD_ID}/meta`,
			),
		)

		expect(response.status).toBe(200)
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

	it('skips setAlarm when an alarm is already that time', async () => {
		const expiresAt = '2026-08-28T12:00:00.000Z'
		const target = Date.parse(expiresAt)
		const { board, storage } = await createBoard({
			expiresAt,
			alarm: target,
		})

		await priv(board).scheduleNextAlarm()

		expect(storage.setAlarm).not.toHaveBeenCalled()
	})

	it('setAlarm runs when the existing alarm is missing or drifted', async () => {
		const expiresAt = '2026-08-28T12:00:00.000Z'
		const { board, storage } = await createBoard({
			expiresAt,
			alarm: null,
		})

		await priv(board).scheduleNextAlarm()

		expect(storage.setAlarm).toHaveBeenCalledTimes(1)
		expect(storage.setAlarm).toHaveBeenCalledWith(Date.parse(expiresAt))
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
