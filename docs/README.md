# St. Cecilia Technology — Documentation

**scsfoxchase.tech** is a PWA dashboard and educational games catalog for St. Cecilia School. Students and teachers use it daily on desktop monitors, Dell Chromebooks, and iPads.

This `docs/` tree is the canonical reference for coding agents and human operators. Prefer these pages over scattered root notes when you need system context; root `AGENTS.md`, `DEPLOYMENT.md`, and `FORMS.md` remain operational shortcuts and may overlap.

## Audience

| Reader | Use these docs to… |
|--------|-------------------|
| **Coding agents** | Orient on stack, routes, bindings, conventions, and where to change code |
| **Human operators** | Understand features, deploy shape, and how whiteboard vs static site fit together |

## How to use this docs set

1. Start here for the map of topics.
2. Read [architecture.md](./architecture.md) for request flow and module layout.
3. Read [conventions.md](./conventions.md) before UI or content changes.
4. Open the feature or whiteboard page that matches the area you are changing.
5. Use [deployment.md](./deployment.md) and [environment.md](./environment.md) for build, secrets, and Cloudflare bindings.

## Table of contents

### Core

| Document | Contents |
|----------|----------|
| [architecture.md](./architecture.md) | Astro + Worker, bindings, request flow, module map |
| [conventions.md](./conventions.md) | Brand, devices, CSS, games content, agent rules |
| [deployment.md](./deployment.md) | Build, Wrangler, Workers Builds, domain |
| [environment.md](./environment.md) | Env vars, secrets, local vs production |
| [ui-and-design.md](./ui-and-design.md) | Layout, theming, shared UI patterns |
| [pwa-and-offline.md](./pwa-and-offline.md) | Service worker, manifest, offline page |

### Features

| Document | Contents |
|----------|----------|
| [features/home.md](./features/home.md) | Homepage — search + app launcher |
| [features/games.md](./features/games.md) | Games catalog and trending |
| [features/forms.md](./features/forms.md) | Help hub, Forms/Guides catalogs, forms + guides |
| [features/inventory.md](./features/inventory.md) | Staff device inventory + QR |

### Whiteboard

| Document | Contents |
|----------|----------|
| [whiteboard/README.md](./whiteboard/README.md) | Whiteboard overview and index |
| [whiteboard/hub-and-board.md](./whiteboard/hub-and-board.md) | Hub UI and live `/board/{uuid}` canvas |
| [whiteboard/sync-storage.md](./whiteboard/sync-storage.md) | Durable Objects, R2 media, Excalidraw sync |
| [whiteboard/auth-libraries.md](./whiteboard/auth-libraries.md) | Clerk auth, cloud-only library, scratch 24h TTL |
| [whiteboard/share-codes.md](./whiteboard/share-codes.md) | Share codes (KV + DO) |
| [whiteboard/people-permissions.md](./whiteboard/people-permissions.md) | Owner / Manager / Editor / Viewer; Follow vs Follow User camera lock |

## Quick pointers

### Stack

- **Astro 7** with `@astrojs/cloudflare` (`output: 'server'`; every page sets `prerender = true`)
- **Cloudflare Worker** `scsfoxchase-tech` — custom entry `src/worker.ts`
- **React** islands (`@astrojs/react`) for Clerk header auth and the Whiteboard canvas
- **Excalidraw 0.18.1** (MIT) on a Durable Object WebSocket — product name is Whiteboard; no tldraw license key
- **Node.js 22+** (`package.json` `engines`)

### Domain and deploy

- **Live domain:** [https://scsfoxchase.tech](https://scsfoxchase.tech)
- **Build:** `npm run build` → assets under `dist/client/`
- **Deploy:** `npx wrangler deploy` (or `npm run deploy`)

### Where things live

| Concern | Location |
|---------|----------|
| **Static / prerendered site** | Astro pages → Worker Assets (`ASSETS` / `dist/client`) served via `@astrojs/cloudflare/handler` |
| **Whiteboard APIs** | `/api/whiteboard/*` in `src/worker.ts` and `src/worker/` (DO, R2, KV, Clerk) |
| **PWA** | `public/sw.js`, `public/manifest.json`, `/offline` |

### Primary routes

| Route | Purpose |
|-------|---------|
| `/` | Homepage — search bars + app launcher |
| `/games` | Game catalog |
| `/help` | Help hub (featured Forms + Guides) |
| `/forms` | Forms catalog |
| `/guides` | Guides catalog |
| `/form/*` | Individual forms |
| `/guide/{slug}` | Guide articles |
| `/inventory` | Staff device inventory lookup + QR |
| `/whiteboard` | Whiteboard hub (create, join; cloud Recents/Library when signed in; canvas assets stay board-scoped) |
| `/board/{uuid}` | Live multiplayer board (Excalidraw + DO WebSocket) |
| `/offline` | Canonical offline fallback |
| `/oldgames` | Legacy game catalog |

Whiteboard HTTP/WebSocket APIs (Worker, not prerendered pages):

| Path | Role |
|------|------|
| `/api/whiteboard/connect/:uuid` | WebSocket upgrade → Durable Object (Excalidraw collab) |
| `/api/whiteboard/join/:code` | Resolve share code → board UUID |
| `/api/whiteboard/boards/:uuid/code` | Get / mint share code (DELETE is internal revoke) |
| `/api/whiteboard/boards/:uuid/meta` | Saved-to-library + Google Owner (lifts 24h TTL) |
| `/api/whiteboard/boards/:uuid/participants/:sessionId` | PATCH role (Owner / Manager) |
| `/api/whiteboard/boards/:uuid/force-follow` | PATCH Follow User / force-follow (Owner / Manager) |
| `/api/whiteboard/boards/:uuid/assets/:fileId` | Board-scoped R2 media with Durable Object manifest |
| `/api/whiteboard/assets/:ownerKey/:assetId` | Legacy owner-key R2 media PUT/GET/DELETE |
| `/api/whiteboard/library/boards` | Cloud board index (Clerk) |
| `/api/whiteboard/library/assets` | Cloud asset index (Clerk) |

### Local commands

```bash
npm install
npm run dev       # Astro dev (host open)
npm run build     # → dist/client/
npm run preview   # production build preview
npm run deploy    # build + wrangler deploy
```

### Root companions (outside this tree)

| File | Role |
|------|------|
| [`AGENTS.md`](../AGENTS.md) | Short agent briefing (stack, routes, devices) |
| [`DEPLOYMENT.md`](../DEPLOYMENT.md) | Workers Builds and deploy checklist |
| [`FORMS.md`](../FORMS.md) | Help / Forms / Guides routes and field notes |
| [`README.md`](../README.md) | Project README / getting started |
