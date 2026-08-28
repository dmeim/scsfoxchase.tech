import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const serviceWorkerSource = readFileSync(
	fileURLToPath(new URL('../public/sw.js', import.meta.url)),
	'utf8',
)

type WorkerEvent = {
	request?: RequestLike
	response?: Promise<Response>
	waitUntilPromises: Promise<unknown>[]
	respondWith: (response: Promise<Response>) => void
	waitUntil: (promise: Promise<unknown>) => void
}

type RequestLike = {
	method: string
	url: string
	mode: string
	headers?: Headers
}

function request(
	path: string,
	options: Partial<RequestLike> = {},
): RequestLike {
	return {
		method: 'GET',
		url: `https://scsfoxchase.tech${path}`,
		mode: 'cors',
		headers: new Headers(),
		...options,
	}
}

function workerHarness() {
	const listeners = new Map<string, (event: WorkerEvent) => void>()
	const cache = {
		put: vi.fn<(key: RequestLike, response: Response) => Promise<void>>(
			async () => undefined,
		),
	}
	const cachesApi = {
		open: vi.fn(async () => cache),
		keys: vi.fn(async () => ['old-cache', 'st-cecilia-tech-astro-v17']),
		delete: vi.fn(async () => true),
		match: vi.fn(async () => undefined as Response | undefined),
	}
	const self = {
		location: { origin: 'https://scsfoxchase.tech' },
		clients: { claim: vi.fn(async () => undefined) },
		addEventListener: vi.fn((name: string, listener: (event: WorkerEvent) => void) => {
			listeners.set(name, listener)
		}),
		skipWaiting: vi.fn(async () => undefined),
	}
	const fetchMock = vi.fn()
	const context = {
		self,
		caches: cachesApi,
		fetch: fetchMock,
		URL,
		Response,
		console,
	}
	vm.runInNewContext(serviceWorkerSource, context)

	function dispatch(name: string, event: Partial<WorkerEvent> = {}): WorkerEvent {
		const waitUntilPromises: Promise<unknown>[] = []
		const fullEvent = {
			request: event.request,
			response: undefined as Promise<Response> | undefined,
			waitUntilPromises,
			respondWith: (response: Promise<Response>) => {
				fullEvent.response = response
			},
			waitUntil: (promise: Promise<unknown>) => {
				waitUntilPromises.push(promise)
			},
		}
		listeners.get(name)?.(fullEvent)
		return fullEvent
	}

	return { cache, cachesApi, fetchMock, self, dispatch }
}

describe('service worker policy', () => {
	it('deletes old caches during activation and claims clients', async () => {
		const worker = workerHarness()
		const event = worker.dispatch('activate')
		await Promise.all(event.waitUntilPromises)

		expect(worker.cachesApi.delete).toHaveBeenCalledWith('old-cache')
		expect(worker.cachesApi.delete).not.toHaveBeenCalledWith(
			'st-cecilia-tech-astro-v17',
			)
		expect(worker.self.clients.claim).toHaveBeenCalledTimes(1)
	})

	it('does not intercept API GETs', () => {
		const worker = workerHarness()
		const event = worker.dispatch('fetch', {
			request: request('/api/whiteboard/version'),
		})

		expect(event.response).toBeUndefined()
		expect(worker.fetchMock).not.toHaveBeenCalled()
	})

	it('uses the precached offline page for failed navigations', async () => {
		const worker = workerHarness()
		const offline = new Response('offline', {
			status: 200,
			headers: { 'content-type': 'text/html' },
		})
		worker.fetchMock.mockRejectedValue(new Error('offline'))
		worker.cachesApi.match.mockResolvedValue(offline)
		const event = worker.dispatch('fetch', {
			request: request('/games', { mode: 'navigate' }),
		})

		expect(await event.response).toBe(offline)
		expect(worker.cachesApi.match).toHaveBeenCalledWith('/offline')
	})

	it('does not substitute cached HTML for a non-navigation request', async () => {
		const worker = workerHarness()
		worker.fetchMock.mockRejectedValue(new Error('offline'))
		worker.cachesApi.match.mockResolvedValue(
			new Response('<!doctype html>', {
				status: 200,
				headers: { 'content-type': 'text/html' },
			}),
		)
		const event = worker.dispatch('fetch', {
			request: request('/games'),
		})

		expect((await event.response).type).toBe('error')
	})

	it('ties a successful asset cache write to fetch lifetime', async () => {
		const worker = workerHarness()
		let resolvePut!: () => void
		worker.cache.put.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					resolvePut = resolve
				}),
		)
		worker.fetchMock.mockResolvedValue(
			new Response('asset', {
				status: 200,
				headers: { 'content-type': 'image/png' },
			}),
		)
		const event = worker.dispatch('fetch', {
			request: request('/_astro/app.js'),
		})

		await expect(event.response).resolves.toHaveProperty('status', 200)
		expect(worker.cache.put).toHaveBeenCalledTimes(1)
		expect(event.waitUntilPromises).toHaveLength(1)
		let completed = false
		const lifetime = Promise.all(event.waitUntilPromises).then(() => {
			completed = true
		})
		await Promise.resolve()
		expect(completed).toBe(false)
		resolvePut()
		await lifetime
		expect(completed).toBe(true)
	})
})
