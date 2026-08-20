# AGENTS.md
## Project Overview

St. Cecilia Technology — a PWA dashboard and educational games catalog for a grade school. Used daily by students and teachers on full-size desktop monitors and small Dell Chromebooks.

## Development

**Stack:** Astro 7 + `@astrojs/cloudflare`, deployed as a Cloudflare Worker with static assets (pages prerendered; Worker handles `/api/whiteboard/*`).

- **Dev server**: `npm run dev` (Astro)
- **Production build**: `npm run build` → output under `dist/client/`
- **Deploy**: `npx wrangler deploy` (Worker name `scsfoxchase-tech`)
- **Domain**: scsfoxchase.tech

See `DEPLOYMENT.md` for Workers Builds settings and deploy notes.

**Detailed docs:** [`docs/README.md`](docs/README.md) — architecture, conventions, features, whiteboard, deploy, and environment.

## Architecture

- **Astro site** on Cloudflare Workers (`output: 'server'` + all pages prerendered + Cloudflare adapter).
- **Custom Worker entry** `src/worker.ts` — serves prerendered assets via `@astrojs/cloudflare/handler` and handles `/api/whiteboard/*` (WebSocket sync + R2 asset upload/download).
- **Whiteboard sync** — Durable Object class `WhiteboardBoard`, binding `WHITEBOARDS` (product family `scsfoxchase-tech_whiteboards`). Product name is **Whiteboard**; editor is stock **Excalidraw 0.18.1** (`src/components/WhiteboardCanvas.tsx`, `client:only="react"`). Native WebSocket to `/api/whiteboard/connect/{uuid}` (element diffs + `reconcileElements`; persist `serializeAsJSON(..., "database")`). Fonts are self-hosted: `window.EXCALIDRAW_ASSET_PATH = '/excalidraw/'` (copied in `predev` / `prebuild`). No tldraw license key.
- **Whiteboard assets** — R2 binding `WHITEBOARD_ASSETS` → bucket `scsfoxchase-tech-whiteboards` (R2 names cannot use `_`; product family spelling keeps the underscore). Keys `assets/{ownerKey}/{assetId}`. Saved boards: `google:{accountId}` (Google `sub` preferred, else Clerk user id). Unsaved/signed-out canvas files: `temp:{boardId}` (24h). MP4/WebM play via same-origin `/whiteboard-player`. Hub Assets index is signed-in cloud only (`library/{ownerKey}/assets.json`).
- **Share codes** — KV binding `WHITEBOARD_CODES` indexes `code:{A1B2C3D4}` → board UUID (TTL 12h). Eight-character letter-digit (`([A-Z][0-9]){4}`). DO stores `activeCode` + alarm for Open/Closed; hub join + manage-panel Open/Closed/Copy/New code. Join is view-only until Owner/Manager sets Editor on People.
- **Whiteboard auth** — Clerk Google sign-in via `@clerk/react` header island (Astro 7; `@clerk/astro` not yet peer-compatible). Custom Clerk Frontend API domain: `clerk.scsfoxchase.tech`. Recents / Library / Assets are **cloud-only** (no localStorage board library). Signed-out create is a live scratch board (ephemeral Owner via host secret) and expires in 24h if never saved. Host proof is first-message `wb:auth` / `X-Board-Host`, not the WebSocket query string. Worker verifies sessions with `@clerk/backend` for cloud library APIs and `google:*` asset writes. Roles: Owner, Manager, Editor, Viewer. Voluntary Follow unfollows on pan; Follow Me locks the guest camera (snap to leader bounds + overlay).
- **PWA** with service worker (`public/sw.js`) for offline support. Network-first for navigations; `/offline` is the canonical offline page. `/api/*` is never intercepted (WebSocket).
- **Game data** lives in `src/content/games/` as individual JSON files (Astro content collection). Trending IDs live in `src/data/trending.json`. To add a game: add its JSON under `src/content/games/` (collection picks it up at build time).
- **Theming** uses CSS variables on `:root` with dark mode via `[data-theme="dark"]`. Theme state persists in localStorage (`src/scripts/theme-toggle.ts`).
- **`src/scripts/placeholder-images.ts`** provides image fallbacks when assets fail to load.

## Key Pages

