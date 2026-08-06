# Help

Student/staff technology help on scsfoxchase.tech: a Help hub, Forms and Guides catalogs, individual forms (n8n later), and Markdown guides with footnote sources.

## Routes

| Route | Label | Status |
|-------|-------|--------|
| `/help` | Help hub — featured Forms + Guides | Live |
| `/forms` | Forms catalog (all forms) | Live |
| `/guides` | Guides catalog (all guides) | Live |
| `/form/game-request` | Request A Game | UI form (no webhook yet) |
| `/form/help-tech` | General Technology Help | Stub |
| `/form/help-account` | Google/Account Help | Stub |
| `/guide/how-to-use-help` | How to use this Help site | Sample / authoring reference |
| `/guide/recover-deleted-file-google-drive` | Recover a deleted file in Google Drive | Live |
| `/guide/find-files-google-drive` | Find files in Google Drive | Live |
| `/guide/delete-files-google-drive` | Delete files in Google Drive | Live |
| `/guide/get-started-google-drive` | Get started with Google Drive | Live |
| `/guide/manage-google-storage` | Manage Google storage | Live |
| `/guide/upload-download-open-google-drive` | Upload, download, and open files in Google Drive | Live |
| `/guide/pdfs-video-and-web-in-google-drive` | PDFs, video, and web content in Google Drive | Live |
| `/guide/organize-files-google-drive` | Organize files in Google Drive | Live |
| `/guide/share-files-google-drive` | Share files and folders in Google Drive | Live |
| `/guide/shared-drives-and-access-google-drive` | Shared drives and access limits in Google Drive | Live |
| `/guide/use-google-drive-for-desktop` | Use Google Drive for desktop | Live |
| `/guide/fix-google-drive-problems` | Fix common Google Drive problems | Live |

Nav label is **Help** → `/help`. Active for `/help`, `/forms`, `/guides`, `/form/*`, and `/guide/*`.

## Key files

| File | Role |
|------|------|
| `src/pages/help.astro` | Help hub (featured sections + View All) |
| `src/pages/forms.astro` | Forms catalog |
| `src/pages/guides.astro` | Guides catalog |
| `src/pages/form/*.astro` | Individual form pages / stubs |
| `src/pages/guide/[slug].astro` | Guide article from content collection |
| `src/data/forms.ts` | Forms catalog metadata (`featured`, icons, slugs) |
| `src/content/guides/*.md` | Guide articles (frontmatter + body) |
| `src/content.config.ts` | `guides` collection schema |
| `src/components/HelpSection.astro` | Section header + View All + tile grid |
| `src/components/FormsLauncher.astro` | Forms tile grid from `forms.ts` |
| `src/components/Header.astro` | Nav link (Home → Games → Help) |
| `src/styles/forms.css` | Help hub, catalogs, form fields, guide article styles |

## UI notes

- Hub/catalog tiles reuse frosted `.forms-tile` treatment.
- Help/catalog pages use `bodyClass="help-page"`; individual forms use `forms-page`. Both share `.container.form-shell` at **1600px** (same as games / global `.container`). Home keeps its own layout.
- Featured tiles on `/help` come from `featured: true` in `src/data/forms.ts` and guide frontmatter.

## Adding a form

1. Add `src/pages/form/<slug>.astro`.
2. Add an entry to `forms` in `src/data/forms.ts` (`slug`, `label`, `description`, `icon`, `featured`, `status`).
3. If needed, add a Lucide SVG string to `src/scripts/icons.ts`.
4. Update this table and `AGENTS.md` Key Pages.

## Adding a guide

1. Create `src/content/guides/<slug>.md` using `how-to-use-help.md` as the template.
2. Set frontmatter: `title`, `description`, `featured`, and optional `sources`.
3. For external/scraped claims, insert `<sup class="guide-fn"><a href="#source-N">N</a></sup>` and a matching `sources` entry with `id: "N"`.
4. The Sources footer renders as favicon chips (title label); do not duplicate it in the Markdown body.

## Form: Request A Game (`/form/game-request`)

Fields:

| Field | `name` | Type | Notes |
|-------|--------|------|-------|
| Game Name | `gameName` | text | required; hint: official name if known, otherwise the name you know |
| URL | `gameUrl` | url | required; hint: full link to game site; placeholder `https://` |
| Game Description | `gameDescription` | textarea | required; hint: keep under a paragraph |

Submit currently only runs browser validation and `preventDefault` (no network call). Wire to n8n later via a Worker/API proxy.

Form intro (under title) covers: school-appropriate requirement, no multi-game hosts (Poki/CrazyGames), and that requests are for review only.

## Future: n8n webhooks

Each form will submit to an n8n webhook (one workflow per form or a shared router with a `formId` field). When wiring:

- Prefer a Cloudflare Worker/API route or Astro action that proxies to n8n so the webhook URL/secret never ships to the browser.
- Record webhook URL env var names here when created (e.g. `N8N_WEBHOOK_GAME_REQUEST`).
- Do not put production webhook URLs in client-side code or git.

Until then, help-tech / help-account stubs stay as placeholders; game-request is UI-only (no network submit).
