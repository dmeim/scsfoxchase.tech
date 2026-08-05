import { Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'

/**
 * Minimal guide title-card canvas — stock tldraw, nothing else.
 */
export default function GuideDiagram() {
  return (
    <div className="guide-diagram">
      <Tldraw licenseKey={import.meta.env.PUBLIC_TLDRAW_LICENSE_KEY} />
    </div>
  )
}
