# Astro Migration Progress

**Branch:** astro-cloudflare-migration
**Worktree:** `/Users/dimitri/Library/Mobile Documents/com~apple~CloudDocs/~/Code/scsfoxchase.tech/.worktrees/astro-cloudflare-migration`
**Plan:** docs/superpowers/plans/2026-07-14-astro-cloudflare-migration.md
**Last updated:** 2026-07-15T01:42:00Z
**Status:** in progress

## Decisions (locked)
- Offline URL: `/offline` (canonical; not offline.html)
- Inventory: include full Astro port in this migration (Task 7)
- Commits: YES after each completed task (human approved overnight autonomous execution of plan commit steps)
- Do not push to remote unless build+parity look solid AND you document it; prefer commits only, no push unless necessary for Cloudflare. Default: commits only, no push.
- Do not redesign — parity first
- Do not migrate hub.html, oldhome/, newhome/, testing.html, old-site/
- Task 8 production DNS/Pages cutover: document exact steps; do NOT flip production unless safe dry-run preview only
- Task 9 legacy deletion: safer keep until Task 8 preview verified; if no production cutover, may remove legacy once Astro is only served surface in `dist/` — document clearly
- Subagent model: `cursor-grok-4.5-high` (fallback `composer-2.5`)

## Current task
Task 4: Games content collection + `/games` page

## Completed
- [x] Step 0: Worktree created (base: `bacc732` gitignore)
- [x] Task 1: Scaffold Astro + Cloudflare adapter
  - Commit: `f38b97a`
  - Notes: `output: static` + `@astrojs/cloudflare`; Worker name `scsfoxchase-tech`; stub at `src/pages/index.astro`; dropped duplicate `/newhome/` redirect to avoid Astro collision (kept `/newhome` → `/`; `/newhome/` covered later via `public/_redirects`)
  - Verify: `npm run build` PASS — `dist/client/index.html` contains stub
- [x] Task 2: Base layout, global styles, Header/Footer
  - Commit: `4959632`
  - Notes: `BaseLayout` + `Header`/`Footer`; `global.css` from `css/styles.css`; ESM `theme-toggle.ts`; minimal `public/` (manifest, sw.js, favicons, logo); Games nav → `/games`; FOUC-prevention inline theme script; SW register once in layout
  - Verify: `npm run build` PASS — `dist/client/index.html` has header/footer/theme/SW; brand tokens `#125F31`/`#F6D724` present in `src/styles/global.css`
- [x] Task 3: Home page parity (`/`)
  - Commit: *(pending — filled after commit)*
  - Notes: `SmartSearch` + `AppLauncher`; `home.css` from `home-mockups.css`; ESM `smart-search.ts`; `bodyClass="home-page"`; home tile/search icons + `background.png` in `public/images/`; global bg URL → `/images/background.png` (no vite warn)
  - Verify: `npm run build` PASS — dist has 3 smart-search forms, 21 app tiles, URLs/labels match `index.html`; home CSS media queries preserved

## In progress
- Task 4

## Blockers / risks
- Cloudflare dashboard domain cutover requires human tomorrow
- Wrangler deploy needs CF credentials (attempt dry-run in Task 8)
- Adapter emits `dist/client/` (not flat `dist/`) — follow generated wrangler on deploy
- Font Awesome still via CDN (Task 6 may drop/self-host)
- No interactive browser viewport smoke for home (build + HTML/CSS parity only)
- iCloud Drive under worktree can briefly desync `public/images` / `src` — re-copy if assets vanish mid-session

## Verification log
- 2026-07-15T01:30:00Z — Isolation check / worktree create. Pass.
- 2026-07-15T01:32:19Z — Task 1 `npm run build` Pass (full permissions). Stub HTML in `dist/client/index.html`.
- 2026-07-15T01:34:14Z — Task 2 `npm run build` Pass (full permissions). `dist/client/index.html` includes header, footer, theme bootstrap, theme-toggle module, SW register `/sw.js` `{ updateViaCache: 'none' }`, favicons + manifest from `public/`.
- 2026-07-15T01:41:15Z — Task 3 `npm run build` Pass (full permissions). Home SmartSearch + AppLauncher in `dist/client/index.html`; 0 missing external hrefs vs legacy; home CSS classes in `_astro/*.css`; no background.png unresolved warn.

## File map status
| Path | Status |
|------|--------|
| package.json | present |
| astro.config.mjs | present |
| wrangler.jsonc | present |
| src/pages/index.astro | full home (SmartSearch + AppLauncher) |
| src/layouts/BaseLayout.astro | present |
| src/components/Header.astro | present |
| src/components/Footer.astro | present |
| src/components/SmartSearch.astro | present |
| src/components/AppLauncher.astro | present |
| src/styles/global.css | present (bg → `/images/background.png`) |
| src/styles/home.css | present (from home-mockups.css) |
| src/scripts/theme-toggle.ts | present |
| src/scripts/smart-search.ts | present |
| public/manifest.json, sw.js, favicons, images/* (home set) | present |
| Legacy HTML | still present (expected until Task 9) |
