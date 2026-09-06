import { afterEach, describe, expect, it, vi } from 'vitest'
import { initTrendingHero } from '../src/scripts/trending-hero'

function setup(reduced = false) {
  vi.useFakeTimers()
  const node = () => Object.assign(new EventTarget(), {
    textContent: '', href: '', src: '', hidden: false, dataset: {},
    style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {},
  })
  const image = node(), title = node(), desc = node(), link = node(), pause = node(), next = node(), prev = node()
  const progress = Object.assign(node(), { querySelector: () => null, querySelectorAll: () => [] })
  const selectors: Record<string, unknown> = { '[data-ng-hero-bg]': image, '[data-ng-hero-title]': title, '[data-ng-hero-desc]': desc, '[data-ng-hero-link]': link, '[data-ng-hero-progress]': progress, '[data-ng-hero-pause]': pause, '[data-ng-hero-next]': next, '[data-ng-hero-prev]': prev }
  const root = Object.assign(node(), { querySelector: (key: string) => selectors[key], contains: (element: unknown) => element === link })
  const motion = Object.assign(new EventTarget(), { matches: reduced })
  const document = Object.assign(new EventTarget(), {
    hidden: false, activeElement: null as unknown,
    querySelector: () => root,
    getElementById: () => ({ textContent: JSON.stringify([
      { id: 'one', name: 'One', image: '/one.png', description: 'First', url: 'https://one.example' },
      { id: 'two', name: 'Two', image: '/two.png', description: 'Second', url: 'https://two.example' },
    ]) }),
  })
  vi.stubGlobal('document', document)
  vi.stubGlobal('matchMedia', () => motion)
  initTrendingHero()
  return { title, link, progress, pause, root, document, motion, next }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('trending hero', () => {
  it('updates the title and destination on keyboard selection and pauses while interacting', () => {
    const f = setup()
    f.progress.dispatchEvent(new CustomEvent('ui:change', { detail: { value: 'two' } }))
    expect(f.title.textContent).toBe('Two')
    expect(f.link.href).toBe('https://two.example')
    f.document.activeElement = f.link
    f.root.dispatchEvent(new Event('focusin'))
    vi.advanceTimersByTime(10000)
    expect(f.title.textContent).toBe('Two')
    f.document.activeElement = null
    f.document.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(5000)
    expect(f.title.textContent).toBe('One')
    f.pause.dispatchEvent(new Event('click'))
    vi.advanceTimersByTime(10000)
    expect(f.title.textContent).toBe('One')
    expect(f.pause.textContent).toBe('Resume')
    f.pause.dispatchEvent(new Event('click'))
    vi.advanceTimersByTime(5000)
    expect(f.title.textContent).toBe('Two')
  })
  it('starts paused for reduced motion, still allows manual navigation, and stops when hidden', () => {
    const f = setup(true)
    vi.advanceTimersByTime(10000)
    expect(f.title.textContent).toBe('One')
    f.next.dispatchEvent(new Event('click'))
    expect(f.title.textContent).toBe('Two')
    f.pause.dispatchEvent(new Event('click'))
    f.document.hidden = true
    f.document.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(10000)
    expect(f.title.textContent).toBe('Two')
  })
})
