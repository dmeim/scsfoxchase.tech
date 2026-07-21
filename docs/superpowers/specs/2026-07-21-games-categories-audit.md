# Games Type / Genre taxonomy audit

**Date:** 2026-07-21  
**Status:** **Approved 2026-07-21** — taxonomy locked for Phase 2 (no game JSON rewritten yet). Exception: **REMOVE Free to Play** only; Real-Time, PvP, and Co-op stay as Types.  
**Scope:** `src/content/games/*.json` (124 files)  
**Audience:** St. Cecilia Technology, grades 1–8 (students + teachers)

## Hard constraints (apply in Phase 2)

| Field | Cap | Notes |
|-------|-----|--------|
| `primaryCategories` (Type) | **≤ 3** | Play-mode / platform style only |
| `secondaryCategories` (Genre) | **≤ 5** | Content / feel only |

Phase 2 updaters must pick the **strongest** ≤3 Types and ≤5 Genres per game (most useful for school sidebar filters). Drop weaker or redundant tags rather than packing every applicable label.

**Caps enforcement:** Enforce in Phase 2 content practice (migration + trim). Optional Zod `.max(3)` / `.max(5)` in `content.config.ts` later — docs note only for now.

### Cap pressure today (before cleanup)

| Metric | Count |
|--------|-------|
| Games with >3 Types | **43** (40× five tags, 3× four) |
| Games with exactly 3 Types | 81 |
| Games with >5 Genres | **4** (all six tags) |
| Games with ≤5 Genres | 120 |

Over-cap Type pattern is almost always:  
`Multiplayer + Online + PvP + Real-Time + Free to Play` (or board games: `Single Player + Multiplayer + Online + Turn-Based + Free to Play`).

Over-cap Genre games: `build-royale`, `goober-dash`, `nugget-royale`, `suroi`.

Removing **Free to Play** (124/124, zero filter value) frees one slot on every game. Real-Time, PvP, and Co-op remain Types; when many apply, Phase 2 priority below trims to ≤3.

## Split rule

- **Type** = how you play / where it runs: Single/Multi, Online/Offline, Turn-Based, Real-Time, PvP, Co-op, Educational Hub  
- **Genre** = what it feels like / subject: Puzzle, Math, Party, Sandbox, etc.  
- Avoid Type↔Genre redundancy where possible (e.g. do not *require* both Type `PvP` and Genre `Competitive`; use both only when each adds a distinct filter path).

## Current Type inventory (`primaryCategories`)

| Type | Count |
|------|------:|
| Free to Play | 124 |
| Online | 101 |
| Single Player | 86 |
| Multiplayer | 47 |
| Real-Time | 34 |
| PvP | 33 |
| Offline | 23 |
| Turn-Based | 6 |
| Co-op | 1 |

Every game has ≥1 primary; none empty. Online/Offline are mutually exclusive (0 overlap). Single+Multi together on 9 games (mostly board games + Kahoot/OpenGuessr). `Free to Play` is on **all 124** → zero filter value.

## Current Genre inventory (`secondaryCategories`)

| Genre | Count | Genre | Count |
|-------|------:|-------|------:|
| Casual | 42 | Competitive | 34 |
| Puzzle | 33 | Action | 29 |
| Educational | 23 | Daily Challenge | 21 |
| Kids | 21 | IO Games | 20 |
| Classics | 19 | Word Games | 18 |
| Art & Creativity | 17 | Arcade | 16 |
| Brain Teaser | 14 | Sandbox | 13 |
| Strategy | 13 | Retro | 10 |
| Trivia | 10 | Math | 9 |
| Party | 9 | Survival | 9 |
| Battle Royale | 8 | Board Games | 6 |
| Exploration | 6 | Geography | 6 |
| Logic | 6 | Reaction Speed | 6 |
| Spelling | 6 | Sports | 6 |
| FPS / Shooter | 4 | Number Puzzles | 4 |
| Science | 4 | Building | 3 |
| Endless Runner | 3 | Obstacle Course | 3 |
| Physics | 3 | Platformer | 3 |
| Tile Matching | 3 | Adventure | 2 |
| Crafting | 2 | Crossword | 2 |
| Early Learning | 2 | Mindfulness | 2 |
| Minecraft-Style | 2 | Music | 2 |
| Open World | 2 | Active | 1 |
| Card Games | 1 | Cooking | 1 |
| Driving & Racing | 1 | Holiday | 1 |
| Movement | 1 | Racing | 1 |
| Reading | 1 | Vocabulary | 1 |

**58 unique genres.** Avg ~3.9 genres/game. Color map in `src/scripts/games-catalog.ts` also defines unused labels **Memory**, **Mouse Skill**, **Typing** (not in any JSON).

### Consistency notes (spot-check)

