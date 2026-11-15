// node --test recommendations/build.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryFromPage, indexText, layout, parseWikiExport, patchSerials, params, shortHash, slug, templates, writeLayout } from "./build.mjs";

const page = `{{vginfobox
|gameid    = {{gameid|id=BCES01741, BCUS98232|oid=BCJS37008|ird=Yes}}<br>'''''Demo'''''<br>{{gameid|id=NPEA90123|ird=NA}}
}}
==Configuration==
{{config
|write color buffers                   = On <!-- On, Off -->
|write color buffers notes             = Fixes lighting issues.
|zcull accuracy                        = Approximate<!-- Precise, Approximate, Relaxed -->
|shader mode                           = Async (multithreaded)
|preferred spu threads                 = 1 - 3
|read depth buffers                    = <!-- On, Off -->
|highly recommended patch              = Disable MLAA, Skip Intro<!-- Mention patch names -->
|highly recommended patch notes        = Needed for the menus.
}}
{{patch
|type    = PPU
|version = 1.2
|content =
Anchors:
  t104: &t104
    "Game":
      BCES01741: [ 01.04 ]
      BCUS98232: [ 01.04 ]

PPU-aaaa:
  "Disable MLAA":
    Games: *t104
    Patch:
      - [ be32, 0x1, 0x2 ]
PPU-bbbb:
  "Disable MLAA":
    Games:
      "Game Demo":
        NPEA90123: [ 01.00 ]
}}
{{patch
|type    = Canary
|content =
PPU-cccc:
  "Skip Intro":
    Games:
      "Game":
        BCJS37008: [ 01.00 ]
}}`;

test("templates and params ignore nested templates and comments", () => {
  const t = templates(page);
  assert.deepEqual(t.map((x) => x.name), ["vginfobox", "config", "patch", "patch"]);
  assert.match(params(t[0].body).get("gameid"), /oid=BCJS37008/);
});

test("patch serials follow anchors and skip canary blocks", () => {
  const m = patchSerials(page);
  assert.deepEqual([...m.get("Disable MLAA")].sort(), ["BCES01741", "BCUS98232", "NPEA90123"]);
  assert.equal(m.has("Skip Intro"), false);
});

test("config maps to Catridge option ids", () => {
  const e = entryFromPage("rpcs3", "God_of_War", page);
  assert.deepEqual(e.serials, ["BCES01741", "BCUS98232", "BCJS37008", "NPEA90123"]);
  assert.deepEqual(e.settings, [
    { id: "rpcs3.wcb", value: "true", note: "Fixes lighting issues." },
    { id: "rpcs3.zcull_precise", value: "false" },
    { id: "rpcs3.zcull_relaxed", value: "false" },
    { id: "rpcs3.shader_mode", value: "Async Recompiler (multi-threaded)" },
  ]);
  assert.deepEqual(e.unmapped, [{ key: "preferred spu threads", value: "1 - 3" }]);
  assert.deepEqual(e.patches, [
    { name: "Disable MLAA", level: "high", note: "Needed for the menus.", only: ["BCES01741", "BCUS98232", "NPEA90123"] },
    { name: "Skip Intro", level: "high", note: "Needed for the menus." },
  ]);
});

test("the stored Tomb Raider page builds", () => {
  const text = readFileSync(new URL("./sources/rpcs3/Tomb_Raider.wiki", import.meta.url), "utf8");
  const e = entryFromPage("rpcs3", "Tomb_Raider", text);
  assert.ok(e.serials.includes("BLES01834"));
  assert.deepEqual(e.patches.map((p) => [p.name, p.only]), [["Disable MLAA", ["BLES01834"]]]);
});

test("the Tampermonkey JSON export maps page titles to raw sources", () => {
  const pages = parseWikiExport({ version: 2, pages: [
    { title: "Tomb_Raider", source: "{{vginfobox|gameid=BLES01834}}" },
    { title: "Empty", source: "" },
  ] });
  assert.deepEqual([...pages], [["Tomb Raider", "{{vginfobox|gameid=BLES01834}}"]]);
  assert.throws(() => parseWikiExport({ version: 3, pages: [] }), /Invalid wiki export/);
});

test("titles become file names", () => {
  assert.equal(slug("Tomb Raider"), "tomb-raider");
  assert.equal(slug("007: Quantum of Solace"), "007-quantum-of-solace");
  assert.equal(slug("Pokémon & Friends!"), "pokemon-and-friends");
  assert.equal(slug("龍が如く"), "");
});

test("one file per game, an index of IDs and hashes, stale files removed", () => {
  const e = (title, serials) => ({ console: "ps3", emulator: "rpcs3", title, page: `p/${title}`, serials, settings: [{ id: "rpcs3.wcb", value: "true" }], patches: [] });
  const { index, files } = layout([e("B Game", ["BLUS00002"]), e("A Game", ["BLES00001"]), e("龍が如く", ["BLJM60001"])], "2026-11-15");
  assert.deepEqual(Object.keys(index.files).slice(0, 2), ["rpcs3/a-game.json", "rpcs3/b-game.json"]);
  const jp = Object.keys(index.files)[2];
  assert.match(jp, /^rpcs3\/[0-9a-f]{8}\.json$/);
  assert.equal(index.files["rpcs3/a-game.json"].hash, shortHash(files.get("rpcs3/a-game.json")));
  assert.deepEqual(index.files["rpcs3/a-game.json"].serials, ["BLES00001"]);

  const out = mkdtempSync(join(tmpdir(), "recs-"));
  try {
    assert.equal(writeLayout(out, [e("A Game", ["BLES00001"]), e("Gone", ["BLES00009"])], "2026-11-14"), true);
    assert.equal(writeLayout(out, [e("A Game", ["BLES00001"])], "2026-11-15"), true);
    assert.equal(existsSync(join(out, "rpcs3", "gone.json")), false);
    assert.equal(writeLayout(out, [e("A Game", ["BLES00001"])], "2026-11-16"), false);
    assert.equal(JSON.parse(readFileSync(join(out, "index.json"), "utf8")).generated, "2026-11-15", "unchanged keeps the date");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("RPCS3's own shader mode names map too", () => {
  const e = entryFromPage("rpcs3", "X", "{{vginfobox|gameid=BLES00001}}{{config\n|shader mode = Legacy Recompiler (single-threaded)\n|xfloat accuracy = Accurate\n}}");
  assert.deepEqual(e.settings, [
    { id: "rpcs3.shader_mode", value: "Legacy Recompiler (single-threaded)" },
    { id: "rpcs3.xfloat", value: "Accurate" },
  ]);
});

test("the index text is valid JSON with one game per line", () => {
  const index = { version: 1, generated: "2026-11-15", files: { "rpcs3/a.json": { console: "ps3", hash: "0123456789abcdef", serials: ["BLES00001"] }, "rpcs3/b.json": { console: "ps3", hash: "fedcba9876543210", serials: [] } } };
  const text = indexText(index);
  assert.deepEqual(JSON.parse(text), index);
  assert.equal(text.split("\n").length, 5);
});
