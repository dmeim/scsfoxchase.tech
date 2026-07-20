# Deployment

St. Cecilia Technology (`scsfoxchase.tech`) is an Astro 7 site deployed as a **Cloudflare Worker** with static assets. Pages are prerendered; the Worker entry (`src/worker.ts`) serves those assets and hosts `/api/whiteboard/*` (Durable Objects, R2, KV).

This is **not** a Cloudflare Pages project. Do not use an empty Pages build, publish directory `/`, or restore `cloudflare-pages.toml`.

For system layout and whiteboard APIs, see [architecture.md](./architecture.md) and [whiteboard/](./whiteboard/). For env vars and secrets, see [environment.md](./environment.md).

## Identity

| Item | Value |
|------|--------|
| Worker name | `scsfoxchase-tech` (matches `wrangler.jsonc` `name`) |
| Domain | `scsfoxchase.tech` (attached to this Worker) |
| Entry | `./src/worker.ts` |
| Assets directory | `./dist/client` |
| Node | `>=22` (`package.json` `engines`, `.nvmrc`) |

## Local build and deploy

Prerequisites: Node 22+, Cloudflare account for the `scsfoxchase.tech` zone, and Wrangler auth (`npx wrangler login` or `CLOUDFLARE_API_TOKEN`).

```bash
npm install
npm run build                 # astro build → dist/client/
npx wrangler deploy           # Worker + assets
# or in one step:
npm run deploy                # astro build && wrangler deploy
```

Useful checks:

```bash
npx wrangler deploy --dry-run
npx wrangler whoami
npx wrangler tail
```

`@astrojs/cloudflare` emits client assets under **`dist/client/`**. `wrangler.jsonc` must keep:

```jsonc
"assets": { "directory": "./dist/client" }
```

Do not point assets at repo root `/` or a flat `./dist`.

## Workers Builds (Git → Cloudflare)

Dashboard: [Workers & Pages](https://dash.cloudflare.com) → Worker **`scsfoxchase-tech`**.

| Setting | Value |
|---------|--------|
| Production branch | `main` |
| Root directory | repo root |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Worker name | `scsfoxchase-tech` |
| Node version | **22+** — set `NODE_VERSION=22` in Workers Builds vars (or rely on `.nvmrc` / `engines`) |

Every push to `main` builds and deploys the Worker.

Use Deploy command `npx wrangler deploy` for this asset-heavy static site. Prefer Node **22**; Node below **20.17** can fail to upload nested dirs like `/_astro/`, leaving HTML unstyled.

**Build / runtime variables and secrets** (details in [environment.md](./environment.md)):

| Kind | Names |
|------|--------|
| Build env (required) | `PUBLIC_TLDRAW_LICENSE_KEY` — inlined into the client at build time |
| Build + runtime | `PUBLIC_CLERK_PUBLISHABLE_KEY`, optional `PUBLIC_CLERK_ALLOWED_DOMAINS` |
| Worker secret | `CLERK_SECRET_KEY` via `npx wrangler secret put CLERK_SECRET_KEY` (never commit) |

## Bindings

Configured in `wrangler.jsonc`. Product resource family: **`scsfoxchase-tech_whiteboards`**.

| Binding | Type | Resource |
|---------|------|----------|
| `WHITEBOARDS` | Durable Object | Class `WhiteboardBoard` (SQLite); migration tag `whiteboard-v1` |
| `WHITEBOARD_ASSETS` | R2 | Bucket `scsfoxchase-tech-whiteboards` |
| `WHITEBOARD_CODES` | KV | Namespace `scsfoxchase-tech-whiteboard-codes` (share code → board id, TTL 12h) |
| `ASSETS` | Assets fetcher | Bound automatically from the assets directory |

R2 bucket names cannot contain `_`. The live bucket is hyphenated (`scsfoxchase-tech-whiteboards`); the product family spelling keeps the underscore.

Create the R2 bucket once if missing:

```bash
npx wrangler r2 bucket create scsfoxchase-tech-whiteboards
```

KV is already bound in `wrangler.jsonc`. To recreate elsewhere:

```bash
npx wrangler kv namespace create scsfoxchase-tech-whiteboard-codes
npx wrangler kv namespace create scsfoxchase-tech-whiteboard-codes-preview
```

First deploy after adding the Durable Object applies migration `whiteboard-v1` via `wrangler deploy`. No separate DO create command is required.

Whiteboard sync, assets, share codes, and cloud libraries are documented under [whiteboard/](./whiteboard/).

## Headers, redirects, and service worker

| File | Role |
|------|------|
| `public/_headers` | Sole security-header source: CSP, HSTS, `X-Frame-Options`, `nosniff`, cache (`max-age=3600`, never `immutable`) |
| `public/_redirects` | `/newhome/` → `/`, `/inventory/` → `/inventory`, `/board/*` → `/board` (200 rewrite) |
| `public/sw.js` | PWA service worker: network-first navigations; offline page `/offline`; **never** intercepts `/api/*` (WebSockets and whiteboard APIs) |
| `astro.config.mjs` | Additional legacy redirects (e.g. `/games.html` → `/games`, `/newgames` → `/games`) |

Asset config in Wrangler uses `not_found_handling: "404-page"` so missing assets return 404 instead of SPA HTML (avoids `nosniff` breakage on CSS).

CSP allows Clerk custom domains (`clerk.scsfoxchase.tech`, `accounts.scsfoxchase.tech`), Google OAuth, Turnstile, tldraw CDN, and same-origin whiteboard WebSocket/asset routes. See [environment.md](./environment.md) for Clerk domain notes.

## Verification checklist

After deploy (custom domain or workers.dev preview):

- [ ] `/` homepage loads with styles (`/_astro/*` present)
- [ ] `/games` catalog
- [ ] `/offline` offline fallback
- [ ] `/inventory` staff lookup
- [ ] `/whiteboard` hub; create board → `/board/{uuid}` syncs
- [ ] Static assets: `/_astro/*`, `/images/*`, `/sw.js`
- [ ] Security headers from `public/_headers` (CSP, HSTS, etc.)
- [ ] Clerk Sign in works on production (`pk_live_` keys; localhost needs a Clerk development instance)
- [ ] Whiteboard APIs: connect WebSocket, join by share code, asset PUT/GET when signed in/out as expected

Local multiplayer / auth smoke test:

```bash
npm run build && npm run preview
# or: npm run dev
```

1. Signed out: `/whiteboard` → Create, paste image, confirm Assets (local).
2. Sign in with Google → hub lists switch to cloud.
3. Create a board + paste media while signed in → cloud Recents/Assets; R2 keys use `google:{id}`.
4. Sign out → local lists return unchanged.
5. Two windows on the same `/board/{uuid}`: sync works; signed-in cursor shows display name.
