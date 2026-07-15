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
| BUG-007 | High | fixed | _(this pass)_ | `dist/client` has index/games/offline/inventory/404 HTML |
| BUG-011 | High | fixed | `338ae96` | Root `sw.js` archived; `public/sw.js` only |
| BUG-010 | Medium | verified | `6e39079` | No FA/`cdnjs` on Astro pages |
| BUG-013 | Medium | fixed | _(this pass)_ | `imageService: 'passthrough'` + `sessionDrivers.lruCache()` |
| Duplicate redirects | Medium | fixed | _(this pass)_ | `_redirects` only extras; Astro config owns `.html` rules |
| BUG-014 | Low | deferred | — | Sitemap intentional-ish |
| Touch hover Chromebook | — | deferred | — | N/A |
| Inventory camera/QR | — | deferred | — | Human hardware test |
| Production DNS cutover | — | deferred | — | Human |

## What’s left for human

1. Restart preview: `cd ".worktrees/astro-cloudflare-migration" && npm run dev` (or `npm run build && npx astro preview`)
2. Visual confirm smart-search title hover yellows the **whole bar** (CSS in `962dd39`)
3. Click Games nav → `/games` catalog loads
4. Inventory camera/QR on a real device
5. Production DNS / Workers cutover (see `ASTRO-MIGRATION.md`) — do **not** flip DNS until preview checklist passes

## Verification checklist

- [x] `/` is Astro (`/_astro/`, Header `/games`, no FA) — curl preview `:4325` 2026-07-15
- [x] Nav Games → `/games` with `#games-catalog-data` — curl verified
- [x] `/games.html` → `/games` with `Accept: text/html` — 301
- [x] `/inventory` 200, no slash loop; `/inventory/` → 301 → `/inventory`
- [ ] Smart search title hover yellows whole bar — **human visual**
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
- **Verification:** `dist/client/{index,games,offline,inventory,404}.html` present after `npm run build`.

### BUG-013 — IMAGES / SESSION binding warnings
- **Status:** fixed
- **Fix:** `adapter: cloudflare({ imageService: 'passthrough', experimental: { headersAndRedirectsDevModeSupport: true } })` and `session: { driver: sessionDrivers.lruCache() }` so static site does not auto-enable Cloudflare Images / SESSION KV.
- **Note:** App does not use Astro Image transforms or Astro sessions; these settings silence adapter defaults without wrangler binding stubs.

### Duplicate redirect warnings
- **Status:** fixed
- **Fix:** `public/_redirects` keeps only `/newhome/` and `/inventory/` (Astro config redirects are merged into dist `_redirects` at build). Preview now: “Parsed 7 valid redirect rules” with no duplicates.

---
