# Astro Migration Progress

**Branch:** astro-cloudflare-migration
**Worktree:** `/Users/dimitri/Library/Mobile Documents/com~apple~CloudDocs/~/Code/scsfoxchase.tech/.worktrees/astro-cloudflare-migration`
**Plan:** docs/superpowers/plans/2026-07-14-astro-cloudflare-migration.md
**Last updated:** 2026-07-15 (bugfix pass complete)
**Status:** ready for human preview / cutover checklist

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
Bugfix pass complete. Human: restart `npm run dev` in worktree, click-check, then Task 8 cutover when ready. See `BUGFIX-LOG.md`.

## Milestone: BUG-004 legacy unshadow (2026-07-15)
- Legacy root HTML/CSS/JS/data/images + hub/newhome/oldhome/old-site/inventory + root `sw.js` moved to `archive/pre-astro/` (outside `public/`, not deployed)
- Unblocks Astro pages winning in `astro dev` (`/`, `/games`, `/offline`, `/inventory`)
- Task 9 deletion deferred further — archive is safer until human cutover verify; archive may be deleted later

## Milestone: bugfix pass (2026-07-15)
- Inventory flattened; `build.format: 'file'`; trailingSlash loops gone
- Smart-search hover CSS; redirects verified with `Accept: text/html`
- Adapter IMAGES/SESSION warnings silenced; duplicate `_redirects` cleaned
- `npm run build` emits HTML in `dist/client`
- BUG-015: restored games dotted-wave canvas (`dot-waves.ts`) + fixed `game-grid` → `games-grid` for 4-column desktop layout

## Task 9 (deferred)
- **Status:** partially done via archive move (not deleted)
- Legacy is under `archive/pre-astro/` — safe for git history, not served
- After workers.dev or production preview checklist passes, optionally delete `archive/pre-astro/` per plan Task 9 and commit

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
  - Commit: `0d46d75`
  - Notes: `SmartSearch` + `AppLauncher`; `home.css` from `home-mockups.css`; ESM `smart-search.ts`; `bodyClass="home-page"`; home tile/search icons + `background.png` in `public/images/`; global bg URL → `/images/background.png` (no vite warn)
  - Verify: `npm run build` PASS — dist has 3 smart-search forms, 21 app tiles, URLs/labels match `index.html`; home CSS media queries preserved
- [x] Task 4: Games content collection + `/games` page
  - Commit: `06f3f40`
  - Notes: `src/content.config.ts` + 95 game JSON in `src/content/games/` (copied from `data/games/`; legacy `data/games/` kept for Task 9); `src/data/trending.json`; `GamesCatalog.astro` embeds build-time JSON via `#games-catalog-data` (no client `/data/games/*` fetches); `initGamesCatalog(games, trendingIds)`; carousel + placeholder-images ports; `public/_redirects` `/games.html` → `/games`; game thumbnails copied into `public/images/`
  - Verify: `npm run build` PASS — `dist/client/games/index.html`; embedded 95 games + 6 trending IDs; shell has hero-carousel / grade-chips / games-grid; no `/data/games/` in built HTML
- [x] Task 5: Offline, 404, PWA icons, service worker
  - Commit: `c19e565`
  - Notes: `src/pages/offline.astro` + `404.astro` via BaseLayout; `public/sw.js` rewritten (`st-cecilia-tech-astro-v1`, precache `/offline`, network-first navigations, cache-first `/_astro/*`, no cdnjs special-case); real `icon-192.png`/`icon-512.png` from `scs-logo.png`; `/offline.html` → `/offline` redirect; SW register remains BaseLayout-only
  - Verify: `npm run build` PASS — `dist/client/offline/index.html`, `dist/client/404.html`, icons + SW in dist; grep confirms network-first/`/offline`/`/_astro`; preview curl `/offline` (follows 307→`/offline/`) + icons 200
- [x] Task 6: Headers, redirects, Font Awesome drop, sitemap/robots
  - Commit: `6e39079`
  - Notes: Dropped Font Awesome CDN entirely (inline SVGs via `src/scripts/icons.ts` + template SVGs); `public/_headers` sole CSP source (n8n connect-src + camera Permissions-Policy; no cdnjs); deleted `cloudflare-pages.toml` SPA rewrite + root `_headers`; `public/_redirects` for games/newhome/hub/offline; hand `public/sitemap.xml` (`/` + `/games`); `public/robots.txt` host `scsfoxchase.tech`
  - Verify: `npm run build` PASS — dist has `_headers`/`_redirects`/robots/sitemap; no cdnjs/FA in dist HTML; no catch-all SPA rewrite

- [x] Task 7: Inventory page (full Astro port)
  - Commit: `513242c`
  - Notes: `src/pages/inventory/index.astro` + `src/styles/inventory.css` + `src/scripts/inventory.ts`; jsQR at `public/vendor/jsQR.min.js`; device images in `public/images/`; webhook via `PUBLIC_INVENTORY_WEBHOOK` fallback `https://n8n.mlabz.io/webhook/scs-inventory`; FA icons → inline SVG; CSP camera + n8n unchanged; legacy `inventory/` kept for Task 9
  - Verify: `npm run build` PASS — `dist/client/inventory/index.html` + vendor/jsQR + DOM hooks; QR/camera not exercised headlessly

