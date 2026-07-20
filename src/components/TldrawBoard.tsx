import { useSync } from '@tldraw/sync'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createUserId,
  getUserPreferences,
  Tldraw,
  type Editor,
  type TLUserId,
} from 'tldraw'
import 'tldraw/tldraw.css'
import { r2AssetStore } from '../lib/whiteboard-assets'
import { shortDisplayName } from '../lib/whiteboard-display-name'
import {
  getActiveIdentity,
  onAuthChange,
  whenAuthReady,
} from '../lib/whiteboard-identity'
import {
  isCanEditPayload,
  isParticipantsPayload,
  type ParticipantRow,
} from '../lib/whiteboard-participants'
import { getHostSecret, touchBoardActive } from '../scripts/whiteboard-library'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const PARTICIPANTS_EVENT = 'scsfoxchase:whiteboard-participants'
const FOLLOW_EVENT = 'scsfoxchase:whiteboard-follow'

function readBoardIdFromLocation(): string | undefined {
  if (typeof window === 'undefined') return undefined

  const pathMatch = window.location.pathname.match(/\/board\/([^/]+)\/?$/i)
  if (pathMatch?.[1]) {
    const id = decodeURIComponent(pathMatch[1])
    if (UUID_RE.test(id)) return id
  }

  return undefined
}

/** Cursor / presence tag: short "First L." when signed in; else leave tldraw default. */
function applyPresenceName(editor: Editor) {
  const identity = getActiveIdentity()
  if (!identity) return
  const short = shortDisplayName(identity.displayName) || identity.displayName
  editor.user.updateUserPreferences({
    name: short.slice(0, 32),
  })
}

function publishParticipants(
  participants: ParticipantRow[],
  yourSessionId: string,
) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent(PARTICIPANTS_EVENT, {
      detail: { participants, yourSessionId },
    }),
  )
}

function applyReadonly(editor: Editor, canEdit: boolean) {
  // useSync keeps isReadonly in sync with collaboration.mode via a react;
  // updateInstanceState alone is overwritten while mode stays "readwrite".
  const mode = editor.store.props.collaboration?.mode as
    | { set: (value: 'readonly' | 'readwrite') => void }
    | null
    | undefined
  if (mode?.set) {
    mode.set(canEdit ? 'readwrite' : 'readonly')
  } else {
    editor.updateInstanceState({ isReadonly: !canEdit })
  }
}

type TldrawBoardProps = {
  boardId?: string
}

export default function TldrawBoard({ boardId: boardIdProp }: TldrawBoardProps) {
  const boardId = boardIdProp ?? readBoardIdFromLocation() ?? ''
  const editorRef = useRef<Editor | null>(null)
  const [viewOnly, setViewOnly] = useState(false)

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

    await whenAuthReady()
    const identity = getActiveIdentity()
    const prefs = getUserPreferences()
    if (identity?.displayName) {
      // Full name to DO / People list; cursors use short form via applyPresenceName.
      url.searchParams.set('displayName', identity.displayName.slice(0, 48))
    }
    if (prefs.id) {
      url.searchParams.set('userId', createUserId(prefs.id))
    }
    return url.toString()
  }, [boardId])

  const onCustomMessageReceived = useCallback((data: unknown) => {
    if (isCanEditPayload(data)) {
      const editor = editorRef.current
      if (editor) applyReadonly(editor, data.canEdit)
      setViewOnly(!data.canEdit)
      return
    }
    if (isParticipantsPayload(data)) {
      publishParticipants(data.participants, data.yourSessionId)
    }
  }, [])

  // useSync must run unconditionally; uri throws if boardId is empty (redirect handles that).
  const store = useSync({
    uri,
    assets: r2AssetStore,
    onCustomMessageReceived,
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

  // Follow buttons in the manage panel (vanilla) → tldraw camera follow.
  useEffect(() => {
    const onFollow = (event: Event) => {
      const editor = editorRef.current
      if (!editor) return
      const detail = (event as CustomEvent<{ userId?: string; stop?: boolean }>)
        .detail
      if (detail?.stop) {
        editor.stopFollowingUser()
        return
      }
      const userId = detail?.userId
      if (!userId) return
      const following = editor.getInstanceState().followingUserId
      if (following === userId) {
        editor.stopFollowingUser()
      } else {
        editor.startFollowingUser(userId as TLUserId)
      }
    }
    window.addEventListener(FOLLOW_EVENT, onFollow)
    return () => window.removeEventListener(FOLLOW_EVENT, onFollow)
  }, [])

  const followingUnsubRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    return () => {
      followingUnsubRef.current?.()
      followingUnsubRef.current = null
    }
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
      {viewOnly ? (
        <div
          role="status"
          style={{
            position: 'absolute',
            top: 8,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 40,
            background: 'rgba(18, 95, 49, 0.92)',
            color: '#fff',
            fontSize: 13,
            fontWeight: 600,
            padding: '6px 12px',
            borderRadius: 2,
            pointerEvents: 'none',
            maxWidth: 'min(420px, calc(100% - 24px))',
            textAlign: 'center',
          }}
        >
          View only — the board host turned off editing for you.
        </div>
      ) : null}
      <Tldraw
        licenseKey={import.meta.env.PUBLIC_TLDRAW_LICENSE_KEY}
        store={store}
        onMount={(editor) => {
          editorRef.current = editor
          applyPresenceName(editor)

          followingUnsubRef.current?.()
          const publishFollowing = () => {
            window.dispatchEvent(
              new CustomEvent('scsfoxchase:whiteboard-following', {
                detail: {
                  followingUserId: editor.getInstanceState().followingUserId,
                },
              }),
            )
          }
          publishFollowing()
          followingUnsubRef.current = editor.store.listen(publishFollowing, {
            source: 'user',
            scope: 'session',
          })
        }}
      />
    </div>
  )
}
