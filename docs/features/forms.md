# Help (`/help`)

Help hub plus Forms and Guides catalogs. Prerendered Astro; shared styles in `src/styles/forms.css` (loaded from `BaseLayout`). Operational detail also lives in root `FORMS.md` — keep that file and this page aligned when routes change.

## Routes

| Route | Label | Source | Notes |
|-------|-------|--------|-------|
| `/help` | Help hub | `src/pages/help.astro` | Featured Forms + Guides; View All → catalogs |
| `/forms` | Forms catalog | `src/pages/forms.astro` | All forms from `src/data/forms.ts` |
| `/guides` | Guides catalog | `src/pages/guides.astro` | All guides from `src/content/guides/` |
| `/form/game-request` | Request A Game | `src/pages/form/game-request.astro` | `Gamepad2` |
| `/form/help-tech` | General Technology Help | `src/pages/form/help-tech.astro` | Stub |
| `/form/help-account` | Google/Account Help | `src/pages/form/help-account.astro` | Stub |
| `/guide/how-to-use-help` | How to use this Help site | content collection | Authoring reference + footnotes demo |

Header nav marks **Help** active for `/help`, `/forms`, `/guides`, `/form/*`, and `/guide/*`.

Help/catalog pages use `bodyClass="help-page"`; individual forms use `forms-page`. Shell width: `.container.form-shell` (**1600px**, same as games).

## Help hub (`/help`)

Two sections via `HelpSection.astro`: **Forms** and **Guides**, each with a top-right **View All** link. Featured items come from `featured: true` on form entries and guide frontmatter.

## Forms catalog (`/forms`)

`FormsLauncher.astro` renders all entries from `src/data/forms.ts` as `.forms-tile` links to `/form/{slug}`.

## Guides

Markdown under `src/content/guides/` with schema in `src/content.config.ts` (`title`, `description`, `featured`, `sources[]`). Rendered by `src/pages/guide/[slug].astro`. External citations use `<sup class="guide-fn"><a href="#source-N">N</a></sup>`; the Sources footer is a row of favicon chips (article title + site favicon via Google s2) built from frontmatter.

Use `how-to-use-help.md` as the template for new articles.

## Request A Game (`/form/game-request`)

| Field | `name` | Required |
|-------|--------|----------|
| Game Name | `gameName` | yes |
| URL | `gameUrl` | yes (`type="url"`) |
| Game Description | `gameDescription` | yes |

Submit runs browser validation then `preventDefault` — **no network request**. “Back to Forms” links to `/forms`.

## Stubs

`/form/help-tech` and `/form/help-account` are placeholders with a “Back to Forms” link.

## Adding content

**Form:** add `src/pages/form/<slug>.astro`, then an entry in `src/data/forms.ts` (and an icon in `icons.ts` if needed).

**Guide:** add `src/content/guides/<slug>.md` from the sample template; set `featured` and `sources` as needed.

## Key files

| File | Role |
|------|------|
| `src/pages/help.astro` | Hub |
| `src/pages/forms.astro` / `guides.astro` | Catalogs |
| `src/pages/form/*.astro` | Form pages |
| `src/pages/guide/[slug].astro` | Guide pages |
| `src/data/forms.ts` | Forms metadata |
| `src/content/guides/*.md` | Guide articles |
| `src/components/HelpSection.astro` | Section + View All |
| `src/components/FormsLauncher.astro` | Forms tiles |
| `src/styles/forms.css` | Shared Help/Forms/Guides styles |
