/**
 * Copy self-hosted Excalidraw fonts into public/ so Vite does not inline them.
 * Source: node_modules/@excalidraw/excalidraw/dist/prod/fonts
 * Served as /excalidraw/fonts/… with window.EXCALIDRAW_ASSET_PATH = "/excalidraw/"
 */
import { cp, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(
  root,
  'node_modules/@excalidraw/excalidraw/dist/prod/fonts',
)
const dest = path.join(root, 'public/excalidraw/fonts')

if (!existsSync(src)) {
  console.error(
    `Missing Excalidraw fonts at ${src}. Run npm install first.`,
  )
  process.exit(1)
}

await mkdir(path.dirname(dest), { recursive: true })
await rm(dest, { recursive: true, force: true })
await cp(src, dest, { recursive: true })
console.log(`Copied Excalidraw fonts → ${path.relative(root, dest)}`)
