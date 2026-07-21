# Games detail modal

**Date:** 2026-07-21  
**Status:** Draft for review  
**Page:** `/games` (`NewGamesCatalog` + max-media grid)  
**Approach:** Extend existing vanilla `games-catalog.ts` (no React island)

## Goal

Let students and teachers preview a game’s art, grades, type/genre, and short description in a modal before launching it. Match the interaction feel of the geozerd gallery collection modal (overlay, blur, close control) without copying the fan-deck UI.

## Non-goals

- Fan / stacked photo decks
- Changing game JSON schema or bulk-writing new descriptions (all 124 games already have `description`)
- React Lightbox / shared-element transitions from geozerd
- Changing the trending hero’s click behavior (hero stays a direct play link unless we revisit later)

## Current behavior

- `/games` uses `data-card-style="max"` cards: image + one-line title.
- The entire card click opens `game.url` in a new tab.
- Descriptions, grades, and category chips exist in data and in the legacy full card renderer, but are hidden on max-media cards.

## Desired behavior

### Card clicks (max-media grid)

| Target | Action |
|--------|--------|
| Card image | Open `game.url` in a new tab (unchanged launch path) |
| Card title (`h4`) | Open the detail modal for that game |

Implementation note: remove the whole-card click listener on max-media cards; attach play to the image and modal-open to the title. Use `cursor: pointer` on both. Title should be keyboard-activable (`button` or `role="button"` + Enter/Space, or a real `<button>` styled as the title).

### Modal chrome

- Fixed full-viewport overlay, centered panel, `role="dialog"` + `aria-modal="true"` + labelled by game name.
- **Backdrop:** dimmed veil + background blur (`backdrop-filter` / `-webkit-backdrop-filter`), consistent with existing site frosted UI.
- Click backdrop → close.
- **Escape** → close.
- Top-right close control using Lucide **X** (reuse `iconTimes` from `src/scripts/icons.ts` or equivalent Lucide X markup).
- Lock `document.body` scroll while open; restore on close.
- Focus close button (or Play) on open; return focus to the title that opened the modal on close.

### Modal content layout

**Always stacked** (wide and narrow share the same structure; narrow may use slightly tighter padding). Order top → bottom:

```
┌──────────────────────────────────────────────────┐
│                                           [X]    │
│  ┌────────────────────────────────────────────┐  │
│  │              image (16:9, play)            │  │
│  └────────────────────────────────────────────┘  │
│                   Game title                     │
│ ──────────────────────────────────────────────── │
│         Grade │ Type │ Genre  (one row)          │
│ ──────────────────────────────────────────────── │
│              Short description…                  │
│                   [ Play ]                       │
└──────────────────────────────────────────────────┘
```

**Stack order**

1. **Photo** — large game image (`game.image`), always **16:9 crop** (`object-fit: cover` — same treatment as max-media cards on `/games`). Keep roughly the current enlarged size (~1.5× the first modal). Click → open `game.url`. Accessible name e.g. “Play {name}”.
2. **Game title** — centered under the photo (same visual idea as max-media card titles on `/games`).
3. **Chips row** — still **one row**, three equal columns: **Grade** (`minGrade`…`maxGrade`), **Type** (`primaryCategories`), **Genre** (`secondaryCategories`), using existing chip color helpers. Horizontal separators above/below the row (title ↔ chips, chips ↔ description); vertical separators between Grade | Type | Genre (`--border-color`).
4. **Description** (`game.description`, centered), then **Play** button — opens `game.url` (`noopener,noreferrer`). Same destination as image click.

Panel scrolls internally (`max-height` ~88vh) when content exceeds the viewport so Chromebooks/iPads still fit.

## Data

No schema changes. Populate from existing `Game` fields:

| Field | Use in modal |
|-------|----------------|
| `name` | Dialog title under photo / `aria-labelledby` |
| `image` | Cover art + click-to-play |
| `url` | Image click, Play button |
| `description` | Body copy |
| `minGrade` / `maxGrade` | Grade chips |
| `primaryCategories` | Type chips |
| `secondaryCategories` | Genre chips |

## Architecture

**Files (expected touch set):**

1. `src/scripts/games-catalog.ts` — split max-media click handlers; add modal open/close/fill helpers; single shared modal DOM node appended once (create on first open or at init).
2. `src/styles/newgames.css` (preferred) and/or `src/styles/global.css` — modal layout, blur backdrop, badge row, Play button; dark theme via existing `[data-theme="dark"]` tokens.
3. Optionally `src/scripts/icons.ts` — already has `iconTimes`; wire into close button.
4. `docs/features/games.md` — brief note on detail modal after ship (docs only if we update feature docs in the same change set).

**Not introducing:** new npm deps, React islands, or content collection changes.

## Interaction / a11y checklist

- [ ] Only one modal instance; refilled per game
- [ ] Backdrop click and Escape close
- [ ] Close button has accessible name (“Close”)
- [ ] Dialog labelled with game name
- [ ] Image and Play both announce as opening/playing the game
- [ ] Focus trap is nice-to-have; at minimum focus moves into dialog on open and returns to opener on close
- [ ] `/api/*` and service worker unchanged

## Visual direction

Stay inside St. Cecilia design system:

- Primary green `#125F31`, secondary yellow `#F6D724`
- Border radius `2px` on panel / buttons (not pill-heavy chrome)
- Reuse existing `.chip` / filter chip visual language for Type and Genre
- Grade chips can mirror filter grade chips on the sidebar for consistency

Blur: overlay backdrop with semi-transparent fill + `backdrop-filter: blur(~12px)` (site convention), not geozerd’s “blur the rest of the document” HTML-class technique unless Chromebook testing shows backdrop-filter is insufficient.

## Testing (manual)

1. Click title on a max-media card → modal opens with correct art, grades, type, genre, description.
2. Click card image → game opens; modal does not open.
3. In modal: click image → game opens; click Play → game opens; click X → closes; click backdrop → closes; Escape → closes.
4. Dark mode: panel and chips remain readable.
5. 1366×768 Chromebook and ~1024px iPad landscape: modal fits / scrolls inside panel without breaking the page layout.
6. Filter/search still work; opening a modal does not reset filters.
7. Stacked layout: photo → centered title → Grade|Type|Genre row → description → Play; same order on wide and narrow.

## Open decisions (resolved)

| Topic | Decision |
|-------|----------|
| Implementation style | Vanilla extension of `games-catalog.ts` (Approach A) |
| Descriptions | Use existing JSON `description` fields |
| Play in modal | Yes — button **and** clickable image |
| Close control | Lucide X in corner + backdrop + Escape |
| Backdrop | Dim + blur |
| Body layout | Always stacked: photo → centered title → Grade\|Type\|Genre row → description → Play |