- [x] Task 8 (overnight only): Docs + local build + auth attempt
  - Commit: `3b0fb16`
  - Notes: Rewrote `DEPLOYMENT.md` + `AGENTS.md` for Astro Workers; `wrangler.jsonc` assets → `./dist/client`; confirmed `cloudflare-pages.toml` absent; `npx wrangler whoami` → **not logged in** (token expired) — **no workers.dev preview deploy overnight**; full domain cutover checklist below for human tomorrow
  - Verify: `npm run build` PASS; Worker name remains `scsfoxchase-tech`

## In progress / deferred (manual — human tomorrow)
- [ ] Task 8 Step 1 (live): `npx wrangler deploy` to workers.dev after `wrangler login`
- [ ] Task 8 Step 2: Connect Git → Workers Builds (dashboard)
- [ ] Task 8 Step 3: Domain cutover `scsfoxchase.tech` Pages → Worker
- [ ] Task 8 Step 4: Post-cutover checklist on production

## Human tomorrow — domain cutover checklist

**Do not do these overnight. Production Pages must keep serving until you finish this list.**

### A. Auth + workers.dev preview (CLI)

1. In the worktree:  
   `cd ".../scsfoxchase.tech/.worktrees/astro-cloudflare-migration"`
2. `npx wrangler login` (interactive browser) **or** export a scoped `CLOUDFLARE_API_TOKEN`
3. `npx wrangler whoami` — confirm account
4. `npm run build`
5. `npx wrangler deploy` — deploys Worker **`scsfoxchase-tech`** with assets from **`./dist/client`**
6. Open the printed `*.workers.dev` URL and smoke:
   - [ ] `/` and `/games`
   - [ ] `/games.html` redirects to `/games`
   - [ ] `/offline`, `/inventory`
   - [ ] Theme toggle persists
   - [ ] SW registers; DevTools offline reload shows `/offline`
   - [ ] Response headers include CSP + HSTS (from `public/_headers`)
   - [ ] No SPA catch-all sending unknown routes to home (404 should be 404)

### B. Workers Builds (Git → Cloudflare dashboard)

