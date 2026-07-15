# Astro Migration Progress

**Branch:** astro-cloudflare-migration
**Worktree:** `/Users/dimitri/Library/Mobile Documents/com~apple~CloudDocs/~/Code/scsfoxchase.tech/.worktrees/astro-cloudflare-migration`
**Plan:** docs/superpowers/plans/2026-07-14-astro-cloudflare-migration.md
**Last updated:** 2026-07-15T01:32:19Z
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
Task 2: Base layout, global styles, Header/Footer

## Completed
- [x] Step 0: Worktree created (base: `bacc732` gitignore)
- [x] Task 1: Scaffold Astro + Cloudflare adapter
  - Commit: (pending this commit)
  - Notes: `output: static` + `@astrojs/cloudflare`; Worker name `scsfoxchase-tech`; stub at `src/pages/index.astro`; dropped duplicate `/newhome/` redirect to avoid Astro collision (kept `/newhome` → `/`; `/newhome/` covered later via `public/_redirects`)
  - Verify: `npm run build` PASS — `dist/client/index.html` contains stub

## In progress
- Task 2

## Blockers / risks
- Cloudflare dashboard domain cutover requires human tomorrow
- Wrangler deploy needs CF credentials (attempt dry-run in Task 8)
- Adapter emits `dist/client/` (not flat `dist/`) — follow generated wrangler on deploy

## Verification log
- 2026-07-15T01:30:00Z — Isolation check / worktree create. Pass.
- 2026-07-15T01:32:19Z — Task 1 `npm run build` Pass (full permissions). Stub HTML in `dist/client/index.html`.

## File map status
| Path | Status |
|------|--------|
| package.json | present |
| astro.config.mjs | present |
| wrangler.jsonc | present |
| src/pages/index.astro | stub |
| src/layouts/BaseLayout.astro | missing (Task 2) |
| Legacy HTML | still present (expected until Task 9) |