- **Junk / theme tags:** `Cooking` on Foodle (word game); `Holiday` singleton (Santa Tracker).  
- **Near-duplicates:** Racing vs Driving & Racing; Active/Movement/Mindfulness; Puzzle vs Brain Teaser/Logic/Number Puzzles/Tile Matching; Classics vs Retro; Minecraft-Style/Open World/Building vs Sandbox.  
- **Vague dumps:** `Casual` (42), `Kids` (21 overlapping Educational + grade range).  
- **School-sensitive:** `FPS / Shooter` (4) — prefer folding into Action for chip UI.  
- **Hubs tagged only as Educational genre:** ABCya, Coolmath, Math Playground, PBS Kids, etc. — good candidates for Type `Educational Hub`.

## Recommended Type list (canonical names only)

1. Single Player  
2. Multiplayer  
3. Online  
4. Offline  
5. Turn-Based  
6. Educational Hub  
7. Real-Time  
8. PvP  
9. Co-op  

### Type keep / rename-merge / add / remove

| Action | Label | Why |
|--------|-------|-----|
| Keep | Single Player, Multiplayer | Core school filter (solo vs with friends/class) |
| Keep | Online, Offline | Chromebook / connectivity reality; currently clean partition |
| Keep | Turn-Based | Quiet classroom / board-game pacing; only 6 today but high signal |
| Keep | Real-Time | Distinct from Turn-Based; useful for live multiplayer pacing |
| Keep | PvP | Competitive vs mode; Genre `Competitive` may still apply when useful |
| Keep | Co-op | Cooperative play distinct from generic Multiplayer (even if n=1 today) |
| Add | Educational Hub | Portals/collections (ABCya, Coolmath, PBS Kids…) distinct from a single educational title |
| Remove | Free to Play | 124/124 — noise; wastes a Type slot under ≤3 |

### Phase 2 Type selection priority (when >3 would apply)

Pick up to **3**, in this preference order:

1. **Mode:** `Single Player` and/or `Multiplayer` (both allowed if truly dual-mode). Include `Co-op` when play is truly cooperative — it counts toward the 3.  
2. **Connectivity:** `Online` **XOR** `Offline` (never both).  
3. **Then** pick the strongest among: `Turn-Based`, `Real-Time`, `PvP`, `Educational Hub`.

**Avoid:** Never both `Online` + `Offline`. Prefer not `Real-Time` + `Turn-Based` together.

**Resolved defaults when forced to 3:**

- Dual-mode board games (chess, etc.): **Multiplayer + Online + Turn-Based**  
- Learning portals: **Single Player + Online + Educational Hub** (or Offline if the hub works offline)  
- Live competitive multiplayer: prefer **Multiplayer + Online + PvP** or **Multiplayer + Online + Real-Time** (pick the stronger signal for that title)  
- Cooperative multiplayer: **Multiplayer + Online + Co-op** (drop Real-Time/PvP if over cap)

## Recommended Genre list (canonical names only)

1. Action  
2. Arcade  
3. Art & Creativity  
4. Battle Royale  
5. Board Games  
6. Classics  
7. Competitive  
8. Daily Challenge  
9. Educational  
10. Geography  
11. IO Games  
12. Math  
13. Movement  
14. Music  
15. Party  
16. Puzzle  
17. Racing  
18. Sandbox  
19. Science  
20. Sports  
21. Strategy  
22. Survival  
23. Trivia  
24. Word Games  

### Genre keep / rename-merge / add / remove

| Action | Label | Why |
|--------|-------|-----|
| Keep | Action, Arcade, Art & Creativity, Board Games, Classics, Competitive, Daily Challenge, Educational, Geography, IO Games, Math, Music, Party, Puzzle, Sandbox, Science, Sports, Strategy, Survival, Trivia, Word Games | High use and/or clear school meaning |
| Keep | Battle Royale | Kids recognize it; distinct from generic Action |
| Rename/merge → Puzzle | Brain Teaser, Logic, Number Puzzles, Tile Matching, Physics | Puzzle subtypes; clutter chips |
| Rename/merge → Classics | Retro | Overlap Classics heavily |
| Rename/merge → Sandbox | Building, Minecraft-Style, Open World, Crafting | One creative/build bucket |
| Rename/merge → Word Games | Spelling, Vocabulary, Crossword, Reading | Literacy cluster |
| Rename/merge → Racing | Driving & Racing, Racing | Unify singletons |
| Rename/merge → Movement | Active, Movement, Mindfulness | Brain-break / GoNoodle cluster |
| Rename/merge → Action | FPS / Shooter, Adventure, Platformer, Endless Runner, Obstacle Course, Reaction Speed | Avoid “Shooter” chip; thin singletons |
| Rename/merge → Board Games | Card Games | Solitaire fits board/card family |
| Rename/merge → Educational | Early Learning, Kids, Holiday | Age covered by grade filter; Holiday is seasonal one-off |
| Rename/merge → Exploration? | Exploration → often with Geography/Sandbox — **map to Geography or Sandbox** by game | Avoid weak sixth chip |
| Remove | Casual | Vague (42); almost never the best filter |
| Remove | Cooking | Theme junk on Foodle |
| Do not add | Memory, Mouse Skill, Typing | In color map only; unused — omit unless real games need them |

