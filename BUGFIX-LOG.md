# Astro Migration Bugfix Log

**Branch:** `astro-cloudflare-migration`  
**Worktree:** `.worktrees/astro-cloudflare-migration`  
**Started:** 2026-07-15  
**Status:** in progress

## Summary

| BUG-ID | Severity | Status | Commit(s) | Notes |
|--------|----------|--------|-----------|-------|
| BUG-004 | Critical | fixed | _(pending commit)_ | Legacy moved to `archive/pre-astro/` (outside `public/`) |
| BUG-002 | High | open | — | Games nav → `/games` (Header already `/games`; verify after 004) |
| BUG-003 / BUG-008 | High | open | — | `/inventory` trailingSlash loop |
| BUG-005 / BUG-006 / BUG-012 | High | open | — | Legacy `.html` / dir redirects with `Accept: text/html` |
| BUG-001 | High | open | — | Smart search nametag hover yellow border on bar |
| BUG-007 | High | open | — | Rebuild; ensure `dist/client` has prerendered HTML |
| BUG-011 | High | fixed | _(same as 004)_ | Root `sw.js` archived; `public/sw.js` remains |
| BUG-010 | Medium | open | — | No FA CDN on Astro pages (follows 004) |
| BUG-013 | Medium | open | — | Cloudflare adapter IMAGES/SESSION binding warnings |
| BUG-014 | Low | deferred | — | Sitemap intentional-ish |
| Touch hover Chromebook | — | deferred | — | N/A |
| Inventory camera/QR | — | deferred | — | Human hardware test |
| Production DNS cutover | — | deferred | — | Human |

## What’s left for human

- Visual confirm smart-search hover yellows whole bar
- Inventory camera/QR on real device
- Production DNS / Workers cutover (see ASTRO-MIGRATION.md)
- Click-check verification checklist below after restarting `npm run dev` in worktree

## Verification checklist (human)

- [ ] `http://localhost:<port>/` is Astro (no FA, Header `/games`, `/_astro/`)
- [ ] Nav Games → `/games` works (Astro GamesCatalog with `#games-catalog-data`)
- [ ] `/games.html` redirects to `/games` with Accept: text/html
- [ ] `/inventory` loads (no slash loop)
- [ ] Smart search title hover yellows whole bar
- [ ] `npm run build` produces HTML in dist/client

## Per-bug detail

### BUG-004 — Legacy root files shadow Astro
- **Status:** fixed (commit pending)
- **Fix:** Moved legacy HTML + dirs + duplicate root statics into `archive/pre-astro/` (not under `public/`, not deployed). Root now only Astro project files + `public/` + `src/`.
- **Moved:** `index.html`, `games.html`, `offline.html`, `404.html`, `hub.html`, `testing.html`, `inventory/`, `newhome/`, `oldhome/`, `old-site/`, `css/`, `js/`, `data/`, `images/`, root `sw.js`, `manifest.json`, `robots.txt`, `sitemap.xml`, favicons, `.htaccess`
- **Commit(s):** _(fill after commit)_
- **Verification:** Root clean; `public/sw.js` remains. Dev/curl verify after restart.

### BUG-011 — Duplicate root sw.js
- **Status:** fixed (same commit as BUG-004)
- **Fix:** Root `sw.js` → `archive/pre-astro/sw.js`; only `public/sw.js` is source of truth.
- **Commit(s):** _(same as BUG-004)_

---
