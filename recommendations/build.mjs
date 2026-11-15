#!/usr/bin/env node
// Builds the recommended-settings list Catridge reads: one small JSON file per game with
// recommended emulator settings and patches, plus an index from game IDs to those files,
// in recommendations/v1/ (index.json, <emulator>/<game>.json). Catridge downloads the index
// and only the files for games in the player's library.
//
//   node recommendations/build.mjs --export <wiki-backup.json> [--out <dir>] [--offline]
//
// Page sources come from:
//   - a JSON export of rpcs3-category-export.user.js (`--export`, or
//     sources/rpcs3/wiki-export.json): the source of every page in the wiki's game category;
//   - sources/<emulator>/<Page_Title>.wiki: single pages pasted by hand. Each run asks the
//     wiki for these with one plain request (`action=raw`); the RPCS3 wiki's bot check
//     usually answers 403 and the stored copy is kept. `--offline` skips the requests.
// A .wiki file takes precedence over the export's copy of the same page (it's there on
// purpose, e.g. an edit the wiki doesn't show yet); delete it once the wiki has caught up.
//
// Only RPCS3's wiki has per-game settings in a structured template (`{{config}}`); PCSX2,
// Dolphin and Cemu apply per-game fixes from databases built into the emulators.
// Publishing (catridge-releases + the backup release): tools/update-recommendations.mjs.
// Node 20+, no dependencies. Wiki content is CC BY-SA 4.0; every entry links to its page.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const OFFLINE = argv.includes("--offline");

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
// the wiki value isn't one Catridge can set. A Rust test checks every id here exists.

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

const XFLOAT = pick("rpcs3.xfloat", { Accurate: "Accurate", Approximate: "Approximate", Relaxed: "Relaxed" });
// The wiki's short names and RPCS3's own spellings (both appear on pages).
const SHADER_MODES = {
  "Legacy (singlethreaded)": "Legacy Recompiler (single-threaded)",
  "Async (multithreaded)": "Async Recompiler (multi-threaded)",
  "Async with Shader Interpreter": "Async Recompiler with Shader Interpreter",
  "Shader Interpreter only": "Shader Interpreter only",
  "Legacy Recompiler (single-threaded)": "Legacy Recompiler (single-threaded)",
  "Async Recompiler (multi-threaded)": "Async Recompiler (multi-threaded)",
  "Async Recompiler with Shader Interpreter": "Async Recompiler with Shader Interpreter",
};

export const RPCS3_KEYS = {
  "ppu decoder": pick("rpcs3.ppu_decoder", { "Recompiler (LLVM)": "Recompiler (LLVM)", "Interpreter (static)": "Interpreter (static)" }),
  "spu decoder": pick("rpcs3.spu_decoder", { "Recompiler (LLVM)": "Recompiler (LLVM)", "Recompiler (ASMJIT)": "Recompiler (ASMJIT)", "Interpreter (dynamic)": "Interpreter (dynamic)", "Interpreter (static)": "Interpreter (static)" }),
  "preferred spu threads": int("rpcs3.spu_threads", 0, 6, { Auto: 0 }),
  "thread scheduler": pick("rpcs3.scheduler", { "Operating System": "Operating System", "RPCS3 Scheduler": "RPCS3 Scheduler", "RPCS3 Alternative Scheduler": "RPCS3 Alternative Scheduler" }),
  "spu xfloat accuracy": XFLOAT,
  "xfloat accuracy": XFLOAT,
  "spu block size": pick("rpcs3.spu_block_size", { Safe: "Safe", Mega: "Mega", Giga: "Giga" }),
  "anti-aliasing": pick("rpcs3.msaa", { Auto: "Auto", Disabled: "Disabled" }),
  "zcull accuracy": (v) => ({
    precise: [["rpcs3.zcull_precise", "true"], ["rpcs3.zcull_relaxed", "false"]],
    approximate: [["rpcs3.zcull_precise", "false"], ["rpcs3.zcull_relaxed", "false"]],
    relaxed: [["rpcs3.zcull_precise", "false"], ["rpcs3.zcull_relaxed", "true"]],
  })[v.toLowerCase()] ?? null,
  "shader quality": pick("rpcs3.shader_precision", { Auto: "Auto", Ultra: "Ultra", High: "High", Low: "Low" }),
  "default resolution": pick("rpcs3.resolution", { "1280x720": "1280x720", "1920x1080": "1920x1080", "720x480": "720x480", "720x576": "720x576" }),
  "shader mode": pick("rpcs3.shader_mode", SHADER_MODES),
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

/** Read the JSON export produced by rpcs3-category-export.user.js. */
export function parseWikiExport(data) {
  if (![1, 2].includes(data?.version) || !Array.isArray(data.pages)) {
    throw new Error("Invalid wiki export: expected version 1 or 2 and a pages array");
  }
  const pages = new Map();
  for (const item of data.pages) {
    if (typeof item?.title !== "string" || typeof item?.source !== "string" || !item.source.trim()) continue;
    const title = item.title.trim().replaceAll("_", " ");
    pages.set(title, item.source);
  }
  return pages;
}

// ---- Output: one file per game plus an index -------------------------------------------

/** A file name for a page title: `Tomb Raider` → `tomb-raider`. */
export function slug(title) {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 80)
    .replace(/^-+|-+$/g, "");
}

