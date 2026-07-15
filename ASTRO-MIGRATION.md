# Astro Migration Progress

**Branch:** astro-cloudflare-migration
**Worktree:** `/Users/dimitri/Library/Mobile Documents/com~apple~CloudDocs/~/Code/scsfoxchase.tech/.worktrees/astro-cloudflare-migration`
**Plan:** docs/superpowers/plans/2026-07-14-astro-cloudflare-migration.md
**Last updated:** 2026-07-15T01:34:30Z
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
Task 3: Home page parity (`/`)

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

## In progress
- Task 3

## Blockers / risks
- Cloudflare dashboard domain cutover requires human tomorrow
- Wrangler deploy needs CF credentials (attempt dry-run in Task 8)
- Adapter emits `dist/client/` (not flat `dist/`) — follow generated wrangler on deploy
- CSS still references `/images/background.png` (full image migration not in Task 2) — vite warn at build; harmless until assets land in `public/images/`
- Font Awesome still via CDN (Task 6 may drop/self-host)

## Verification log
- 2026-07-15T01:30:00Z — Isolation check / worktree create. Pass.
- 2026-07-15T01:32:19Z — Task 1 `npm run build` Pass (full permissions). Stub HTML in `dist/client/index.html`.
- 2026-07-15T01:34:14Z — Task 2 `npm run build` Pass (full permissions). `dist/client/index.html` includes header, footer, theme bootstrap, theme-toggle module, SW register `/sw.js` `{ updateViaCache: 'none' }`, favicons + manifest from `public/`.

## File map status
| Path | Status |
|------|--------|
| package.json | present |
| astro.config.mjs | present |
| wrangler.jsonc | present |
| src/pages/index.astro | uses BaseLayout (stub content) |
| src/layouts/BaseLayout.astro | present |
| src/components/Header.astro | present |
| src/components/Footer.astro | present |
| src/styles/global.css | present |
| src/scripts/theme-toggle.ts | present |
| public/manifest.json, sw.js, favicons, images/scs-logo.png | present (minimal) |
| Legacy HTML | still present (expected until Task 9) |
