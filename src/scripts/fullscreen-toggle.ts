/**
 * Header fullscreen chip — toggles document fullscreen via the Fullscreen API.
 * Hidden when the API is unavailable (e.g. iOS Safari).
 */

type FullscreenDocument = Document & {
  webkitFullscreenEnabled?: boolean
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => Promise<void> | void
}

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void
}

function fullscreenEnabled(): boolean {
  const doc = document as FullscreenDocument
  return Boolean(document.fullscreenEnabled || doc.webkitFullscreenEnabled)
}

function fullscreenElement(): Element | null {
  const doc = document as FullscreenDocument
  return document.fullscreenElement ?? doc.webkitFullscreenElement ?? null
}

async function enterFullscreen(): Promise<void> {
  const el = document.documentElement as FullscreenElement
  if (el.requestFullscreen) {
    await el.requestFullscreen()
    return
  }
  if (el.webkitRequestFullscreen) {
    await el.webkitRequestFullscreen()
  }
}

async function exitFullscreen(): Promise<void> {
  const doc = document as FullscreenDocument
  if (document.exitFullscreen) {
    await document.exitFullscreen()
    return
  }
  if (doc.webkitExitFullscreen) {
    await doc.webkitExitFullscreen()
  }
}

function syncButton(btn: HTMLButtonElement): void {
  const active = Boolean(fullscreenElement())
  btn.dataset.fullscreen = active ? 'true' : 'false'
  const label = active ? 'Exit full screen' : 'Enter full screen'
  btn.setAttribute('aria-label', label)
  btn.title = label
}

function initFullscreenToggle(): void {
  const btn = document.getElementById('header-fullscreen-btn')
  if (!(btn instanceof HTMLButtonElement)) return

  if (!fullscreenEnabled()) {
    btn.hidden = true
    return
  }

  btn.hidden = false
  syncButton(btn)

  btn.addEventListener('click', () => {
    void (fullscreenElement() ? exitFullscreen() : enterFullscreen()).catch(() => {
      // User gesture denied or browser blocked — leave UI as-is until change event
    })
  })

  const onChange = () => syncButton(btn)
  document.addEventListener('fullscreenchange', onChange)
  document.addEventListener('webkitfullscreenchange', onChange)
}

initFullscreenToggle()
