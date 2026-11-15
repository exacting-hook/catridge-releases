// ==UserScript==
// @name         RPCS3 Wiki category source exporter
// @namespace    https://wiki.rpcs3.net/
// @version      2.2.0
// @description  Incrementally export Category:Games source with revision checks and resumable backups.
// @match        https://wiki.rpcs3.net/index.php*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const CATEGORY = "Category:Games";
  const DB_NAME = "rpcs3-category-source-export";
  const DB_VERSION = 2;
  const STATE_KEY = "run";
  const PAGE_SIZE = 500;
  const DEFAULT_DELAY_MS = 3000;
  const url = new URL(location.href);
  const titleKey = (title) => title.replaceAll("_", " ").trim().toLocaleLowerCase();

  if (url.searchParams.get("title")?.replaceAll("_", " ") !== CATEGORY) return;

  let dbPromise;
  let active = false;
  let runPromise;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
        if (!db.objectStoreNames.contains("sources")) db.createObjectStore("sources", { keyPath: "title" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  }

  async function dbRequest(storeName, mode, action) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const request = action(tx.objectStore(storeName));
      let result;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error("Local database request failed"));
      tx.onabort = () => reject(tx.error || new Error("Local database request was cancelled"));
    });
  }

  function freshState(status = "Ready. Start a scan or load a previous list.") {
    return {
      key: STATE_KEY,
      schema: 2,
      pages: [],
      continuation: null,
      listingComplete: false,
      cursor: 0,
      phase: "listing",
      revisionCursor: 0,
      revisionsComplete: false,
      customMetadataCursor: 0,
      customMetadataComplete: false,
      scanComplete: false,
      customList: false,
      lastScanAt: null,
      unchangedCount: 0,
      fetchedCount: 0,
      paused: true,
      resumeAfter: 0,
      status,
    };
  }

  async function getState() {
    let state = await dbRequest("meta", "readonly", (store) => store.get(STATE_KEY));
    if (!state || state.schema !== 2) {
      // Keep downloaded source records when upgrading the earlier userscript version.
      state = freshState(state ? "Updated exporter. Start a revision scan to compare saved pages." : undefined);
      await saveState(state);
    } else {
      state.customMetadataCursor ??= 0;
      state.customMetadataComplete ??= !state.customList;
      state.revisionCursor ??= state.customMetadataCursor;
      state.revisionsComplete ??= state.customList
        ? state.customMetadataComplete
        : state.phase === "scrape" && state.pages.every((page) => page.revisionTimestamp || page.missing);
    }
    return state;
  }

  function saveState(state) {
    return dbRequest("meta", "readwrite", (store) => store.put(state));
  }

  function getSavedCount() {
    return dbRequest("sources", "readonly", (store) => store.count());
  }

  function saveSource(record) {
    return dbRequest("sources", "readwrite", (store) => store.put(record));
  }

  async function saveSources(records) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sources", "readwrite");
      const store = tx.objectStore("sources");
      for (const record of records) store.put(record);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error("Could not import saved sources"));
      tx.onabort = () => reject(tx.error || new Error("Source import was cancelled"));
    });
  }

  function getSource(title) {
    return dbRequest("sources", "readonly", (store) => store.get(title));
  }

  function getAllSources() {
    return dbRequest("sources", "readonly", (store) => store.getAll());
  }

  function makePanel() {
    const panel = document.createElement("section");
    panel.id = "rpcs3-source-export-panel";
    panel.innerHTML = `
      <div class="rse-heading">
        <div class="rse-icon">W</div>
        <div><strong>RPCS3 Wiki Exporter</strong><small>Incremental · resumable · local to this browser</small></div>
      </div>
      <div class="rse-status" role="status">Opening local progress…</div>
      <div class="rse-bar"><span></span></div>
      <div class="rse-stats">
        <div><b class="rse-total">—</b><small>in scan</small></div>
        <div><b class="rse-saved">—</b><small>sources saved</small></div>
        <div><b class="rse-unchanged">—</b><small>unchanged</small></div>
      </div>
      <div class="rse-last-scan"></div>
      <label class="rse-delay-label">Delay after changed pages
        <select class="rse-delay">
          <option value="2000">2 seconds</option>
          <option value="3000" selected>3 seconds</option>
          <option value="5000">5 seconds</option>
          <option value="10000">10 seconds</option>
        </select>
      </label>
      <div class="rse-actions">
        <button class="rse-primary rse-start">Start / continue</button>
        <button class="rse-pause">Pause</button>
        <button class="rse-export">Export sources</button>
        <button class="rse-backup">Save backup</button>
        <button class="rse-load">Load list / backup</button>
        <input class="rse-file" type="file" accept=".json,.txt,application/json,text/plain" hidden>
      </div>
      <small class="rse-foot">403, 429, and challenge pages pause the scan. No challenge solving or automatic retries.</small>`;
    const style = document.createElement("style");
    style.textContent = `
      #rpcs3-source-export-panel { position: fixed; z-index: 2147483647; top: 14px; right: 14px; width: min(430px, calc(100vw - 28px)); box-sizing: border-box; padding: 16px; border: 1px solid #d9dce5; border-radius: 14px; background: #fbfcff; color: #202431; box-shadow: 0 10px 36px #1118272b; font: 13px/1.45 system-ui, sans-serif; }
      #rpcs3-source-export-panel * { box-sizing: border-box; }
      #rpcs3-source-export-panel .rse-heading { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
      #rpcs3-source-export-panel .rse-icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 11px; background: #5b4ce2; color: white; font-weight: 800; font-size: 17px; }
      #rpcs3-source-export-panel strong, #rpcs3-source-export-panel small { display: block; }
      #rpcs3-source-export-panel .rse-heading strong { font-size: 15px; }
      #rpcs3-source-export-panel .rse-heading small, #rpcs3-source-export-panel .rse-foot { color: #697084; }
      #rpcs3-source-export-panel .rse-status { min-height: 38px; padding: 9px 10px; border-radius: 9px; background: #f0f1f8; color: #30364a; overflow-wrap: anywhere; }
      #rpcs3-source-export-panel .rse-bar { height: 6px; margin: 11px 0; overflow: hidden; border-radius: 8px; background: #e5e7ef; }
      #rpcs3-source-export-panel .rse-bar span { display: block; width: 0; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #5b4ce2, #17a7a1); transition: width .2s ease; }
      #rpcs3-source-export-panel .rse-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
      #rpcs3-source-export-panel .rse-stats div { padding: 8px; border: 1px solid #e7e9f0; border-radius: 9px; background: #fff; }
      #rpcs3-source-export-panel .rse-stats b { display: block; font-size: 17px; font-variant-numeric: tabular-nums; }
      #rpcs3-source-export-panel .rse-stats small { color: #697084; }
      #rpcs3-source-export-panel .rse-last-scan { margin: 8px 0; color: #697084; font-size: 12px; }
      #rpcs3-source-export-panel .rse-delay-label { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin: 10px 0; }
      #rpcs3-source-export-panel select, #rpcs3-source-export-panel button { min-height: 32px; padding: 6px 9px; border: 1px solid #d9dce5; border-radius: 8px; background: #fff; color: inherit; font: inherit; cursor: pointer; }
      #rpcs3-source-export-panel button:hover { background: #f0f1f8; }
      #rpcs3-source-export-panel button.rse-primary { border-color: #5143cc; background: #5b4ce2; color: white; font-weight: 650; }
      #rpcs3-source-export-panel button.rse-primary:hover { background: #493acb; }
      #rpcs3-source-export-panel .rse-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
      #rpcs3-source-export-panel .rse-foot { margin-top: 4px; }
    `;
    document.documentElement.append(style, panel);
    panel.querySelector(".rse-start").addEventListener("click", start);
    panel.querySelector(".rse-pause").addEventListener("click", pause);
    panel.querySelector(".rse-export").addEventListener("click", () => exportData(false));
    panel.querySelector(".rse-backup").addEventListener("click", () => exportData(true));
    panel.querySelector(".rse-load").addEventListener("click", () => panel.querySelector(".rse-file").click());
    panel.querySelector(".rse-file").addEventListener("change", loadFile);
    return panel;
  }

  const panel = makePanel();
  const statusEl = panel.querySelector(".rse-status");

  async function renderState(state) {
    const count = await getSavedCount();
    const total = state.pages.length;
    const metadataPhase = state.phase === "listing" || state.phase === "revisions";
    const done = Math.min(metadataPhase ? (state.phase === "listing" ? 0 : state.revisionCursor) : state.cursor, total);
    panel.querySelector(".rse-total").textContent = total.toLocaleString();
    panel.querySelector(".rse-saved").textContent = count.toLocaleString();
    panel.querySelector(".rse-unchanged").textContent = state.unchangedCount.toLocaleString();
    panel.querySelector(".rse-bar span").style.width = `${total ? (done / total) * 100 : 0}%`;
    panel.querySelector(".rse-last-scan").textContent = state.lastScanAt
      ? `Last complete scan: ${new Date(state.lastScanAt).toLocaleString()}`
      : "No complete scan yet.";
    statusEl.textContent = state.status;
  }

  function apiUrl(params) {
    const target = new URL("/api.php", location.origin);
    target.search = new URLSearchParams(params).toString();
    return target.href;
  }

  class HttpFailure extends Error {
    constructor(status, retryAfter, message) {
      super(message);
      this.status = status;
      this.retryAfter = retryAfter;
    }
  }

  function retryTimestamp(value) {
    if (!value) return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) return Date.now() + seconds * 1000;
    const date = Date.parse(value);
    return Number.isFinite(date) ? date : 0;
  }

  async function requestJson(target) {
    const response = await fetch(target, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) {
      throw new HttpFailure(response.status, retryTimestamp(response.headers.get("Retry-After")), `HTTP ${response.status}`);
    }
    const type = response.headers.get("Content-Type") || "";
    if (!type.includes("json")) throw new HttpFailure(response.status, 0, "The wiki returned a non-JSON page, possibly a challenge.");
    return response.json();
  }

  async function loadCategoryTitles(state) {
    const known = new Set(state.pages.map((page) => page.title));
    while (!state.listingComplete && active) {
      const params = {
        action: "query",
        list: "categorymembers",
        cmtitle: CATEGORY,
        cmnamespace: "0",
        cmtype: "page",
        cmlimit: String(PAGE_SIZE),
        format: "json",
        formatversion: "2",
      };
      if (state.continuation) {
        if (typeof state.continuation.continue === "string") params.continue = state.continuation.continue;
        if (typeof state.continuation.cmcontinue === "string") params.cmcontinue = state.continuation.cmcontinue;
      }
      const data = await requestJson(apiUrl(params));
      if (data.error) throw new Error(data.error.info || data.error.code || "MediaWiki API error");
      for (const member of data.query?.categorymembers || []) {
        if (!known.has(member.title)) {
          state.pages.push({ title: member.title, revisionTimestamp: null, revisionId: null });
          known.add(member.title);
        }
      }
      state.continuation = data.continue || null;
      state.listingComplete = !state.continuation;
      state.status = state.listingComplete
        ? `Found ${state.pages.length.toLocaleString()} category pages. Checking latest revisions…`
        : `Loading category titles: ${state.pages.length.toLocaleString()} found…`;
      await saveState(state);
      await renderState(state);
      if (active && state.continuation) await delay(1000);
    }
    if (state.listingComplete) state.phase = "revisions";
  }

  async function loadPageRevisions(state) {
    const batchSize = 50;
    while (active && state.revisionCursor < state.pages.length) {
      const batch = state.pages.slice(state.revisionCursor, state.revisionCursor + batchSize);
      const params = {
        action: "query",
        prop: "revisions",
        titles: batch.map((page) => page.title).join("|"),
        rvprop: "timestamp|ids",
        format: "json",
        formatversion: "2",
      };
      const data = await requestJson(apiUrl(params));
      if (data.error) throw new Error(data.error.info || data.error.code || "MediaWiki API error");
      const revisions = new Map((data.query?.pages || []).map((page) => [titleKey(page.title), page]));
      for (const page of batch) {
        const current = revisions.get(titleKey(page.title));
        page.revisionTimestamp = current?.revisions?.[0]?.timestamp || null;
        page.revisionId = current?.revisions?.[0]?.revid || null;
        page.missing = !current || Boolean(current.missing) || !page.revisionTimestamp;
      }
      state.revisionCursor += batch.length;
      state.status = `Checking latest revisions: ${state.revisionCursor.toLocaleString()} of ${state.pages.length.toLocaleString()}…`;
      await saveState(state);
      await renderState(state);
      if (active && state.revisionCursor < state.pages.length) await delay(1000);
    }
    if (state.revisionCursor >= state.pages.length) {
      state.revisionsComplete = true;
      state.customMetadataComplete = true;
      state.phase = "scrape";
    }
  }

  function challengeResponse(contentType, text) {
    return contentType.includes("text/html") || /just a moment|cf-chl-|cloudflare ray id|security verification/i.test(text.slice(0, 12000));
  }

  async function fetchRawSource(title) {
    const target = new URL("/index.php", location.origin);
    target.search = new URLSearchParams({ title, action: "raw" }).toString();
    const response = await fetch(target.href, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) {
      throw new HttpFailure(response.status, retryTimestamp(response.headers.get("Retry-After")), `HTTP ${response.status} for ${title}`);
    }
    const text = await response.text();
    const type = response.headers.get("Content-Type") || "";
    if (!text.trim() || challengeResponse(type, text)) {
      throw new HttpFailure(response.status, 0, `The wiki returned a challenge or empty response for ${title}.`);
    }
    return text;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function run(state) {
    try {
      if (!state.customList && !state.listingComplete) await loadCategoryTitles(state);
      if (!state.revisionsComplete) await loadPageRevisions(state);
      while (active && state.cursor < state.pages.length) {
        const page = state.pages[state.cursor];
        if (page.missing) {
          state.cursor++;
          state.status = `Skipped missing page: ${page.title}`;
          await saveState(state);
          await renderState(state);
          continue;
        }
        if (!page.revisionTimestamp && !state.customList) {
          throw new Error(`No revision timestamp was returned for ${page.title}; paused without skipping it.`);
        }

        const existing = await getSource(page.title);
        const sameRevision = page.revisionId && existing?.revisionId
          ? String(page.revisionId) === String(existing.revisionId)
          : page.revisionTimestamp && existing?.revisionTimestamp === page.revisionTimestamp;
        if (sameRevision && existing?.text) {
          state.cursor++;
          state.unchangedCount++;
          state.status = `Unchanged: ${page.title}`;
          await saveState(state);
          await renderState(state);
          continue;
        }

        state.status = `${existing ? "Changed" : "New page"}: fetching ${page.title}…`;
        await saveState(state);
        await renderState(state);
        const text = await fetchRawSource(page.title);
        await saveSource({
          title: page.title,
          text,
          revisionTimestamp: page.revisionTimestamp,
          revisionId: page.revisionId,
          scrapedAt: new Date().toISOString(),
        });
        state.cursor++;
        state.fetchedCount++;
        state.status = `Saved ${page.title} (revision ${page.revisionTimestamp}).`;
        await saveState(state);
        await renderState(state);
        if (active && state.cursor < state.pages.length) {
          const wait = Number(panel.querySelector(".rse-delay").value) || DEFAULT_DELAY_MS;
          state.status = `Waiting ${wait / 1000} seconds before the next changed page.`;
          await saveState(state);
          await renderState(state);
          await delay(wait);
        }
      }

      if (state.cursor >= state.pages.length && state.listingComplete) {
        state.scanComplete = true;
        state.phase = "done";
        state.lastScanAt = new Date().toISOString();
        state.paused = true;
        state.status = `Scan complete: ${state.fetchedCount} new/changed, ${state.unchangedCount} unchanged.`;
        await saveState(state);
      } else if (!active) {
        state.paused = true;
        state.status = "Paused. Progress is saved in this browser.";
        await saveState(state);
      }
    } catch (error) {
      active = false;
      state.paused = true;
      state.resumeAfter = error instanceof HttpFailure ? error.retryAfter : 0;
      state.status = error instanceof HttpFailure && error.status === 429
        ? `Rate limited. Paused${error.retryAfter ? ` until ${new Date(error.retryAfter).toLocaleString()}` : "; wait before continuing"}.`
        : error instanceof HttpFailure && error.status === 403
          ? "HTTP 403. Paused; check the wiki in this tab and continue later if access returns."
          : `Paused: ${error.message || error}`;
      await saveState(state);
    }
    active = false;
    await renderState(state);
  }

  function resetForFreshScan(state) {
    const previousScanAt = state.lastScanAt;
    Object.assign(state, freshState("Checking the current category and latest revisions…"));
    state.key = STATE_KEY;
    state.schema = 2;
    state.lastScanAt = previousScanAt;
  }

  async function start() {
    if (runPromise) return;
    const state = await getState();
    if (state.scanComplete) resetForFreshScan(state);
    if (state.resumeAfter && Date.now() < state.resumeAfter) {
      state.status = `Rate-limit cooldown remains until ${new Date(state.resumeAfter).toLocaleString()}.`;
      await saveState(state);
      await renderState(state);
      return;
    }
    state.resumeAfter = 0;
    state.paused = false;
    state.status = state.phase === "listing" ? "Checking the current category and latest revisions…" : "Continuing the saved page list…";
    active = true;
    await saveState(state);
    runPromise = run(state).finally(() => { runPromise = null; });
    await runPromise;
  }

  async function pause() {
    active = false;
    const state = await getState();
    state.paused = true;
    state.status = "Pause requested. The current request will finish first.";
    await saveState(state);
    await renderState(state);
  }

  function downloadJson(payload, filename) {
    const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
  }

  async function exportData(includeProgress) {
    try {
      const state = await getState();
      const rows = await getAllSources();
      rows.sort((a, b) => a.title.localeCompare(b.title));
      const payload = {
        version: 2,
        source: "RPCS3 Wiki",
        category: CATEGORY,
        exportedAt: new Date().toISOString(),
        scan: includeProgress ? {
          pages: state.pages,
          continuation: state.continuation,
          listingComplete: state.listingComplete,
          cursor: state.cursor,
          phase: state.phase,
          scanComplete: state.scanComplete,
          customList: state.customList,
          revisionCursor: state.revisionCursor,
          revisionsComplete: state.revisionsComplete,
          customMetadataCursor: state.customMetadataCursor,
          customMetadataComplete: state.customMetadataComplete,
          lastScanAt: state.lastScanAt,
          unchangedCount: state.unchangedCount,
          fetchedCount: state.fetchedCount,
          resumeAfter: state.resumeAfter,
        } : null,
        pages: rows.map(({ title, text, revisionTimestamp, revisionId, scrapedAt }) => ({
          title, source: text, revisionTimestamp: revisionTimestamp || null, revisionId: revisionId || null, scrapedAt: scrapedAt || null,
        })),
      };
      const date = new Date().toISOString().slice(0, 10);
      downloadJson(payload, `rpcs3-wiki-${includeProgress ? "backup" : "sources"}-${date}.json`);
      statusEl.textContent = `${includeProgress ? "Backup" : "Source export"} saved with ${rows.length.toLocaleString()} page sources.`;
    } catch (error) {
      statusEl.textContent = `Export failed: ${error.message || error}`;
    }
  }

  async function importJson(data) {
    if (!Array.isArray(data?.pages)) throw new Error("JSON file has no pages array.");
    const records = [];
    for (const item of data.pages) {
      const title = typeof item?.title === "string" ? item.title.trim() : "";
      const text = typeof item?.source === "string" ? item.source : typeof item?.text === "string" ? item.text : "";
      if (!title || !text) continue;
      records.push({
        title,
        text,
        revisionTimestamp: item.revisionTimestamp || null,
        revisionId: item.revisionId || null,
        scrapedAt: item.scrapedAt || new Date().toISOString(),
      });
    }
    await saveSources(records);

    if (data.version === 2 && data.scan && Array.isArray(data.scan.pages)) {
      const scan = data.scan;
      const state = {
        ...freshState("Previous scan backup loaded. Continue to resume its saved list."),
        pages: scan.pages,
        continuation: scan.continuation || null,
        listingComplete: Boolean(scan.listingComplete),
        cursor: Number(scan.cursor) || 0,
        phase: scan.phase || "listing",
        scanComplete: Boolean(scan.scanComplete),
        customList: Boolean(scan.customList),
        revisionCursor: Number(scan.revisionCursor ?? scan.customMetadataCursor) || 0,
        revisionsComplete: Boolean(scan.revisionsComplete ?? scan.customMetadataComplete),
        customMetadataCursor: Number(scan.customMetadataCursor) || 0,
        customMetadataComplete: Boolean(scan.customMetadataComplete),
        lastScanAt: scan.lastScanAt || null,
        unchangedCount: Number(scan.unchangedCount) || 0,
        fetchedCount: Number(scan.fetchedCount) || 0,
        resumeAfter: Number(scan.resumeAfter) || 0,
      };
      await saveState(state);
    } else {
      const state = freshState("Sources loaded. Start a fresh revision scan to find changes and new pages.");
      await saveState(state);
    }
  }

  async function importTitleList(text) {
    const titlesByKey = new Map();
    for (const line of text.split(/\r?\n/)) {
      const value = line.trim();
      if (!value) continue;
      let title = value;
      try {
        if (/^https?:\/\//i.test(value)) {
          const link = new URL(value);
          title = link.searchParams.get("title") || decodeURIComponent(link.pathname.split("/").pop());
        }
      } catch { /* Treat malformed URL lines as titles. */ }
      title = title.trim().replaceAll("_", " ");
      if (title && !titlesByKey.has(titleKey(title))) titlesByKey.set(titleKey(title), title);
    }
    const titles = [...titlesByKey.values()];
    if (!titles.length) throw new Error("No page titles found in the text file.");
    const state = {
      ...freshState(`Loaded ${titles.length.toLocaleString()} titles. Continue this saved list.`),
      pages: titles.map((title) => ({ title, revisionTimestamp: null, revisionId: null })),
      listingComplete: true,
      phase: "revisions",
      customList: true,
      revisionCursor: 0,
      revisionsComplete: false,
      customMetadataCursor: 0,
      customMetadataComplete: false,
    };
    await saveState(state);
  }

  async function loadFile(event) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      if (file.name.toLowerCase().endsWith(".txt")) {
        await importTitleList(text);
      } else {
        await importJson(JSON.parse(text));
      }
      const state = await getState();
      statusEl.textContent = state.status;
      await renderState(state);
    } catch (error) {
      statusEl.textContent = `Could not load file: ${error.message || error}`;
    } finally {
      input.value = "";
    }
  }

  getState().then(renderState).catch((error) => {
    statusEl.textContent = `Local storage unavailable: ${error.message || error}`;
  });
})();