| Route | Source | Purpose |
|-------|--------|---------|
| `/` | `src/pages/index.astro` | Homepage — search bars + app launcher grid |
| `/games` | `src/pages/games.astro` | Game catalog (current layout) |
| `/help` | `src/pages/help.astro` | Help hub — featured Forms + Guides |
| `/forms` | `src/pages/forms.astro` | Forms catalog (all forms) |
| `/guides` | `src/pages/guides.astro` | Guides catalog (all guides) |
| `/form/*` | `src/pages/form/*.astro` | Individual form pages / stubs (n8n later) |
| `/guide/{slug}` | `src/pages/guide/[slug].astro` | Guide articles (Markdown + footnote sources) |
| `/oldgames` | `src/pages/oldgames.astro` | Legacy game catalog (kept until removed) |
| `/offline` | `src/pages/offline.astro` | Offline fallback |
| `/inventory` | `src/pages/inventory.astro` | Staff device inventory lookup + QR |
| `/whiteboard` | `src/pages/whiteboard.astro` | Whiteboard hub — create, join; Recents/Assets/Library when signed in |
| `/board/{uuid}` | `src/pages/board.astro` (+ `/board/*` rewrite) | Live board — site header + Excalidraw canvas |
| `/whiteboard-player` | `src/pages/whiteboard-player.astro` | Same-origin MP4/WebM player for canvas embeds |
| `/api/whiteboard/connect/:uuid` | `src/worker.ts` → DO | WebSocket upgrade for Excalidraw collab |
| `/api/whiteboard/join/:code` | `src/worker.ts` → KV | Resolve share code → board UUID |
| `/api/whiteboard/boards/:uuid/code` | `src/worker.ts` → DO + KV | GET/POST/DELETE share code (Open/Closed/rotate) |
| `/api/whiteboard/assets/:ownerKey/:assetId` | `src/worker.ts` → R2 | PUT/GET/DELETE whiteboard media |
| `/api/whiteboard/admin/wipe-storage` | `src/worker.ts` → DO RPC | Bearer `WHITEBOARD_ADMIN_SECRET`; `deleteAll` on listed DO hex IDs |
| `/api/whiteboard/library/boards` | `src/worker.ts` → R2 JSON | Signed-in cloud board index (Clerk) |
| `/api/whiteboard/library/assets` | `src/worker.ts` → R2 JSON | Signed-in cloud asset index (Clerk) |
| `/games.html` | redirect | → `/games` |
| `/newgames` | redirect | → `/games` |

See `FORMS.md` for form routes, icons, and future webhook notes.

## Device Compatibility (Important)

The site runs on three device types:
- **Desktop monitors**: Large screens, the layout fits perfectly — do not change
- **Student Chromebooks**: 11.6" screens (1366x768), limited vertical space
- **iPads**: ~1024px wide in landscape, limited horizontal space

Responsive queries in `src/styles/global.css` / `home.css`:
- `@media (max-width: 1100px)` — iPad scaling (narrower app tiles, smaller icons/gaps)
- `@media (max-width: 768px)` — Mobile/phone layout (stacked elements)
- `@media (max-height: 800px)` — Chromebook vertical compression (whiteboard hub included)

**When adding new sections or elements, ensure they fit on all three device types without scrolling.** The desktop layout is considered final. Whiteboard fonts stay self-hosted (`EXCALIDRAW_ASSET_PATH`); do not load them from a CDN.

## Deployment Config

- `wrangler.jsonc` — Worker `scsfoxchase-tech`, assets `./dist/client`, `main` `./src/worker.ts`, DO binding `WHITEBOARDS`, R2 binding `WHITEBOARD_ASSETS`, KV binding `WHITEBOARD_CODES`
- `public/_headers` — Security headers (CSP, HSTS, X-Frame-Options, cache rules)
- `public/_redirects` — Legacy path redirects
- `public/sw.js` — Service worker (network-first HTML, cache fallback for assets)
- **Do not** use empty Pages build / publish `/` — `cloudflare-pages.toml` is removed

## Style Conventions

- Colors: primary `#125F31` (green), secondary `#F6D724` (yellow)
- Border radius: `2px` for cards/buttons, `999px` for pills/search bars
- No CSS framework — styles in `src/styles/` (`global.css`, `home.css`, `carousel.css`, `inventory.css`, `forms.css`)
