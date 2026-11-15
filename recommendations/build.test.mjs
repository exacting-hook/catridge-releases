// node --test recommendations/build.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { entryFromPage, patchSerials, params, templates } from "./build.mjs";

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