In [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create** / open Worker:

1. Worker name: **`scsfoxchase-tech`** (must match `wrangler.jsonc`)
2. Connect the GitHub repo
3. Root directory: repo root
4. Build command: **`npm run build`**
5. Deploy command: **`npx wrangler deploy`**
6. Production branch: **`main`**
7. Save; wait for a successful build on a non-production branch or workers.dev first if possible
8. **Do not** attach the custom domain yet

### C. Domain move (accept brief downtime)

1. Keep the **old Pages project running** until the Worker preview passes section A/B.
2. In the Worker `scsfoxchase-tech` → **Custom domains** → add **`scsfoxchase.tech`** (and `www` if used).
3. Remove / detach **`scsfoxchase.tech`** from the **old Pages** project so only the Worker owns the hostname.
4. Wait for DNS + SSL on the Worker custom domain (usually a few minutes).
5. Verify production HTTPS on `https://scsfoxchase.tech` (full post-cutover checklist below).
6. **Only then** disable or delete the old Pages project.

### D. Post-cutover checklist (production)

- [ ] `/` and `/games` load on desktop, iPad landscape, Chromebook height
- [ ] `/games.html` redirects
- [ ] Theme persists
- [ ] SW registers; offline works
- [ ] Headers present (CSP, HSTS)
- [ ] Inventory camera + webhook (if shipped)
- [ ] No accidental SPA fallback of all routes to home

### Deploy path reminder

| Item | Value |
|------|--------|
| Worker name | `scsfoxchase-tech` |
| Build | `npm run build` |
| Deploy | `npx wrangler deploy` |
| Assets | `./dist/client` (not `/`, not `./dist`) |
| Docs | `DEPLOYMENT.md`, this file |

## Blockers / risks
- Task 7: QR/camera + live n8n lookup not exercised headlessly — needs human browser pass with camera permission
- Legacy `inventory/` + `js/inventory.js` still present until Task 9
- Cloudflare dashboard domain cutover requires human tomorrow
- **Wrangler auth expired overnight** — `whoami` failed; no workers.dev URL yet. Human must `wrangler login` then deploy.
- Adapter emits `dist/client/` — root `wrangler.jsonc` now points assets there
- No interactive browser viewport smoke for games filters/carousel (build + HTML/JS embed parity only)
- iCloud Drive under worktree can briefly desync `public/images` / `src` — re-copy if assets vanish mid-session
- Legacy `data/games/` + `games.html` still present until Task 9 (Astro does not depend on them)
- Task 5: `astro preview` redirects `/offline`→`/offline/` (307); SW uses fetch+put under `/offline` key. Confirm Workers Assets serves `/offline` without redirect after workers.dev deploy. Full DevTools offline toggle still needs human pass.
- Task 6: Astro config redirects + `public/_redirects` both emit rules (duplicate lines in dist `_redirects` — harmless). Root legacy `robots.txt`/`sitemap.xml` still exist until Task 9 cleanup.

## Verification log
- 2026-07-15T02:09:18Z — Final overnight checkpoint: npm run build PASS (5 pages). Task 9 deferred. Status ready for cutover.
- 2026-07-15T02:06:59Z — Task 8 overnight: `npm run build` PASS; `wrangler deploy --dry-run` PASS (169 assets from `dist/client`, Worker `scsfoxchase-tech`); `wrangler whoami` FAIL (auth expired) — no workers.dev deploy. Docs rewritten; `cloudflare-pages.toml` confirmed absent.
- 2026-07-15T02:03:37Z — Task 7 `npm run build` Pass (full permissions). `dist/client/inventory/index.html` has DOM hooks + jsQR + inventory module; CSP camera=(self) + n8n.mlabz.io; device images + fallback in dist.
- 2026-07-15T01:58:52Z — Checkpoint Tasks 4–6: build PASS; /games embed; offline/404; SW /offline; FA CDN removed; public/_headers; cloudflare-pages.toml removed. Pass.
- 2026-07-15T01:57:32Z — Task 6 `npm run build` Pass (full permissions). `dist/client/_headers` CSP without cdnjs, camera + n8n preserved; `_redirects` has games/newhome/hub/offline; robots/sitemap host `scsfoxchase.tech`; no FA/cdnjs in dist HTML; `cloudflare-pages.toml` deleted.
- 2026-07-15T01:52:35Z — Task 5 `npm run build` Pass (full permissions). `dist/client/offline/index.html` + `404.html`; SW `OFFLINE_PAGE=/offline` + `/_astro` cache-first; icons 192/512 present; preview curl smoke for `/offline` + icons.
- 2026-07-15T01:46:58Z — Task 4 `npm run build` Pass (full permissions). `dist/client/games/index.html` embeds 95 games + trending; carousel/filter shell present; no `/data/games/` fetch path in HTML.
- 2026-07-15T01:43:33Z — Checkpoint Tasks 1–3: npm run build PASS; dist home has SmartSearch + AppLauncher + BaseLayout. Pass.
- 2026-07-15T01:30:00Z — Isolation check / worktree create. Pass.
- 2026-07-15T01:32:19Z — Task 1 `npm run build` Pass (full permissions). Stub HTML in `dist/client/index.html`.
- 2026-07-15T01:34:14Z — Task 2 `npm run build` Pass (full permissions). `dist/client/index.html` includes header, footer, theme bootstrap, theme-toggle module, SW register `/sw.js` `{ updateViaCache: 'none' }`, favicons + manifest from `public/`.
- 2026-07-15T01:41:15Z — Task 3 `npm run build` Pass (full permissions). Home SmartSearch + AppLauncher in `dist/client/index.html`; 0 missing external hrefs vs legacy; home CSS classes in `_astro/*.css`; no background.png unresolved warn.

## File map status
| Path | Status |
|------|--------|
| package.json | present |
| astro.config.mjs | present (redirects: games.html, newhome, hub.html, offline.html) |
| wrangler.jsonc | present |
| cloudflare-pages.toml | deleted (SPA rewrite removed) |
| public/_headers | present (sole headers source; n8n + camera; max-age≤3600, no immutable) |
| public/_redirects | present (games/newhome/hub/offline) |
| public/robots.txt | present (`scsfoxchase.tech`) |
| public/sitemap.xml | present (`/` + `/games` only) |
| src/content.config.ts | present (games collection) |
| src/content/games/*.json | present (95 games; copied from data/games) |
| src/data/trending.json | present |
| src/pages/index.astro | full home (SmartSearch + AppLauncher) |
| src/pages/games.astro | present (`bodyClass="games-page"`) |
| src/pages/offline.astro | present (canonical `/offline`) |
| src/pages/404.astro | present |
| src/pages/inventory/index.astro | present (staff inventory lookup + QR) |
| src/styles/inventory.css | present |
| src/scripts/inventory.ts | present (ESM; PUBLIC_INVENTORY_WEBHOOK fallback) |
| public/vendor/jsQR.min.js | present |
| src/layouts/BaseLayout.astro | present (no FA CDN; sole SW registration) |
| src/components/Header.astro | present |
| src/components/Footer.astro | present |
| src/components/SmartSearch.astro | present (SVG chevrons) |
| src/components/AppLauncher.astro | present |
| src/components/GamesCatalog.astro | present (SVG carousel/search icons) |
| src/styles/global.css | present (bg → `/images/background.png`) |
| src/styles/home.css | present (from home-mockups.css) |
| src/styles/carousel.css | present |
| src/scripts/theme-toggle.ts | present (inline SVG sun/moon) |
| src/scripts/icons.ts | present (shared SVG helpers) |
| src/scripts/smart-search.ts | present |
| src/scripts/games-catalog.ts | present (`initGamesCatalog`) |
| src/scripts/carousel.ts | present |
| src/scripts/placeholder-images.ts | present (image fallbacks only) |
| public/manifest.json, sw.js, favicons, images/* (home + game thumbs + icon-192/512) | present |
| Legacy HTML / data/games | still present (expected until Task 9) |
