import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CaptureUpdateAction,
  Excalidraw,
  getSceneVersion,
  reconcileElements,
  restoreElements,
  serializeAsJSON,
} from '@excalidraw/excalidraw'
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from '@excalidraw/excalidraw/types'
import '@excalidraw/excalidraw/index.css'
import { isSignedIn, waitForSessionToken, whenAuthReady } from '../lib/whiteboard-identity'
import {
  buildWhiteboardConnectUrl,
  CLIENT_PING_MS,
  elementsWithIncreasedVersion,
  getOrCreateSessionId,
  mergeSceneElements,
  rememberElementVersions,
  SCENE_FLUSH_MS,
  type SceneAppState,
  type SceneElement,
} from '../lib/whiteboard-sync'
import {
  getHostSecret,
  touchBoardActive,
} from '../scripts/whiteboard-library'
// PHASE 3.2
import { useWhiteboardExcalidrawFiles } from '../lib/whiteboard-excalidraw-files'
// PHASE 3.3
import {
  FOLLOW_SOCKET_GAP_MS,
  getBoardConnectIdentity,
  useWhiteboardExcalidrawRoles,
} from '../lib/whiteboard-excalidraw-roles'

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
 * Whiteboard canvas island. Phase 2: Durable Object WebSocket collab.
 * Remote applies use CaptureUpdateAction.NEVER so they stay out of undo.
 */
