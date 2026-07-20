# Forms (`/forms`)

Hub of technology help/request form pages. Prerendered Astro; shared styles in `src/styles/forms.css` (loaded from `BaseLayout`). Operational detail also lives in root `FORMS.md` — keep that file and this page aligned when routes change.

## Routes

| Route | Label | Page | Lucide icon (via `src/scripts/icons.ts`) |
|-------|-------|------|------------------------------------------|
| `/forms` | Forms hub | `src/pages/forms.astro` | — |
| `/forms/game-request` | Request A Game | `src/pages/forms/game-request.astro` | `Gamepad2` (`iconGamepad2`) |
| `/forms/help-tech` | General Technology Help | `src/pages/forms/help-tech.astro` | `Wrench` (`iconWrench`) |
| `/forms/help-account` | Google/Account Help | `src/pages/forms/help-account.astro` | `KeyRound` (`iconKeyRound`) |

All forms pages use `bodyClass="forms-page"` and `.container.form-shell` (1120px width, same shell width pattern as inventory’s `.asset-shell`). Header nav marks Forms active for `/forms` and `/forms/*` (`src/components/Header.astro`).

## Hub (`/forms`)

`src/components/FormsLauncher.astro` renders a grid of `.forms-tile` links (frosted tile treatment in `forms.css`). Tile list is the `forms` array in that component (`href`, `label`, `icon`).

## Request A Game (`/forms/game-request`)

Full UI form with fields and client-side validation. Intro copy requires school-appropriate games, disallows multi-game host sites (e.g. Poki, CrazyGames), and states that a request is for review only — approval is required before a game is added.

| Field | `name` | Type | Required |
|-------|--------|------|----------|
| Game Name | `gameName` | text | yes |
| URL | `gameUrl` | url | yes (placeholder `https://`) |
| Game Description | `gameDescription` | textarea | yes |

Submit runs browser `required` / `type` validation, then a page script calls `preventDefault` — **no network request**. There is a “Back to Forms” link to `/forms`.

`FORMS.md` specifies that submissions should go through a Worker/API (or Astro action) proxy to an n8n webhook so the webhook URL/secret stays off the client, and that production webhook URLs must not ship in client code or git. No `N8N_WEBHOOK_*` names appear in `.env.example`.

## Help pages

### `/forms/help-tech`

Placeholder page (`forms-stub` section): heading “General Technology Help”, a short placeholder paragraph, and a “Back to Forms” link to `/forms`. No form fields or submit handlers.

### `/forms/help-account`

Same placeholder layout with heading “Google/Account Help”. No form fields or submit handlers.

## Adding a form

Documented in `FORMS.md`:

1. Add `src/pages/forms/<slug>.astro`.
2. Add an entry to the `forms` array in `FormsLauncher.astro`.
3. Add a Lucide SVG string to `src/scripts/icons.ts` if needed.
4. Update `FORMS.md` and `AGENTS.md` Key Pages.

## Key files

| File | Role |
|------|------|
| `src/pages/forms.astro` | Hub |
| `src/pages/forms/*.astro` | Individual pages |
| `src/components/FormsLauncher.astro` | Hub tiles |
| `src/styles/forms.css` | Hub + form field/panel styles |
| `src/scripts/icons.ts` | Tile icons |
| `FORMS.md` | Canonical route/icon/field notes |
