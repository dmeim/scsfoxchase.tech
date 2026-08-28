# Deploying to Cloudflare Workers

St. Cecilia Technology is an **Astro** site deployed as a **Cloudflare Worker** with static assets (Workers Assets). Pages are prerendered (`output: 'server'` + `prerender = true` on each page) so the Worker can also host `/api/whiteboard/*`, Durable Objects, D1 metadata, R2 media/previews, and KV share codes. It is **not** a Cloudflare Pages project anymore.

- **Worker name:** `scsfoxchase-tech` (must match `wrangler.jsonc` `name`)
- **Domain:** `scsfoxchase.tech` — live on Worker `scsfoxchase-tech`
- **Build command:** `npm run build`
- **Production deploy:** GitHub Workers Builds on `main` (the **single** deployer)
- **Assets directory:** `./dist/client` (Astro adapter emits client assets here — not repo root `/`, not flat `./dist`)

**GitHub Workers Builds on `main` is the only path that should take production traffic.** Manual `npx wrangler deploy` from a laptop is **discouraged**: Builds overwrites that version ~70 seconds later, silently replacing the Worker you just tested.

The D1 metadata cutover is staged separately from the Worker release. Do not assume production migration, R2 backfill, or deployment has completed; use the [D1 library operations runbook](docs/whiteboard/d1-library-operations.md) and record each verification result.

Before trusting any production observation, confirm the live commit:

```bash
curl -sS https://scsfoxchase.tech/api/whiteboard/version
```

`GET /api/whiteboard/version` returns `{ "sha", "builtAt" }` (`Cache-Control: no-store`). The `sha` must match the commit you expect.

## Prerequisites

- Node.js 22+ (or current LTS that Astro 7 supports)
- Cloudflare account with the zone for `scsfoxchase.tech`
- GitHub repo connected for Workers Builds (production). Wrangler CLI auth is for pre-merge preview (`versions upload`), not for shipping live traffic.

```bash
npm install
npx wrangler login   # once, interactive — or set CLOUDFLARE_API_TOKEN
```

## Local build + deploy

Build locally as usual. To test a change **before merge**, upload a preview version (it does not take production traffic):

```bash
npm run build
npx wrangler versions upload
```

Do **not** run `npx wrangler deploy` (or `npm run deploy`) from a laptop: Workers Builds on `main` overwrites that version shortly afterward.

Confirm after a production deploy (Workers Builds) or a preview URL:

- [ ] `GET /api/whiteboard/version` — `{ sha, builtAt }` matches the expected commit
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

**This is the single production deployer.** Every push to `main` builds and deploys the Worker.

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

**Important:** Workers Builds must use Node **≥ 20.17** (prefer **22**). Older Node can fail to upload nested static dirs like `/_astro/`, which leaves HTML unstyled (header logo at full 1000×1000). Keep the Builds **Deploy command** as `npx wrangler deploy` for this asset-heavy static site. From a laptop, use `npx wrangler versions upload` for pre-merge preview URLs — not as a production deploy.

## Domain

`scsfoxchase.tech` is attached to Worker `scsfoxchase-tech`. The old Cloudflare Pages project has been removed. No further domain cutover steps are required.

## Useful CLI commands

