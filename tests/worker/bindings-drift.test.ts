import { env } from 'cloudflare:workers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootWorker, disposeWorker } from './helpers/harness'
import rootWranglerSource from '../../wrangler.jsonc?raw'
import testWranglerSource from './wrangler.jsonc?raw'

type DurableObjectBinding = { name: string; class_name: string }

type WranglerBindings = {
	durableObjects: DurableObjectBinding[]
	r2: string[]
	kv: string[]
}

const REQUIRED_DO = { name: 'WHITEBOARDS', class_name: 'WhiteboardBoard' }
const REQUIRED_R2 = 'WHITEBOARD_ASSETS'
const REQUIRED_KV = 'WHITEBOARD_CODES'

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

	return {
		durableObjects: durableBindings.map((binding) => ({
			name: stringProp(binding, 'name'),
			class_name: stringProp(binding, 'class_name'),
		})),
		r2: r2.map((bucket) => stringProp(bucket, 'binding')),
		kv: kv.map((namespace) => stringProp(namespace, 'binding')),
	}
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

		expect(root.durableObjects).toContainEqual(REQUIRED_DO)
		expect(test.durableObjects).toContainEqual(REQUIRED_DO)
		expect(root.r2).toContain(REQUIRED_R2)
		expect(test.r2).toContain(REQUIRED_R2)
		expect(root.kv).toContain(REQUIRED_KV)
		expect(test.kv).toContain(REQUIRED_KV)
	})

	it('exposes WHITEBOARDS, WHITEBOARD_ASSETS, and WHITEBOARD_CODES as the right binding kinds', async () => {
		// `cloudflare:workers` `env` is not the global `Env` under tsc; the
		// runtime bindings still have to exist or Miniflare misconfigures the Worker.
		const workerEnv = env as unknown as {
			WHITEBOARDS: DurableObjectNamespace
			WHITEBOARD_ASSETS: R2Bucket
			WHITEBOARD_CODES: KVNamespace
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
	})
})
