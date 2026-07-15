# Task 3 Report — Home page parity (`/`)

**Status:** DONE_WITH_CONCERNS  
**Branch:** `astro-cloudflare-migration`  
**Worktree:** `.worktrees/astro-cloudflare-migration`  
**Date:** 2026-07-15T01:42:00Z

## Task
Port homepage SmartSearch + AppLauncher into Astro for parity with `index.html`.

## Changes
| File | Reason |
|------|--------|
| `src/styles/home.css` | Copied from `css/home-mockups.css`; media queries intact |
| `src/scripts/smart-search.ts` | ESM port of `js/smart-search.js` (picker + submit) |
| `src/components/SmartSearch.astro` | Same `data-smart-search` markup as legacy home; imports script |
| `src/components/AppLauncher.astro` | Same G-Suite / Sites tile grid (URLs, labels, icons) |
| `src/pages/index.astro` | Full home via `BaseLayout` `bodyClass="home-page"` + components + `home.css` |
| `src/styles/global.css` | `background-image` → `url('/images/background.png')` so public asset resolves (clears vite warn) |
| `public/images/*` | Home icons + `background.png` (+ existing logo) for build/runtime |
| `docs/superpowers/plans/2026-07-14-astro-cloudflare-migration.md` | Task 3 steps checked off |
| `ASTRO-MIGRATION.md` | Current→Task 4; Task 3 completed + verification log |

## Commits
- `0d46d75` — Port homepage SmartSearch and AppLauncher into Astro for parity.

## Validation
- `npm run build` → **PASS** (full permissions)
  - `1 page(s) built`; `dist/client/index.html` present
  - 3 smart-search forms; titles G-Suite / Google / Sites
  - 21 mockup-link tiles; external hrefs + `data-url` / `data-label` match `index.html` (0 missing)
  - Bundled smart-search + theme-toggle modules present
  - Home CSS classes + `max-width: 1100px` / `max-height: 800px` rules in source; home styles in `dist/client/_astro/*.css`
  - No unresolved `background.png` vite warning

## Impact checked
- `BaseLayout` still sole page shell; home content is slot sections (no nested `<main>`)
- Legacy `index.html` / `css/home-mockups.css` / `js/smart-search.js` unchanged
- Games page still Task 4

## Self-review
- [x] Parity-first; no redesign
- [x] Same search URLs/labels/icons as `index.html`
- [x] Same app tile URLs/labels/icons
- [x] Theme/SW not duplicated (layout owns them)
- [x] Home CSS media queries preserved
- [x] Build green
- [ ] Interactive picker/tile/theme/viewport click-test in browser — **not run**

## Residual risks / concerns
1. **No browser smoke** — picker open/position, submit navigation, theme persistence, and Chromebook/iPad fit inferred from markup/CSS only.
2. **iCloud worktree desync** — mid-task `public/images` and some `src` files briefly vanished under sandbox/iCloud; restored before build. Watch for missing assets if another agent runs without `all` permissions.
3. **Build notes leftover redirects** — Astro logs empty responses for `/games.html/` and `/newhome/` during static generation (pre-existing redirect config; not home regression).
4. **Font Awesome CDN** — still required for chevrons / theme icons (Task 6).
5. **Ledger SHA** — Task 3 commit SHA recorded in follow-up if amend blocked (same pattern as Task 2).

## Out of scope (intentionally not done)
- Games catalog / content collections (Task 4)
- Full `public/images` game asset migration
- SW rewrite / offline (Task 5)
- hub/oldhome/newhome/testing migration

## Handoff
Ready for Task 4. Home is `src/pages/index.astro` with `bodyClass="home-page"`.
