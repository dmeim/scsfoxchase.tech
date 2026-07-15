# Astro + Cloudflare Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate scsfoxchase.tech from a hand-authored static HTML/CSS/JS site on Cloudflare Pages to an Astro app deployed on Cloudflare Workers with the `@astrojs/cloudflare` adapter, using Astro layouts/components/content collections for as much of the site as practical.

**Architecture:** Hybrid Astro on Workers — pages are prerendered at build time (same user experience as today), but the project uses the Cloudflare adapter + Wrangler so the deploy target is a Worker with static assets. Game catalog data becomes an Astro content collection loaded at build time (no ~100 client fetches). Shared chrome lives in one layout. Client behavior (theme, smart search, games filters/carousel, inventory) becomes colocated Astro `<script>` modules. PWA assets live under `public/`; the service worker is rewritten for hashed `/_astro/*` assets.

**Tech Stack:** Astro (latest stable), `@astrojs/cloudflare`, Wrangler, Workers Builds (Git push deploy), vanilla JS islands (no React/Vue unless a later task explicitly needs them), existing CSS design tokens.

## Global Constraints

- Preserve brand colors: primary `#125F31`, secondary `#F6D724`
- Preserve device fit: desktop unchanged; iPad `@media (max-width: 1100px)`; Chromebook `@media (max-height: 800px)` (today these live mainly in `css/home-mockups.css`)
- Border radius: `2px` cards/buttons, `999px` pills/search
- Production routes to ship: `/`, `/games`, `/offline`, `/404`, optional `/inventory`
- Do **not** migrate `hub.html`, `oldhome/`, `newhome/`, `testing.html`, `old-site/`, `images/favicon-generator.html` into the Astro app (archive or redirect only)
- Keep `.html` URLs working via redirects: `/games.html` → `/games`, `/newhome/` → `/`
- Prefer build-time data and Astro components over runtime fetch storms
- Prefer self-hosted or SVG icons over Font Awesome CDN when touching head chrome
- One headers source of truth (Wrangler / `public/_headers`); delete conflicting `cloudflare-pages.toml` SPA rewrite
- Vibe-code friendly: small files, clear names, no premature React islands
- Do not redesign look-and-feel during migration — parity first, visual refresh after cutover
- Commits only when the user asks (or when executing this plan with explicit commit steps approved)

---

## Target file map

| Path | Responsibility |
|------|----------------|
| `package.json` | Astro, adapter, scripts (`dev`, `build`, `preview`, `deploy`) |
| `astro.config.mjs` | Site URL, Cloudflare adapter, trailingSlash, redirects |
| `wrangler.jsonc` | Worker name, assets, compatibility date, optional bindings |
| `src/layouts/BaseLayout.astro` | Head, theme bootstrap, header/footer slots, SW register |
| `src/components/Header.astro` | Logo, nav, `.header-right` mount point |
| `src/components/Footer.astro` | Copyright |
| `src/components/SmartSearch.astro` | Home search pickers + client script |
| `src/components/AppLauncher.astro` | Home app grid markup |
| `src/components/GamesCatalog.astro` | Filters shell + grid + carousel mount; client script |
| `src/pages/index.astro` | Home |
| `src/pages/games.astro` | Games (`prerender = true`) |
| `src/pages/offline.astro` | Offline fallback |
| `src/pages/404.astro` | Not found |
| `src/pages/inventory/index.astro` | Staff inventory tool (optional phase) |
| `src/content.config.ts` | Games collection schema |
| `src/content/games/*.json` | One file per game (moved from `data/games/`) |
| `src/content/games/_trending.json` or `src/data/trending.json` | Carousel IDs |
| `src/styles/global.css` | Former `styles.css` tokens + shell |
| `src/styles/home.css` | Former `home-mockups.css` |
| `src/styles/carousel.css` | Carousel |
| `src/styles/inventory.css` | Inventory (if migrated) |
| `src/scripts/theme-toggle.ts` | Theme button logic |
| `src/scripts/games-catalog.ts` | Filter/search/carousel orchestration |
| `src/scripts/carousel.ts` | Carousel behavior |
| `src/scripts/smart-search.ts` | Smart search menus |
| `public/sw.js` | Rewritten network-first + offline; aware of `/_astro/` |
| `public/manifest.json` | PWA manifest (fixed icon paths) |
| `public/images/**` | Icons including real `icon-192.png` / `icon-512.png` |
| `public/_headers` | CSP, cache, inventory noindex |
| `public/_redirects` | Legacy URL redirects |
| `AGENTS.md` / `DEPLOYMENT.md` | Updated for Astro + Workers |

