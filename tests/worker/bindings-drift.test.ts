import { env } from 'cloudflare:workers'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootWorker, disposeWorker } from './helpers/harness'
import rootWranglerSource from '../../wrangler.jsonc?raw'
import testWranglerSource from './wrangler.jsonc?raw'

type DurableObjectBinding = { name: string; class_name: string }
type D1Binding = {
	binding: string
	database_name: string
	database_id: string
	preview_database_id?: string
	migrations_dir?: string
}

type WranglerBindings = {
	durableObjects: DurableObjectBinding[]
	r2: string[]
	kv: string[]
	d1: D1Binding[]
}

const REQUIRED_DO = { name: 'WHITEBOARDS', class_name: 'WhiteboardBoard' }
const REQUIRED_R2 = 'WHITEBOARD_ASSETS'
const REQUIRED_KV = 'WHITEBOARD_CODES'
const REQUIRED_D1 = 'WHITEBOARD_LIBRARY'

function parseJsonc(source: string): Record<string, unknown> {
	const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
	const parsed: unknown = JSON.parse(stripped)
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('wrangler config is not a JSON object')
	}
	return parsed as Record<string, unknown>
}

function stringProp(value: unknown, key: string): string {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
	const raw = (value as Record<string, unknown>)[key]
	return typeof raw === 'string' ? raw : ''
}

function bindingsFromConfig(source: string, label: string): WranglerBindings {
	const config = parseJsonc(source)
	const durable = config.durable_objects
	const durableBindings =
		durable && typeof durable === 'object' && !Array.isArray(durable)
			? (durable as Record<string, unknown>).bindings
			: undefined
	if (!Array.isArray(durableBindings)) {
		throw new Error(`${label} is missing durable_objects.bindings`)
	}

	const r2 = config.r2_buckets
	if (!Array.isArray(r2)) {
		throw new Error(`${label} is missing r2_buckets`)
	}

	const kv = config.kv_namespaces
	if (!Array.isArray(kv)) {
		throw new Error(`${label} is missing kv_namespaces`)
	}

	const d1 = config.d1_databases
	if (!Array.isArray(d1)) {
		throw new Error(`${label} is missing d1_databases`)
	}

	return {
		durableObjects: durableBindings.map((binding) => ({
			name: stringProp(binding, 'name'),
			class_name: stringProp(binding, 'class_name'),
		})),
		r2: r2.map((bucket) => stringProp(bucket, 'binding')),
		kv: kv.map((namespace) => stringProp(namespace, 'binding')),
		d1: d1.map((database) => ({
			binding: stringProp(database, 'binding'),
			database_name: stringProp(database, 'database_name'),
			database_id: stringProp(database, 'database_id'),
			preview_database_id: stringProp(database, 'preview_database_id') || undefined,
			migrations_dir: stringProp(database, 'migrations_dir') || undefined,
		})),
	}
}

type TableInfo = {
	cid: number
	name: string
	type: string
	notnull: number
	dflt_value: string | null
	pk: number
}

type IndexInfo = {
	seqno: number
	cid: number
	name: string | null
}

type IndexXInfo = IndexInfo & {
	desc: number
	key: number
}

function resolveMigrationsPath(
	binding: D1Binding | undefined,
	configPath: string,
	label: string,
): string {
	if (!binding?.migrations_dir) {
		throw new Error(`${label} WHITEBOARD_LIBRARY is missing migrations_dir`)
	}
	return resolve(dirname(configPath), binding.migrations_dir)
}

async function tableInfo(
	database: D1Database,
	tableName: string,
): Promise<TableInfo[]> {
	const result = await database
		.prepare(`PRAGMA table_info(${tableName})`)
		.all<TableInfo>()
	return result.results
}

async function indexInfo(
	database: D1Database,
	indexName: string,
): Promise<IndexInfo[]> {
	const result = await database
		.prepare(`PRAGMA index_info(${indexName})`)
		.all<IndexInfo>()
	return result.results
}

async function indexXInfo(
	database: D1Database,
	indexName: string,
): Promise<IndexXInfo[]> {
	const result = await database
		.prepare(`PRAGMA index_xinfo(${indexName})`)
		.all<IndexXInfo>()
	return result.results
}

