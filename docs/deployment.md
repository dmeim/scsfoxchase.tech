# Deployment

St. Cecilia Technology (`scsfoxchase.tech`) is an Astro 7 site deployed as a **Cloudflare Worker** with static assets. Pages are prerendered; the Worker entry (`src/worker.ts`) serves those assets and hosts `/api/whiteboard/*` (Durable Objects, D1 metadata, R2 previews/legacy media, KV, Rate Limiting, and Clerk).

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
| Live version | `GET /api/whiteboard/version` → `{ sha, builtAt }` |

**GitHub Workers Builds on `main` is the single production deployer.** Manual `npx wrangler deploy` from a laptop is **discouraged**: Builds overwrites that version ~70 seconds later, silently replacing the Worker you just tested.

The current documentation does not assert that production D1 migration, R2 backfill, or the cutover Worker deployment is complete. Apply and verify the production D1 schema before pushing the cutover commit; see [the operator runbook](./whiteboard/d1-library-operations.md).

Before trusting any production observation, confirm `GET /api/whiteboard/version` matches the expected commit (`Cache-Control: no-store` — do not trust a cached copy).

## Local build and deploy

Prerequisites: Node 22+, Cloudflare account for the `scsfoxchase.tech` zone, and Wrangler auth (`npx wrangler login` or `CLOUDFLARE_API_TOKEN`).

Build locally as usual. To test a change **before merge**, upload a preview version (it does not take production traffic):

```bash
npm install
npm run preview:upload  # type-check + tests + build + preview upload
```

Do **not** run `npx wrangler deploy` (or `npm run deploy`) from a laptop: Workers Builds on `main` overwrites that version shortly afterward.

Useful checks:

```bash
npx wrangler deploy --dry-run
npx wrangler whoami
npx wrangler tail
curl -sS https://scsfoxchase.tech/api/whiteboard/version
```

`@astrojs/cloudflare` emits client assets under **`dist/client/`**. `wrangler.jsonc` must keep:

```jsonc
"assets": { "directory": "./dist/client" }
```

Do not point assets at repo root `/` or a flat `./dist`.

## Workers Builds (Git → Cloudflare)

**This is the single production deployer.** Every push to `main` builds and deploys the Worker.