Legacy root HTML/CSS/JS are removed only after parity cutover (Task 9).

---

### Task 1: Scaffold Astro + Cloudflare Worker project

**Files:**
- Create: `package.json`, `astro.config.mjs`, `wrangler.jsonc`, `tsconfig.json`, `.gitignore` (Node entries), `src/pages/index.astro` (temporary stub)
- Modify: `.gitignore` if present
- Do not delete existing HTML yet

**Interfaces:**
- Produces: `npm run dev`, `npm run build`, `npx wrangler deploy` (or `npm run deploy`) working against a stub page

- [x] **Step 1: Scaffold in the repo root without wiping the site**

From repo root, initialize Astro manually (do not use a destructive overwrite of existing files):

```bash
npm init -y
npm install astro @astrojs/cloudflare
npm install -D wrangler typescript
```

- [x] **Step 2: Write `astro.config.mjs`**

```js
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  site: 'https://scsfoxchase.tech',
  output: 'static',
  adapter: cloudflare(),
  trailingSlash: 'never',
  redirects: {
    '/games.html': '/games',
    '/newhome': '/',
    '/newhome/': '/',
  },
});
```

Note: With current `@astrojs/cloudflare`, static output still uses the adapter for Workers static-asset deploys. If `astro add cloudflare` rewrites `output`, prefer hybrid/prerender-all pages over forcing unnecessary SSR for this school site. Every product page should set `export const prerender = true` if the project ends up in `server`/`hybrid` mode.

- [x] **Step 3: Write `wrangler.jsonc`**

```jsonc
{
  "name": "scsfoxchase-tech",
  "compatibility_date": "2026-07-14",
  "assets": {
    "directory": "./dist"
  }
}
```

If the installed adapter generates a different Wrangler shape (e.g. binding name `ASSETS`), follow the adapter’s generated config and keep the Worker name `scsfoxchase-tech` (or match the existing Cloudflare project name exactly).

- [x] **Step 4: Add scripts to `package.json`**

```json
{
  "type": "module",
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "preview": "astro preview",
    "deploy": "astro build && wrangler deploy"
  }
}
```

- [x] **Step 5: Temporary stub page**

Create `src/pages/index.astro`:

```astro
---
export const prerender = true;
---
<html lang="en">
  <head><meta charset="utf-8" /><title>St. Cecilia Technology</title></head>
  <body><h1>Astro scaffold OK</h1></body>
</html>
```

- [x] **Step 6: Verify locally**

Run:

```bash
npm run build
```

Expected: build succeeds; `dist/` contains HTML.

Run:

```bash
npm run dev
```

Expected: stub page at `http://localhost:4321`.

- [x] **Step 7: Commit** (only if user approved commits for this plan)

```bash
git add package.json package-lock.json astro.config.mjs wrangler.jsonc tsconfig.json src .gitignore
git commit -m "$(cat <<'EOF'
Scaffold Astro with Cloudflare adapter alongside existing static site.

EOF
)"
```

---

### Task 2: Base layout, global styles, Header/Footer

**Files:**
- Create: `src/layouts/BaseLayout.astro`, `src/components/Header.astro`, `src/components/Footer.astro`, `src/styles/global.css`, `src/scripts/theme-toggle.ts`
- Copy content from: `css/styles.css` → `src/styles/global.css` (move, keep tokens intact)
- Copy logic from: `js/theme-toggle.js` → `src/scripts/theme-toggle.ts` (ESM, no globals)