describe('worker binding config must not drift', () => {
	beforeAll(async () => {
		await bootWorker()
	})

	afterAll(async () => {
		await disposeWorker()
	})

	it('keeps test wrangler bindings a superset of production wrangler bindings', () => {
		const root = bindingsFromConfig(rootWranglerSource, 'wrangler.jsonc')
		const test = bindingsFromConfig(
			testWranglerSource,
			'tests/worker/wrangler.jsonc',
		)

		for (const binding of root.durableObjects) {
			expect(
				test.durableObjects,
				`tests/worker/wrangler.jsonc is missing Durable Object ${binding.name} (${binding.class_name}) from wrangler.jsonc`,
			).toContainEqual(binding)
		}
		for (const binding of root.r2) {
			expect(
				test.r2,
				`tests/worker/wrangler.jsonc is missing R2 binding ${binding} from wrangler.jsonc`,
			).toContain(binding)
		}
		for (const binding of root.kv) {
			expect(
				test.kv,
				`tests/worker/wrangler.jsonc is missing KV binding ${binding} from wrangler.jsonc`,
			).toContain(binding)
		}
		for (const binding of root.d1) {
			expect(
				test.d1.map((database) => database.binding),
				`tests/worker/wrangler.jsonc is missing D1 binding ${binding.binding} from wrangler.jsonc`,
			).toContain(binding.binding)
		}

		expect(root.durableObjects).toContainEqual(REQUIRED_DO)
		expect(test.durableObjects).toContainEqual(REQUIRED_DO)
		expect(root.r2).toContain(REQUIRED_R2)
		expect(test.r2).toContain(REQUIRED_R2)
		expect(root.kv).toContain(REQUIRED_KV)
		expect(test.kv).toContain(REQUIRED_KV)
		expect(root.d1.map((database) => database.binding)).toContain(REQUIRED_D1)
		expect(test.d1.map((database) => database.binding)).toContain(REQUIRED_D1)

		const rootLibrary = root.d1.find(
			(database) => database.binding === REQUIRED_D1,
		)
		const testLibrary = test.d1.find(
			(database) => database.binding === REQUIRED_D1,
		)
		const rootWranglerPath = fileURLToPath(
			new URL('../../wrangler.jsonc', import.meta.url),
		)
		const testWranglerPath = fileURLToPath(
			new URL('./wrangler.jsonc', import.meta.url),
		)
		const migrationsPath = fileURLToPath(
			new URL('../../migrations', import.meta.url),
		)
		expect(resolveMigrationsPath(rootLibrary, rootWranglerPath, 'wrangler.jsonc')).toBe(
			migrationsPath,
		)
		expect(
			resolveMigrationsPath(
				testLibrary,
				testWranglerPath,
				'tests/worker/wrangler.jsonc',
			),
		).toBe(migrationsPath)
		expect(rootLibrary?.database_name).toBe(
			'scsfoxchase-tech-whiteboard-library',
		)
		expect(rootLibrary?.database_id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
		)
		expect(rootLibrary?.preview_database_id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
		)
		expect(rootLibrary?.database_id).not.toBe(
			rootLibrary?.preview_database_id,
		)
		expect(testLibrary?.database_id).not.toBe(rootLibrary?.database_id)
		expect(testLibrary?.database_id).not.toBe(rootLibrary?.preview_database_id)
	})

	it('exposes whiteboard storage bindings as the right binding kinds', async () => {
		// `cloudflare:workers` `env` is not the global `Env` under tsc; the
		// runtime bindings still have to exist or Miniflare misconfigures the Worker.
		const workerEnv = env as unknown as {
			WHITEBOARDS: DurableObjectNamespace
			WHITEBOARD_ASSETS: R2Bucket
			WHITEBOARD_CODES: KVNamespace
			WHITEBOARD_LIBRARY: D1Database
		}

		expect(workerEnv.WHITEBOARDS).toBeTruthy()
		expect(typeof workerEnv.WHITEBOARDS.idFromName).toBe('function')
		expect(typeof workerEnv.WHITEBOARDS.get).toBe('function')

		expect(workerEnv.WHITEBOARD_ASSETS).toBeTruthy()
		expect(typeof workerEnv.WHITEBOARD_ASSETS.get).toBe('function')
		expect(typeof workerEnv.WHITEBOARD_ASSETS.put).toBe('function')
		expect(
			await workerEnv.WHITEBOARD_ASSETS.head('__bindings-drift-probe__'),
		).toBeNull()

		expect(workerEnv.WHITEBOARD_CODES).toBeTruthy()
		expect(typeof workerEnv.WHITEBOARD_CODES.get).toBe('function')
		expect(typeof workerEnv.WHITEBOARD_CODES.put).toBe('function')
		expect(
			await workerEnv.WHITEBOARD_CODES.get('__bindings-drift-probe__'),
		).toBeNull()

		expect(workerEnv.WHITEBOARD_LIBRARY).toBeTruthy()
		expect(typeof workerEnv.WHITEBOARD_LIBRARY.prepare).toBe('function')
		const d1Probe = await workerEnv.WHITEBOARD_LIBRARY.prepare('SELECT 1 AS ok').first<{ ok: number }>()
		expect(d1Probe?.ok).toBe(1)
	})

	it('applies the configured D1 migrations and exposes the exact schema', async () => {
		const workerEnv = env as unknown as {
			WHITEBOARD_LIBRARY: D1Database
		}
		const database = workerEnv.WHITEBOARD_LIBRARY

		const appliedMigrations = await database
			.prepare('SELECT name FROM d1_migrations ORDER BY id')
			.all<{ name: string }>()
		expect(appliedMigrations.results.map(({ name }) => name)).toEqual([
			'0000_create_whiteboard_library.sql',
			'0001_enforce_library_owner_imports_owner_key.sql',
			'0002_add_library_tombstones.sql',
		])

		const tables = await database
			.prepare(
				`SELECT name FROM sqlite_master
				 WHERE type = 'table'
				   AND name IN (?, ?, ?, ?, ?)
				 ORDER BY name`,
			)
			.bind(
				'library_boards',
				'library_assets',
				'library_owner_imports',
				'library_board_tombstones',
				'library_asset_tombstones',
			)
			.all<{ name: string }>()
		expect(tables.results.map(({ name }) => name)).toEqual([
			'library_asset_tombstones',
			'library_assets',
			'library_board_tombstones',
			'library_boards',
			'library_owner_imports',
		])

		const indexes = await database
			.prepare(
				`SELECT name FROM sqlite_master
				 WHERE type = 'index'
				   AND name IN (?, ?, ?, ?)
				 ORDER BY name`,
			)
			.bind(
				'library_assets_owner_recent',
				'library_boards_owner_recent',
				'library_asset_tombstones_owner',
				'library_board_tombstones_owner',
			)
			.all<{ name: string }>()
		expect(indexes.results.map(({ name }) => name)).toEqual([
			'library_asset_tombstones_owner',
			'library_assets_owner_recent',
			'library_board_tombstones_owner',
			'library_boards_owner_recent',
		])

		expect(await tableInfo(database, 'library_boards')).toEqual([
			{
				cid: 0,
				name: 'owner_key',
				type: 'TEXT',
				notnull: 1,
				dflt_value: null,
				pk: 1,
			},
			{
				cid: 1,
				name: 'board_id',
				type: 'TEXT',
				notnull: 1,
				dflt_value: null,
				pk: 2,
			},
			{
				cid: 2,
				name: 'title',
				type: 'TEXT',
				notnull: 1,
				dflt_value: null,
				pk: 0,
			},
			{
				cid: 3,
				name: 'last_accessed_at',
				type: 'TEXT',
				notnull: 1,
				dflt_value: null,
				pk: 0,
			},
			{
				cid: 4,
				name: 'preview_data_url',
				type: 'TEXT',
				notnull: 0,
				dflt_value: null,
				pk: 0,
			},
		])

		expect(await tableInfo(database, 'library_assets')).toEqual([
			{
				cid: 0,
				name: 'owner_key',
				type: 'TEXT',
				notnull: 1,
				dflt_value: null,
				pk: 1,
			},
			{
				cid: 1,
				name: 'asset_id',
				type: 'TEXT',
				notnull: 1,
				dflt_value: null,
				pk: 2,
			},
			{
				cid: 2,
				name: 'title',
				type: 'TEXT',
				notnull: 1,
				dflt_value: null,
				pk: 0,
			},
			{
				cid: 3,
				name: 'created_at',
				type: 'TEXT',
				notnull: 1,
				dflt_value: null,
				pk: 0,
			},
			{
				cid: 4,
				name: 'last_accessed_at',
				type: 'TEXT',
				notnull: 1,
				dflt_value: null,
				pk: 0,
			},
			{
				cid: 5,
				name: 'mime_type',
				type: 'TEXT',
				notnull: 1,
				dflt_value: null,
				pk: 0,
			},
			{
				cid: 6,
				name: 'size',
				type: 'INTEGER',
				notnull: 0,
				dflt_value: null,
				pk: 0,
			},
			{
				cid: 7,
				name: 'r2_key',
				type: 'TEXT',
				notnull: 1,
				dflt_value: null,
				pk: 0,
			},
			{
				cid: 8,
				name: 'source_board_ids_json',
				type: 'TEXT',
				notnull: 0,
				dflt_value: null,
				pk: 0,
			},
		])

		expect(await tableInfo(database, 'library_owner_imports')).toEqual([
			{
				cid: 0,
				name: 'owner_key',
				type: 'TEXT',
				notnull: 1,
				dflt_value: null,
				pk: 1,
			},
			{
				cid: 1,
				name: 'imported_at',
				type: 'TEXT',
				notnull: 1,
				dflt_value: null,
				pk: 0,
			},
			{
				cid: 2,
				name: 'import_version',
				type: 'INTEGER',
				notnull: 1,
				dflt_value: null,
				pk: 0,
			},
		])

		expect(await tableInfo(database, 'library_board_tombstones')).toEqual([
			{
				cid: 0,
				name: 'owner_key',
				type: 'TEXT',
				notnull: 1,
				dflt_value: null,
				pk: 1,
			},
			{
				cid: 1,
				name: 'board_id',
				type: 'TEXT',
				notnull: 1,
				dflt_value: null,
				pk: 2,
			},
			{
				cid: 2,
				name: 'deleted_at',
				type: 'TEXT',
				notnull: 1,
				dflt_value: null,
				pk: 0,
			},
		])

		expect(await tableInfo(database, 'library_asset_tombstones')).toEqual([
			{
				cid: 0,
				name: 'owner_key',
				type: 'TEXT',
				notnull: 1,
				dflt_value: null,
				pk: 1,
			},
			{
				cid: 1,
				name: 'asset_id',
				type: 'TEXT',
				notnull: 1,
				dflt_value: null,
				pk: 2,
			},
			{
				cid: 2,
				name: 'deleted_at',
				type: 'TEXT',
				notnull: 1,
				dflt_value: null,
				pk: 0,
			},
		])

		expect(await indexInfo(database, 'library_boards_owner_recent')).toEqual([
			{ seqno: 0, cid: 0, name: 'owner_key' },
			{ seqno: 1, cid: 3, name: 'last_accessed_at' },
		])
		expect(await indexInfo(database, 'library_assets_owner_recent')).toEqual([
			{ seqno: 0, cid: 0, name: 'owner_key' },
			{ seqno: 1, cid: 4, name: 'last_accessed_at' },
		])
		expect(await indexInfo(database, 'library_board_tombstones_owner')).toEqual([
			{ seqno: 0, cid: 0, name: 'owner_key' },
		])
		expect(await indexInfo(database, 'library_asset_tombstones_owner')).toEqual([
			{ seqno: 0, cid: 0, name: 'owner_key' },
		])

		expect(
			(await indexXInfo(database, 'library_boards_owner_recent'))
				.filter(({ key }) => key === 1)
				.map(({ seqno, name, desc }) => ({ seqno, name, desc })),
		).toEqual([
			{ seqno: 0, name: 'owner_key', desc: 0 },
			{ seqno: 1, name: 'last_accessed_at', desc: 1 },
		])
		expect(
			(await indexXInfo(database, 'library_assets_owner_recent'))
				.filter(({ key }) => key === 1)
				.map(({ seqno, name, desc }) => ({ seqno, name, desc })),
		).toEqual([
			{ seqno: 0, name: 'owner_key', desc: 0 },
			{ seqno: 1, name: 'last_accessed_at', desc: 1 },
		])
		expect(
			(await indexXInfo(database, 'library_board_tombstones_owner'))
				.filter(({ key }) => key === 1)
				.map(({ seqno, name, desc }) => ({ seqno, name, desc })),
		).toEqual([{ seqno: 0, name: 'owner_key', desc: 0 }])
		expect(
			(await indexXInfo(database, 'library_asset_tombstones_owner'))
				.filter(({ key }) => key === 1)
				.map(({ seqno, name, desc }) => ({ seqno, name, desc })),
		).toEqual([{ seqno: 0, name: 'owner_key', desc: 0 }])
	})
})
