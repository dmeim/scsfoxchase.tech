# Astro Migration Bugfix Log

**Branch:** `astro-cloudflare-migration`  
**Worktree:** `.worktrees/astro-cloudflare-migration`  
**Started:** 2026-07-15  
**Status:** in progress

## Summary

| BUG-ID | Severity | Status | Commit(s) | Notes |
|--------|----------|--------|-----------|-------|
| BUG-004 | Critical | fixed | `338ae96` | Legacy moved to `archive/pre-astro/` (outside `public/`) |
| BUG-002 | High | verified | — (pre-existing `/games` in Header) | No `games.html` links in `src/`; nav → `/games` |
| BUG-003 / BUG-008 | High | fixed | `db3f2a8` | Flat `inventory.astro` + `build.format: file`; `/inventory` 200, `/inventory/`→301 |
| BUG-005 / BUG-006 / BUG-012 | High | fixed | `db3f2a8` (+ verify) | Legacy redirects OK with `Accept: text/html`; see detail |
| BUG-001 | High | fixed | `962dd39` | Smart search nametag hover yellows whole bar; human visual confirm still needed |
| BUG-007 | High | open | — | Rebuild; ensure `dist/client` has prerendered HTML |
| BUG-011 | High | fixed | `338ae96` | Root `sw.js` archived; `public/sw.js` remains |
| BUG-010 | Medium | verified | `6e39079` (historical) | No FA/`cdnjs` in `src/` or built `dist/client` HTML |
| BUG-013 | Medium | open | — | Cloudflare adapter IMAGES/SESSION binding warnings |
| BUG-014 | Low | deferred | — | Sitemap intentional-ish |
| Touch hover Chromebook | — | deferred | — | N/A |
| Inventory camera/QR | — | deferred | — | Human hardware test |
| Production DNS cutover | — | deferred | — | Human |

## What’s left for human

- Visual confirm smart-search hover yellows whole bar (BUG-001 CSS landed in `962dd39`)
- Inventory camera/QR on real device
- Production DNS / Workers cutover (see ASTRO-MIGRATION.md)
- Click-check verification checklist below after restarting `npm run dev` in worktree

## Verification checklist (human)

- [ ] `http://localhost:<port>/` is Astro (no FA, Header `/games`, `/_astro/`)
- [ ] Nav Games → `/games` works (Astro GamesCatalog with `#games-catalog-data`)
- [x] `/games.html` redirects to `/games` with Accept: text/html (curl verified 2026-07-15)
- [ ] `/inventory` loads (no slash loop)
- [ ] Smart search title hover yellows whole bar
- [x] `npm run build` produces HTML in dist/client (verified; also `/_astro/` in built index)

## Per-bug detail

### BUG-001 — Smart search nametag hover
- **Status:** fixed
- **Fix:** Mirrored title hover/focus-within border styles onto `.smart-search-bar` so field hover yellows the whole bar, not only the title tab.
- **Commit(s):** `962dd39` (`fix(home): yellow smart-search bar border on title hover`)
- **Verification:** Human visual confirm still needed (checklist item above).

### BUG-004 — Legacy root files shadow Astro
- **Status:** fixed
- **Fix:** Moved legacy HTML + dirs + duplicate root statics into `archive/pre-astro/` (not under `public/`, not deployed). Root now only Astro project files + `public/` + `src/`.
- **Moved:** `index.html`, `games.html`, `offline.html`, `404.html`, `hub.html`, `testing.html`, `inventory/`, `newhome/`, `oldhome/`, `old-site/`, `css/`, `js/`, `data/`, `images/`, root `sw.js`, `manifest.json`, `robots.txt`, `sitemap.xml`, favicons, `.htaccess`
- **Commit(s):** `338ae96`
- **Verification:** Root clean; `public/sw.js` remains. After archive, Astro wins on `/` in `astro dev`.

### BUG-011 — Duplicate root sw.js
- **Status:** fixed (same commit as BUG-004)
- **Fix:** Root `sw.js` → `archive/pre-astro/sw.js`; only `public/sw.js` is source of truth.
- **Commit(s):** `338ae96`

### BUG-003 / BUG-008 — `/inventory` trailingSlash loop
- **Status:** fixed
- **Fix:** Moved `src/pages/inventory/index.astro` → `src/pages/inventory.astro` (flat route). Set `build.format: 'file'` so routes emit `inventory.html` / `games.html` / `offline.html` instead of `*/index.html` directories that 307 to trailing slash and fought `_redirects`. Added `public/_redirects` rule `/inventory/ → /inventory` (301). Did **not** add Astro `redirects['/inventory/']` (that collided with the page and produced a self-redirect).
- **Commit(s):** `db3f2a8`
- **Verification:** `npm run build` → `dist/client/inventory.html`. `wrangler pages dev`: `/inventory` → 200; `/inventory/` → 301 → `/inventory`; `/games` and `/offline` → 200; slash variants 307 to no-slash (no loop).

### BUG-002 — Games nav → `/games`
- **Status:** verified (no code change needed)
- **Fix:** Already correct in `Header.astro`, `404.astro`, `offline.astro` (`href="/games"`). Grep of `src/` found no `games.html` links (archive/ untouched).
- **Commit(s):** —
- **Verification (2026-07-15):** `astro dev` `/` HTML contains `href="/games"`; no `games.html` in `src/`.

### BUG-005 / BUG-006 / BUG-012 — Legacy `.html` / dir redirects
- **Status:** fixed / verified
- **Fix:** `astro.config.mjs` `redirects` + `public/_redirects` cover legacy paths. `/hub` added alongside `/hub.html`. `/newhome/` kept only in `_redirects` (Astro config cannot list both `/newhome` and `/newhome/` under `trailingSlash: 'never'` — route key collision).
- **Commit(s):** rules present as of `db3f2a8` / earlier `6e39079`; no additional code commit required after verify
- **Verification (2026-07-15):**
  - `astro dev` `:4321` with `Accept: text/html` (no-follow → follow):
    - `/games.html` → 301 `/games` → 200
    - `/hub.html` → 301 `/` → 200
    - `/hub` → 301 `/` → 200
    - `/newhome` → 301 `/` → 200
    - `/offline.html` → 301 `/offline` → 200
    - `/newhome/` → **404 in astrodev** (CF workerd path; Vite middleware / Astro middleware do not apply `_redirects` in static+adapter dev)
  - `astro preview` `:4323` with `Accept: text/html`: **all of the above including `/newhome/` → 301 `/` → 200**
  - `/` is Astro (`/@vite/client` in dev; `/_astro/` in build/preview); no FA CDN
- **Residual:** `/newhome/` only fails in `astrodev`; production/`astro preview` OK via `_redirects`.

### BUG-010 — No Font Awesome CDN
- **Status:** verified
- **Fix:** Historical removal in `6e39079`; confirmed gone after BUG-004 archive.
- **Commit(s):** `6e39079` (historical)
- **Verification (2026-07-15):** No `cdnjs` / `font-awesome` / `fontawesome` in `src/` or `dist/client` HTML. Homepage curl clean.

---
