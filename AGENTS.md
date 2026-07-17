# AGENTS.md
## Project Overview

St. Cecilia Technology — a PWA dashboard and educational games catalog for a grade school. Used daily by students and teachers on full-size desktop monitors and small Dell Chromebooks.

## Development

**Stack:** Astro 7 + `@astrojs/cloudflare`, deployed as a Cloudflare Worker with static assets.

- **Dev server**: `npm run dev` (Astro)
- **Production build**: `npm run build` → output under `dist/client/`
- **Deploy**: `npx wrangler deploy` (Worker name `scsfoxchase-tech`)
- **Domain**: scsfoxchase.tech

See `DEPLOYMENT.md` for Workers Builds settings and deploy notes.

## Architecture

- **Astro static site** adapted for Cloudflare Workers Assets (`output: 'static'` + Cloudflare adapter).
- **PWA** with service worker (`public/sw.js`) for offline support. Network-first for navigations; `/offline` is the canonical offline page. `/_astro/*` is cache-first.
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

- `wrangler.jsonc` — Worker `scsfoxchase-tech`, assets `./dist/client`
- `public/_headers` — Security headers (CSP, HSTS, X-Frame-Options, cache rules)
- `public/_redirects` — Legacy path redirects
- `public/sw.js` — Service worker (network-first HTML, cache fallback for assets)
- **Do not** use empty Pages build / publish `/` — `cloudflare-pages.toml` is removed

## Style Conventions

- Colors: primary `#125F31` (green), secondary `#F6D724` (yellow)
- Border radius: `2px` for cards/buttons, `999px` for pills/search bars
- No CSS framework — styles in `src/styles/` (`global.css`, `home.css`, `carousel.css`, `inventory.css`, `forms.css`)
