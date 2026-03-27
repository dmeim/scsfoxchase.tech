# Game Click Tracking via Redirect

**Status:** Deferred (2026-03-27)

## Idea

Track which games are clicked most using Cloudflare Web Analytics by routing clicks through a redirect path.

Currently game cards use `window.open(game.url, '_blank')` to open external URLs directly. Cloudflare Web Analytics only tracks page views on our domain, so outbound clicks are invisible.

## Proposed Approach

Route game clicks through a path like `/go?game=math-blaster`:

1. Create a lightweight `go.html` page that reads the `game` query param
2. Look up the game's external URL from the game JSON data
3. Redirect to the external URL via `window.location.replace()`
4. Each redirect registers as a page view in Cloudflare Web Analytics
5. The dashboard's "Top Paths" report shows which games are clicked most

## Changes Needed

- New `go.html` redirect page
- Update `createGameCard()` in `js/games.js` to link to `/go?game={id}` instead of the external URL
- Update carousel click handlers similarly

## Trade-offs

- Adds a brief redirect step before the game loads
- Slightly more complex than direct links
- Requires zero backend — pure static site solution

## Why Deferred

The trending carousel (`_trending.json`) is small and infrequently updated. Teacher feedback is sufficient for curation right now. Revisit if the game catalog grows or data-driven curation becomes worthwhile.
