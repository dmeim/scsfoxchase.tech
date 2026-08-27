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
	shouldReplaceStorageAlarm,
	shouldSkipIdenticalScenePersist,
} from '../src/worker/WhiteboardBoard'
import {
	FULL_RESYNC_EVERY,
	META_BOARD_ID_KEY,
	META_CREATED_AT_KEY,
	META_UNSAVED_EXPIRES_AT_KEY,
	SCENE_ASSET_NOT_READY_CODE,
	sceneBroadcastPlan,
	shouldApplySocketReauth,
	shouldSkipIdleFullFlush,
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
	applySceneUpdate: (
		fromSessionId: string,
		incoming: SceneElement[],
		databaseJson: string | undefined,
		full: boolean,
	) => Promise<void>
}

function priv(board: WhiteboardBoard): BoardPrivate {
	return board as unknown as BoardPrivate
}

function isSceneInsert(query: string): boolean {
	return /INSERT INTO excalidraw_scene\b/i.test(query)
}

function createHarness(options?: { expiresAt?: string; alarm?: number | null }) {
	const meta = new Map<string, unknown>()
	if (options?.expiresAt) {
		meta.set(META_BOARD_ID_KEY, BOARD_ID)
		meta.set(META_CREATED_AT_KEY, '2026-01-01T00:00:00.000Z')
		meta.set(META_UNSAVED_EXPIRES_AT_KEY, options.expiresAt)
	}

	let alarm: number | null =
		options?.alarm === undefined ? null : options.alarm
	let sceneJson: string | null = null
	const kv = new Map<string, string>()
	let initPromise = Promise.resolve()

	const sqlExec = vi.fn((query: string, ...binds: unknown[]) => {
		const q = String(query)
		if (/sqlite_master/i.test(q)) {
			return { toArray: () => [] }
		}
		if (/PRAGMA table_info\(excalidraw_scene\)/i.test(q)) {
			return {
				toArray: () => [
					{ name: 'id' },
					{ name: 'scene_json' },
					{ name: 'updated_at' },
				],
			}
		}
		if (/SELECT scene_json FROM excalidraw_scene/i.test(q)) {
			return {
				toArray: () => (sceneJson ? [{ scene_json: sceneJson }] : []),
			}
		}
		if (/FROM whiteboard_asset_manifest/i.test(q)) {
			return { toArray: () => [] }
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

describe('WhiteboardBoard share-code and persist lifetime', () => {
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

	it('fails closed on asset_not_ready and does not persist', async () => {
		const { board, sqlExec } = await createBoard()
		priv(board).persistScene({ elements: [], appState: {} })
		const inserts = sceneInsertCount(sqlExec)

		await expect(
			priv(board).applySceneUpdate(
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
			),
		).rejects.toMatchObject({
			code: SCENE_ASSET_NOT_READY_CODE,
		})
		expect(sceneInsertCount(sqlExec)).toBe(inserts)
	})
})

describe('sceneBroadcastPlan writer exclude', () => {
	it('excludes the writer from full scene:sync broadcasts', () => {
		expect(
			sceneBroadcastPlan({
				full: true,
				updatesSinceFullSync: 1,
				fromSessionId: 'writer-session',
			}),
		).toEqual({ type: 'scene:sync', exceptSessionId: 'writer-session' })
		expect(
			sceneBroadcastPlan({
				full: false,
				updatesSinceFullSync: FULL_RESYNC_EVERY,
				fromSessionId: 'writer-session',
			}),
		).toEqual({ type: 'scene:sync', exceptSessionId: 'writer-session' })
	})
})

describe('shouldSkipIdleFullFlush', () => {
	it('skips when the scene version has not moved', () => {
		expect(
			shouldSkipIdleFullFlush({
				sceneVersion: 10,
				acknowledgedVersion: 10,
				lastSentFullFlushVersion: 10,
			}),
		).toBe(true)
	})

	it('retries the same version after persist_failed', () => {
		expect(
			shouldSkipIdleFullFlush({
				sceneVersion: 10,
				acknowledgedVersion: 10,
				lastSentFullFlushVersion: 10,
				persistFailedNeedsRetry: true,
			}),
		).toBe(false)
	})
})

describe('shouldApplySocketReauth', () => {
	const guest = {
		role: 'editor' as const,
		userId: '11111111-1111-4111-8111-111111111111',
		isHost: false,
		displayName: 'Guest',
	}

	it('upgrades share-code Editor to Owner when Clerk identity arrives', () => {
		expect(
			shouldApplySocketReauth(guest, {
				role: 'owner',
				userId: 'google-sub',
				isHost: true,
				displayName: 'Teacher',
			}),
		).toBe(true)
	})

	it('attaches Clerk identity to a host-secret Owner without a second hello', () => {
		expect(
			shouldApplySocketReauth(
				{
					role: 'owner',
					userId: guest.userId,
					isHost: true,
					displayName: 'Guest',
				},
				{
					role: 'owner',
					userId: 'google-sub',
					isHost: true,
					displayName: 'Teacher',
				},
			),
		).toBe(true)
	})

	it('does not demote an editable session', () => {
		expect(
			shouldApplySocketReauth(guest, {
				role: 'viewer',
				userId: guest.userId,
				isHost: false,
				displayName: 'Guest',
			}),
		).toBe(false)
	})
})
