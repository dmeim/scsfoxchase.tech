import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'

vi.mock('@excalidraw/excalidraw', () => ({
  CaptureUpdateAction: { NEVER: 'never' },
  getVisibleSceneBounds: (state: { scrollX: number }) => [state.scrollX, 0, 100, 100],
  zoomToFitBounds: () => ({ appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 } } }),
}))
vi.mock('../src/lib/whiteboard-identity', () => ({
  getActiveIdentity: () => ({ accountId: 'teacher', displayName: 'Teacher' }),
  identityMatchIds: () => ['teacher'],
  onAuthChange: () => () => {},
  isSignedIn: () => true,
  whenAuthReady: async () => {},
}))
vi.mock('../src/scripts/whiteboard-library', () => ({
  readBoardIdFromPath: () => 'test-board',
  getHostSecret: () => null,
  getEntryActive: async () => null,
  getScratchBoardTitle: () => null,
  patchLiveBoardTitle: vi.fn(),
  setBoardTitleActive: vi.fn(),
}))
vi.mock('../src/lib/whiteboard-codes', () => ({
  fetchBoardShareCode: async () => ({ code: '1A2B3C4D' }),
  ensureBoardShareCode: async () => ({ code: '1A2B3C4D' }),
}))

import { useWhiteboardExcalidrawRoles } from '../src/lib/whiteboard-excalidraw-roles'

class NodeStub extends EventTarget {
  checked = false
  disabled = false
  hidden = false
  textContent = ''
  classes = new Set<string>()
  classList = {
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, on: boolean) => on ? this.classes.add(name) : this.classes.delete(name),
  }
  setAttribute() {}
  closest() { return null }
}

const EDIT_GATE_EVENT = 'scsfoxchase:whiteboard-edit-gate'
let windowTarget: EventTarget

