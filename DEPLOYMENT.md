# Deploying to Cloudflare Workers

St. Cecilia Technology is an **Astro** site deployed as a **Cloudflare Worker** with static assets (Workers Assets). It is **not** a Cloudflare Pages project anymore.

- **Worker name:** `scsfoxchase-tech` (must match `wrangler.jsonc` `name`)
- **Domain:** `scsfoxchase.tech`
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

Every push to `main` should build and deploy the Worker. Prefer verifying on `*.workers.dev` / preview URLs before attaching the custom domain.

## Custom domain cutover

Pointing `scsfoxchase.tech` at this Worker is a **manual dashboard step**. See **Human tomorrow — domain cutover** in [`ASTRO-MIGRATION.md`](./ASTRO-MIGRATION.md).

Rules of thumb:

1. Deploy and smoke-test the Worker on workers.dev / preview first.
2. Move the custom domain from the old Pages project to Worker `scsfoxchase-tech`.
3. Only disable/delete the old Pages project after DNS + HTTPS confirm on the Worker.
4. Expect brief downtime during the domain move.

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
| `astro.config.mjs` | Astro + `@astrojs/cloudflare` adapter |
| `public/_headers` | CSP, HSTS, cache rules (sole headers source) |
| `public/_redirects` | Legacy path redirects (`/games.html` → `/games`, etc.) |
| `public/sw.js` | Service worker (network-first navigations) |

`cloudflare-pages.toml` has been **removed** — do not restore Pages SPA rewrites or empty-build Pages settings.
