import { Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'

function readRoomIdFromLocation(): string | undefined {
  if (typeof window === 'undefined') return undefined

  const fromQuery = new URLSearchParams(window.location.search).get('room')
  if (fromQuery) {
    const cleaned = fromQuery.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)
    return cleaned || undefined
  }

  // Forward-compat: /whiteboard/r/{id} if served via rewrite
  const pathMatch = window.location.pathname.match(/\/whiteboard\/r\/([^/]+)\/?$/i)
  if (pathMatch?.[1]) {
    const cleaned = decodeURIComponent(pathMatch[1]).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)
    return cleaned || undefined
  }

  return undefined
}

type TldrawBoardProps = {
  roomId?: string
}

export default function TldrawBoard({ roomId: roomIdProp }: TldrawBoardProps) {
  const roomId = roomIdProp ?? readRoomIdFromLocation()
  const persistenceKey = roomId
    ? `scsfoxchase-tldraw-r-${roomId}`
    : 'scsfoxchase-tldraw'

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      {roomId && (
        <p
          style={{
            position: 'fixed',
            top: 10,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 40,
            margin: 0,
            padding: '6px 12px',
            borderRadius: 2,
            background: 'rgba(18, 95, 49, 0.92)',
            color: '#fff',
            font: '500 0.8rem/1.3 system-ui, -apple-system, sans-serif',
            pointerEvents: 'none',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.18)',
          }}
        >
          Room {roomId} — collaborative sync coming soon (local board for now)
        </p>
      )}
      <Tldraw
        licenseKey={import.meta.env.PUBLIC_TLDRAW_LICENSE_KEY}
        persistenceKey={persistenceKey}
      />
    </div>
  )
}