Dashboard: [Workers & Pages](https://dash.cloudflare.com) → Worker **`scsfoxchase-tech`**.

| Setting | Value |
|---------|--------|
| Production branch | `main` |
| Root directory | repo root |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Worker name | `scsfoxchase-tech` |
| Node version | **22+** — set `NODE_VERSION=22` in Workers Builds vars (or rely on `.nvmrc` / `engines`) |

Keep the Builds Deploy command `npx wrangler deploy` for this asset-heavy static site. Prefer Node **22**; Node below **20.17** can fail to upload nested dirs like `/_astro/`, leaving HTML unstyled. From a laptop, use `npx wrangler versions upload` for pre-merge preview URLs — not as a production deploy.

**Build / runtime variables and secrets** (details in [environment.md](./environment.md)):

| Kind | Names |
|------|--------|
| Build + runtime | `PUBLIC_CLERK_PUBLISHABLE_KEY`, optional `PUBLIC_CLERK_ALLOWED_DOMAINS` |
| Worker secret | `CLERK_SECRET_KEY` via `npx wrangler secret put CLERK_SECRET_KEY` (never commit) |

## Bindings

Configured in `wrangler.jsonc`. Product resource family: **`scsfoxchase-tech_whiteboards`**.

| Binding | Type | Resource |
|---------|------|----------|
| `WHITEBOARDS` | Durable Object | Class `WhiteboardBoard` (SQLite); migration tag `whiteboard-v1` |
| `WHITEBOARD_ASSETS` | R2 | Bucket `scsfoxchase-tech-whiteboards` |
| `WHITEBOARD_CODES` | KV | Namespace `scsfoxchase-tech-whiteboard-codes` (share code → board id, permanent) |
| `WHITEBOARD_LIBRARY` | D1 | `scsfoxchase-tech-whiteboard-library` in production; signed-in metadata only |
| `WHITEBOARD_CONNECT_LIMITER` | Rate Limiting | 120 admissions / 60 seconds per trusted `CF-Connecting-IP` |
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

## D1 migration order

Production database name: `scsfoxchase-tech-whiteboard-library`. Preview uses the separate `preview_database_id` configured for the `WHITEBOARD_LIBRARY` binding; test workers use `scsfoxchase-tech-whiteboard-library-worker-tests` locally. Apply the additive migrations in order (`0000`, `0001`, `0002`) to local, then preview, then production. Production D1 must be migrated and verified before the cutover commit is pushed; this repository does not claim that production migration, backfill, or deployment is complete.

```bash
npx wrangler d1 migrations list WHITEBOARD_LIBRARY --local
npx wrangler d1 migrations apply WHITEBOARD_LIBRARY --local
npx wrangler d1 migrations list WHITEBOARD_LIBRARY --remote --preview
npx wrangler d1 migrations apply WHITEBOARD_LIBRARY --remote --preview
npx wrangler d1 migrations list WHITEBOARD_LIBRARY --remote
npx wrangler d1 migrations apply WHITEBOARD_LIBRARY --remote
```

The apply command prompts for confirmation and captures a backup. Use [d1-library-operations.md](./whiteboard/d1-library-operations.md) for the read-only R2 scan, explicit import, resumable checkpoints, no-clobber D1 export, verification, and rollback procedure.

## Observability

Wrangler observability is enabled with structured logs, `invocation_logs: false`, and `head_sampling_rate: 0.05` in production. The allow-listed events cover connection admission/auth transitions, throttles, scene rejection/persistence failures, and bounded D1/R2/KV storage failures. Logs omit IDs, IPs, URLs/paths, credentials, arbitrary exceptions, and scene contents; ping and per-update success traffic is not logged.

Whiteboard sync, assets, share codes, and cloud libraries are documented under [whiteboard/](./whiteboard/).

## Headers, redirects, and service worker

| File | Role |
|------|------|
| `public/_headers` | Sole security-header source: CSP, HSTS, `X-Frame-Options`, `nosniff`, cache (`max-age=3600`, never `immutable`) |
| `public/_redirects` | `/newhome/` → `/`, `/inventory/` → `/inventory`, `/board/*` → `/board` (200 rewrite) |
| `public/sw.js` | PWA service worker: network-first navigations; offline page `/offline`; **never** intercepts `/api/*` (WebSockets and whiteboard APIs) |
| `astro.config.mjs` | Additional legacy redirects (e.g. `/games.html` → `/games`, `/newgames` → `/games`) |

Asset config in Wrangler uses `not_found_handling: "404-page"` so missing assets return 404 instead of SPA HTML (avoids `nosniff` breakage on CSS).

CSP allows Clerk custom domains (`clerk.scsfoxchase.tech`, `accounts.scsfoxchase.tech`), Google OAuth, Turnstile, same-origin Whiteboard WebSocket/asset/font routes, and YouTube/Vimeo `frame-src` for canvas embeds. See [environment.md](./environment.md) for Clerk domain notes. There is no tldraw license key.

## Verification checklist

After deploy (custom domain or workers.dev preview):

- [ ] `GET /api/whiteboard/version` — `{ sha, builtAt }` matches the expected commit
- [ ] `/` homepage loads with styles (`/_astro/*` present)
- [ ] `/games` catalog
- [ ] `/offline` offline fallback
- [ ] `/inventory` staff lookup
- [ ] `/whiteboard` hub; create board → `/board/{uuid}` syncs
- [ ] Static assets: `/_astro/*`, `/images/*`, `/sw.js`
- [ ] Security headers from `public/_headers` (CSP, HSTS, etc.)
- [ ] Clerk Sign in works on production (`pk_live_` keys; localhost needs a Clerk development instance)
- [ ] Whiteboard APIs: connect WebSocket, join by share code, asset PUT/GET for `temp:` / `google:` keys as expected

Local Whiteboard smoke test:

```bash
npm run build && npm run preview
# or: npm run dev
```

1. Signed out: `/whiteboard` → Create (Recents hidden). Two windows on `/board/{uuid}` sync shapes; refresh keeps the scene.
2. Sign in with Google on a scratch board this browser created → Save claims Owner; hub Recents/Library appear.
3. Signed-in create autosaves; paste image + MP4 → cloud Assets; R2 uses `google:{id}` after save (scratch uses `temp:{boardId}`).
4. Sign out → hub lists hide; cloud data remains for next sign-in.
5. Join by code as a guest: Editor (Group Edit Off = view-only). Follow (pan unfollows). Follow User locks the camera.