function payloadResponse(payload: unknown) {
  return Object.assign(new Response(), { json: vi.fn(async () => payload) })
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  windowTarget = Object.assign(new EventTarget(), {
    location: { protocol: 'https:', origin: 'https://example.test' },
    requestAnimationFrame: vi.fn(() => 1),
    cancelAnimationFrame: vi.fn(),
    setTimeout,
    clearTimeout,
    fetch: vi.fn(async () => Response.json({ title: 'Class board', classCanEdit: false })),
  })
  vi.stubGlobal('window', windowTarget)
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('WebSocket', { OPEN: 1 })
  const storage = new Map<string, string>()
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function rolesHarness() {
  const send = vi.fn()
  let scrollX = 0
  const updateScene = vi.fn()
  const apiRef = { current: {
    getAppState: () => ({ scrollX }),
    updateScene,
  } as unknown as ExcalidrawImperativeAPI }
  const wsRef = { current: { readyState: 1, send } as unknown as WebSocket }
  let roles!: ReturnType<typeof useWhiteboardExcalidrawRoles>
  // Real React refs/callbacks; server rendering avoids adding a DOM dependency.
  // Effects are not run, so camera tests exercise the socket/scroll callbacks directly.
  function Harness() {
    roles = useWhiteboardExcalidrawRoles({ boardId: 'test-board', apiRef, wsRef })
    return null
  }
  renderToStaticMarkup(createElement(Harness))
  const message = roles.handleSocketMessage
  message({ type: 'wb:hello', sessionId: 'teacher-tab', role: 'owner', canEdit: true })
  const participants = (role = 'owner') => message({
    type: 'wb:participants', yourSessionId: 'teacher-tab', yourRole: role,
    participants: [
      { sessionId: 'teacher-tab', userId: 'teacher', displayName: 'Teacher', role, canEdit: true },
      { sessionId: 'student-tab', userId: 'student', displayName: 'Student', role: 'viewer', canEdit: false },
    ],
  })
  participants()
  send.mockClear()
  const pan = () => {
    scrollX++
    roles.onScrollChange()
    vi.advanceTimersByTime(120)
  }
  const frames = () => send.mock.calls.map(([json]) => JSON.parse(json as string))
  return { roles, message, participants, pan, frames, send, updateScene }
}

const forceState = (forceFollow: boolean, subjects: Record<string, string> = {}) => ({
  type: 'wb:forceFollow', forceFollow, targetUserId: forceFollow ? 'teacher' : '',
  targetSessionId: forceFollow ? 'teacher-tab' : '', subjects,
})

describe('leader camera publishing', () => {
  it('preserves voluntary followers across participant and role updates, then stops on the last unsubscribe', () => {
    const h = rolesHarness()
    h.message({ type: 'wb:followedBy', followed: true })
    h.participants('manager')
    h.message({ type: 'wb:role', role: 'manager', canEdit: true })
    h.send.mockClear()
    h.pan()
    expect(h.frames()).toEqual([expect.objectContaining({ type: 'wb:sceneBounds' })])
    h.message({ type: 'wb:followedBy', followed: false })
    h.participants('manager')
    h.send.mockClear()
    h.pan()
    expect(h.frames()).toEqual([])
  })

  it('does not publish a queued camera update after the last follower unsubscribes', () => {
    const h = rolesHarness()
    h.message({ type: 'wb:followedBy', followed: true })
    h.send.mockClear()
    h.roles.onScrollChange()
    h.message({ type: 'wb:followedBy', followed: false })
    vi.advanceTimersByTime(120)
    expect(h.frames()).toEqual([])
  })

  it.each(['room', 'subject'])('keeps publishing after followedBy false while a %s force follower exists', (kind) => {
    const h = rolesHarness()
    h.message(forceState(kind === 'room', kind === 'subject' ? { student: 'teacher' } : {}))
    h.message({ type: 'wb:followedBy', followed: false })
    h.send.mockClear()
    h.pan()
    expect(h.frames()).toEqual([expect.objectContaining({ type: 'wb:sceneBounds' })])
    h.message(forceState(false))
    h.send.mockClear()
    h.pan()
    expect(h.frames()).toEqual([])
  })

  it('keeps voluntary followers when force follow is removed', () => {
    const h = rolesHarness()
    h.message({ type: 'wb:followedBy', followed: true })
    h.message(forceState(true))
    h.message(forceState(false))
    h.send.mockClear()
    h.pan()
    expect(h.frames()).toEqual([expect.objectContaining({ type: 'wb:sceneBounds' })])
  })

  it('resubscribes voluntary follow after a socket gap or hello and keeps force-follow camera locks', () => {
    const h = rolesHarness()
    h.roles.onUserFollow({ action: 'FOLLOW', userToFollow: { socketId: 'student-tab', username: 'Student' } })
    h.send.mockClear()
    h.roles.resubscribeFollow()
    h.message({ type: 'wb:hello', sessionId: 'teacher-tab', role: 'owner', canEdit: true })
    expect(h.frames()).toEqual(Array(2).fill({ type: 'wb:follow', targetUserId: 'student', targetSessionId: 'student-tab' }))
    h.message({ ...forceState(true), targetUserId: 'student', targetSessionId: 'student-tab' })
    h.message({ type: 'wb:followedBy', followed: true })
    h.send.mockClear()
    h.pan()
    expect(h.frames()).toEqual([])
    h.roles.resubscribeFollow()
    expect(h.frames()).toEqual([{ type: 'wb:follow', targetUserId: 'student', targetSessionId: 'student-tab' }])
  })
})

async function menuHarness(role: 'owner' | 'manager') {
  sessionStorage.setItem('scsfoxchase.whiteboard.auth.test-board', JSON.stringify({
    sessionId: 'teacher-tab', authToken: 'test-auth', role,
  }))
  const root = new NodeStub()
  const toggle = new NodeStub()
  const checkbox = new NodeStub()
  const label = new NodeStub()
  const nodes = new Map([
    ['[data-whiteboard-toggle]', toggle],
    ['[data-whiteboard-panel]', new NodeStub()],
    ['[data-wb-class-can-edit-toggle]', checkbox],
    ['[data-wb-class-can-edit-state]', label],
  ])
  Object.assign(root, {
    getAttribute: () => 'manage',
    querySelector: (selector: string) => nodes.get(selector) ?? null,
  })
  vi.stubGlobal('document', Object.assign(new EventTarget(), {
    readyState: 'complete', cookie: '',
    querySelector: () => root,
  }))
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    payloadResponse({ title: 'Class board', classCanEdit: false }),
  )
  vi.stubGlobal('fetch', fetcher)
  await import('../src/scripts/whiteboard-menu')
  toggle.dispatchEvent(new Event('click'))
  await Promise.resolve()
  await Promise.resolve()
  return { checkbox, label, fetcher }
}

