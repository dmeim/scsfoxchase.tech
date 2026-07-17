import { Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'

export default function TldrawBoard() {
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Tldraw licenseKey={import.meta.env.PUBLIC_TLDRAW_LICENSE_KEY} />
    </div>
  )
}
