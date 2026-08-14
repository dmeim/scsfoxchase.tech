# Environment variables

Runtime and build configuration for Worker `scsfoxchase-tech`. Bindings (DO / R2 / KV) live in `wrangler.jsonc` and do not need env vars — see [deployment.md](./deployment.md). Architecture and whiteboard auth flows: [architecture.md](./architecture.md), [whiteboard/](./whiteboard/).

**Never commit secrets.** Do not put `CLERK_SECRET_KEY` (or any production secret) in git, `wrangler.jsonc`, or example files with real values. Use Wrangler secrets in production and gitignored local files for development.

## Variable reference

| Variable | Public / secret | Required | Where set | Purpose |
|----------|-----------------|----------|-----------|---------|
| `PUBLIC_CLERK_PUBLISHABLE_KEY` | Public | Yes for Clerk | Workers Builds build + runtime vars; local `.env` and `.dev.vars` | Client `ClerkProvider` / sign-in UI; Worker `authenticateRequest` |
| `PUBLIC_CLERK_ALLOWED_DOMAINS` | Public | No | Workers Builds vars; local `.env` / `.dev.vars` | Optional allowlist: comma-separated email domains and/or full emails |
| `CLERK_SECRET_KEY` | **Secret** | Yes for cloud library / `google:*` writes | `npx wrangler secret put`; local `.dev.vars` only | Worker verifies Clerk sessions via `@clerk/backend` |
| `WHITEBOARD_ADMIN_SECRET` | **Secret** | Only for Durable Object storage wipe | `npx wrangler secret put WHITEBOARD_ADMIN_SECRET` | Bearer token for `POST /api/whiteboard/admin/wipe-storage` (`deleteAll` on listed object hex IDs). Omit locally unless testing wipe. |
| `PUBLIC_INVENTORY_WEBHOOK` | Public | No | Build env / `.env` if overriding default | Inventory form webhook URL; defaults in code to the n8n inventory endpoint |

There is no whiteboard license key (`PUBLIC_TLDRAW_LICENSE_KEY` is gone). Excalidraw 0.18.1 is MIT.

Worker `Env` also accepts legacy alias `CLERK_PUBLISHABLE_KEY` as a fallback for the publishable key at runtime (`src/worker/clerkAuth.ts`). Prefer `PUBLIC_CLERK_PUBLISHABLE_KEY` everywhere.

### `PUBLIC_CLERK_ALLOWED_DOMAINS`

- Format: `stceciliafc.com` or `stceciliafc.com,you@gmail.com`
- Empty / unset: any Google account that can sign in via Clerk is allowed (Clerk Dashboard still controls Google-only)
- Non-empty: email must match a listed domain (after `@`) or an exact email

### Whiteboard storage

No extra env vars for sync, assets, share codes, or fonts. Those use bindings plus self-hosted files under `public/excalidraw/`:

- `WHITEBOARDS` — Durable Objects (Excalidraw scene JSON)
- `WHITEBOARD_ASSETS` — R2 bucket `scsfoxchase-tech-whiteboards`
- `WHITEBOARD_CODES` — KV share-code index

## Where to set values

### Production (Workers Builds + Wrangler)

| Kind | How |
|------|-----|
| Build vars | Cloudflare dashboard → Worker `scsfoxchase-tech` → Workers Builds / Variables: `PUBLIC_CLERK_PUBLISHABLE_KEY`, optional `PUBLIC_CLERK_ALLOWED_DOMAINS`, `NODE_VERSION=22` |
| Runtime vars | Same dashboard variables so the Worker process can read Clerk public config |
| Secrets | `npx wrangler secret put CLERK_SECRET_KEY` (never in git or plaintext dashboard dumps committed to the repo). Optional: `WHITEBOARD_ADMIN_SECRET` for the Durable Object wipe route. |

`PUBLIC_*` values used by Astro must be present at **build** time so they are inlined into client bundles. The Worker also reads `PUBLIC_CLERK_*` and `CLERK_SECRET_KEY` at **runtime** for `/api/whiteboard/*` auth.

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

`.dev.vars.example` mirrors the Worker-needed Clerk trio:

```
CLERK_SECRET_KEY=
PUBLIC_CLERK_PUBLISHABLE_KEY=
PUBLIC_CLERK_ALLOWED_DOMAINS=stceciliafc.com
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

## Related config files

| File | Role |
|------|------|
| `.env.example` | Documented public + secret names for Astro / build |
| `.dev.vars.example` | Documented Worker local secrets/vars |
| `wrangler.jsonc` | Bindings only; secrets are not stored here |
| `public/_headers` | CSP allowlists for Clerk, Google, Turnstile, same-origin Whiteboard (fonts, WebSocket, player, YouTube/Vimeo) |
| `worker-configuration.d.ts` | TypeScript `Env` shape for the Worker |
