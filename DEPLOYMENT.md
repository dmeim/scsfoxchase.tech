# Deploying to Cloudflare Workers

St. Cecilia Technology is an **Astro** site deployed as a **Cloudflare Worker** with static assets (Workers Assets). It is **not** a Cloudflare Pages project anymore.

- **Worker name:** `scsfoxchase-tech` (must match `wrangler.jsonc` `name`)
- **Domain:** `scsfoxchase.tech` — live on Worker `scsfoxchase-tech`
- **Build command:** `npm run build`
- **Deploy command:** `npx wrangler deploy`
- **Assets directory:** `./dist/client` (Astro adapter emits client assets here — not repo root `/`, not flat `./dist`)

## Prerequisites

- Node.js 22+ (or current LTS that Astro 7 supports)
- Cloudflare account with the zone for `scsfoxchase.tech`
- GitHub repo connected for Workers Builds (production) **or** Wrangler CLI auth for manual deploy

```bash
npm install
npx wrangler login   # once, interactive — or set CLOUDFLARE_API_TOKEN
```

## Local build + deploy

```bash
npm run build
npx wrangler deploy
# or: npm run deploy   # runs astro build && wrangler deploy
```

Confirm after deploy (workers.dev preview or custom domain):

- [ ] `/` homepage
- [ ] `/games` catalog
- [ ] `/offline` offline fallback
- [ ] `/inventory` staff lookup (if shipped)
- [ ] Static assets (`/_astro/*`, `/images/*`, `/sw.js`)
- [ ] Security headers from `public/_headers` (CSP, HSTS, etc.)

### Important path note

`@astrojs/cloudflare` with `output: 'static'` writes the site into **`dist/client/`**. Root `wrangler.jsonc` must set:

```jsonc
"assets": { "directory": "./dist/client" }
```

Do **not** use an empty Pages build command or publish directory `/`.

## Workers Builds (Git → Cloudflare)

In [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → create/connect Worker **`scsfoxchase-tech`**:

| Setting | Value |
|---|---|
| Production branch | `main` |
| Root directory | repo root |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Worker name | `scsfoxchase-tech` |
| Node version | **22+** (set `NODE_VERSION=22` in Workers Builds vars, or rely on `.nvmrc` / `package.json` `engines`) |

**Important:** Workers Builds must use Node **≥ 20.17** (prefer **22**). Older Node can fail to upload nested static dirs like `/_astro/`, which leaves HTML unstyled (header logo at full 1000×1000). Prefer **Deploy command** `npx wrangler deploy` over relying only on `versions upload` for asset-heavy static sites.

Every push to `main` should build and deploy the Worker.

## Domain

`scsfoxchase.tech` is attached to Worker `scsfoxchase-tech`. The old Cloudflare Pages project has been removed. No further domain cutover steps are required.

## Useful CLI commands

```bash
npm run dev              # Astro local dev
npm run build            # production build → dist/client/
npx wrangler deploy --dry-run
npx wrangler deploy      # deploy Worker + assets
npx wrangler whoami      # auth check
npx wrangler tail        # live logs
```

## Config files (Workers era)

| File | Role |
|---|---|
| `wrangler.jsonc` | Worker name + assets directory |
| `astro.config.mjs` | Astro + `@astrojs/cloudflare` adapter; legacy redirects (`/games.html` → `/games`, `/newgames` → `/games`, `/hub`, `/offline.html`, etc.) |
| `public/_headers` | CSP, HSTS, cache rules (sole headers source) |
| `public/_redirects` | Path redirects for `/newhome/` and `/inventory/` only |
| `public/sw.js` | Service worker (network-first navigations) |

`cloudflare-pages.toml` has been **removed** — do not restore Pages SPA rewrites or empty-build Pages settings.
