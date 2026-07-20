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
- **Whiteboard sync** — Durable Object class `WhiteboardBoard`, binding `WHITEBOARDS` (product family `scsfoxchase-tech_whiteboards`). Client uses `@tldraw/sync` `useSync` on `/board/{uuid}`.
- **Whiteboard assets** — R2 binding `WHITEBOARD_ASSETS` → bucket `scsfoxchase-tech-whiteboards` (R2 names cannot use `_`; product family spelling keeps the underscore). Keys `assets/{ownerKey}/{assetId}`; signed-out owner `local:{deviceInstallId}`; signed-in owner `google:{accountId}` (Google `sub` preferred, else Clerk user id). Hub Assets index: localStorage when signed out; R2 JSON `library/{ownerKey}/assets.json` when signed in.
- **Share codes (Phase 5)** — KV binding `WHITEBOARD_CODES` indexes `code:{A1B2}` → board UUID (TTL 12h). DO stores `activeCode` + alarm for Open/Closed; hub join + manage-panel Open/Closed/Copy/New code.
- **Whiteboard auth (Phase 4b)** — Clerk Google sign-in via `@clerk/react` header island (Astro 7; `@clerk/astro` not yet peer-compatible). Custom Clerk Frontend API domain: `clerk.scsfoxchase.tech`. Dual library mode: sign-in/out swaps Recents/Library/Assets without wiping the other namespace. Worker verifies sessions with `@clerk/backend` for cloud library APIs and `google:*` asset writes.
- **PWA** with service worker (`public/sw.js`) for offline support. Network-first for navigations; `/offline` is the canonical offline page. `/api/*` is never intercepted (WebSocket).
- **Game data** lives in `src/content/games/` as individual JSON files (Astro content collection). Trending IDs live in `src/data/trending.json`. To add a game: add its JSON under `src/content/games/` (collection picks it up at build time).
- **Theming** uses CSS variables on `:root` with dark mode via `[data-theme="dark"]`. Theme state persists in localStorage (`src/scripts/theme-toggle.ts`).
- **`src/scripts/placeholder-images.ts`** provides image fallbacks when assets fail to load.

## Key Pages

| Route | Source | Purpose |
|-------|--------|---------|
| `/` | `src/pages/index.astro` | Homepage — search bars + app launcher grid |
| `/games` | `src/pages/games.astro` | Game catalog (current layout) |
| `/forms` | `src/pages/forms.astro` | Forms hub — launch help/request forms |
| `/forms/*` | `src/pages/forms/*.astro` | Individual form stubs (n8n later) |
| `/oldgames` | `src/pages/oldgames.astro` | Legacy game catalog (kept until removed) |
| `/offline` | `src/pages/offline.astro` | Offline fallback |
| `/inventory` | `src/pages/inventory.astro` | Staff device inventory lookup + QR |
| `/whiteboard` | `src/pages/whiteboard.astro` | Whiteboard hub — create, join, Recents, Assets, Library |
| `/board/{uuid}` | `src/pages/board.astro` (+ `/board/*` rewrite) | Live board — site header + tldraw sync canvas |
| `/api/whiteboard/connect/:uuid` | `src/worker.ts` → DO | WebSocket upgrade for tldraw sync |
| `/api/whiteboard/join/:code` | `src/worker.ts` → KV | Resolve share code → board UUID |
| `/api/whiteboard/boards/:uuid/code` | `src/worker.ts` → DO + KV | GET/POST/DELETE share code (Open/Closed/rotate) |
| `/api/whiteboard/assets/:ownerKey/:assetId` | `src/worker.ts` → R2 | PUT/GET/DELETE whiteboard media |
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
- `@media (max-height: 800px)` — Chromebook vertical compression

**When adding new sections or elements, ensure they fit on all three device types without scrolling.** The desktop layout is considered final.

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
