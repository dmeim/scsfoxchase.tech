# Astro Migration Bugfix Log

**Branch:** `astro-cloudflare-migration`  
**Worktree:** `.worktrees/astro-cloudflare-migration`  
**Started:** 2026-07-15  
**Status:** complete (awaiting human click-check)

## Summary

| BUG-ID | Severity | Status | Commit(s) | Notes |
|--------|----------|--------|-----------|-------|
| BUG-004 | Critical | fixed | `338ae96` | Legacy → `archive/pre-astro/` (outside `public/`) |
| BUG-002 | High | verified | — | Header `/games`; no `games.html` in `src/` |
| BUG-003 / BUG-008 | High | fixed | `db3f2a8` | Flat `inventory.astro` + `build.format: 'file'` |
| BUG-005 / BUG-006 / BUG-012 | High | fixed | `db3f2a8` + follow-ups | Redirects OK with `Accept: text/html` |
| BUG-001 | High | fixed | `962dd39` | Smart-search bar yellow on field hover; human visual confirm |
| BUG-007 | High | fixed | `e0fb143` | `dist/client` has index/games/offline/inventory/404 HTML |
| BUG-011 | High | fixed | `338ae96` | Root `sw.js` archived; `public/sw.js` only |
| BUG-010 | Medium | verified | `6e39079` | No FA/`cdnjs` on Astro pages |
| BUG-013 | Medium | fixed | `e0fb143` | `imageService: 'passthrough'` + `sessionDrivers.lruCache()` |
| Duplicate redirects | Medium | fixed | `e0fb143` | `_redirects` only extras; Astro config owns `.html` rules |
| BUG-014 | Low | deferred | — | Sitemap intentional-ish |
| Touch hover Chromebook | — | deferred | — | N/A |
| Inventory camera/QR | — | deferred | — | Human hardware test |
| Production DNS cutover | — | deferred | — | Human |
| BUG-015 | Medium | fixed | `6dfc3e8` | Games wave bg + 4-col grid |
| BUG-016 | Low | fixed | `8fba87a` | Home header max-width matched games |
| BUG-017 | Critical | fixed | 9be2e74 | Unstyled workers.dev — immutable `/_astro` 404 cache |

## What’s left for human

1. Restart preview: `cd ".worktrees/astro-cloudflare-migration" && npm run dev` (or `npm run build && npx astro preview`)
2. Visual confirm smart-search title hover yellows the **whole bar** (CSS in `962dd39`)
3. Click Games nav → `/games` catalog loads — confirm dotted wave background + **4 game cards per row** on desktop
4. Inventory camera/QR on a real device
5. Production DNS / Workers cutover (see `ASTRO-MIGRATION.md`) — do **not** flip DNS until preview checklist passes

## Verification checklist

- [x] `/` is Astro (`/_astro/`, Header `/games`, no FA) — curl preview `:4325` 2026-07-15
- [x] Nav Games → `/games` with `#games-catalog-data` — curl verified
- [x] `/games.html` → `/games` with `Accept: text/html` — 301
- [x] `/inventory` 200, no slash loop; `/inventory/` → 301 → `/inventory`
- [ ] Smart search title hover yellows whole bar — **human visual**
- [ ] Games page: dotted wave canvas + 4-column `.games-grid` — **human visual** (hard-refresh)
- [x] `npm run build` produces HTML in `dist/client`

## Per-bug detail

### BUG-004 — Legacy root files shadow Astro
- **Status:** fixed
- **Commit(s):** `338ae96`
- **Fix:** Moved legacy HTML + dirs + duplicate root statics into `archive/pre-astro/` (not deployed).

### BUG-011 — Duplicate root sw.js
- **Status:** fixed
- **Commit(s):** `338ae96`
- **Fix:** Root `sw.js` → archive; only `public/sw.js` remains.

### BUG-001 — Smart search nametag hover
- **Status:** fixed (CSS); human visual confirm pending
- **Commit(s):** `962dd39`
- **Fix:** `.smart-search-field:hover/.focus-within .smart-search-bar` mirrors title yellow/primary borders.

### BUG-003 / BUG-008 — `/inventory` trailingSlash loop
- **Status:** fixed
- **Commit(s):** `db3f2a8`
- **Fix:** Flat `src/pages/inventory.astro`; `build.format: 'file'`; `_redirects` `/inventory/` → `/inventory`.

