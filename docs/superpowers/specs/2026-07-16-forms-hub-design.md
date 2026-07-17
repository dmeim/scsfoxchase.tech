# Forms Hub Design

**Date:** 2026-07-16  
**Status:** Approved (style A — frosted homepage tiles)

## Goal

Add a Forms section for students/staff to open help request forms. Forms will later POST to n8n webhooks; this phase is nav + hub + empty route stubs only.

## Routes

| Route | Page | Content (this phase) |
|-------|------|----------------------|
| `/forms` | Hub | Three frosted tiles linking to form stubs |
| `/forms/game-request` | Request A Game | Empty stub (layout + title only) |
| `/forms/help-tech` | General Technology Help | Empty stub |
| `/forms/help-account` | Google/Account Help | Empty stub |

## Navigation

- Header: Home → Games → **Forms** (before theme toggle)
- Active when pathname is `/forms` or starts with `/forms/`

## UI

- Reuse homepage `mockup-link` frosted tile styling (`home.css`)
- Lucide icons (inline SVG via `icons.ts`):
  - Request A Game → `Gamepad2`
  - General Technology Help → `Wrench`
  - Google/Account Help → `KeyRound`
- Three-column row on desktop; stack on narrow viewports; fit Chromebook height constraints

## Architecture

- Hardcoded `FormsLauncher.astro` (same pattern as `AppLauncher.astro`)
- No form fields, validation, or webhook calls in this phase
- Future: client/server submit → n8n webhook per form; document endpoints in `FORMS.md`

## Docs

- `FORMS.md` — agent reference for routes, icons, future webhook wiring
- `AGENTS.md` — add Forms to Key Pages table

## Out of scope

- Actual form UIs and n8n integration
- Content collection / data-driven form registry