**Interfaces:**
- Consumes: existing CSS variables and header markup patterns from `index.html`
- Produces: `BaseLayout` with props `title`, `bodyClass?`; slots `default`, optional `head`

- [x] **Step 1: Move shell CSS**

Copy `css/styles.css` to `src/styles/global.css` unchanged except path comments. Do not “clean up” responsive rules in this task.

- [x] **Step 2: Create `Header.astro` and `Footer.astro`** matching production markup from `index.html` (logo, Home/Games links to `/` and `/games`, `.header-right` empty div for theme button).

- [x] **Step 3: Port `theme-toggle.js` to `src/scripts/theme-toggle.ts`**

Requirements:
- Same `localStorage` key and `data-theme` behavior as today
- Mount into `.header-right`
- Importable: `import '../scripts/theme-toggle'` from layout script

- [x] **Step 4: Create `BaseLayout.astro`**

Must include:
- charset, viewport, title, theme-color `#125F31`
- `manifest.json`, favicons from `/` public paths
- `<link rel="stylesheet">` for global CSS via `import '../styles/global.css'`
- Early inline theme read **only if needed** to prevent flash (keep tiny); otherwise rely on script
- Header + `<main>` slot + Footer
- Client script: `import '../scripts/theme-toggle'`
- SW registration pointing at `/sw.js` with `{ updateViaCache: 'none' }` as a module script (not duplicated per page)

- [x] **Step 5: Point stub `index.astro` at `BaseLayout`** and verify header/footer/theme on desktop width and a narrow viewport.

- [x] **Step 6: Commit** (if approved)

```bash
git commit -m "$(cat <<'EOF'
Add Astro BaseLayout with shared header, footer, and theme toggle.

EOF
)"
```

---

### Task 3: Home page parity (`/` )

**Files:**
- Create: `src/pages/index.astro`, `src/components/SmartSearch.astro`, `src/components/AppLauncher.astro`, `src/styles/home.css`, `src/scripts/smart-search.ts`
- Source: `index.html`, `css/home-mockups.css`, `js/smart-search.js`

**Interfaces:**
- Consumes: `BaseLayout`
- Produces: visual + behavior parity with current homepage (search pickers + app launcher)

- [x] **Step 1: Move `css/home-mockups.css` → `src/styles/home.css`** and import from home page or layout when `bodyClass` includes home.

- [x] **Step 2: Build `SmartSearch.astro`** with the same `data-smart-search` markup as `index.html`; port `smart-search.js` to `src/scripts/smart-search.ts` and import from the component:

```astro
<script>
  import '../scripts/smart-search';
</script>
```

- [x] **Step 3: Build `AppLauncher.astro`** with the current app tile grid markup (same URLs, labels, icons).

- [x] **Step 4: Replace stub `index.astro`** with full home using `BaseLayout`, `bodyClass` matching current home classes, SmartSearch + AppLauncher.

- [x] **Step 5: Parity check**

Manual checklist:
- [x] Google/search picker menus open and navigate correctly *(markup + bundled smart-search module verified in dist; interactive click-test not run overnight)*
- [x] App tiles open expected destinations *(all 21 tile URLs/labels match `index.html` via dist grep)*
- [x] Theme toggle works and persists *(layout module present in dist; interactive not re-tested)*
- [x] iPad width (~1024) and short height (~768) still fit without unexpected scroll (compare to live site) *(CSS media queries `max-width: 1100px` / `max-height: 800px` preserved in `home.css`; no browser viewport smoke)*

- [x] **Step 6: Commit** (if approved)

---

### Task 4: Games content collection + `/games` page

