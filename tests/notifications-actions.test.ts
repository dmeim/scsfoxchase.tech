import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/lib/whiteboard-identity', () => ({
  getActiveIdentity: () => ({ clerkUserId: 'test-user' }),
  getSessionTokenSettled: async () => 'test-token',
  onAuthChange: () => () => {},
  whenAuthReady: async () => {},
}))
vi.mock('../src/scripts/toasts', () => ({ showToast: vi.fn(), notificationIconMarkup: () => '' }))
import { showToast } from '../src/scripts/toasts'

class NodeStub extends EventTarget {
  children: unknown[] = []
  dataset: Record<string, string> = {}
  disabled = false
  hidden = false
  textContent = ''
  classList = { contains: () => false, toggle() {} }
  setAttribute() {}
  replaceChildren(...children: unknown[]) { this.children = children }
  appendChild(child: unknown) { this.children.push(child) }
  closest() { return this }
}

beforeEach(() => { vi.resetModules(); vi.clearAllMocks() })
afterEach(() => { vi.unstubAllGlobals() })

describe('notification actions', () => {
  it.each(['clear', 'dismiss'])('keeps notifications on a failed %s and removes them only after a successful retry', async action => {
    const list = new NodeStub()
    const clear = new NodeStub()
    const center = new NodeStub()
    const nodes = new Map([
      ['[data-notification-list]', list], ['[data-notification-clear]', clear],
      ...['empty', 'badge', 'trigger', 'panel'].map(key => [`[data-notification-${key}]`, new NodeStub()] as const),
    ])
    Object.assign(center, { querySelector: (key: string) => nodes.get(key) })
    vi.stubGlobal('Element', NodeStub)
    vi.stubGlobal('document', Object.assign(new EventTarget(), {
      querySelectorAll: () => [center], createElement: () => new NodeStub(),
    }))
    vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} })
    const item = {
      id: '11111111-1111-4111-8111-111111111111', kind: 'info', icon: 'info', title: 'Keep this notice',
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), persist: true,
    }
    let successful = false
    const fetcher = vi.fn(async (_url, init) => init?.method
      ? new Response('{}', { status: successful ? 200 : 503 })
      : Response.json({ notifications: [item] }))
    vi.stubGlobal('fetch', fetcher)
    await import('../src/scripts/notifications')
    await vi.waitFor(() => expect(list.children).toHaveLength(1))
    const click = () => {
      if (action === 'clear') clear.dispatchEvent(new Event('click'))
      else {
        const button = new NodeStub()
        button.dataset.notificationDismiss = item.id
        const event = new Event('click')
        Object.defineProperty(event, 'target', { value: button })
        center.dispatchEvent(event)
      }
    }
    click()
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Notifications were not updated' })))
    expect(list.children).toHaveLength(1)
    expect(clear.disabled).toBe(false)
    successful = true
    click()
    await vi.waitFor(() => expect(list.children).toHaveLength(0))
    expect(fetcher.mock.calls.at(-1)?.[1]?.method).toBe(action === 'clear' ? 'POST' : 'DELETE')
  })
})