### BUG-002 — Games nav → `/games`
- **Status:** verified (no code change)
- **Verification:** `src/` has no `games.html` links; Header uses `/games`.

### BUG-005 / BUG-006 / BUG-012 — Legacy redirects
- **Status:** fixed / verified
- **Commit(s):** rules as of `db3f2a8`; dedupe + `_redirects` trim in this pass
- **Verification (preview `:4325`, `Accept: text/html`):**
  - `/games.html` → 301 `/games`
  - `/hub.html`, `/hub`, `/newhome`, `/newhome/` → 301 `/`
  - `/offline.html` → 301 `/offline`
  - `/inventory/` → 301 `/inventory`

### BUG-010 — No Font Awesome CDN
- **Status:** verified
- **Commit(s):** historical `6e39079`

### BUG-007 — Rebuild / dist HTML
- **Status:** fixed
- **Commit(s):** `e0fb143` (verification recorded)
- **Verification:** `dist/client/{index,games,offline,inventory,404}.html` present after `npm run build`.

### BUG-013 — IMAGES / SESSION binding warnings
- **Status:** fixed
- **Commit(s):** `e0fb143`
- **Fix:** `adapter: cloudflare({ imageService: 'passthrough', experimental: { headersAndRedirectsDevModeSupport: true } })` and `session: { driver: sessionDrivers.lruCache() }` so static site does not auto-enable Cloudflare Images / SESSION KV.
- **Note:** App does not use Astro Image transforms or Astro sessions; these settings silence adapter defaults without wrangler binding stubs.

### Duplicate redirect warnings
- **Status:** fixed
- **Commit(s):** `e0fb143`
- **Fix:** `public/_redirects` keeps only `/newhome/` and `/inventory/` (Astro config redirects are merged into dist `_redirects` at build). Preview now: “Parsed 7 valid redirect rules” with no duplicates.

### BUG-015 — Games page missing wave background and 4-column grid
- **Status:** fixed
- **Commit(s):** `6dfc3e8`
- **Root cause:**
  1. `GamesCatalog.astro` used `class="game-grid"` but `global.css` styles `.games-grid` (incl. `repeat(4, 1fr)` at ≥1280px).
  2. Legacy `js/dot-waves.js` (creates `.dot-wave-canvas`) was never ported; CSS for the canvas already existed in `global.css`.
- **Fix:** Rename wrapper to `games-grid`; add `src/scripts/dot-waves.ts` and call `initDotWaves()` from `GamesCatalog.astro`.

### BUG-016 — Home header spacing differs from games
- **Status:** fixed
- **Commit(s):** `8fba87a`
- **Root cause:** `.home-page .container { max-width: none }` also applied to `header .container`, so on wide screens the home navbar stretched edge-to-edge while games kept `max-width: 1600px`.
- **Fix:** Scope the override to `.home-page main .container` so the shared Header matches games.

### BUG-017 — Gigantic logo / unstyled workers.dev (CSS not applying)
- **Status:** fixed (deployed version `cf027424`; `9be2e74`)
- **Symptom:** Homepage showed unstyled HTML — 1000×1000 `scs-logo.png` at full intrinsic size.
- **Root cause:** `/_astro/*` had `Cache-Control: public, max-age=31536000, immutable`. When CSS was briefly missing (or 404) after early deploys, browsers cached those **404s as immutable for a year**. Redeploys that restored CSS could not override the poisoned client cache for the same hashed URLs. Local `wrangler` confirmed `_headers` also applied that long TTL to `/_astro` 404 responses.
- **Fix:** Cap all site `Cache-Control` to `max-age=3600, must-revalidate` (no `immutable`); bump SW to `st-cecilia-tech-astro-v2` and network-first all assets; change `.header-logo` CSS to force new `/_astro` hash (`BaseLayout.Bvsk51aj.css`); set `workers_dev`/`not_found_handling: 404-page` in `wrangler.jsonc`.
- **Note:** Public DNS for `*.dimitri-meimaridis.workers.dev` currently returns NXDOMAIN from 1.1.1.1 (API still reports subdomain enabled). If Visit still fails to resolve, re-check workers.dev in the dashboard or use a custom domain.

---
