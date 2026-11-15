#!/usr/bin/env node
// Builds recommendations/v1.json — per-game recommended emulator settings and patches —
// from wiki page sources kept in recommendations/sources/<emulator>/<Page_Title>.wiki.
//
// Catridge downloads the result from the public catridge-releases repo, where a scheduled
// GitHub Action runs this script (see workflow.yml). Node 20+, no dependencies.
//
// Where the page sources come from:
//   - Pasted by hand: open the game's page on the wiki, View source / Edit, copy it into
//     sources/<emulator>/<Page_Title>.wiki (the file name is the wiki page title).
//   - Refreshed automatically: each run asks the wiki for the page's source with one plain
//     request (`action=raw`). The RPCS3 wiki sits behind a bot check that usually answers
//     automated requests with HTTP 403; then the stored copy is kept. Nothing here tries to
//     get past that check. `--offline` skips the requests.
//
// Only RPCS3's wiki has per-game settings in a structured template (`{{config}}`); PCSX2,
// Dolphin and Cemu apply per-game fixes from databases built into the emulators.
//
// Wiki content is CC BY-SA 4.0; every entry keeps a link to its page.

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "v1.json");
const OFFLINE = process.argv.includes("--offline");

const WIKIS = {
  rpcs3: { console: "ps3", base: "https://wiki.rpcs3.net/index.php", name: "RPCS3 Wiki" },
};

// ---- Wiki markup -------------------------------------------------------------------

export function stripComments(s) {
  return s.replace(/<!--[\s\S]*?-->/g, "");
}

/** Every top-level `{{name ...}}` template in `text`, with its raw body. */
export function templates(text) {
  const out = [];
  let i = 0;
  while ((i = text.indexOf("{{", i)) !== -1) {
    let depth = 0, j = i;
    for (; j < text.length - 1; j++) {
      if (text[j] === "{" && text[j + 1] === "{") { depth++; j++; }
      else if (text[j] === "}" && text[j + 1] === "}") { depth--; j++; if (depth === 0) break; }
    }
    const body = text.slice(i + 2, j - 1);
    const name = body.split(/[|\n]/, 1)[0].trim().toLowerCase();
    out.push({ name, body });
    i = j + 1;
  }
  return out;
}

/** A template's `|key = value` parameters (split at depth 0, comments removed). */
export function params(body) {
  const parts = [];
  let depth = 0, cur = "";
  for (let k = 0; k < body.length; k++) {
    const two = body.slice(k, k + 2);
    if (two === "{{" || two === "[[") { depth++; cur += two; k++; continue; }
    if ((two === "}}" || two === "]]") && depth > 0) { depth--; cur += two; k++; continue; }
    if (body[k] === "|" && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += body[k];
  }
  parts.push(cur);
  const map = new Map();
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq === -1) continue;
    map.set(p.slice(0, eq).trim().toLowerCase(), p.slice(eq + 1));
  }
  return map;
}

const clean = (v) => stripComments(v ?? "").trim();

// ---- RPCS3 {{config}} → Catridge native option ids ------------------------------------
// Catridge's ids and file keys are in src-tauri/src/emulators/adapters/native.rs (verified
// against RPCS3's Emu/system_config.h). Each mapper returns [[id, value], ...] or null when
// the wiki value isn't one Catridge can set.

const onOff = (id) => (v) => (/^on$/i.test(v) ? [[id, "true"]] : /^off$/i.test(v) ? [[id, "false"]] : null);
const pick = (id, table) => (v) => {
  const hit = Object.entries(table).find(([k]) => k.toLowerCase() === v.toLowerCase());
  return hit ? [[id, hit[1]]] : null;
};
const int = (id, min, max, words = {}) => (v) => {
  const w = Object.entries(words).find(([k]) => k.toLowerCase() === v.toLowerCase());
  // A single number ("34", "34ms"); ranges like "1 - 3" aren't a value Catridge can pick.
  const n = w ? w[1] : /^\d+\s*(ms|%)?$/i.test(v) ? parseInt(v, 10) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? [[id, String(n)]] : null;
};

