# Deploying to Cloudflare Workers

St. Cecilia Technology is an **Astro** site deployed as a **Cloudflare Worker** with static assets (Workers Assets). Pages are prerendered (`output: 'server'` + `prerender = true` on each page) so the Worker can also host `/api/whiteboard/*` and Durable Objects. It is **not** a Cloudflare Pages project anymore.

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
| Build / runtime env | `PUBLIC_CLERK_PUBLISHABLE_KEY` — Clerk publishable key (client + Worker `authenticateRequest`) |
| Build / runtime env | `PUBLIC_CLERK_ALLOWED_DOMAINS` — optional allowlist, e.g. `stceciliafc.com` or `stceciliafc.com,you@gmail.com` |
| Worker secret | `CLERK_SECRET_KEY` — `npx wrangler secret put CLERK_SECRET_KEY` (never commit) |

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
| `wrangler.jsonc` | Worker name, assets directory, custom `main` (`src/worker.ts`), Durable Objects |
| `src/worker.ts` | Worker entry — static assets + `/api/whiteboard/*` |
| `astro.config.mjs` | Astro + `@astrojs/cloudflare` adapter; legacy redirects (`/games.html` → `/games`, `/newgames` → `/games`, `/hub`, `/offline.html`, etc.) |
| `public/_headers` | CSP, HSTS, cache rules (sole headers source) |
| `public/_redirects` | Path redirects for `/newhome/` and `/inventory/` only |
| `public/sw.js` | Service worker (network-first navigations; skips `/api/*`) |

`cloudflare-pages.toml` has been **removed** — do not restore Pages SPA rewrites or empty-build Pages settings.

## Whiteboard Durable Objects + R2 assets

Product resource family: **`scsfoxchase-tech_whiteboards`**.

| Wrangler name | Value |
|---|---|
| DO binding | `WHITEBOARDS` |
| DO class | `WhiteboardBoard` |
| Migration tag | `whiteboard-v1` (`new_sqlite_classes`) |
| R2 binding | `WHITEBOARD_ASSETS` |
| R2 bucket | `scsfoxchase-tech-whiteboards` |
| KV binding | `WHITEBOARD_CODES` |
| KV namespace | `scsfoxchase-tech-whiteboard-codes` (share code → boardId, TTL 12h) |

**R2 naming note:** Cloudflare R2 bucket names cannot contain `_`. The live bucket is hyphenated (`scsfoxchase-tech-whiteboards`); the product family spelling with an underscore is unchanged for docs / DO naming.

Create the bucket once (if missing) before the first deploy that uses the binding:

```bash
npx wrangler r2 bucket create scsfoxchase-tech-whiteboards
```

Share-code KV (Phase 5) is already created and bound in `wrangler.jsonc`. To recreate elsewhere:

```bash
npx wrangler kv namespace create scsfoxchase-tech-whiteboard-codes
npx wrangler kv namespace create scsfoxchase-tech-whiteboard-codes-preview
```

First deploy after adding the DO applies migration `whiteboard-v1` automatically via `wrangler deploy`. No separate create command is required for Durable Objects.

Asset API (capability URLs; no public list):

- `PUT|GET|DELETE /api/whiteboard/assets/{ownerKey}/{assetId}`
- Object key: `assets/{ownerKey}/{assetId}`
- Signed-out owner: scratch canvas files use `temp:{boardId}` (24h). Device id in `localStorage` is for guest names, not a board library.
- Signed-in owner: `google:{accountId}` (Google OAuth `sub` when available, else Clerk `user.id`)
- `google:*` PUT/DELETE require a Clerk session whose owner key matches

Share codes (Phase 5):

- KV key: `code:{A1B2}` → `{ boardId, exp }` with `expirationTtl` 12h
- DO metadata: `activeCode` + `codeExpiresAt` + alarm cleanup
- `GET /api/whiteboard/join/{code}` → `{ id }` or 404
- `GET|POST|DELETE /api/whiteboard/boards/{uuid}/code` — status / mint-or-keep (optional `?rotate=1`) / revoke
- Auth: knowing the board UUID is enough (same capability model as opening the board); mint/rotate rate-limited per board

Cloud library indexes reuse the same R2 bucket (no extra KV/D1):

- `library/{ownerKey}/boards.json`
- `library/{ownerKey}/assets.json`
- APIs: `GET|PUT /api/whiteboard/library/boards`, `DELETE .../boards/:id`, same for `assets` (Clerk Bearer token)
- Recents / Library / Assets are signed-in cloud only. Signed-out create is a scratch Durable Object (24h TTL until Save).

### Clerk (Google sign-in)

- **Frontend API:** `clerk.scsfoxchase.tech` (encoded in `pk_live_…`; OAuth callback `https://clerk.scsfoxchase.tech/v1/oauth_callback`)
- **Accounts portal:** `accounts.scsfoxchase.tech`
- **UI:** header `SignInButton` (modal) + `UserButton` via `@clerk/react` island. Google-only is Dashboard config, not custom redirect code.
- **ClerkProvider:** `publishableKey` + `afterSignOutUrl` only — no `domain` / `isSatellite` / `proxyUrl`
- **Packages:** `@clerk/react` (client) + `@clerk/backend` (Worker). `@clerk/astro` not Astro 7–ready yet.
- **Env:**
  - Local: `.env` + `.dev.vars` (see examples)
  - Production: Workers Builds `PUBLIC_CLERK_PUBLISHABLE_KEY` (+ optional `PUBLIC_CLERK_ALLOWED_DOMAINS`) and `wrangler secret put CLERK_SECRET_KEY`
- **CSP** (`public/_headers`): allow `clerk.scsfoxchase.tech`, `accounts.scsfoxchase.tech`, `challenges.cloudflare.com`, `accounts.google.com`, `img.clerk.com`, `clerk-telemetry.com`
- **Dashboard checklist:**
  - Allowed origins: `https://scsfoxchase.tech` (and `www` if used). Localhost only works with a `pk_test_` development instance.
  - Google connection enabled; application home URL `https://scsfoxchase.tech`
  - Native Google OAuth callback stays on Clerk FAPI (not the app)
- **Local vs production:** `pk_live_` → `origin_invalid` on localhost. Test Sign in on production after deploy, or use a separate Clerk development instance locally.
Local Whiteboard smoke test:

```bash
npm run build && npm run preview
# or during iteration: npm run dev
# 1. Signed out: /whiteboard → Create (no Recents). Draw on two windows of /board/{uuid}; refresh keeps the scene.
# 2. Sign in with Google on a scratch board this browser created → Save claims Owner; Recents/Library appear.
# 3. Signed-in Create autosaves; paste an image (R2 google:{id}) and an MP4 (same-origin /whiteboard-player).
# 4. Sign out → hub lists hide; scratch create still works; cloud data remains for next sign-in.
# 5. Join by share code as a guest: Viewer (view-only banner); Owner can set Editor. Follow + Follow Me.
```