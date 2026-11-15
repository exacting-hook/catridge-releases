# Recommended settings list

`v1.json` lists recommended emulator settings and patches per game. Catridge reads it to:

- **apply them on its own** to games added to your library folders (after a scan),
- **ask first** (a notice with an Apply button) for games installed into an emulator, such
  as PS3 games installed from a `.pkg` into RPCS3,
- **apply them on request** from a game's page: *Updates, DLC and mods → Recommended
  settings → Apply recommended*.

Games that were already in the library before this feature only get the button.

## Where it lives

| What | Where |
|---|---|
| Master copy, builder, tests, page sources | `recommendations/` in the Catridge source repo (this folder) |
| Published copy Catridge downloads | `recommendations/v1.json` in the public `exacting-hook/catridge-releases` repo, served from `https://raw.githubusercontent.com/exacting-hook/catridge-releases/main/recommendations/v1.json` |
| Scheduled rebuild | `.github/workflows/recommendations.yml` in `catridge-releases` (a copy of `workflow.yml`) |
| Copy built into the app | `src-tauri/src/emulators/recommendations.rs` includes this folder's `v1.json` at build time |

Catridge downloads the list at most once a day (or when *Check for updates* is pressed on a
game page), keeps it in its cache folder, and falls back to whichever is newer of that cache
and the built-in copy when it's offline.

## How the list is built

`build.mjs` (Node 20+, no dependencies) reads every `sources/<emulator>/<Page_Title>.wiki`
file, which is the wiki source of one game's page, and writes `v1.json`:

1. **Game IDs** come from the page's `{{vginfobox}}` → `gameid` (all IDs, including the
   "other" IDs).
2. **Settings** come from the `{{config}}` template. Each filled-in field is mapped to one of
   Catridge's own option IDs (`src-tauri/src/emulators/adapters/native.rs`, whose file keys
   are verified against the emulator's source). Fields Catridge can't set yet, or values it
   can't pick (like a range "1 - 3"), go into `unmapped` and are not applied. The field's
   `notes` become the setting's note.
3. **Patches** come from the `highly recommended patch` and `recommended patch` fields
   (comma-separated patch names). The page's `{{patch}}` blocks (PPU and SPU, not Canary)
   say which game IDs each patch exists for; those go into `only`, so a patch is only
   switched on for those IDs. Catridge switches patches on in RPCS3's `patch_config.yml`,
   downloading RPCS3's official patch list first when a recommended patch isn't in it yet.

Only the RPCS3 wiki has structured per-game settings. PCSX2, Dolphin and Cemu apply per-game
fixes from databases built into the emulators, and their wikis describe the rest in prose.

### Keeping page sources up to date

Each run tries to refresh every page with one plain request to the wiki
(`index.php?title=<page>&action=raw`). The RPCS3 wiki is behind a bot check that answers
automated requests with HTTP 403 ("Just a moment..."); then the stored copy is kept and the
run says so. The builder does not try to get past that check.

So, in practice, pages are added and updated by hand:

1. Open the game's page on the RPCS3 wiki in your browser.
2. *View source* (or *Edit*), select all, copy.
3. Save it as `sources/rpcs3/<Page_Title>.wiki`. The file name is the page title as it
   appears in the address bar (`Tomb_Raider`, `God_of_War_3`), so the entry links back to it.
4. Commit it to `catridge-releases` (the GitHub web editor is fine). The Action rebuilds
   `v1.json` on that push.

If the RPCS3 wiki admins ever allow the Action's requests, pages refresh on their own with no
code change.

## Running it

```bash
node recommendations/build.mjs            # refresh pages (one request each), rebuild v1.json
node recommendations/build.mjs --offline  # rebuild from the stored pages only
node --test recommendations/build.test.mjs
```

`generated` in `v1.json` only changes when the game list changes, so scheduled runs don't
commit anything when nothing changed.

## The Action

`workflow.yml` runs every two days (05:23 UTC), on pushes that change `sources/` or
`build.mjs`, and on demand (*Actions → Recommendations → Run workflow*). It runs the tests,
then the builder, and commits `recommendations/` only when something changed. It never
creates releases. It needs *Settings → Actions → General → Workflow permissions → Read and
write* on the repo (or the `permissions: contents: write` in the file, which it has).

Publishing from the source repo copies these to `catridge-releases`:
`recommendations/{build.mjs,build.test.mjs,README.md,v1.json,sources/**}` and
`recommendations/workflow.yml` → `.github/workflows/recommendations.yml`.

## File format (`version: 1`)

```json
{
  "version": 1,
  "generated": "2026-11-15",
  "games": [
    {
      "console": "ps3",
      "emulator": "rpcs3",
      "title": "Tomb Raider",
      "page": "https://wiki.rpcs3.net/index.php?title=Tomb_Raider",
      "source": "RPCS3 Wiki",
      "license": "CC BY-SA 4.0",
      "serials": ["BLES01780", "BLES01834"],
      "settings": [{ "id": "rpcs3.rcb", "value": "true", "note": "..." }],
      "patches": [{ "name": "Disable MLAA", "level": "high", "note": "...", "only": ["BLES01834"] }],
      "unmapped": [{ "key": "preferred spu threads", "value": "1 - 3" }]
    }
  ]
}
```

- `console` is Catridge's console id; `emulator` must be the console's default emulator in
  Catridge, or the entry is ignored.
- `settings[].id` / `value` use Catridge's option ids and value spellings (bools are
  `true`/`false`). Ids an older Catridge doesn't know are skipped.
- `patches[].level` is `high` (highly recommended) or `normal`; both are applied.
- A breaking change to the format gets a new file (`v2.json`), so older copies of Catridge
  keep reading `v1.json`.

Wiki content is licensed CC BY-SA 4.0; each entry keeps the link to its page, and the game
page in Catridge shows where the settings came from.