describe('Group Edit menu synchronization', () => {
  it.each(['owner', 'manager'] as const)('updates an already open %s menu from gate messages without changing permissions', async (role) => {
    const menu = await menuHarness(role)
    const h = rolesHarness()
    h.message({ type: 'wb:hello', sessionId: 'teacher-tab', role, canEdit: true, classCanEdit: true })
    expect(menu.checkbox.checked).toBe(true)
    h.updateScene.mockClear()
    expect(h.message({ type: 'wb:editGate', allowEdits: false })).toBe(true)
    expect(menu.checkbox.checked).toBe(false)
    expect(menu.label.textContent).toBe('Off')
    expect(h.message({ type: 'wb:editGate', allowEdits: true })).toBe(true)
    expect(menu.checkbox.checked).toBe(true)
    expect(menu.label.textContent).toBe('On')
    expect(h.updateScene).not.toHaveBeenCalled()
    h.message({ type: 'wb:editGate', allowEdits: 'false' })
    expect(menu.checkbox.checked).toBe(true)
  })

  it('does not let an older metadata read overwrite a newer authoritative gate event', async () => {
    const menu = await menuHarness('owner')
    let resolve!: (response: Response) => void
    menu.fetcher.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done }))
    windowTarget.dispatchEvent(new CustomEvent('scsfoxchase:whiteboard-hello', {
      detail: { role: 'owner', sessionId: 'teacher-tab', title: 'Class board' },
    }))
    await Promise.resolve()
    await Promise.resolve()
    expect(resolve).toBeTypeOf('function')
    windowTarget.dispatchEvent(new CustomEvent(EDIT_GATE_EVENT, { detail: { allowEdits: true } }))
    const response = payloadResponse({ classCanEdit: false })
    resolve(response)
    for (let i = 0; i < 8; i++) await Promise.resolve()
    expect(response.json).toHaveBeenCalled()
    expect(menu.checkbox.checked).toBe(true)
    expect(menu.label.textContent).toBe('On')
  })

  it('keeps the latest gate state if an older local PATCH response arrives later', async () => {
    const menu = await menuHarness('owner')
    windowTarget.dispatchEvent(new CustomEvent(EDIT_GATE_EVENT, { detail: { allowEdits: true } }))
    let resolve!: (response: Response) => void
    menu.fetcher.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done }))
    menu.checkbox.checked = false
    menu.checkbox.dispatchEvent(new Event('change'))
    expect(menu.fetcher.mock.calls.at(-1)?.[1]?.method).toBe('PATCH')
    windowTarget.dispatchEvent(new CustomEvent(EDIT_GATE_EVENT, { detail: { allowEdits: true } }))
    const response = payloadResponse({ classCanEdit: false })
    resolve(response)
    for (let i = 0; i < 8; i++) await Promise.resolve()
    expect(response.json).toHaveBeenCalled()
    expect(menu.checkbox.checked).toBe(true)
    expect(menu.label.textContent).toBe('On')
  })
})
