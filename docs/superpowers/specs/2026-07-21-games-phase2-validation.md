# Games catalog — Phase 2 validation

**Date:** 2026-07-21  
**Scope:** `src/content/games/*.json` (124 files)  
**Result:** **PASS** (after 1 mechanical fix)

## Pass / fail summary

| Check | Result |
|-------|--------|
| File count = 124 | Pass (124) |
| Valid JSON | Pass (124/124) |
| Types ⊆ canonical, ≤3, no Free to Play | Pass (after fix) |
| Genres ⊆ canonical, ≤5 | Pass (after fix) |
| Online XOR Offline | Pass (102 Online, 22 Offline, 0 both, 0 neither) |
| Real-Time AND Turn-Based | Pass (0 games) |
| minGrade / maxGrade integers 1–8, min≤max | Pass (124/124) |
| Description present; ≤3 sentences; no grade/age phrases | Pass (0 flags) |

| Metric | Count |
|--------|------:|
| Games OK (mechanical) | **124** |
| Mechanical failures fixed | **1** |
| Soft flags for human review | **see below** (~44 distinct games across judgment themes) |

## Mechanical fixes made

### `2048.json` (only failure)

Missed Phase 2 migration leftovers:

| Field | Before | After |
|-------|--------|-------|
| `primaryCategories` | Single Player, Offline, **Free to Play** | Single Player, Offline |
| `secondaryCategories` | **Number Puzzles**, Puzzle, **Casual** | Puzzle |

Rationale (audit mappings, not judgment): remove Forbidden `Free to Play`; merge `Number Puzzles` → `Puzzle`; remove `Casual`. Description and grades were already fine.

No other JSON rewrites.

## Type inventory (`primaryCategories`)

| Type | Count |
|------|------:|
| Online | 102 |
| Single Player | 80 |
| Multiplayer | 47 |
| PvP | 25 |
| Offline | 22 |
| Educational Hub | 16 |
| Real-Time | 10 |
| Turn-Based | 7 |
| Co-op | 1 |
| **Free to Play** | **0** |

All labels canonical. Cap: 62 games use exactly 3 Types; none over 3.

## Genre inventory (`secondaryCategories`)

| Genre | Count | Genre | Count |
|-------|------:|-------|------:|
| Puzzle | 40 | Action | 38 |
| Competitive | 37 | Educational | 25 |
| Classics | 23 | Word Games | 22 |
| Daily Challenge | 22 | Arcade | 20 |
| IO Games | 19 | Art & Creativity | 17 |
| Sandbox | 14 | Strategy | 13 |
| Trivia | 10 | Math | 9 |
| Survival | 9 | Party | 9 |
| Battle Royale | 8 | Geography | 8 |
| Sports | 7 | Board Games | 7 |
| Science | 5 | Music | 2 |
| Movement | 1 | Racing | 1 |

All labels canonical. No game over 5 genres. Sparse chips: **Movement** (1), **Racing** (1), **Music** (2) — worth confirming intentional, not mechanical failures.

## Flagged for human review (judgment / consistency)

Left untouched. Caps force tradeoffs; these are the clearest inconsistencies.

### 1. PvP vs Real-Time (Type-cap tradeoff)

No game has both PvP and Real-Time (would need a 4th Type alongside Multiplayer + Online). Catalog split unevenly:

**PvP, no Real-Time** (25) — includes many live IO / arena titles, e.g. `diep-io`, `slither-io`, `smash-karts`, `stumble-guys`, `suroi`, `zombs-royale`, `paper-io`, `hexanaut-io`, …

**Real-Time, no PvP** (10): `agar-io`, `baseball-bros`, `basket-bros`, `bloxd`, `bonk-io`, `build-royale`, `gimkit`, `narrow-one`, `skribblio`, `slope-run`

Especially inconsistent peers: `agar-io` (Real-Time) vs other IO games (PvP); sports “bros” titles mixed (`football-bros`/`soccer-bros` = PvP; `baseball-bros`/`basket-bros` = Real-Time).

### 2. Educational Hub + Educational genre (16)

Possible Type↔Genre redundancy (audit said both can stay when each adds a filter path). Hubs: `abcya`, `arcademics`, `blooket`, `chrome-music-lab`, `coolmath-games`, `digipuzzle`, `funbrain`, `gonoodle`, `math-playground`, `natgeo-kids`, `pbs-kids`, `santa-tracker`, `sesame-street`, `shady-bears`, `starfall`, `turtle-diary`.

### 3. Single Player + Multiplayer together (3)

Allowed for dual-mode titles; confirm: `kahoot`, `openguessr`, `pong`.

### 4. Co-op only on one title

Only `eaglercraft` has Co-op. Confirm no other co-op-capable games were trimmed off Co-op under the ≤3 Type cap.

### 5. Sparse genres

`Movement` (1), `Racing` (1), `Music` (2) — filter chips will look nearly empty; product call whether to keep or merge later.

## Out of scope / not done

- No judgment re-tagging (PvP ↔ Real-Time, hub genre trim, etc.)
- No description rewrites (none flagged)
- No schema/`content.config.ts` Zod `.max(3)` / `.max(5)` enforcement
- No commit
