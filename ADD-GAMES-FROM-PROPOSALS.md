# Add games from proposals (copy-paste prompt)

Paste everything below the line into a **new** Cursor agent chat.

---

Sections to process: (leave blank = all Not reviewed)

Add Keep?=Y games from `new-game-proposals.md` into the scsfoxchase.tech catalog.

**Paths**
- Proposals: `new-game-proposals.md`
- Game JSON: `src/content/games/`
- Images: `public/images/`

**Scope**
- If `Sections to process:` lists section names, only do those.
- Otherwise, only process sections whose headings end with `— Not reviewed`.
- Do not process `— Reviewed` sections unless named above.

**For each Keep?=Y game in scope**
1. Create a JSON file in `src/content/games/` matching the existing schema (see any file there / `src/content.config.ts`): `id`, `name`, `url`, `image`, `description`, `minGrade`, `maxGrade`, `primaryCategories`, `secondaryCategories`.
2. Match or place the image under `public/images/` and set `image` to `/images/...`.
3. Include the section name in `secondaryCategories` (plus any other fitting genres from the proposal row / similar games).
4. If the game is already in the catalog (same URL or clear same title/id), do **not** duplicate — update the existing entry’s `secondaryCategories` to include this section if missing.

**After each section succeeds**
- Change that section’s heading from `## … — Not reviewed` to `## … — Reviewed` in `new-game-proposals.md`.

**Do not**
- Change Keep? Y/N values
- Commit (user will run `npm run dev` to verify)
- Touch unrelated files