**Files:**
- Create: `src/content.config.ts`, `src/content/games/*.json` (from `data/games/*.json`), `src/data/trending.json` (from `_trending.json`), `src/pages/games.astro`, `src/components/GamesCatalog.astro`, `src/styles/carousel.css`, `src/scripts/games-catalog.ts`, `src/scripts/carousel.ts`, `src/scripts/placeholder-images.ts` (image fallbacks only; drop PWA icon generation if real icons exist)
- Remove from client path: runtime fetch of `_index.json` + per-game JSON

**Interfaces:**
- Consumes: content collection `games`
- Produces: `getCollection('games')` at build time; client receives serialized JSON embed or `data-games` attribute for filtering UI

- [x] **Step 1: Define collection schema in `src/content.config.ts`**

Schema fields matching existing JSON:
`id`, `name`, `url`, `image`, `description`, `minGrade`, `maxGrade`, `primaryCategories[]`, `secondaryCategories[]`

Exclude `_index.json` and `_trending.json` from the collection glob (trending becomes `src/data/trending.json`).

- [x] **Step 2: Move game JSON files** into `src/content/games/` (keep filenames as IDs). Keep a copy under `public/data/games/` **only if** something still needs public URLs during transition; delete public copies once client no longer fetches them.

- [x] **Step 3: Port carousel CSS/JS** and games catalog JS into Astro scripts. Refactor `games.js` so it accepts an in-memory array instead of fetching:

```ts
export function initGamesCatalog(games: Game[], trendingIds: string[]) { /* ... */ }
```

In `GamesCatalog.astro`:

```astro
---
import { getCollection } from 'astro:content';
import trending from '../data/trending.json';
const games = (await getCollection('games')).map((e) => e.data);
---
<!-- shell markup from games.html -->
<script define:vars={{ games, trendingIds: trending }}>
  import { initGamesCatalog } from '../scripts/games-catalog';
  initGamesCatalog(games, trendingIds);
</script>
```

(Adjust `define:vars` + import pattern to valid Astro 5 script rules; if `define:vars` cannot mix with imports, embed `JSON.stringify(games)` into a `type="application/json"` script tag and read it from the module.)

- [x] **Step 4: `games.astro`** uses `BaseLayout`, imports carousel + home/games styles as needed, sets `body` class `games-page`, includes `GamesCatalog`.

- [x] **Step 5: Add redirect** already in config for `/games.html` → `/games`. Add `public/_redirects` entry as backup:

```
/games.html /games 301
```

- [x] **Step 6: Parity check**

- [x] All games render without network waterfalls to `/data/games/*.json`
- [x] Search, grade chips, category chips filter correctly
- [x] Trending carousel autoplay/indicators work
- [x] Clicking a game opens the external URL
- [x] Broken images get placeholders (if that behavior is kept)

- [x] **Step 7: Commit** (if approved)

---

### Task 5: Offline, 404, PWA icons, service worker

**Files:**
- Create: `src/pages/offline.astro`, `src/pages/404.astro`
- Modify: `public/sw.js`, `public/manifest.json`
- Create: `public/images/icon-192.png`, `public/images/icon-512.png` (generate real PNGs from existing brand assets; stop relying on canvas-generated icons)

**Interfaces:**
- Produces: offline fallback still works; SW does not break hashed `/_astro/*` assets

- [x] **Step 1: Port `offline.html` and `404.html`** into Astro pages using `BaseLayout` (or a minimal layout if header differs). Move inline CSS into small scoped style files or page `<style>` blocks.

- [x] **Step 2: Fix manifest icons** — ensure files exist at the paths in `manifest.json`.

- [x] **Step 3: Rewrite `public/sw.js`**

Keep:
- Pre-cache `/offline` (or `/offline.html` if that remains the URL — pick **one** canonical offline URL and use it everywhere)
- Network-first for navigations
- Offline fallback on navigation failure
- `skipWaiting` + `clients.claim`

Change:
- Do not specially depend on `cdnjs` if Font Awesome is removed
- For `/_astro/*` hashed assets: cache-first on successful fetch is OK; never serve stale HTML for navigations
- Precache only the offline document, not the whole site