/** First 16 hex digits of the SHA-256 of a file's bytes (Catridge checks downloads with it). */
export const shortHash = (text) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);

/** Games worth a file: ones with something Catridge can apply. */
export const useful = (e) => e.serials.length > 0 && (e.settings.length > 0 || e.patches.length > 0);

/**
 * The files for `entries`: `{ index, files: Map<path, text> }`. File names are unique per
 * emulator; a title that slugs to nothing or collides gets a hash of its page as a suffix.
 */
export function layout(entries, generated) {
  const files = new Map();
  const index = { version: 1, generated, files: {} };
  const sorted = [...entries].sort((a, b) => a.title.localeCompare(b.title) || a.page.localeCompare(b.page));
  for (const e of sorted) {
    let name = slug(e.title);
    if (!name || files.has(`${e.emulator}/${name}.json`)) name = `${name ? name + "-" : ""}${shortHash(e.page).slice(0, 8)}`;
    const path = `${e.emulator}/${name}.json`;
    const text = JSON.stringify(e, null, 2) + "\n";
    files.set(path, text);
    index.files[path] = { console: e.console, hash: shortHash(text), serials: e.serials };
  }
  return { index, files };
}

/** The index with one game per line: small, and diffs show which games changed. */
export function indexText(index) {
  const lines = Object.entries(index.files).map(([path, v]) => `  ${JSON.stringify(path)}: ${JSON.stringify(v)}`);
  return `{"version": ${index.version}, "generated": ${JSON.stringify(index.generated)}, "files": {\n${lines.join(",\n")}\n}}\n`;
}

/** Write `layout()` into `out`, removing game files no longer listed. Returns whether anything changed. */
export function writeLayout(out, entries, today) {
  const indexPath = join(out, "index.json");
  const old = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : null;
  let { index, files } = layout(entries, today);
  // Keep the old date when no game changed, so scheduled runs don't commit for nothing.
  const same = !!old && JSON.stringify(old.files) === JSON.stringify(index.files);
  if (same) index = { ...index, generated: old.generated };
  for (const [path, text] of files) {
    const file = join(out, path);
    mkdirSync(dirname(file), { recursive: true });
    if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileSync(file, text);
  }
  if (existsSync(out)) {
    for (const dir of readdirSync(out, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      for (const f of readdirSync(join(out, dir.name))) {
        if (f.endsWith(".json") && !files.has(`${dir.name}/${f}`)) rmSync(join(out, dir.name, f));
      }
    }
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(indexPath, indexText(index));
  return !same;
}

// ---- Fetch (one plain request per page) and build ---------------------------------------

async function refresh(emulator, page, file) {
  const url = `${WIKIS[emulator].base}?title=${encodeURIComponent(page)}&action=raw`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "CatridgeRecommendations/1 (+https://github.com/exacting-hook/catridge-releases)" } });
    const body = await r.text();
    if (r.ok && body.includes("{{vginfobox")) {
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
  const out = resolve(option("--out") ?? join(HERE, "v1"));
  const exportFile = option("--export");
  if (exportFile && !existsSync(exportFile)) throw new Error(`No such export: ${exportFile}`);
  const entries = [];
  let pages = 0;
  for (const emulator of Object.keys(WIKIS)) {
    const dir = join(HERE, "sources", emulator);
    const sources = new Map();
    if (existsSync(dir)) {
      for (const f of readdirSync(dir).filter((f) => f.endsWith(".wiki")).sort()) {
        const page = f.slice(0, -5);
        sources.set(page.replaceAll("_", " "), { page, file: join(dir, f) });
      }
    }
    const bundles = [join(dir, "wiki-export.json"), emulator === "rpcs3" ? exportFile : null].filter((b) => b && existsSync(b));
    for (const bundle of bundles) {
      const data = JSON.parse(readFileSync(bundle, "utf8"));
      if (data.scan && data.scan.scanComplete === false) console.warn(`${bundle}: the scan wasn't finished; building from the pages it has`);
      for (const [title, text] of parseWikiExport(data)) {
        if (!sources.get(title)?.file) sources.set(title, { page: title.replaceAll(" ", "_"), text });
      }
    }
    for (const [, source] of [...sources].sort(([a], [b]) => a.localeCompare(b))) {
      if (!OFFLINE && source.file) await refresh(emulator, source.page, source.file);
      const text = source.file ? readFileSync(source.file, "utf8") : source.text;
      const entry = entryFromPage(emulator, source.page, text);
      pages++;
      if (useful(entry)) entries.push(entry);
    }
  }
  const changed = writeLayout(out, entries, new Date().toISOString().slice(0, 10));
  console.log(`${pages} pages, ${entries.length} games with recommendations, ${changed ? "updated" : "unchanged"}: ${out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
