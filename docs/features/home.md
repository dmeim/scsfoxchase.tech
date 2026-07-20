# Homepage (`/`)

Student/teacher dashboard: three smart search bars and a two-column app launcher. Prerendered Astro page; no Worker API involved.

## Route

| Route | Source | Notes |
|-------|--------|-------|
| `/` | `src/pages/index.astro` | Title: “St. Cecilia Technology”; `bodyClass="home-page"` |
| `/newhome`, `/hub`, `/hub.html` | `astro.config.mjs` `redirects` | Redirect to `/` |
| `/newhome/` | `public/_redirects` | `301` → `/` |

Layout: `BaseLayout` → `SmartSearch` + `AppLauncher`. Styles: `src/styles/home.css` (imported by the page). Shared chrome: header/footer via `BaseLayout` / `src/styles/global.css`.

## Smart search bars

Component: `src/components/SmartSearch.astro`. Behavior: `src/scripts/smart-search.ts`.

Three titled fields open the chosen destination in a new tab. Each bar has a picker (default option listed first). Submit replaces `{query}` in the option’s `data-url` with the encoded input.

### G-Suite

| Option | Search URL template |
|--------|---------------------|
| Drive (default) | `https://drive.google.com/drive/u/0/search?q={query}` |
| Docs | `https://docs.google.com/document/u/0/?tgif=d&q={query}` |
| Slides | `https://docs.google.com/presentation/u/0/?tgif=d&q={query}` |
| Sheets | `https://docs.google.com/spreadsheets/u/0/?tgif=d&q={query}` |
| Gmail | `https://mail.google.com/mail/u/0/#search/{query}` |
| Calendar | `https://calendar.google.com/calendar/u/0/r/search?q={query}` |

### Google

| Option | Search URL template |
|--------|---------------------|
| Web (default) | `https://www.google.com/search?udm=web&q={query}` |
| Image | `https://www.google.com/search?udm=2&q={query}` |
| Videos | `https://www.google.com/search?tbm=vid&q={query}` |
| Books | `https://www.google.com/search?tbm=bks&q={query}` |
| News | `https://www.google.com/search?tbm=nws&q={query}` |
| Maps | `https://www.google.com/maps/search/{query}` |

### Sites

| Option | Search URL template |
|--------|---------------------|
| Wikipedia (default) | `https://en.wikipedia.org/wiki/Special:Search?search={query}` |
| Scholar | `https://scholar.google.com/scholar?q={query}` |
| IXL | `https://www.ixl.com/search?q={query}` |
| YouTube | `https://www.youtube.com/results?search_query={query}` |

Empty query focuses the input and does not navigate. Clear button empties the field.

## App launcher

Component: `src/components/AppLauncher.astro`. Two group cards in `.newhome-workflow-grid-2`: **G-Suite** and **Sites**. Tiles use `.mockup-link` (frosted tile styles in `home.css`); all links open in a new tab (`target="_blank"`).

### G-Suite

| Label | Target |
|-------|--------|
| Classroom | Google Classroom sign-in continue URL |
| Drive | `https://drive.google.com` |
| Docs | `https://docs.google.com` |
| Sheets | `https://sheets.google.com` |
| Slides | `https://slides.google.com` |
| Calendar | `https://calendar.google.com` |
| Gmail | `https://mail.google.com` |
| Meet | `https://meet.google.com` |
| Tasks | `https://tasks.google.com/` |
| Vids | `https://docs.google.com/videos/u/0/` |
| Keep | `https://keep.google.com/` |

### Sites

| Label | Target |
|-------|--------|
| IXL | School IXL sign-in (`/signin/saintcecilia`) |
| TypeSetGo | `https://typesetgo.app` |
| Sumdog | School Sumdog URL (`play.sumdog.com/sch/stcecilia8`) |
| TinkerCAD | `https://www.tinkercad.com/login` |
| Typing.com | `https://www.typing.com/student/lessons` |
| Prodigy | `https://sso.prodigygame.com/game/login` |
| Lumio | `https://www.hellosmart.com/link/` |
| Monkeytype | Monkeytype with preset `testSettings` query |
| Canva | `https://www.canva.com/login/` |
| Destiny | Follett Destiny Discover portal (school-specific `appId` / `siteGuid`) |

Icons live under `public/images/` (paths referenced in the component).

## Key files

| File | Role |
|------|------|
| `src/pages/index.astro` | Route entry |
| `src/components/SmartSearch.astro` | Search UI + option URLs |
| `src/components/AppLauncher.astro` | Launcher tiles |
| `src/scripts/smart-search.ts` | Picker + submit |
| `src/styles/home.css` | Dashboard layout, search bars, tiles |
| `src/styles/global.css` | Shared layout / theme |
| `src/scripts/theme-toggle.ts` | Theme toggle (header host) |

Header nav (Home / Games / Forms) is in `src/components/Header.astro`; home is active when the path is `/`.