```bash
npm run dev              # Astro local dev
npm run build            # production build → dist/client/
npx wrangler versions upload   # preview URL; does not take production traffic
npx wrangler deploy --dry-run
# npx wrangler deploy    # discouraged from a laptop — Builds overwrites it shortly after
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
| KV namespace | `scsfoxchase-tech-whiteboard-codes` (share code → boardId, permanent) |
| D1 binding | `WHITEBOARD_LIBRARY` |
| D1 production database | `scsfoxchase-tech-whiteboard-library` (metadata only) |
| Rate Limiting binding | `WHITEBOARD_CONNECT_LIMITER` (120 admissions / 60 seconds / trusted IP) |

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

## Observability and connection admission

`wrangler.jsonc` explicitly enables structured Worker logs with `invocation_logs: false` and a production head sampling rate of `0.05` (5%). The `WHITEBOARD_CONNECT_LIMITER` binding runs before Durable Object resolution and admits up to 120 WebSocket upgrades per 60-second window per trusted `CF-Connecting-IP`. Local/test fallback buckets expire and are capped at 4096 keys. Per-board limits are 64 total sockets, 32 pending-auth sockets, and approximately 30 seconds pending age; pending cleanup does not schedule one alarm per socket.

The safe logger records only low-cardinality admission/auth transitions, scene rejection/persistence failures, bounded storage failures, and throttles. It excludes board/session identifiers, IPs, URLs/paths, host secrets, JWTs, arbitrary exception text, and scene contents. Review the [whiteboard runbook](docs/whiteboard/d1-library-operations.md) for migration and rollback checks.

Asset API (capability URLs; no public list):

- `PUT|GET|DELETE /api/whiteboard/assets/{ownerKey}/{assetId}`
- Object key: `assets/{ownerKey}/{assetId}`
- Signed-out owner: scratch canvas files use `temp:{boardId}` (24h). Device id in `localStorage` is for guest names, not a board library.
- Signed-in owner: `google:{accountId}` (Google OAuth `sub` when available, else Clerk `user.id`)
- `google:*` PUT/DELETE require a Clerk session whose owner key matches

Share codes (Phase 5):

- KV key: `code:{1A2B3C4D}` → `{ boardId }` with **no TTL** (legacy `1A2B` still joins)
- DO metadata: `meta:activeCode` (mint once; never rotated or closed)
- `GET /api/whiteboard/join/{code}` → `{ id }` or 404
- `GET|POST /api/whiteboard/boards/{uuid}/code` — read / mint-if-missing (Owner/Manager)
- `DELETE /api/whiteboard/boards/{uuid}/code` — internal revoke (library delete + unsaved expiry)
- Auth for GET/POST/DELETE: Owner or Manager (live session, scratch host, or Clerk). Join lookup is unauthenticated and rate-limited.

## D1 library cutover

`WHITEBOARD_LIBRARY` is the dedicated D1 database named `scsfoxchase-tech-whiteboard-library`. The preview binding selects the separate `preview_database_id` configured in `wrangler.jsonc`; it is not the production database. Test workers use the local database identity `scsfoxchase-tech-whiteboard-library-worker-tests`. D1 contains only signed-in Library / Recents / Assets metadata; scenes remain in DO SQLite.

Migrations are additive and must be applied in filename order: `0000_create_whiteboard_library.sql`, `0001_enforce_library_owner_imports_owner_key.sql`, then `0002_add_library_tombstones.sql`. Use the preview database before production, and apply production D1 before pushing the Worker cutover commit:

```bash
npx wrangler d1 migrations list WHITEBOARD_LIBRARY --local
npx wrangler d1 migrations apply WHITEBOARD_LIBRARY --local
npx wrangler d1 migrations list WHITEBOARD_LIBRARY --remote --preview
npx wrangler d1 migrations apply WHITEBOARD_LIBRARY --remote --preview
npx wrangler d1 migrations list WHITEBOARD_LIBRARY --remote
# After preview verification and explicit approval:
npx wrangler d1 migrations apply WHITEBOARD_LIBRARY --remote
```

The apply command prompts for confirmation and captures a backup. The production migration/backfill/deploy sequence is not recorded as complete by this document. Scan/import/export, count verification, and emergency rollback are in [d1-library-operations.md](docs/whiteboard/d1-library-operations.md).

The historical R2 objects remain source indexes for migration and recovery:

- `library/{ownerKey}/boards.json`
- `library/{ownerKey}/assets.json`

Normal `GET|PUT|DELETE /api/whiteboard/library/*` routes use D1 and never rewrite those source indexes. R2 continues to store previews and serve legacy media compatibility reads. New image/video insertion remains disabled.

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
# 3. Signed-in Create autosaves; new image/video insertion is disabled. Existing media remains readable from legacy google:{id} / temp:{boardId} paths and retained board-scoped compatibility objects.
# 4. Sign out → hub lists hide; scratch create still works; cloud data remains for next sign-in.
# 5. Join by share code as a guest: Editor (Group Edit Off = view-only). Follow (pan unfollows). Follow User locks the camera.
```