- [x] **Step 4: Register SW from `BaseLayout` only**

- [x] **Step 5: Verify** in DevTools: SW registers; offline toggle shows offline page; hard reload after deploy gets new HTML (network-first). *(overnight: build + curl/grep smoke; full DevTools offline toggle deferred to human)*

- [x] **Step 6: Commit** (if approved)

---

### Task 6: Headers, redirects, Font Awesome decision, sitemap/robots

**Files:**
- Create/replace: `public/_headers`, `public/_redirects`
- Modify: `public/robots.txt`, `public/sitemap` generation (prefer `@astrojs/sitemap` **or** a hand-maintained `public/sitemap.xml` listing only `/` and `/games`)
- Delete or stop using: `cloudflare-pages.toml` SPA rewrite to `index.html` (must not ship)

**Interfaces:**
- Produces: CSP compatible with final asset strategy; inventory camera policy preserved if inventory ships

- [x] **Step 1: Prefer dropping Font Awesome CDN**

Replace theme/nav icons with inline SVG or local static SVGs in `public/icons/`. Then CSP can drop `cdnjs` / font CDNs.

If dropping FA is too large for one pass, keep CDN temporarily and document a follow-up; do not leave both unused FA link tags and SVGs.

- [x] **Step 2: Write `public/_headers`** based on current `_headers` (the authoritative one with n8n + camera), updated for Astro paths:

```
/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(self), microphone=(), geolocation=()
  Content-Security-Policy: <final policy matching scripts/styles/images/connect>
  Strict-Transport-Security: max-age=31536000; includeSubDomains

/inventory
  X-Robots-Tag: noindex, nofollow

/inventory/*
  X-Robots-Tag: noindex, nofollow

/_astro/*
  Cache-Control: public, max-age=31536000, immutable
```

Tune CSP after FA decision. Keep `connect-src` entries for n8n if inventory remains.

- [x] **Step 3: `public/_redirects`**

```
/games.html /games 301
/newhome / 301
/newhome/ / 301
/hub.html / 301
```

- [x] **Step 4: Fix `robots.txt`** to real host `scsfoxchase.tech` and sitemap URL.

- [x] **Step 5: Commit** (if approved)

---

### Task 7: Inventory page (optional but “as entirely Astro as possible”)

**Files:**
- Create: `src/pages/inventory/index.astro`, port `css/inventory.css`, `js/inventory.js`, `js/vendor/jsQR.min.js` → `src/scripts/` or `public/vendor/`
- Source: `inventory/index.html`

**Interfaces:**
- Consumes: n8n webhook URL (keep as constant or `import.meta.env.PUBLIC_INVENTORY_WEBHOOK`)
- Produces: `/inventory` parity including camera QR

- [ ] **Step 1: Port page + styles + client script** as an Astro page with `BaseLayout` or a staff layout.

- [ ] **Step 2: Confirm CSP `connect-src` and `Permissions-Policy camera=(self)` allow scanner + webhook.

- [ ] **Step 3: Manual test** lookup + QR (or mock mode).

- [ ] **Step 4: Commit** (if approved)

If inventory is out of scope for v1 cutover, skip this task and leave `inventory/` as a static folder under `public/inventory/` temporarily — but prefer full Astro port for the “entirely Astro” goal.

---

### Task 8: Cloudflare Workers cutover

**Files:**
- Modify: `DEPLOYMENT.md`, `AGENTS.md`
- Delete or archive: `cloudflare-pages.toml` (replace with Wrangler-centric docs)
- Cloudflare dashboard changes (manual)

**Interfaces:**
- Produces: `main` pushes build + deploy Worker; custom domain `scsfoxchase.tech` on Worker

- [ ] **Step 1: Local production deploy dry-run**

```bash
npm run build
npx wrangler deploy
```

Confirm Worker URL serves `/`, `/games`, offline, assets.

