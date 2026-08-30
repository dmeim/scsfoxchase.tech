import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/scripts/toasts', () => ({
	showToast: vi.fn(() => 'update-toast'),
}))

import { showToast } from '../src/scripts/toasts'

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')

afterEach(() => {
	vi.resetModules()
	vi.clearAllMocks()
	if (originalNavigator) {
		Object.defineProperty(globalThis, 'navigator', originalNavigator)
	} else {
		Reflect.deleteProperty(globalThis, 'navigator')
	}
	if (originalWindow) {
		Object.defineProperty(globalThis, 'window', originalWindow)
	} else {
		Reflect.deleteProperty(globalThis, 'window')
	}
})

describe('service-worker update notification', () => {
	it('uses a persistent toast action to activate and reload the update', async () => {
		const updateWorker = Object.assign(new EventTarget(), {
			state: 'installing',
			postMessage: vi.fn(),
		})
		const registration = Object.assign(new EventTarget(), {
			installing: updateWorker,
			waiting: null as typeof updateWorker | null,
			scope: 'https://scsfoxchase.tech/',
		})
		const serviceWorkers = Object.assign(new EventTarget(), {
			controller: {},
			register: vi.fn(async () => registration),
		})
		const reload = vi.fn()
		Object.defineProperty(globalThis, 'navigator', {
			configurable: true,
			value: { serviceWorker: serviceWorkers },
		})
		Object.defineProperty(globalThis, 'window', {
			configurable: true,
			value: {
				addEventListener: vi.fn(),
				location: { reload },
			},
		})

		const { registerServiceWorkerUpdates } = await import(
			'../src/scripts/service-worker-updates'
		)
		await registerServiceWorkerUpdates()
		registration.dispatchEvent(new Event('updatefound'))
		updateWorker.state = 'installed'
		updateWorker.dispatchEvent(new Event('statechange'))

		expect(showToast).toHaveBeenCalledWith(
			expect.objectContaining({
				title: 'Update ready',
				persist: true,
				action: expect.objectContaining({ label: 'Reload' }),
			}),
		)
		const toast = vi.mocked(showToast).mock.calls[0]?.[0]

		serviceWorkers.dispatchEvent(new Event('controllerchange'))
		expect(reload).not.toHaveBeenCalled()

		toast?.action?.onClick()
		expect(updateWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })

		serviceWorkers.dispatchEvent(new Event('controllerchange'))
		expect(reload).toHaveBeenCalledTimes(1)
	})
})
