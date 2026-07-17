# Forms

Student/staff help-request forms on scsfoxchase.tech. Hub launches individual form pages; submissions will eventually POST to n8n webhooks.

## Routes

| Route | Label | Lucide icon | Status |
|-------|-------|-------------|--------|
| `/forms` | Forms hub | — | Live (launcher only) |
| `/forms/game-request` | Request A Game | `Gamepad2` | UI form (no webhook yet) |
| `/forms/help-tech` | General Technology Help | `Wrench` | Stub |
| `/forms/help-account` | Google/Account Help | `KeyRound` | Stub |

## Key files

| File | Role |
|------|------|
| `src/pages/forms.astro` | Hub page |
| `src/pages/forms/*.astro` | Individual form pages / stubs |
| `src/components/FormsLauncher.astro` | Hub tile links + icons |
| `src/components/Header.astro` | Nav link (Home → Games → Forms) |
| `src/styles/forms.css` | Hub grid + shared form field/panel styles |
| `src/styles/home.css` | Shared `.mockup-link` frosted tile styles |
| `src/scripts/icons.ts` | `iconGamepad2`, `iconWrench`, `iconKeyRound` |

## UI notes

- Hub tiles match homepage frosted `mockup-link` treatment (styles live in `forms.css` as `.forms-tile`).
- Forms pages use `bodyClass="forms-page"` (not `home-page`) so home dashboard container rules cannot override layout.
- **Page width:** all forms pages use `.container.form-shell` at **1120px** — same as inventory’s `.container.asset-shell`.
- `forms.css` is imported from `BaseLayout.astro` so it ships in the shared layout CSS bundle (avoids small-CSS inline-before-global prod/dev drift).

## Adding a form later

1. Add a stub page under `src/pages/forms/<slug>.astro`.
2. Add an entry to the `forms` array in `FormsLauncher.astro` (href, label, icon).
3. If needed, add a Lucide SVG string to `src/scripts/icons.ts`.
4. Update this table and `AGENTS.md` Key Pages.

## Form: Request A Game (`/forms/game-request`)

Fields:

| Field | `name` | Type | Notes |
|-------|--------|------|-------|
| Game Name | `gameName` | text | required; hint: official name if known, otherwise the name you know |
| URL | `gameUrl` | url | required; hint: full link to game site; placeholder `https://` |
| Game Description | `gameDescription` | textarea | required; hint: keep under a paragraph |

Submit currently only runs browser validation and `preventDefault` (no network call). Wire to n8n later via a Worker/API proxy.

Form intro (under title) covers: school-appropriate requirement, no multi-game hosts (Poki/CrazyGames), and that requests are for review only.

Shared form chrome styles live in `src/styles/forms.css` (`.form-panel`, `.tech-form`, `.form-field`, `.form-intro`).

## Future: n8n webhooks

Each form will submit to an n8n webhook (one workflow per form or a shared router with a `formId` field). When wiring:

- Prefer a Cloudflare Worker/API route or Astro action that proxies to n8n so the webhook URL/secret never ships to the browser.
- Record webhook URL env var names here when created (e.g. `N8N_WEBHOOK_GAME_REQUEST`).
- Do not put production webhook URLs in client-side code or git.

Until then, help-tech / help-account stubs stay as placeholders; game-request is UI-only (no network submit).