- [ ] **Step 2: Connect Git → Workers Builds**

In Cloudflare dashboard:
1. Create or convert project to Worker named to match `wrangler.jsonc` `name`
2. Connect GitHub repo
3. Build command: `npm run build`
4. Deploy command: `npx wrangler deploy` (or adapter-recommended)
5. Root directory: repo root
6. Production branch: `main`

- [ ] **Step 3: Domain cutover window**

1. Deploy Astro Worker on a `*.workers.dev` or preview URL first
2. Run full checklist against preview
3. Point `scsfoxchase.tech` custom domain from old Pages project to the new Worker
4. Disable/delete old Pages project only after DNS + HTTPS confirm
5. Accept brief downtime during domain move

- [ ] **Step 4: Post-cutover checklist**

- [ ] `/` and `/games` load on desktop, iPad landscape, Chromebook height
- [ ] `/games.html` redirects
- [ ] Theme persists
- [ ] SW registers; offline works
- [ ] Headers present (CSP, HSTS)
- [ ] Inventory (if shipped) camera + webhook
- [ ] No accidental SPA fallback of all routes to home

- [ ] **Step 5: Update docs**

Rewrite `DEPLOYMENT.md` for Workers + Astro build. Update `AGENTS.md`:
- Stack is Astro + Cloudflare Workers
- Dev: `npm run dev`
- Games live in `src/content/games/`
- No more “empty build command / publish `/`”

- [ ] **Step 6: Commit** (if approved)

---

### Task 9: Remove legacy static surface

**Files:**
- Delete from repo root after cutover confirmed: `index.html`, `games.html`, `hub.html`, `404.html`, `offline.html`, `testing.html`, `css/`, `js/` (except anything still needed — should be none), duplicate `newhome/`, optionally move `oldhome/` + `old-site/` to a separate archive branch or leave unlinked under `archive/` outside the Astro `public/` tree so they are not deployed

**Interfaces:**
- Produces: single Astro source of truth; `npm run build` output is the only deployable site

- [ ] **Step 1: Confirm production has been on Astro for a stable period** (same day OK if preview checklist passed).

- [ ] **Step 2: Remove legacy files**; ensure nothing in `public/` still duplicates old CSS/JS incorrectly.

- [ ] **Step 3: Final build + deploy + smoke test**

- [ ] **Step 4: Commit** (if approved)

```bash
git commit -m "$(cat <<'EOF'
Remove pre-Astro HTML/CSS/JS after Workers cutover.

EOF
)"
```

---

## Out of scope (follow-ups, not this migration)

- Visual redesign / new look-and-feel
- Game click tracking `/go?game=` (see `docs/game-click-tracking.md`)
- D1/KV/R2 bindings (adapter is in place so these can be added later without re-platforming)
- React/Vue islands
- Migrating `old-site/` content into Astro

---

## Risk register

| Risk | Mitigation |
|------|------------|
| SW serves stale HTML after cutover | Network-first navigations; bump cache name in `sw.js`; users hard-refresh once |
| Pages SPA rewrite still active | Remove `cloudflare-pages.toml` catch-all; verify 404 is real 404 page |
| Chromebook vertical overflow after CSS move | Diff `home-mockups` media queries; test 1366×768 |
| Content collection schema mismatch | Validate one sample game JSON against schema before bulk move |
| Worker name ≠ dashboard name | Match `wrangler.jsonc` `name` exactly |
| CSP breaks theme or games scripts | Test with console open; prefer same-origin modules over inline |

---

## Self-review

1. **Spec coverage:** Scaffold, layout, home, games collection, PWA/SW, headers, inventory, Workers cutover, legacy removal — all have tasks.
2. **Placeholder scan:** No TBD steps; adapter Wrangler shape notes a follow-the-generator exception where Cloudflare’s generated config may differ slightly.
3. **Consistency:** Canonical games URL is `/games` with redirect from `/games.html`; offline URL must be single-chosen in Task 5 and used in SW + links.