export const RPCS3_KEYS = {
  "ppu decoder": pick("rpcs3.ppu_decoder", { "Recompiler (LLVM)": "Recompiler (LLVM)", "Interpreter (static)": "Interpreter (static)" }),
  "spu decoder": pick("rpcs3.spu_decoder", { "Recompiler (LLVM)": "Recompiler (LLVM)", "Recompiler (ASMJIT)": "Recompiler (ASMJIT)", "Interpreter (dynamic)": "Interpreter (dynamic)", "Interpreter (static)": "Interpreter (static)" }),
  "preferred spu threads": int("rpcs3.spu_threads", 0, 6, { Auto: 0 }),
  "thread scheduler": pick("rpcs3.scheduler", { "Operating System": "Operating System", "RPCS3 Scheduler": "RPCS3 Scheduler", "RPCS3 Alternative Scheduler": "RPCS3 Alternative Scheduler" }),
  "spu xfloat accuracy": pick("rpcs3.xfloat", { Accurate: "Accurate", Approximate: "Approximate", Relaxed: "Relaxed" }),
  "spu block size": pick("rpcs3.spu_block_size", { Safe: "Safe", Mega: "Mega", Giga: "Giga" }),
  "anti-aliasing": pick("rpcs3.msaa", { Auto: "Auto", Disabled: "Disabled" }),
  "zcull accuracy": (v) => ({
    precise: [["rpcs3.zcull_precise", "true"], ["rpcs3.zcull_relaxed", "false"]],
    approximate: [["rpcs3.zcull_precise", "false"], ["rpcs3.zcull_relaxed", "false"]],
    relaxed: [["rpcs3.zcull_precise", "false"], ["rpcs3.zcull_relaxed", "true"]],
  })[v.toLowerCase()] ?? null,
  "shader quality": pick("rpcs3.shader_precision", { Auto: "Auto", Ultra: "Ultra", High: "High", Low: "Low" }),
  "default resolution": pick("rpcs3.resolution", { "1280x720": "1280x720", "1920x1080": "1920x1080", "720x480": "720x480", "720x576": "720x576" }),
  "shader mode": pick("rpcs3.shader_mode", {
    "Legacy (singlethreaded)": "Legacy Recompiler (single-threaded)",
    "Async (multithreaded)": "Async Recompiler (multi-threaded)",
    "Async with Shader Interpreter": "Async Recompiler with Shader Interpreter",
    "Shader Interpreter only": "Shader Interpreter only",
  }),
  "write color buffers": onOff("rpcs3.wcb"),
  "read color buffers": onOff("rpcs3.rcb"),
  "write depth buffers": onOff("rpcs3.wdb"),
  "read depth buffers": onOff("rpcs3.rdb"),
  "strict rendering mode": onOff("rpcs3.strict"),
  "multithreaded rsx": onOff("rpcs3.mt_rsx"),
  "asynchronous texture streaming": onOff("rpcs3.async_textures"),
  "accurate rsx reservation access": onOff("rpcs3.accurate_rsx"),
  "accurate spu dma": onOff("rpcs3.accurate_dma"),
  "maximum spurs threads": int("rpcs3.spurs_threads", 1, 6, { Unlimited: 6 }),
  "disable zcull occlusion queries": onOff("rpcs3.zcull_off"),
  "enable time stretching": onOff("rpcs3.time_stretch"),
  "audio buffer duration": int("rpcs3.audio_buffer", 4, 250),
  "emulate special depth comparison": onOff("rpcs3.depth_compare"),
};

const PATCH_FIELDS = { "highly recommended patch": "high", "recommended patch": "normal" };

// ---- RPCS3 {{patch}} blocks: which serials each patch name covers -------------------

