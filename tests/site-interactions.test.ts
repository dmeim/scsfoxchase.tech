import { afterEach, describe, expect, it, vi } from 'vitest'
import { initDotWaves } from '../src/scripts/dot-waves'
import { bindUnsavedChangesGuard, whiteboardSaveStatus } from '../src/lib/whiteboard-save-status'

afterEach(() => { vi.unstubAllGlobals() })

describe('background animation lifecycle', () => {
  it('keeps one loop through resizes and stops all work when hidden or reduced motion is enabled', () => {
    const callbacks = new Map<number, FrameRequestCallback>()
    let next = 0
    const motion = Object.assign(new EventTarget(), { matches: false })
    const canvas = { dataset: {}, style: {}, getContext: () => ({ setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {} }) }
    const win = Object.assign(new EventTarget(), { innerWidth: 1366, innerHeight: 768, devicePixelRatio: 1, matchMedia: () => motion })
    const doc = Object.assign(new EventTarget(), { hidden: false, querySelector: () => canvas })
    vi.stubGlobal('window', win)
    vi.stubGlobal('document', doc)
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { callbacks.set(++next, fn); return next })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id))
    initDotWaves()
    expect(callbacks.size).toBe(1)
    for (let i = 0; i < 10; i++) win.dispatchEvent(new Event('resize'))
    expect(callbacks.size).toBe(1)
    const [id, frame] = [...callbacks][0]
    callbacks.delete(id)
    frame(16)
    expect(callbacks.size).toBe(1)
    doc.hidden = true
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(callbacks.size).toBe(0)
    win.dispatchEvent(new Event('resize'))
    expect(callbacks.size).toBe(0)
    doc.hidden = false
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(callbacks.size).toBe(1)
    motion.matches = true
    motion.dispatchEvent(new Event('change'))
    expect(callbacks.size).toBe(0)
  })
})

describe('unsaved Whiteboard changes', () => {
  it('guards navigation only until pending changes are acknowledged and removes the listener on cleanup', () => {
    const target = new EventTarget()
    let unsaved = false
    const cleanup = bindUnsavedChangesGuard(target as Window, () => unsaved)
    const navigate = () => {
      const event = new Event('beforeunload', { cancelable: true })
      target.dispatchEvent(event)
      return event.defaultPrevented
    }
    expect(navigate()).toBe(false)
    unsaved = true
    expect(navigate()).toBe(true)
    unsaved = false
    expect(navigate()).toBe(false)
    cleanup()
    unsaved = true
    expect(navigate()).toBe(false)
  })
  it('does not describe queued or rejected edits as synced', () => {
    expect(whiteboardSaveStatus(false, true, false)).toContain('Unsaved')
    expect(whiteboardSaveStatus(true, true, false)).toContain('Saving')
    expect(whiteboardSaveStatus(true, false, true)).toContain('not saved')
    expect(whiteboardSaveStatus(true, false, false)).toBe('Changes synced')
  })
})