export default function WhiteboardCanvas({
  boardId: boardIdProp,
}: WhiteboardCanvasProps) {
  const boardId = boardIdProp ?? readBoardIdFromLocation() ?? ''
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const applyingRemoteRef = useRef(false)
  const lastSceneVersionRef = useRef(0)
  const lastElementVersionsRef = useRef(new Map<string, number>())
  const flushTimerRef = useRef<number | null>(null)
  const pendingFlushRef = useRef<{
    elements: readonly OrderedExcalidrawElement[]
    appState: AppState
  } | null>(null)
  const fullSyncCounterRef = useRef(0)
  const pendingRemoteRef = useRef<{
    elements: SceneElement[]
    appState: SceneAppState | null
  } | null>(null)
  /**
   * True once this Excalidraw instance has applied a server scene. Outgoing
   * updates are blocked until then — a freshly (re)mounted empty canvas must
   * never push a full (empty) scene over the stored board.
   */
  const sceneHydratedRef = useRef(false)
  /**
   * True once `wb:auth` has been sent on the current socket. The server drops
   * every message until auth, so sends before this would be lost while still
   * being marked as delivered by version bookkeeping.
   */
  const authSentRef = useRef(false)
  const persistErrorToastAtRef = useRef(0)
  // PHASE 3.2
  const media = useWhiteboardExcalidrawFiles(boardId, apiRef)

  // PHASE 3.3
  const roles = useWhiteboardExcalidrawRoles({ boardId, apiRef, wsRef })
  const handleRoleMessageRef = useRef(roles.handleSocketMessage)
  handleRoleMessageRef.current = roles.handleSocketMessage
  const onUserFollowRef = useRef(roles.onUserFollow)
  onUserFollowRef.current = roles.onUserFollow
  const reassertFollowRef = useRef(roles.reassertFollow)
  reassertFollowRef.current = roles.reassertFollow
  const resubscribeFollowRef = useRef(roles.resubscribeFollow)
  resubscribeFollowRef.current = roles.resubscribeFollow
  const unsubUserFollowRef = useRef<(() => void) | null>(null)
  const canEditRef = useRef(roles.canEdit)
  canEditRef.current = roles.canEdit
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el || !roles.forceFollowLocked) return
    const stop = (event: Event) => {
      event.preventDefault()
      event.stopPropagation()
    }
    const opts: AddEventListenerOptions = { capture: true, passive: false }
    const types = [
      'wheel',
      'gesturestart',
      'gesturechange',
      'gestureend',
      'pointerdown',
      'touchstart',
      'touchmove',
    ] as const
    for (const type of types) {
      el.addEventListener(type, stop, opts)
    }
    return () => {
      for (const type of types) {
        el.removeEventListener(type, stop, opts)
      }
    }
  }, [roles.forceFollowLocked])

  useEffect(() => {
    return () => {
      unsubUserFollowRef.current?.()
      unsubUserFollowRef.current = null
    }
  }, [])

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

  const applyRemoteElements = useCallback(
    (remoteElements: SceneElement[], remoteAppState: SceneAppState | null) => {
      const api = apiRef.current
      if (!api) {
        const pending = pendingRemoteRef.current
        if (!pending) {
          pendingRemoteRef.current = {
            elements: remoteElements,
            appState: remoteAppState,
          }
        } else {
          pendingRemoteRef.current = {
            elements: mergeSceneElements(pending.elements, remoteElements).next,
            appState: remoteAppState ?? pending.appState,
          }
        }
        return
      }
      applyingRemoteRef.current = true
      try {
        const local = api.getSceneElementsIncludingDeleted()
        const localAppState = api.getAppState()
        const restored = restoreElements(remoteElements, local)
        const reconciled = reconcileElements(
          local,
          restored as Parameters<typeof reconcileElements>[1],
          localAppState,
        )
        const viewBackgroundColor =
          typeof remoteAppState?.viewBackgroundColor === 'string'
            ? remoteAppState.viewBackgroundColor
            : undefined
        api.updateScene({
          elements: reconciled,
          ...(viewBackgroundColor
            ? { appState: { viewBackgroundColor } }
            : {}),
          captureUpdate: CaptureUpdateAction.NEVER,
        })
        lastSceneVersionRef.current = getSceneVersion(reconciled)
        rememberElementVersions(
          reconciled as SceneElement[],
          lastElementVersionsRef.current,
        )
        sceneHydratedRef.current = true
      } finally {
        queueMicrotask(() => {
          applyingRemoteRef.current = false
        })
      }
    },
    [],
  )

  const sendSceneUpdate = useCallback(
    (
      elements: readonly OrderedExcalidrawElement[],
      appState: AppState,
      forceFull: boolean,
    ): boolean => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return false
      if (!authSentRef.current) return false
      if (applyingRemoteRef.current) return false
      if (!canEditRef.current) return false
      if (!sceneHydratedRef.current) return false

      const version = getSceneVersion(elements)
      if (!forceFull && version === lastSceneVersionRef.current) return true

      const asScene = elements as unknown as SceneElement[]
      const dirty = elementsWithIncreasedVersion(
        asScene,
        lastElementVersionsRef.current,
      )
      if (!forceFull && dirty.length === 0) {
        lastSceneVersionRef.current = version
        return true
      }

      fullSyncCounterRef.current += 1
      const full = forceFull || fullSyncCounterRef.current % 15 === 0
      const payload = full ? asScene : dirty

      let databaseJson: string | undefined
      try {
        databaseJson = serializeAsJSON(
          elements,
          { ...appState, viewModeEnabled: false },
          {},
          'database',
        )
      } catch {
        databaseJson = undefined
      }

      try {
        ws.send(
          JSON.stringify({
            type: 'scene:update',
            elements: payload,
            full,
            databaseJson,
          }),
        )
      } catch {
        return false
      }

      rememberElementVersions(payload, lastElementVersionsRef.current)
      lastSceneVersionRef.current = version
      return true
    },
    [],
  )

  const flushPending = useCallback(
    (forceFull = false) => {
      const pending = pendingFlushRef.current
      if (!pending) return
      const sent = sendSceneUpdate(
        pending.elements,
        pending.appState,
        forceFull,
      )
      if (sent) pendingFlushRef.current = null
    },
    [sendSceneUpdate],
  )

  const flushNow = useCallback(
    (forceFull = false) => {
      if (flushTimerRef.current != null) {
        window.clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      flushPending(forceFull)
    },
    [flushPending],
  )
  const flushNowRef = useRef(flushNow)
  flushNowRef.current = flushNow

  const handleChange = useCallback(
    (
      elements: readonly OrderedExcalidrawElement[],
      appState: AppState,
      files: BinaryFiles,
    ) => {
      // PHASE 3.2 — upload/hydrate R2 files; do not gate on remote-apply.
      media.syncFiles(elements, files)
      if (applyingRemoteRef.current) return
      if (!canEditRef.current) return
      const version = getSceneVersion(elements)
      if (version === lastSceneVersionRef.current) return
      pendingFlushRef.current = { elements, appState }
      if (flushTimerRef.current != null) return
      flushTimerRef.current = window.setTimeout(() => {
        flushTimerRef.current = null
        flushPending()
      }, SCENE_FLUSH_MS)
    },
    [flushPending, media.syncFiles],
  )

  useEffect(() => {
    const persist = () => {
      flushNowRef.current(true)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') persist()
    }
    window.addEventListener('pagehide', persist)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', persist)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  useEffect(() => {
    if (!boardId) return
    let cancelled = false
    let pingTimer: number | null = null
    let resyncTimer: number | null = null
    let reconnectTimer: number | null = null
    let attempt = 0
    let lastSocketJsAt = 0

    const clearTimers = () => {
      if (pingTimer != null) {
        window.clearInterval(pingTimer)
        pingTimer = null
      }
      if (resyncTimer != null) {
        window.clearInterval(resyncTimer)
        resyncTimer = null
      }
    }

    /**
     * Send `wb:auth` once Clerk has settled. Runs in parallel with the open
     * socket — the server already sent the full scene on connect, so board
     * contents download while Clerk is still loading. Signed-in sockets wait
     * for a real JWT (an empty token would finalize the session as Viewer).
     */
    const sendConnectAuth = async (ws: WebSocket) => {
      await whenAuthReady()
      if (cancelled || wsRef.current !== ws) return
      const sessionToken = isSignedIn()
        ? ((await waitForSessionToken(20, 100, { require: true })) ?? '')
        : ''
      if (cancelled || wsRef.current !== ws) return
      if (ws.readyState !== WebSocket.OPEN) return
      const hostSecret = getHostSecret(boardId)
      ws.send(
        JSON.stringify({
          type: 'wb:auth',
          ...(sessionToken ? { token: sessionToken } : {}),
          ...(hostSecret ? { hostSecret } : {}),
        }),
      )
      authSentRef.current = true
      // Resubscribe wb:follow on open/reconnect while the socket is OPEN.
      resubscribeFollowRef.current()
      // Push anything drawn while the socket was down / auth was pending.
      flushNowRef.current(true)
    }

    const connect = () => {
      if (cancelled) return

      const identity = getBoardConnectIdentity()
      const sessionId = getOrCreateSessionId(boardId)
      // Guest identity hint only. Signed-in users are identified by the
      // verified `wb:auth` JWT; a non-UUID userId is dropped from the URL.
      const uri = buildWhiteboardConnectUrl(window.location.origin, {
        boardId,
        sessionId,
        displayName: identity.displayName,
        userId: identity.userId,
      })

      authSentRef.current = false
      const ws = new WebSocket(uri)
      wsRef.current = ws

      ws.addEventListener('open', () => {
        attempt = 0
        clearTimers()
        void sendConnectAuth(ws)
        pingTimer = window.setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return
          ws.send('{"type":"ping"}')
          // Auto-pong does not wake DO JS. After a gap, replay wb:follow even
          // if the tab never disconnected.
          if (Date.now() - lastSocketJsAt >= FOLLOW_SOCKET_GAP_MS) {
            resubscribeFollowRef.current()
          }
        }, CLIENT_PING_MS)
        resyncTimer = window.setInterval(() => {
          const api = apiRef.current
          if (!api || ws.readyState !== WebSocket.OPEN) return
          sendSceneUpdate(
            api.getSceneElementsIncludingDeleted(),
            api.getAppState(),
            true,
          )
        }, 30_000)
        // Pending strokes flush in sendConnectAuth (after wb:auth) — the
        // server drops messages sent before auth. The full scene arrives
        // unprompted on every connect, so no scene:request is needed here.
      })

      ws.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return
        let parsed: unknown
        try {
          parsed = JSON.parse(event.data)
        } catch {
          return
        }
        if (!parsed || typeof parsed !== 'object') return
        const data = parsed as Record<string, unknown>

        if (data.type === 'pong') {
          // Socket stayed OPEN across a hibernation gap; resubscribe wb:follow.
          if (Date.now() - lastSocketJsAt >= FOLLOW_SOCKET_GAP_MS) {
            resubscribeFollowRef.current()
          }
          return
        }
        lastSocketJsAt = Date.now()

        if (data.type === 'wb:error') {
          const message =
            typeof data.message === 'string' && data.message.trim()
              ? data.message
              : 'This board is too large to save. The last change was not stored.'
          const now = Date.now()
          if (now - persistErrorToastAtRef.current >= 5000) {
            persistErrorToastAtRef.current = now
            apiRef.current?.setToast?.({
              message,
              duration: 8000,
              closable: true,
            })
          }
          return
        }

        // PHASE 3.3
        if (handleRoleMessageRef.current(data)) return

        if (data.type === 'scene:sync' || data.type === 'scene:update') {
          const elements = Array.isArray(data.elements)
            ? (data.elements as SceneElement[])
            : []
          const appState =
            data.appState && typeof data.appState === 'object'
              ? (data.appState as SceneAppState)
              : null
          applyRemoteElements(elements, appState)
          return
        }
      })

      ws.addEventListener('close', () => {
        clearTimers()
        if (wsRef.current === ws) {
          const api = apiRef.current
          if (
            api &&
            canEditRef.current &&
            !pendingFlushRef.current &&
            !applyingRemoteRef.current
          ) {
            const elements = api.getSceneElementsIncludingDeleted()
            if (getSceneVersion(elements) !== lastSceneVersionRef.current) {
              pendingFlushRef.current = {
                elements,
                appState: api.getAppState(),
              }
            }
          }
          wsRef.current = null
        }
        if (cancelled) return
        const delay = Math.min(10_000, 500 * 2 ** attempt)
        attempt += 1
        reconnectTimer = window.setTimeout(() => {
          void connect()
        }, delay)
      })
    }

    const onVisibleAfterGap = () => {
      if (document.visibilityState !== 'visible') return
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      if (Date.now() - lastSocketJsAt < FOLLOW_SOCKET_GAP_MS) return
      // Tab stayed connected; still resubscribe wb:follow after a gap.
      resubscribeFollowRef.current()
    }
    document.addEventListener('visibilitychange', onVisibleAfterGap)

    void connect()

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibleAfterGap)
      clearTimers()
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer)
      flushNowRef.current(true)
      const ws = wsRef.current
      wsRef.current = null
      try {
        ws?.close()
      } catch {
        // ignore
      }
    }
  }, [applyRemoteElements, boardId, sendSceneUpdate])

  const handleApi = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      apiRef.current = api
      // New (or remounted, via key={canEdit}) instance starts empty; block
      // outgoing scene pushes until a server scene has been applied.
      sceneHydratedRef.current = false
      unsubUserFollowRef.current?.()
      unsubUserFollowRef.current = api.onUserFollow((payload) => {
        onUserFollowRef.current(payload)
      })
      api.updateScene({
        appState: { viewModeEnabled: !canEditRef.current },
        captureUpdate: CaptureUpdateAction.NEVER,
      })
      requestAnimationFrame(() => {
        reassertFollowRef.current()
      })
      const pending = pendingRemoteRef.current
      if (pending) {
        pendingRemoteRef.current = null
        applyRemoteElements(pending.elements, pending.appState)
      } else if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'scene:request' }))
      }
    },
    [applyRemoteElements],
  )

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
    <div
      ref={wrapRef}
      style={{
        position: 'absolute',
        inset: 0,
        touchAction: roles.forceFollowLocked ? 'none' : undefined,
      }}
    >
      {roles.helloReceived ? (
        <Excalidraw
          key={roles.canEdit ? 'edit' : 'view'}
          excalidrawAPI={handleApi}
          theme={theme}
          onChange={handleChange}
          generateIdForFile={media.generateIdForFile}
          validateEmbeddable={media.validateEmbeddable}
          renderEmbeddable={media.renderEmbeddable}
          onPaste={media.onPaste}
          isCollaborating
          name={roles.displayName}
          viewModeEnabled={roles.viewModeEnabled}
          collaborators={roles.collaborators}
          onScrollChange={roles.onScrollChange}
        />
      ) : null}
      {roles.forceFollowLocked ? (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 1,
            background: 'transparent',
            touchAction: 'none',
            pointerEvents: 'none',
          }}
        />
      ) : null}
      {!roles.helloReceived ? (
        <div
          style={{
            position: 'absolute',
            top: 8,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 7,
            padding: '4px 10px',
            borderRadius: 2,
            background: 'var(--primary-color)',
            color: '#fff',
            fontSize: '0.75rem',
            fontWeight: 600,
            pointerEvents: 'none',
          }}
        >
          Connecting…
        </div>
      ) : roles.viewModeEnabled ? (
        <div
          style={{
            position: 'absolute',
            top: 8,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 7,
            padding: '4px 10px',
            borderRadius: 2,
            background: 'var(--primary-color)',
            color: '#fff',
            fontSize: '0.75rem',
            fontWeight: 600,
            pointerEvents: 'none',
          }}
        >
          View only
        </div>
      ) : null}
    </div>
  )
}
