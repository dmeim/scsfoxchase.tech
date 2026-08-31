# Environment variables

Runtime and build configuration for Worker `scsfoxchase-tech`. Bindings (DO / D1 / R2 / KV / Rate Limiting) live in `wrangler.jsonc` and do not need env vars — see [deployment.md](./deployment.md). Architecture and whiteboard auth flows: [architecture.md](./architecture.md), [whiteboard/](./whiteboard/).

**Never commit secrets.** Do not put `CLERK_SECRET_KEY` (or any production secret) in git, `wrangler.jsonc`, or example files with real values. Use Wrangler secrets in production and gitignored local files for development.

## Variable reference

| Variable | Public / secret | Required | Where set | Purpose |
|----------|-----------------|----------|-----------|---------|
| `PUBLIC_CLERK_PUBLISHABLE_KEY` | Public | Yes for Clerk | Workers Builds build + runtime vars; local `.env` and `.dev.vars` | Client `ClerkProvider` / sign-in UI; Worker `authenticateRequest` |
| `PUBLIC_CLERK_ALLOWED_DOMAINS` | Public | No | Workers Builds vars; local `.env` / `.dev.vars` | Optional allowlist: comma-separated email domains and/or full emails |
| `CLERK_SECRET_KEY` | **Secret** | Yes for cloud library / `google:*` writes | `npx wrangler secret put`; local `.dev.vars` only | Worker verifies Clerk sessions via `@clerk/backend` |
| `WHITEBOARD_ADMIN_SECRET` | **Secret** | Only for Durable Object storage wipe | `npx wrangler secret put WHITEBOARD_ADMIN_SECRET` | Bearer token for `POST /api/whiteboard/admin/wipe-storage` (`deleteAll` on listed object hex IDs). Omit locally unless testing wipe. |
| `PUBLIC_TURNSTILE_SITEKEY` | Public | Yes for public forms | Worker runtime variable; local `.dev.vars` | Shared Turnstile sitekey returned to public forms by `/api/forms/config` |
| `TURNSTILE_SECRET` | **Secret** | Yes for public forms | Worker runtime secret; local `.dev.vars` | Server-only Siteverify credential shared across forms |
| `N8N_WEBHOOK_BASE_URL` | **Secret** | Yes for n8n-backed forms | Worker runtime secret; local `.dev.vars` | Server-only base URL; allowlisted form routes append their fixed n8n path |
| `N8N_WEBHOOK_SECRET` | **Secret** | Yes for n8n-backed forms | Worker runtime secret; local `.dev.vars` | Shared `X-SCS-Webhook-Key` value sent only from the Worker to n8n |

There is no whiteboard license key (`PUBLIC_TLDRAW_LICENSE_KEY` is gone). Excalidraw 0.18.1 is MIT.

Worker `Env` also accepts legacy alias `CLERK_PUBLISHABLE_KEY` as a fallback for the publishable key at runtime (`src/worker/clerkAuth.ts`). Prefer `PUBLIC_CLERK_PUBLISHABLE_KEY` everywhere.

### `PUBLIC_CLERK_ALLOWED_DOMAINS`

- Format: `stceciliafc.com` or `stceciliafc.com,you@gmail.com`
- Empty / unset: any Google account that can sign in via Clerk is allowed (Clerk Dashboard still controls Google-only)
- Non-empty: email must match a listed domain (after `@`) or an exact email

### Whiteboard storage

No extra env vars for sync, assets, share codes, library metadata, connection admission, or fonts. Those use bindings plus self-hosted files under `public/excalidraw/`:

- `WHITEBOARDS` — Durable Objects (Excalidraw scene JSON and room metadata)
- `WHITEBOARD_LIBRARY` — D1 database `scsfoxchase-tech-whiteboard-library` in production; signed-in Library / Recents / Assets metadata only. Preview uses the separate `preview_database_id` in `wrangler.jsonc`; local test workers use `scsfoxchase-tech-whiteboard-library-worker-tests`.
- `WHITEBOARD_ASSETS` — R2 bucket `scsfoxchase-tech-whiteboards` (previews and legacy media reads; historical library JSON source indexes retained)
- `WHITEBOARD_CODES` — KV share-code index
- `WHITEBOARD_CONNECT_LIMITER` — Rate Limiting binding, 600 admissions per 60 seconds keyed by trusted `CF-Connecting-IP`
- `WHITEBOARD_BOARD_CONNECT_LIMITER` — Rate Limiting binding, 240 admissions per 60 seconds keyed by canonical board UUID plus trusted `CF-Connecting-IP`

Scenes never move to D1 or R2. New image/video insertion remains disabled. The historical R2 indexes are read-only migration sources; normal library CRUD uses D1.

Apply migrations in filename order (`0000_create_whiteboard_library.sql`, `0001_enforce_library_owner_imports_owner_key.sql`, `0002_add_library_tombstones.sql`) local → preview → production. Production migration and the R2 backfill are separate operator steps and are not implied by setting the binding. See [d1-library-operations.md](./whiteboard/d1-library-operations.md).

