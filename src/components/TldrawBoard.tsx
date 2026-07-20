import { useSync } from '@tldraw/sync'
import { useCallback, useEffect, useRef } from 'react'
import { Tldraw, type Editor } from 'tldraw'
import 'tldraw/tldraw.css'
import { r2AssetStore } from '../lib/whiteboard-assets'
import {
  getActiveIdentity,
  onAuthChange,
  whenAuthReady,
} from '../lib/whiteboard-identity'
import { getHostSecret, touchBoardActive } from '../scripts/whiteboard-library'

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

function applyPresenceName(editor: Editor) {
  const identity = getActiveIdentity()
  if (!identity) return
  editor.user.updateUserPreferences({
    name: identity.displayName.slice(0, 32),
  })
}

type TldrawBoardProps = {
  boardId?: string
}

export default function TldrawBoard({ boardId: boardIdProp }: TldrawBoardProps) {
  const boardId = boardIdProp ?? readBoardIdFromLocation() ?? ''
  const editorRef = useRef<Editor | null>(null)

  const uri = useCallback(async () => {
    if (!boardId) {
      throw new Error('Missing board id for sync')
    }
    const url = new URL(
      `/api/whiteboard/connect/${encodeURIComponent(boardId)}`,
      window.location.origin,
    )
    const hostSecret = getHostSecret(boardId)
    if (hostSecret) {
      url.searchParams.set('hostSecret', hostSecret)
    }
    return url.toString()
  }, [boardId])

  // useSync must run unconditionally; uri throws if boardId is empty (redirect handles that).
  const store = useSync({
    uri,
    assets: r2AssetStore,
  })

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

  useEffect(() => {
    return onAuthChange(() => {
      if (editorRef.current) applyPresenceName(editorRef.current)
    })
  }, [])

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
      <Tldraw
        licenseKey={import.meta.env.PUBLIC_TLDRAW_LICENSE_KEY}
        store={store}
        onMount={(editor) => {
          editorRef.current = editor
          applyPresenceName(editor)
        }}
      />
    </div>
  )
}