/** Patch name → serials it lists, from the page's PPU/SPU patch blocks (not Canary). */
export function patchSerials(text) {
  const out = new Map();
  for (const t of templates(text).filter((t) => t.name === "patch")) {
    const p = params(t.body);
    if (!/^(ppu|spu)$/i.test(clean(p.get("type")))) continue;
    const lines = (p.get("content") ?? "").split("\n");
    // Anchors that list games: `name: &name` followed by indented serial lines.
    const anchors = new Map();
    let anchor = null;
    for (const l of lines) {
      const a = l.match(/^\s{2}(\S+):\s*&(\S+)\s*$/);
      if (a) { anchor = a[2]; anchors.set(anchor, []); continue; }
      if (/^\S/.test(l)) anchor = null;
      const s = l.match(/^\s+([A-Z]{4}\d{5}):\s*\[/);
      if (anchor && s) anchors.get(anchor).push(s[1]);
    }
    let name = null;
    for (const l of lines) {
      if (/^\S/.test(l)) { name = null; continue; }
      const n = l.match(/^\s{2}"(.+)":\s*$/);
      if (n) { name = n[1]; if (!out.has(name)) out.set(name, new Set()); continue; }
      if (!name) continue;
      const s = l.match(/^\s+([A-Z]{4}\d{5}):\s*\[/);
      if (s) out.get(name).add(s[1]);
      const ref = l.match(/^\s+Games:\s*\*(\S+)/);
      if (ref) for (const x of anchors.get(ref[1]) ?? []) out.get(name).add(x);
    }
  }
  return out;
}

// ---- One page → one entry --------------------------------------------------------------

export function entryFromPage(emulator, page, text) {
  const wiki = WIKIS[emulator];
  const all = templates(text);
  const info = all.find((t) => t.name === "vginfobox");
  const serials = info ? [...new Set((params(info.body).get("gameid") ?? "").match(/[A-Z]{4}\d{5}/g) ?? [])] : [];
  const config = all.find((t) => t.name === "config");
  const settings = [], patches = [], unmapped = [];
  const covered = patchSerials(text);
  if (config) {
    const p = params(config.body);
    for (const [key, raw] of p) {
      if (key.endsWith(" notes")) continue;
      const value = clean(raw);
      if (!value) continue;
      const note = clean(p.get(`${key} notes`)) || undefined;
      if (PATCH_FIELDS[key]) {
        for (const name of value.split(",").map((s) => s.trim()).filter(Boolean)) {
          const only = covered.get(name);
          patches.push({ name, level: PATCH_FIELDS[key], ...(note && { note }), ...(only && only.size && { only: [...only].sort() }) });
        }
        continue;
      }
      const mapped = RPCS3_KEYS[key]?.(value);
      if (mapped) for (const [id, v] of mapped) settings.push({ id, value: v, ...(note && { note }) });
      else unmapped.push({ key, value });
    }
  }
  return {
    console: wiki.console,
    emulator,
    title: page.replace(/_/g, " "),
    page: `${wiki.base}?title=${encodeURIComponent(page)}`,
    source: wiki.name,
    license: "CC BY-SA 4.0",
    serials,
    settings,
    patches,
    ...(unmapped.length && { unmapped }),
  };
}

// ---- Fetch (one plain request per page) and build ---------------------------------------

async function refresh(emulator, page, file) {
  const url = `${WIKIS[emulator].base}?title=${encodeURIComponent(page)}&action=raw`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "CatridgeRecommendations/1 (+https://github.com/exacting-hook/catridge-releases)" } });
    const body = await r.text();
    if (r.ok && body.includes("{{config")) {
      writeFileSync(file, body);
      console.log(`refreshed ${emulator}/${page}`);
    } else {
      console.log(`kept the stored copy of ${emulator}/${page} (HTTP ${r.status})`);
    }
  } catch (e) {
    console.log(`kept the stored copy of ${emulator}/${page} (${e.message})`);
  }
}

async function main() {
  const games = [];
  for (const emulator of Object.keys(WIKIS)) {
    const dir = join(HERE, "sources", emulator);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".wiki")).sort()) {
      const page = f.slice(0, -5);
      const file = join(dir, f);
      if (!OFFLINE) await refresh(emulator, page, file);
      const entry = entryFromPage(emulator, page, readFileSync(file, "utf8"));
      if (!entry.serials.length) { console.warn(`skipped ${emulator}/${page}: no game IDs on the page`); continue; }
      games.push(entry);
    }
  }
  games.sort((a, b) => a.title.localeCompare(b.title));
  // Keep the old date when nothing changed, so scheduled runs don't commit for nothing.
  const old = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;
  const same = old && JSON.stringify(old.games) === JSON.stringify(games);
  const out = { version: 1, generated: same ? old.generated : new Date().toISOString().slice(0, 10), games };
  writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`${games.length} games${same ? ", unchanged" : ""}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