## Where to set values

### Production (Workers Builds + Wrangler)

| Kind | How |
|------|-----|
| Build vars | Cloudflare dashboard → Worker `scsfoxchase-tech` → Workers Builds / Variables: `PUBLIC_CLERK_PUBLISHABLE_KEY`, optional `PUBLIC_CLERK_ALLOWED_DOMAINS`, `NODE_VERSION=22` |
| Runtime vars | Worker settings: Clerk public config plus `PUBLIC_TURNSTILE_SITEKEY`. The Turnstile sitekey is public and is served by `/api/forms/config`, so it does not need to be duplicated in Workers Builds. |
| Secrets | Worker runtime secrets: `CLERK_SECRET_KEY`, `TURNSTILE_SECRET`, `N8N_WEBHOOK_BASE_URL`, and `N8N_WEBHOOK_SECRET`. Optional: `WHITEBOARD_ADMIN_SECRET` for the Durable Object wipe route. Never commit their values. |

`PUBLIC_CLERK_*` values used by Astro must be present at **build** time so they are inlined into client bundles. `PUBLIC_TURNSTILE_SITEKEY` is different: the Worker reads it at runtime and returns it from the same-origin `/api/forms/config` endpoint. The Turnstile secret remains server-only.

The root Wrangler configuration sets `keep_vars: true`, so Git-driven `wrangler deploy` operations preserve dashboard-managed runtime text variables. Without that setting, Wrangler deletes text variables absent from the checked-in `vars` object; encrypted secrets are unaffected.

### Local development

| File | Gitignored? | Use |
|------|-------------|-----|
| `.env` | Yes (copy from `.env.example`) | Astro / Vite `import.meta.env` for client and SSR during `npm run dev` / `npm run build` |
| `.dev.vars` | Yes (copy from `.dev.vars.example`) | Wrangler / Worker entry during `astro preview` / `wrangler dev` — must include `CLERK_SECRET_KEY` so the custom Worker can verify JWTs |

Typical local pattern:

```bash
cp .env.example .env
cp .dev.vars.example .dev.vars
# Edit both with real keys. Keep secrets out of git.
```

`.dev.vars.example` mirrors the Worker-needed Clerk and public-form variables. For local Turnstile testing, use Cloudflare's official test key pair rather than the production widget, whose hostname policy excludes localhost.

```
CLERK_SECRET_KEY=
PUBLIC_CLERK_PUBLISHABLE_KEY=
PUBLIC_CLERK_ALLOWED_DOMAINS=stceciliafc.com
PUBLIC_TURNSTILE_SITEKEY=
TURNSTILE_SECRET=
N8N_WEBHOOK_BASE_URL=
N8N_WEBHOOK_SECRET=
```

## Clerk domains

Custom Frontend API and accounts (encoded in live publishable keys; CSP in `public/_headers`):

| Host | Role |
|------|------|
| `clerk.scsfoxchase.tech` | Clerk Frontend API; OAuth callback `https://clerk.scsfoxchase.tech/v1/oauth_callback` |
| `accounts.scsfoxchase.tech` | Accounts portal |

Client setup uses `publishableKey` + `afterSignOutUrl` only (no `domain` / `isSatellite` / `proxyUrl` on `ClerkProvider`). Packages: `@clerk/react` (UI island) and `@clerk/backend` (Worker).

### Clerk Dashboard checklist

- Allowed origins: `https://scsfoxchase.tech` (and `www` if used)
- Application home URL: `https://scsfoxchase.tech`
- Google connection enabled; native Google OAuth callback stays on Clerk FAPI
- `pk_live_` keys reject localhost (`origin_invalid`). Use a Clerk **development** instance (`pk_test_`) for local Sign in, or verify Sign in on production after deploy

Authorized parties checked by the Worker include `https://scsfoxchase.tech`, `https://www.scsfoxchase.tech`, and local Astro origins (`http://localhost:4321`, `http://127.0.0.1:4321`).

## Observability configuration

`wrangler.jsonc` persists structured Worker logs and automatic traces at `0.05` (5%) sampling while leaving invocation logs disabled (`invocation_logs: false`). The application logger is allow-listed and emits only low-cardinality admission/auth transitions, throttles, scene rejection/persistence failures, and bounded storage-failure categories. It does not emit board/session IDs, IPs, URLs/paths, host secrets, JWTs, arbitrary exception strings, or scene contents.

## Related config files

| File | Role |
|------|------|
| `.env.example` | Documented public + secret names for Astro / build |
| `.dev.vars.example` | Documented Worker local secrets/vars |
| `wrangler.jsonc` | Bindings only; secrets are not stored here |
| `public/_headers` | CSP allowlists for Clerk, Google, Turnstile, same-origin Whiteboard (fonts, WebSocket, player, YouTube/Vimeo) |
| `worker-configuration.d.ts` | TypeScript `Env` shape for the Worker |
| `migrations/` | Additive D1 schema migrations, applied in order |
| `docs/whiteboard/d1-library-operations.md` | Scan/import/export, verification, and rollback runbook |