`Competitive` stays as **Genre** (not Type) so ≤3 Types stay available for mode/connectivity/pacing. Type `PvP` may coexist with Genre `Competitive` only when both earn a filter slot.

### Phase 2 Genre selection priority (when >5 would apply)

Prefer tags that a teacher/student would actually click:

1. Subject / activity: Math, Word Games, Geography, Science, Music, Movement, Educational  
2. Distinct form: Puzzle, Board Games, Party, IO Games, Battle Royale, Daily Challenge, Sandbox, Art & Creativity  
3. Feel: Action, Arcade, Strategy, Sports, Survival, Classics, Trivia, Competitive, Racing  

Drop redundant siblings after merge (e.g. keep `Puzzle`, drop `Brain Teaser`). Prefer **≤4** when possible; use the 5th only when it adds a real second discovery path.

## Migration map (old → new | REMOVE)

### Types

| Old | New |
|-----|-----|
| Single Player | Single Player |
| Multiplayer | Multiplayer |
| Online | Online |
| Offline | Offline |
| Turn-Based | Turn-Based |
| Real-Time | Real-Time |
| PvP | PvP |
| Co-op | Co-op |
| Free to Play | **REMOVE** |
| *(none)* | **ADD** Educational Hub (hubs/portals only) |

### Genres

| Old | New |
|-----|-----|
| Action | Action |
| Arcade | Arcade |
| Art & Creativity | Art & Creativity |
| Battle Royale | Battle Royale |
| Board Games | Board Games |
| Card Games | Board Games |
| Classics | Classics |
| Retro | Classics |
| Competitive | Competitive |
| Daily Challenge | Daily Challenge |
| Educational | Educational |
| Early Learning | Educational |
| Kids | Educational *(or REMOVE if Educational already present / grades suffice)* |
| Holiday | Educational *(or REMOVE)* |
| Geography | Geography |
| Exploration | Geography **or** Sandbox (pick one per game) |
| IO Games | IO Games |
| Math | Math |
| Active | Movement |
| Movement | Movement |
| Mindfulness | Movement |
| Music | Music |
| Party | Party |
| Puzzle | Puzzle |
| Brain Teaser | Puzzle |
| Logic | Puzzle |
| Number Puzzles | Puzzle |
| Tile Matching | Puzzle |
| Physics | Puzzle |
| Driving & Racing | Racing |
| Racing | Racing |
| Sandbox | Sandbox |
| Building | Sandbox |
| Minecraft-Style | Sandbox |
| Open World | Sandbox |
| Crafting | Sandbox |
| Science | Science |
| Sports | Sports |
| Strategy | Strategy |
| Survival | Survival |
| Trivia | Trivia |
| Word Games | Word Games |
| Spelling | Word Games |
| Vocabulary | Word Games |
| Crossword | Word Games |
| Reading | Word Games |
| FPS / Shooter | Action |
| Adventure | Action |
| Platformer | Action |
| Endless Runner | Action |
| Obstacle Course | Action *(or Party if Stumble Guys–style)* |
| Reaction Speed | Action **or** Arcade |
| Casual | **REMOVE** |
| Cooking | **REMOVE** |
| Memory / Mouse Skill / Typing | **do not introduce** |

## Docs impact (later)

| Doc | Mentions categories? | Update later? |
|-----|----------------------|---------------|
| `docs/features/games.md` | Dynamic Type/Genre chips; schema example with PvP/Real-Time/Free to Play | Yes — examples + note ≤3/≤5; drop Free to Play from examples |
| `docs/conventions.md` | Example primary/secondary arrays | Yes — examples + caps |
| `docs/superpowers/specs/2026-07-21-games-detail-modal-design.md` | Chips row uses fields; no fixed vocabulary | Soft — optional note on caps |
| `src/scripts/games-catalog.ts` | `PRIMARY_CATEGORY_COLORS` / `SECONDARY_CATEGORY_COLORS` | Yes — align color maps to canonical lists (incl. Educational Hub; drop Free to Play) |
| No hardcoded allowlist in content schema today | Chips = union of labels in collection | Caps: Phase 2 content practice first; optional Zod `.max(3)` / `.max(5)` later |

## Resolved questions (defaults)

1. **Dual-mode board games (chess, etc.):** When forced to 3 → **Multiplayer + Online + Turn-Based**.  
2. **Educational Hub vs Educational genre:** Hubs get Type `Educational Hub` **and** may keep Genre `Educational` (+ subject like Math) when useful.  
3. **Battle Royale:** **Keep** as its own Genre.  
4. **Enforce caps in `content.config.ts`?** Phase 2 content practice first; Zod schema optional later (docs note only).

## Phase 2 reminder

- Do not exceed **3** Types / **5** Genres per game.  
- Apply migration map (strip Free to Play; keep Real-Time / PvP / Co-op when they earn a slot), then **trim to strongest** remaining tags for school filters.  
- Update color maps + docs examples after JSON migration.  
- Do not commit until human review of Phase 2 JSON edits.
