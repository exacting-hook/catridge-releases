# Recommended settings list

Catridge reads a list of recommended emulator settings and patches per game to:

- **apply them on its own** to games added to your library folders (after a scan),
- **ask first** (a notice with an Apply button) for games installed into an emulator, such
  as PS3 games installed from a `.pkg` into RPCS3,
- **apply them on request** from a game's page: *Updates, DLC and mods → Recommended
  settings → Apply recommended*.

Games that were already in the library before this feature only get the button.

## Where it lives

| What | Where |
|---|---|
| Builder, tests, userscript, hand-added pages | `recommendations/` in the Catridge source repo (this folder) |
| Published list | `recommendations/v1/` in the public `exacting-hook/catridge-releases` repo, served from `https://raw.githubusercontent.com/exacting-hook/catridge-releases/main/recommendations/v1/` |
| Wiki backup (every game page's source) | the `rpcs3-wiki-backup` release of `catridge-releases`, one file `rpcs3-wiki-backup-<date>.json` |
| Publishing script | `tools/update-recommendations.mjs` in the source repo |
| Scheduled rebuild | `.github/workflows/recommendations.yml` in `catridge-releases` (a copy of `workflow.yml`) |
| Catridge's side | `src-tauri/src/emulators/recommendations.rs`, `src-tauri/src/commands/recommendations.rs` |

The list is split so each player only downloads what their library needs:

- `v1/index.json` (about 70 KB, one line per game): each game file's console, game IDs and
  hash.
- `v1/<emulator>/<game>.json` (a few KB each): one game's settings and patches.

Catridge downloads the index at most once a day (or when *Check for updates* is pressed on a
game page), then only the file for a game it's asked about. Both are kept in its cache
folder; a game file is reused while its hash matches the index, and a download that doesn't
match is refused. Offline, it uses whatever it saved before.

## Updating the list

The RPCS3 wiki answers automated requests with a bot check (HTTP 403), so the pages are
collected in your own browser with the userscript, and published from your machine:

1. **Get the last backup** (skip this the first time):
   ```bash
   node tools/update-recommendations.mjs --get-backup
   ```
   This saves `rpcs3-wiki-backup-<date>.json` from the release into Downloads.
2. **Scan the wiki.** With `rpcs3-category-export.user.js` installed in Tampermonkey, open
   the RPCS3 wiki's `Category:Games` page. *Load list / backup* and choose that file (if the
   browser's saved progress was cleared), then scan. Only new or changed pages are fetched.
   Wait for **Scan complete**, then **Save backup**.
3. **Publish:**
   ```bash
   node tools/update-recommendations.mjs
   ```
   It takes the newest `rpcs3-wiki-backup-*.json` in Downloads (or a path you pass), runs
   the tests, builds `v1/`, commits and pushes it to `catridge-releases` when something
   changed, and replaces the file on the `rpcs3-wiki-backup` release. That release is never
   marked "latest", so Catridge's updater (which reads the latest release) isn't affected.
   It never publishes a Catridge release. `--dry-run` builds and commits in a temporary
   clone without pushing or uploading; `--allow-partial` publishes an unfinished scan.

It needs `GH_TOKEN` (in the git-ignored `.env`, see `docs/DEVELOPMENT.md`) and `gh`.

### The userscript

`rpcs3-category-export.user.js` runs on the RPCS3 `Category:Games` page. Each scan gets the
current mainspace page list and latest revision ID/timestamp, then compares those with
previously saved sources. It fetches raw source only for new or changed pages; a later scan
also discovers newly added games. MediaWiki's API provides the category list with
continuation and the latest revision metadata ([category members](https://www.mediawiki.org/wiki/API:Categorymembers), [revisions](https://www.mediawiki.org/wiki/API:Revisions)).

Changed pages are fetched one at a time with a three-second delay by default (2, 3, 5, and 10
second options are available). It does not solve challenges or retry a blocked request: HTTP
403/429 and challenge pages pause the run. Page titles, revision metadata, source, and progress
stay in that browser's IndexedDB, so you can reload and continue later. **Save backup**
exports the saved sources plus the title list and cursor (what the publishing script wants);
**Export sources** exports the sources only; **Load list / backup** restores a backup or
accepts a plain text file with one page title or wiki URL per line.

### Hand-added pages

`sources/rpcs3/<Page_Title>.wiki` holds single pages pasted by hand (*View source*, select
all, copy; the file name is the page title as in the address bar). A hand-added page takes
precedence over the backup's copy of the same page, which is useful for an edit the wiki
doesn't show yet, so delete it once the wiki has caught up. `Tomb_Raider.wiki` is one:
it has the *Disable MLAA* patch submitted to the wiki, which the live page didn't show
when the backup of 2026-11-15 was made.

### The Action

`workflow.yml` runs every two days (05:23 UTC), on pushes that change `sources/` or
`build.mjs`, and on demand (*Actions → Recommendations → Run workflow*). It runs the tests,
downloads the backup from the release, rebuilds `v1/` with the repo's `build.mjs`, and
commits only when something changed. So a builder change (a new wiki field mapped, say)
reaches players without a new scan. Without a backup it rebuilds nothing. It never creates
releases.

## How a page becomes a game file

`build.mjs` (Node 20+, no dependencies):

```bash
node recommendations/build.mjs --export <backup.json> [--out <dir>] [--offline]
node --test recommendations/build.test.mjs
```

`--out` defaults to `recommendations/v1` (git-ignored here); `--offline` skips the one plain
request per hand-added page.

1. **Game IDs** come from the page's `{{vginfobox}}` → `gameid` (all IDs, including the
   "other" IDs).
2. **Settings** come from the `{{config}}` template. Every field of the template is mapped:
   - to an RPCS3 option (`rpcs3.*`, `src-tauri/src/emulators/adapters/native.rs`, whose
     keys are verified against RPCS3's source), written to the game's own RPCS3 config;
   - or, for renderer, resolution scale, vsync, aspect ratio, stretch, anisotropic filter and
     volume, to Catridge's own per-game setting (`video.*`, `audio.*`), because Catridge
     writes those to RPCS3's main config at every launch.

   A Rust test checks every ID the builder uses exists, and `cargo test built_list_applies`
   (run by the publish script) checks every value in a built list applies. What can't be
   set goes into `unmapped`, and the game page lists it to set by hand: fields RPCS3 no
   longer has (`delay each odd mfc command`, `accurate getllar`, `tsx instructions`,
   `ppu llvm java mode handling`) and values that aren't one setting (a range "1 - 3").
   On the 2026-11-15 backup that leaves 12 values across 2,294 pages. The field's `notes`
   become the setting's note.
3. **Patches** come from the `highly recommended patch` and `recommended patch` fields
   (comma-separated patch names). The page's `{{patch}}` blocks (PPU and SPU, not Canary)
   say which game IDs each patch exists for; those go into `only`, so a patch is only
   switched on for those IDs. Catridge switches patches on in RPCS3's `patch_config.yml`,
   downloading RPCS3's official patch list first when a recommended patch isn't in it yet.
4. Only games with at least one setting or patch get a file. File names come from the page
   title (`Tomb Raider` → `tomb-raider.json`); a title with no Latin letters or digits, or a
   collision, gets a hash of the page link instead.

`generated` in the index only changes when a game file changes, so scheduled runs don't
commit anything when nothing changed.

Only the RPCS3 wiki has structured per-game settings. PCSX2, Dolphin and Cemu apply per-game
fixes from databases built into the emulators, and their wikis describe the rest in prose.

## File format (`v1`)

`index.json`:

```json
{"version": 1, "generated": "2026-11-15", "files": {
  "rpcs3/tomb-raider.json": {"console":"ps3","hash":"<first 16 hex digits of the file's SHA-256>","serials":["BLES01780","BLES01834"]}
}}
```

`rpcs3/tomb-raider.json`:

```json
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
```

- `console` is Catridge's console id; `emulator` must be the console's default emulator in
  Catridge, or the entry is ignored.
- `settings[].id` / `value` use Catridge's option ids and value spellings (bools are
  `true`/`false`). Ids an older Catridge doesn't know are skipped.
- `patches[].level` is `high` (highly recommended) or `normal`; both are applied.
- Paths in the index are `<emulator>/<name>.json` in lowercase letters, digits and dashes;
  Catridge ignores anything else.
- A breaking change to the format goes into a new folder (`v2/`), so older copies of
  Catridge keep reading `v1/`.

Wiki content is licensed CC BY-SA 4.0; each entry keeps the link to its page, and the game
page in Catridge shows where the settings came from.
