import { useEffect, useState } from 'react'
import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { whenAuthReady } from '../lib/whiteboard-identity'
import { touchBoardActive } from '../scripts/whiteboard-library'

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[]
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function readBoardIdFromLocation(): string | undefined {
  if (typeof window === 'undefined') return undefined

  const pathMatch = window.location.pathname.match(/\/board\/([^/]+)\/?$/i)
  if (pathMatch?.[1]) {
    const id = decodeURIComponent(pathMatch[1])
    if (UUID_RE.test(id)) return id
  }

  return undefined
}

function ensureExcalidrawAssetPath() {
  if (typeof window === 'undefined') return
  window.EXCALIDRAW_ASSET_PATH = '/excalidraw/'
}

ensureExcalidrawAssetPath()

type WhiteboardCanvasProps = {
  boardId?: string
}

/**
 * Whiteboard canvas island. Phase 1: local empty Excalidraw scene.
 * Live Durable Object sync is Phase 2.
 */
export default function WhiteboardCanvas({
  boardId: boardIdProp,
}: WhiteboardCanvasProps) {
  const boardId = boardIdProp ?? readBoardIdFromLocation() ?? ''
  const [theme, setTheme] = useState<'light' | 'dark'>('light')

  useEffect(() => {
    ensureExcalidrawAssetPath()
    const root = document.documentElement
    const syncTheme = () => {
      setTheme(root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light')
    }
    syncTheme()
    const observer = new MutationObserver(syncTheme)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!boardId) return
    let cancelled = false
    void whenAuthReady()
      .then(() => {
        if (cancelled) return
        return touchBoardActive(boardId)
      })
      .catch(() => {
        // Cloud upsert can fail offline; local create path still works when signed out
      })
    return () => {
      cancelled = true
    }
  }, [boardId])

  if (!boardId) {
    return (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          color: 'var(--text-muted, #666)',
          display: 'grid',
          placeItems: 'center',
        }}
      >
        Invalid board link
      </div>
    )
  }

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Excalidraw theme={theme} />
    </div>
  )
}
