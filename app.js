/* zerodig · advanced youtube search · client-side
 * search.list (100u) exposes every native filter; results are enriched via
 * videos.list / channels.list / playlists.list (1u each) so we can also filter
 * and re-sort locally by views, likes, comments and length. Resumable paging.
 * No dependencies, no build step. All state in the browser.
 */
(() => {
  "use strict";

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const API = "https://www.googleapis.com/youtube/v3";
  const STORE_KEY = "zerodig.apikey";
  const STORE_CFG = "zerodig.cfg";
  const STORE_QUOTA = "zerodig.quota"; // { date, used }
  const STORE_PRESETS = "zerodig.presets"; // [{ name, cfg }]
  const STORE_STARS = "zerodig.stars";     // [{ key, q, cfg, ts }]
  const STORE_SEEN = "zerodig.seen";       // [videoId, ...] memory of seen/dismissed videos

  const ids = ["apikey","q","exclude","type","order","min-views","max-views","min-likes",
    "sort","min-dur","max-dur","after","before","region","lang","safe","v-duration",
    "v-definition","v-dimension","v-caption","v-license","v-type","category","event",
    "embeddable","syndicated","ppp","channel-id","location","radius","maxresults",
    "maxpages","target","slices"];

  const el = {
    form: $("#builder"),
    saveKey: $("#save-key"), toggleKey: $("#toggle-key"), qEcho: $("#q-echo"),
    run: $("#run"), runLabel: $("#run-label"), stop: $("#stop"),
    quotaEst: $("#quota-est"), moreEst: $("#more-est"),
    console: $("#console"), consoleState: $("#console-state"),
    results: $("#results"), ledger: $("#ledger"), resultN: $("#result-n"),
    resultScope: $("#result-scope"), resultSort: $("#result-sort"),
    empty: $("#empty"), moreWrap: $("#more-wrap"), digMore: $("#dig-more"),
    statKey: $("#stat-key"), statQuota: $("#stat-quota"), statFound: $("#stat-found"),
    footQuota: $("#foot-quota"),
    presetsRow: $("#presets-row"), savePreset: $("#save-preset"),
    starsList: $("#stars-list"), starsCount: $("#stars-count"), starBtn: $("#star-btn"),
    openYt: $("#open-yt"), copyYt: $("#copy-yt"), ytUrl: $("#yt-url"),
    hideSeen: $("#hide-seen"), seenCount: $("#seen-count"),
    markAllSeen: $("#mark-all-seen"), resetSeen: $("#reset-seen"),
    deep: $("#deep"), deepOpts: $("#deep-opts"),
    useCache: $("#use-cache"), cacheTtl: $("#cache-ttl"), cacheCount: $("#cache-count"),
    clearCacheBtn: $("#clear-cache"), quotaLeft: $("#quota-left"),
  };
  // map field ids to camelCase refs
  const f = {};
  ids.forEach((id) => { f[id] = $("#" + id); });

  let controller = null;
  let session = null; // { cfg, pageToken, items, seen, scanned, exhausted, filters, sort }
  let keyIdx = 0;      // active key index (multi-key rotation)
  let runUnits = 0;    // quota units spent in the current dig
  let cacheMem = null; // in-memory page cache: Map(hash -> { ts, items, nextPageToken, found })
  let cacheDirty = false, persistTimer = null;

  // ============================================================ utils
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtInt = (n) => Number(n).toLocaleString("en-US");
  const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };

  const fmtCompact = (n) => {
    if (n == null) return "n/a";
    if (n < 1000) return String(n);
    if (n < 1e6)  return (n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, "") + "k";
    if (n < 1e9)  return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  };
  const fmtDate = (iso) => { const d = new Date(iso); return isNaN(d) ? "n/a" : d.toLocaleDateString("en-CA"); };

  const durSeconds = (iso) => {
    if (!iso) return null;
    const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!m) return null;
    return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
  };
  const fmtClock = (sec) => {
    if (sec == null) return "";
    const h = Math.floor(sec / 3600), mn = Math.floor((sec % 3600) / 60), s = sec % 60;
    const p = (x) => String(x).padStart(2, "0");
    return h ? `${h}:${p(mn)}:${p(s)}` : `${mn}:${p(s)}`;
  };

  // ============================================================ console
  function log(msg, kind = "") {
    const cur = $(".logline:last-child .cursor", el.console)?.closest(".logline");
    const line = document.createElement("div");
    line.className = "logline" + (kind ? ` logline--${kind}` : "");
    const lead = kind === "hit" || kind === "ok" ? "✓" : kind === "warn" ? "" : ">";
    line.innerHTML = `<span class="lead">${lead}</span><span>${msg}</span>`;
    if (cur) el.console.insertBefore(line, cur); else el.console.appendChild(line);
    el.console.scrollTop = el.console.scrollHeight;
  }
  function clearConsole() {
    el.console.innerHTML = `<div class="logline"><span class="lead">&gt;</span><span class="cursor" aria-hidden="true"></span></div>`;
  }

  // ============================================================ quota
  const today = () => new Date().toISOString().slice(0, 10);
  function getQuota() {
    try { const q = JSON.parse(localStorage.getItem(STORE_QUOTA) || "null"); if (q && q.date === today()) return q.used; } catch {}
    return 0;
  }
  function addQuota(u) {
    const used = getQuota() + u;
    localStorage.setItem(STORE_QUOTA, JSON.stringify({ date: today(), used }));
    paintQuota(used); return used;
  }
  function paintQuota(used = getQuota()) {
    el.statQuota.querySelector("b").textContent = fmtInt(used);
    el.footQuota.textContent = fmtInt(used);
    el.statQuota.dataset.ok = used < 9000;
    if (el.quotaLeft) el.quotaLeft.textContent = fmtInt(Math.max(0, 10000 - used));
  }

  // ============================================================ config
  function readCfg() {
    const c = {};
    ids.forEach((id) => { c[id] = f[id].value.trim(); });
    return c;
  }
  function saveCfg() { try { localStorage.setItem(STORE_CFG, JSON.stringify(readCfg())); } catch {} }
  function loadCfg() {
    let c; try { c = JSON.parse(localStorage.getItem(STORE_CFG) || "null"); } catch {}
    if (!c) return;
    for (const [k, v] of Object.entries(c)) if (f[k] != null && v != null && v !== "") f[k].value = v;
  }

  function buildQuery(cfg) {
    let q = cfg.q;
    const ex = cfg.exclude.split(/\s+/).filter(Boolean).map((t) => `-${t.replace(/^-+/, "")}`);
    if (ex.length) q = (q + " " + ex.join(" ")).trim();
    return q;
  }
  function paintEcho() { el.qEcho.textContent = buildQuery(readCfg()) || "(empty)"; paintEstimate(); updateYtPreview(); }
  function paintEstimate() {
    const pages = Math.max(1, Math.min(20, num(f.maxpages.value) || 1));
    const deep = el.deep && el.deep.checked;
    const slices = Math.max(2, Math.min(40, num(f.slices ? f.slices.value : "") || 8));
    const units = deep ? slices * pages * 103 : pages * 103;
    el.quotaEst.textContent = "~" + fmtInt(units);
    if (el.quotaLeft) el.quotaLeft.textContent = fmtInt(Math.max(0, 10000 - getQuota()));
    if (el.moreEst) el.moreEst.textContent = fmtInt(pages * 103);
  }
  function paintType() { el.form.dataset.type = f.type.value; }

  function paintKey() {
    const n = getKeys().length;
    el.statKey.dataset.ok = n > 0;
    el.statKey.querySelector("b").textContent = n > 1 ? `set ✓ (${n})` : n === 1 ? "set ✓" : "none ✗";
  }

  // ============================================================ presets
  function dateMinus(days) {
    const d = new Date(); d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 10);
  }
  // each preset fully sets the filter fields it controls; query, locale and key are left alone
  const PRESETS = {
    gems: { label: "Hidden Gems", values: () => ({
      type: "video", order: "relevance", sort: "views_asc",
      "min-views": "", "max-views": "1000", "min-likes": "",
      "min-dur": "", "max-dur": "", "v-duration": "any",
      after: "", before: dateMinus(365), event: "",
    }) },
    fresh: { label: "Fresh Drops", values: () => ({
      type: "video", order: "date", sort: "date_desc",
      "min-views": "", "max-views": "", "min-likes": "",
      "min-dur": "", "max-dur": "", "v-duration": "any",
      after: dateMinus(7), before: "", event: "",
    }) },
    deep: { label: "Deep Dives", values: () => ({
      type: "video", order: "viewCount", sort: "views_desc",
      "min-views": "", "max-views": "", "min-likes": "",
      "min-dur": "", "max-dur": "", "v-duration": "long",
      after: "", before: "", event: "",
    }) },
  };
  function applyPreset(name) {
    const p = PRESETS[name];
    if (!p) return;
    for (const [id, v] of Object.entries(p.values())) if (f[id]) f[id].value = v;
    paintType(); paintEcho(); saveCfg();
    $$(".preset").forEach((b) => b.setAttribute("aria-pressed", b.dataset.preset === name ? "true" : "false"));
    log(`preset "${p.label}" applied. Adjust the query and hit Digging.`, "dim");
  }

  // ============================================================ custom presets + starred searches
  function loadJSON(k) { try { return JSON.parse(localStorage.getItem(k) || "[]"); } catch { return []; } }
  function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  function filterCfg(cfg) { const c = { ...cfg }; delete c.apikey; return c; }
  function markPreset(btn) {
    $$(".preset").forEach((b) => b.setAttribute("aria-pressed", "false"));
    if (btn) btn.setAttribute("aria-pressed", "true");
  }

  // --- custom presets: a saved filter template (query is left alone) ---
  function getPresets() { return loadJSON(STORE_PRESETS); }
  function saveCurrentAsPreset() {
    const name = (prompt("Name this preset:") || "").trim();
    if (!name) return;
    const list = getPresets().filter((p) => p.name !== name);
    list.push({ name, cfg: filterCfg(readCfg()) });
    saveJSON(STORE_PRESETS, list);
    renderPresets();
    log(`preset "${esc(name)}" saved.`, "ok");
  }
  function deletePreset(name) { saveJSON(STORE_PRESETS, getPresets().filter((p) => p.name !== name)); renderPresets(); }
  function applyCustomPreset(name) {
    const p = getPresets().find((x) => x.name === name);
    if (!p) return;
    for (const [id, v] of Object.entries(p.cfg)) if (id !== "q" && id !== "exclude" && f[id]) f[id].value = v ?? "";
    paintType(); paintEcho(); saveCfg();
    markPreset($$(".preset").find((b) => b.dataset.custom === name));
    log(`preset "${esc(name)}" applied. Adjust the query and hit Digging.`, "dim");
  }
  function renderPresets() {
    $$(".preset-wrap", el.presetsRow).forEach((n) => n.remove());
    for (const p of getPresets()) {
      const wrap = document.createElement("div");
      wrap.className = "preset-wrap";
      wrap.innerHTML =
        `<button type="button" class="preset" data-custom="${esc(p.name)}"><b>${esc(p.name)}</b><small>custom</small></button>` +
        `<button type="button" class="preset-del" data-del="${esc(p.name)}" aria-label="delete preset">×</button>`;
      el.presetsRow.appendChild(wrap);
    }
  }

  // --- starred searches: a saved query + its filters ---
  function getStars() { return loadJSON(STORE_STARS); }
  function starKey(cfg) { return JSON.stringify(filterCfg(cfg)); }
  function isStarred(cfg) { const k = starKey(cfg); return getStars().some((s) => s.key === k); }
  function toggleStar() {
    if (!session) { log("run a search first, then star it.", "dim"); return; }
    const k = starKey(session.cfg);
    let list = getStars();
    if (list.some((s) => s.key === k)) { list = list.filter((s) => s.key !== k); log("search unstarred.", "dim"); }
    else {
      list.unshift({ key: k, cfg: filterCfg(session.cfg), q: buildQuery(session.cfg), ts: Date.now() });
      list = list.slice(0, 40);
      log("search starred.", "ok");
    }
    saveJSON(STORE_STARS, list);
    renderStars(); paintStarBtn();
  }
  function paintStarBtn() {
    const on = !!(session && isStarred(session.cfg));
    el.starBtn.textContent = on ? "★ starred" : "☆ star";
    el.starBtn.setAttribute("aria-pressed", on ? "true" : "false");
    el.starBtn.disabled = !session;
  }
  function applyStarByIdx(i) {
    const s = getStars()[i];
    if (!s) return;
    for (const [id, v] of Object.entries(s.cfg)) if (f[id]) f[id].value = v ?? "";
    paintType(); paintEcho(); saveCfg(); markPreset(null);
    if (f.apikey.value.trim() && buildQuery(readCfg())) run(readCfg(), false);
    else log("starred search loaded. Set your api key, then hit Digging.", "dim");
  }
  function renderStars() {
    const list = getStars();
    el.starsCount.textContent = list.length;
    if (!list.length) {
      el.starsList.innerHTML = `<p class="hint-note">No starred searches yet. Run a search, then hit ☆ star above the results.</p>`;
      return;
    }
    el.starsList.innerHTML = "";
    list.forEach((s, i) => {
      const meta = [s.cfg.type,
        s.cfg["max-views"] ? `≤${fmtInt(s.cfg["max-views"])} views` : "",
        (s.cfg.sort && s.cfg.sort !== "api") ? (SORT_LABEL[s.cfg.sort] || s.cfg.sort) : ""].filter(Boolean).join(" · ");
      const row = document.createElement("div");
      row.className = "star-row";
      row.innerHTML =
        `<button type="button" class="star-apply" data-idx="${i}"><b>${esc(s.q || "(no query)")}</b><small>${esc(meta)}</small></button>` +
        `<button type="button" class="star-del" data-idx="${i}" aria-label="remove starred search">×</button>`;
      el.starsList.appendChild(row);
    });
  }

  // ============================================================ URL mode (no API)
  // Builds a youtube.com/results URL. The "sp" param is a base64 protobuf of YouTube's
  // own search filters (sort + a nested filters message). Field numbers reverse-engineered.
  function pbVarint(n) { const b = []; n = Math.max(0, Math.floor(n)); do { let x = n & 0x7f; n = Math.floor(n / 128); if (n) x |= 0x80; b.push(x); } while (n); return b; }
  function pbTag(field, wire) { return pbVarint(field * 8 + wire); }
  const YT = {
    sort: { relevance: 0, rating: 1, date: 2, views: 3 },     // top-level field 1
    date: { any: 0, hour: 1, today: 2, week: 3, month: 4, year: 5 }, // nested field 1
    type: { any: 0, video: 1, channel: 2, playlist: 3, movie: 4 },   // nested field 2
    duration: { any: 0, short: 1, long: 2, medium: 3 },       // nested field 3
  };
  function gv(id) { const e = document.getElementById(id); return e ? e.value : "any"; }
  function buildSp() {
    const pairs = [];
    const d = YT.date[gv("u-date")]; if (d) pairs.push([1, d]);
    const t = YT.type[gv("u-type")]; if (t) pairs.push([2, t]);
    const du = YT.duration[gv("u-duration")]; if (du) pairs.push([3, du]);
    $$(".u-feat").forEach((cb) => { if (cb.checked) pairs.push([+cb.dataset.field, 1]); });
    pairs.sort((a, b) => a[0] - b[0]);
    const nested = [];
    pairs.forEach(([field, val]) => nested.push(...pbTag(field, 0), ...pbVarint(val)));
    const sort = YT.sort[gv("u-sort")] || 0;
    const top = [];
    if (sort) top.push(...pbTag(1, 0), ...pbVarint(sort));
    if (nested.length) top.push(...pbTag(2, 2), ...pbVarint(nested.length), ...nested);
    if (!top.length) return "";
    return btoa(String.fromCharCode.apply(null, top));
  }
  function buildYtUrl() {
    const q = buildQuery(readCfg());
    const u = new URL("https://www.youtube.com/results");
    if (q) u.searchParams.set("search_query", q);
    const sp = buildSp();
    if (sp) u.searchParams.set("sp", sp);
    return u.toString();
  }
  function updateYtPreview() { if (el.ytUrl) el.ytUrl.textContent = buildYtUrl(); }
  function setMode(mode) {
    const m = mode === "url" ? "url" : "api";
    document.body.dataset.mode = m;
    try { localStorage.setItem("zerodig.mode", m); } catch {}
    $$(".modetab").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === m ? "true" : "false"));
    updateYtPreview();
  }
  function openYt() { const url = buildYtUrl(); window.open(url, "_blank", "noopener"); }

  // ============================================================ fetch
  async function ytFetch(path, params, signal) {
    const url = new URL(`${API}/${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== "" && v != null) url.searchParams.set(k, v);
    const res = await fetch(url, { signal });
    let data = null; try { data = await res.json(); } catch {}
    if (!res.ok) {
      const e = new Error(data?.error?.message || res.statusText);
      e.reason = data?.error?.errors?.[0]?.reason || data?.error?.status || res.status;
      throw e;
    }
    return data;
  }

  // ---- multi-key rotation: use several keys, switch to the next on quotaExceeded ----
  function getKeys() { return f.apikey.value.trim().split(/[\s,]+/).filter(Boolean); }
  async function ytFetchKeyed(path, params, signal) {
    const keys = getKeys();
    while (true) {
      const key = keys[keyIdx] || keys[0] || "";
      try { return await ytFetch(path, { ...params, key }, signal); }
      catch (e) {
        if (e.reason === "quotaExceeded" && keyIdx < keys.length - 1) {
          keyIdx++;
          log(`key ${keyIdx}/${keys.length} out of quota, switching to key ${keyIdx + 1}`, "warn");
          continue;
        }
        throw e;
      }
    }
  }

  // ---- response cache: a search page + its enrichment, keyed by request (never by api key) ----
  const CACHE_STORE = "zerodig.cache";
  const CACHE_MAX = 200;
  function hashStr(s) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
  }
  function cacheMap() {
    if (cacheMem) return cacheMem;
    cacheMem = new Map();
    try { for (const [k, e] of JSON.parse(localStorage.getItem(CACHE_STORE) || "[]")) cacheMem.set(k, e); } catch {}
    return cacheMem;
  }
  function useCacheOn() { return !(el.useCache && !el.useCache.checked); }
  function cacheTTL() { return Math.max(1, num(el.cacheTtl ? el.cacheTtl.value : "") || 60) * 60000; }
  function cacheGet(k) {
    const m = cacheMap(); const e = m.get(k);
    if (!e) return null;
    if (Date.now() - e.ts > cacheTTL()) { m.delete(k); cacheDirty = true; return null; }
    m.delete(k); m.set(k, e); // LRU bump
    return e;
  }
  function cacheSet(k, val) {
    const m = cacheMap();
    m.set(k, { ts: Date.now(), ...val });
    while (m.size > CACHE_MAX) m.delete(m.keys().next().value);
    cacheDirty = true; schedulePersist(); paintCache();
  }
  function schedulePersist() { clearTimeout(persistTimer); persistTimer = setTimeout(persistCache, 900); }
  function persistCache() {
    if (!cacheDirty) return;
    const m = cacheMap();
    try { localStorage.setItem(CACHE_STORE, JSON.stringify([...m.entries()])); cacheDirty = false; }
    catch {
      const arr = [...m.entries()], half = Math.floor(arr.length / 2);
      for (let i = 0; i < half; i++) m.delete(arr[i][0]);
      try { localStorage.setItem(CACHE_STORE, JSON.stringify([...m.entries()])); cacheDirty = false; } catch {}
    }
    paintCache();
  }
  function clearCache() { cacheMem = new Map(); cacheDirty = false; try { localStorage.removeItem(CACHE_STORE); } catch {} paintCache(); }
  function paintCache() { if (el.cacheCount) el.cacheCount.textContent = fmtInt(cacheMap().size); }

  // one search page + enrichment, served from cache when possible
  async function fetchPage(searchParams, signal) {
    const ck = "s:" + hashStr(JSON.stringify(Object.keys(searchParams).sort().map((k) => [k, searchParams[k]])));
    if (useCacheOn()) {
      const c = cacheGet(ck);
      if (c) { log(`page: <b style="color:var(--color-ink-dim)">cache hit</b> (0u)`, "dim"); return c; }
    }
    const search = await ytFetchKeyed("search", searchParams, signal);
    addQuota(100); runUnits += 100;
    const found = (search.items || []).filter((i) => i.id);
    const items = found.length ? await enrichPage(found, signal) : [];
    const result = { items, nextPageToken: search.nextPageToken || "", found: found.length };
    cacheSet(ck, result);
    return result;
  }

  // ---- quota estimate + preflight budget guard ----
  function estUnits(cfg) {
    const pages = Math.max(1, Math.min(20, num(cfg.maxpages) || 1));
    if (el.deep && el.deep.checked) {
      const slices = Math.max(2, Math.min(40, num(cfg.slices) || 8));
      return slices * pages * 103;
    }
    return pages * 103;
  }
  function preflightOK(est) {
    const remaining = 10000 - getQuota();
    if (est > remaining) return confirm(`This dig may cost ~${fmtInt(est)} units, but only ${fmtInt(Math.max(0, remaining))} remain in today's quota. Continue anyway?`);
    return true;
  }

  const setIf = (obj, key, val) => { if (val && val !== "any") obj[key] = val; };
  const rfc = (dateStr, end) => dateStr ? `${dateStr}T${end ? "23:59:59" : "00:00:00"}Z` : "";

  function buildSearchParams(cfg, pageToken) {
    const type = cfg.type || "video";
    const p = {
      part: "snippet", maxResults: Math.max(1, Math.min(50, num(cfg.maxresults) || 50)),
      q: buildQuery(cfg), type, order: cfg.order, safeSearch: cfg.safe,
      publishedAfter: rfc(cfg.after, false), publishedBefore: rfc(cfg.before, true),
      regionCode: cfg.region ? cfg.region.toUpperCase() : "",
      relevanceLanguage: cfg.lang, channelId: cfg["channel-id"], pageToken,
    };
    if (type === "video") {
      setIf(p, "videoDuration", cfg["v-duration"]);
      setIf(p, "videoDefinition", cfg["v-definition"]);
      setIf(p, "videoDimension", cfg["v-dimension"]);
      setIf(p, "videoCaption", cfg["v-caption"]);
      setIf(p, "videoLicense", cfg["v-license"]);
      setIf(p, "videoType", cfg["v-type"]);
      setIf(p, "videoEmbeddable", cfg.embeddable);
      setIf(p, "videoSyndicated", cfg.syndicated);
      setIf(p, "videoPaidProductPlacement", cfg.ppp);
      setIf(p, "eventType", cfg.event);
      if (cfg.category) p.videoCategoryId = cfg.category;
      if (cfg.location && cfg.radius) { p.location = cfg.location; p.locationRadius = cfg.radius; }
    }
    return p;
  }

  // ---- normalise enriched items ----
  const thumbOf = (sn) => sn?.thumbnails?.medium?.url || sn?.thumbnails?.default?.url || "";
  function normVideo(v) {
    return { kind: "video", id: v.id, title: v.snippet?.title || "(untitled)",
      channel: v.snippet?.channelTitle || "unknown", published: v.snippet?.publishedAt,
      thumb: thumbOf(v.snippet), views: v.statistics?.viewCount != null ? +v.statistics.viewCount : null,
      likes: v.statistics?.likeCount != null ? +v.statistics.likeCount : null,
      comments: v.statistics?.commentCount != null ? +v.statistics.commentCount : null,
      durSec: durSeconds(v.contentDetails?.duration), hd: v.contentDetails?.definition === "hd",
      link: `https://www.youtube.com/watch?v=${v.id}` };
  }
  function normChannel(c) {
    return { kind: "channel", id: c.id, title: c.snippet?.title || "(channel)",
      channel: c.snippet?.title, published: c.snippet?.publishedAt, thumb: thumbOf(c.snippet),
      desc: c.snippet?.description || "", subs: c.statistics?.subscriberCount != null ? +c.statistics.subscriberCount : null,
      videoCount: c.statistics?.videoCount != null ? +c.statistics.videoCount : null,
      views: c.statistics?.viewCount != null ? +c.statistics.viewCount : null,
      link: `https://www.youtube.com/channel/${c.id}` };
  }
  function normPlaylist(p) {
    return { kind: "playlist", id: p.id, title: p.snippet?.title || "(playlist)",
      channel: p.snippet?.channelTitle || "unknown", published: p.snippet?.publishedAt,
      thumb: thumbOf(p.snippet), itemCount: p.contentDetails?.itemCount ?? null,
      link: `https://www.youtube.com/playlist?list=${p.id}` };
  }

  async function enrichPage(searchItems, signal) {
    const g = { video: [], channel: [], playlist: [] };
    const order = [];
    for (const it of searchItems) {
      const k = it.id?.kind || "";
      if (k.endsWith("#video") && it.id.videoId) { g.video.push(it.id.videoId); order.push("video:" + it.id.videoId); }
      else if (k.endsWith("#channel") && it.id.channelId) { g.channel.push(it.id.channelId); order.push("channel:" + it.id.channelId); }
      else if (k.endsWith("#playlist") && it.id.playlistId) { g.playlist.push(it.id.playlistId); order.push("playlist:" + it.id.playlistId); }
    }
    const map = new Map();
    if (g.video.length) {
      const r = await ytFetchKeyed("videos", { part: "snippet,statistics,contentDetails", id: g.video.join(",") }, signal);
      addQuota(1); runUnits += 1; for (const v of r.items || []) map.set("video:" + v.id, normVideo(v));
    }
    if (g.channel.length) {
      const r = await ytFetchKeyed("channels", { part: "snippet,statistics", id: g.channel.join(",") }, signal);
      addQuota(1); runUnits += 1; for (const c of r.items || []) map.set("channel:" + c.id, normChannel(c));
    }
    if (g.playlist.length) {
      const r = await ytFetchKeyed("playlists", { part: "snippet,contentDetails", id: g.playlist.join(",") }, signal);
      addQuota(1); runUnits += 1; for (const p of r.items || []) map.set("playlist:" + p.id, normPlaylist(p));
    }
    return order.map((k) => map.get(k)).filter(Boolean);
  }

  // ---- client-side post filters (video items only) ----
  function passesFilters(it, ft) {
    if (it.kind !== "video") return true;
    if (ft.minViews != null || ft.maxViews != null) {
      if (it.views == null) return false;
      if (ft.minViews != null && it.views < ft.minViews) return false;
      if (ft.maxViews != null && it.views > ft.maxViews) return false;
    }
    if (ft.minLikes != null) { if (it.likes == null || it.likes < ft.minLikes) return false; }
    if (ft.minDur != null) { if (it.durSec == null || it.durSec < ft.minDur) return false; }
    if (ft.maxDur != null) { if (it.durSec == null || it.durSec > ft.maxDur) return false; }
    return true;
  }

  function sortItems(items, mode) {
    const metric = (it, key) =>
      key === "views" ? (it.views ?? null) :
      key === "likes" ? (it.likes ?? null) :
      key === "date"  ? (it.published ? Date.parse(it.published) : null) :
      key === "dur"   ? (it.durSec ?? null) : null;
    const cmp = (key, dir) => (a, b) => {
      const av = metric(a, key), bv = metric(b, key);
      if (av == null && bv == null) return 0;
      if (av == null) return 1; if (bv == null) return -1;
      return dir * (av - bv);
    };
    const map = {
      views_asc: cmp("views", 1), views_desc: cmp("views", -1),
      likes_desc: cmp("likes", -1), date_desc: cmp("date", -1), date_asc: cmp("date", 1),
      dur_desc: cmp("dur", -1), dur_asc: cmp("dur", 1),
    };
    if (map[mode]) items.sort(map[mode]);
  }

  const SORT_LABEL = { api: "api order", views_asc: "views ↑", views_desc: "views ↓",
    likes_desc: "likes ↓", date_desc: "newest", date_asc: "oldest", dur_desc: "longest", dur_asc: "shortest" };

  // ============================================================ the search
  async function run(cfg, resume = false) {
    if (!getKeys().length) { log("no api key set. enter one above and Save.", "warn"); return; }
    const q = buildQuery(cfg);
    if (!q && !cfg["channel-id"]) { log("empty query. type something to search for.", "warn"); return; }

    const maxPages = Math.max(1, Math.min(20, num(cfg.maxpages) || 3));
    const target   = Math.max(1, num(cfg.target) || 50);
    const filters = {
      minViews: num(cfg["min-views"]), maxViews: num(cfg["max-views"]),
      minLikes: num(cfg["min-likes"]), minDur: num(cfg["min-dur"]), maxDur: num(cfg["max-dur"]),
    };

    if (!resume || !session) {
      session = { cfg, pageToken: "", items: [], seen: new Set(), scanned: 0, exhausted: false, sort: cfg.sort };
      clearConsole();
      el.ledger.innerHTML = ""; el.results.hidden = true; el.empty.hidden = true; el.moreWrap.hidden = true;
      log(`query: <b style="color:var(--color-ink)">${esc(q || "(channel scope)")}</b> · type ${esc(cfg.type)}`, "dim");
      const bits = [];
      if (cfg.after || cfg.before) bits.push(`date ${esc(cfg.after || "…")}→${esc(cfg.before || "…")}`);
      if (cfg.region) bits.push(`region ${esc(cfg.region.toUpperCase())}`);
      if (cfg.category) bits.push(`category ${esc(cfg.category)}`);
      if (filters.minViews != null || filters.maxViews != null) bits.push(`views ${filters.minViews ?? 0} to ${filters.maxViews ?? "∞"}`);
      if (bits.length) log(bits.join(" · "), "dim");
      log(`order ${esc(cfg.order)} · sort ${esc(SORT_LABEL[cfg.sort] || cfg.sort)} · depth ${maxPages} · target ${target}`, "dim");
    } else {
      log(`loading more · ${session.items.length} so far · +${maxPages} pages`, "dim");
    }

    controller = new AbortController();
    setRunning(true);
    el.consoleState.textContent = "searching…";

    keyIdx = 0; if (!resume) runUnits = 0;
    const goal = visibleItems(session.items).length + target;
    let page = 0;

    try {
      while (page < maxPages && visibleItems(session.items).length < goal && !session.exhausted) {
        page++;
        log(`search · page ${page}/${maxPages}`);
        const sp = buildSearchParams(cfg, session.pageToken);
        const pg = await fetchPage(sp, controller.signal);

        if (pg.found === 0) { log("no items on this page, stopping.", "dim"); session.exhausted = true; break; }
        session.scanned += pg.found;

        let pageHits = 0;
        for (const it of pg.items) {
          const uid = it.kind + ":" + it.id;
          if (session.seen.has(uid)) continue;
          if (!passesFilters(it, filters)) continue;
          session.seen.add(uid);
          session.items.push(it);
          pageHits++;
        }
        const vis = visibleItems(session.items).length;
        log(`page ${page}: +${pageHits} found · ${vis} shown`, pageHits ? "hit" : "dim");

        session.pageToken = pg.nextPageToken;
        if (!session.pageToken) { log("reached last page of results.", "dim"); session.exhausted = true; break; }
      }

      session.sort = cfg.sort;
      sortItems(session.items, cfg.sort);
      el.consoleState.textContent = "done";
      const more = !session.exhausted;
      const vis = visibleItems(session.items).length;
      log(`search ${resume ? "extended" : "complete"}: scanned ${session.scanned}, kept ${vis}. ${runUnits === 0 ? "all cached (0u)." : "spent ~" + fmtInt(runUnits) + "u."}` +
          (more ? " more available ↓" : " no more results."), "ok");
      quotaTip();
      render(session.items, cfg);
      el.statFound.querySelector("b").textContent = fmtInt(vis);
      paintQuota(); updateMore();
    } catch (err) {
      if (err.name === "AbortError") { log("aborted by user.", "warn"); el.consoleState.textContent = "stopped"; }
      else {
        el.consoleState.textContent = "error";
        const r = err.reason;
        if (r === "quotaExceeded") log("quota exhausted for today (10,000 units). Try tomorrow or use another key.", "warn");
        else if (r === "keyInvalid" || r === "badRequest") log(`invalid api key / request: ${esc(err.message)}`, "warn");
        else if (r === "accessNotConfigured") log("this key can't reach the YouTube Data API v3. Enable it in Google Cloud → APIs.", "warn");
        else log(`error [${esc(r)}]: ${esc(err.message)}`, "warn");
      }
      if (session && session.items.length) { sortItems(session.items, cfg.sort); render(session.items, cfg); }
      updateMore();
    } finally {
      setRunning(false); controller = null; paintStarBtn();
    }
  }

  function updateMore() {
    el.moreWrap.hidden = !(session && !session.exhausted && session.pageToken);
  }
  function quotaTip() {
    if (runUnits >= 400) log(`this run spent ~${fmtInt(runUnits)} units. Narrow with date, category or duration to reach the target with fewer pages.`, "dim");
  }

  // ============================================================ render
  function render(items, cfg) {
    el.ledger.innerHTML = "";
    const display = visibleItems(items);
    if (!display.length) { el.results.hidden = true; el.empty.hidden = false; return; }
    el.empty.hidden = true; el.results.hidden = false;
    el.resultN.textContent = fmtInt(display.length);
    const kinds = new Set(display.map((i) => i.kind));
    el.resultScope.textContent = kinds.size === 1 ? [...kinds][0] + "s" : "results";
    el.resultSort.textContent = SORT_LABEL[cfg.sort] || "api order";

    const frag = document.createDocumentFragment();
    display.forEach((it, i) => {
      const li = document.createElement("li");
      li.className = "result result--" + it.kind + (isSeen(it.id) ? " is-seen" : "");
      li.dataset.id = it.id; li.dataset.kind = it.kind;
      li.style.setProperty("--i", Math.min(i, 14));
      li.innerHTML = cardHTML(it, i);
      frag.appendChild(li);
    });
    el.ledger.appendChild(frag);
  }

  function cardHTML(it, i) {
    const idx = `<span class="result__idx">${String(i + 1).padStart(2, "0")}</span>`;
    const thumb = `<div class="result__thumb">${it.thumb ? `<img src="${esc(it.thumb)}" alt="" loading="lazy" width="320" height="180" />` : ""}` +
      (it.kind === "video" && it.durSec != null ? `<span class="result__dur">${fmtClock(it.durSec)}</span>` : "") + `</div>`;
    const title = `<a href="${esc(it.link)}" target="_blank" rel="noopener">${esc(it.title)}</a>`;

    if (it.kind === "channel") {
      const meta = [it.videoCount != null ? `${fmtCompact(it.videoCount)} videos` : "",
                    it.views != null ? `${fmtCompact(it.views)} total views` : ""].filter(Boolean).join(" · ");
      return idx + thumb +
        `<div class="result__main"><div class="result__kind">channel</div><div class="result__title">${title}</div>` +
        `<div class="result__meta">${it.desc ? `<span class="result__desc">${esc(it.desc)}</span>` : ""}<span>${meta}</span><span class="result__open">open ↗</span></div></div>` +
        `<div class="result__views"><span class="n">${fmtCompact(it.subs)}</span><span class="lbl">subscribers</span></div>`;
    }
    if (it.kind === "playlist") {
      return idx + thumb +
        `<div class="result__main"><div class="result__kind">playlist</div><div class="result__title">${title}</div>` +
        `<div class="result__meta"><span class="chan">${esc(it.channel)}</span><span>${fmtDate(it.published)}</span><span class="result__open">open ↗</span></div></div>` +
        `<div class="result__views"><span class="n">${it.itemCount != null ? fmtInt(it.itemCount) : "n/a"}</span><span class="lbl">videos</span></div>`;
    }
    // video
    const hidden = it.views == null, zero = it.views === 0;
    const meta = [it.likes != null ? `♥ ${fmtCompact(it.likes)}` : "",
                  it.comments != null ? `▸ ${fmtCompact(it.comments)}` : "",
                  it.hd ? "HD" : ""].filter(Boolean).join(" · ");
    return idx + thumb +
      `<div class="result__main"><div class="result__title">${title}</div>` +
      `<div class="result__meta"><span class="chan">${esc(it.channel)}</span><span>${fmtDate(it.published)}</span>` +
      (meta ? `<span>${meta}</span>` : "") + `<span class="result__open">watch ↗</span></div></div>` +
      `<div class="result__views" data-zero="${zero}" data-hidden="${hidden}"><span class="n">${hidden ? "n/a" : fmtInt(it.views)}</span>` +
      `<span class="lbl">${hidden ? "hidden" : zero ? "zero views" : "views"}</span></div>` +
      `<button type="button" class="result__dismiss" aria-label="hide and remember as seen" title="hide + remember as seen">×</button>`;
  }

  function setRunning(on) {
    el.run.disabled = on;
    el.run.dataset.state = on ? "loading" : "default";
    el.runLabel.textContent = on ? "Digging…" : "Digging";
    el.run.querySelector(".btn__spin").textContent = on ? "…" : "▶";
    el.stop.hidden = !on;
    el.digMore.disabled = on;
    if (on) el.moreWrap.hidden = true;
  }

  // ============================================================ memory (seen videos)
  let seenSet = null;
  function seenStore() { if (!seenSet) seenSet = new Set(loadJSON(STORE_SEEN)); return seenSet; }
  function isSeen(id) { return !!id && seenStore().has(id); }
  function hideSeenOn() { return !!(el.hideSeen && el.hideSeen.checked); }
  function persistSeen() {
    let arr = [...seenStore()];
    if (arr.length > 15000) { arr = arr.slice(arr.length - 15000); seenSet = new Set(arr); }
    saveJSON(STORE_SEEN, arr);
  }
  function markSeen(id) { if (!id || seenStore().has(id)) return; seenStore().add(id); persistSeen(); paintMem(); }
  function markSeenMany(list) { let ch = false; for (const id of list) if (id && !seenStore().has(id)) { seenStore().add(id); ch = true; } if (ch) { persistSeen(); paintMem(); } }
  function clearSeen() { seenSet = new Set(); saveJSON(STORE_SEEN, []); paintMem(); }
  function paintMem() { if (el.seenCount) el.seenCount.textContent = fmtInt(seenStore().size); }
  // items actually shown = all items minus already-seen videos (when "hide seen" is on)
  function visibleItems(items) { return hideSeenOn() ? items.filter((it) => !(it.kind === "video" && isSeen(it.id))) : items; }

  // ============================================================ deep dig (past the ~500 cap)
  function sliceDates(startStr, endStr, n) {
    const s = Date.parse(startStr + "T00:00:00Z");
    const e = Date.parse(endStr + "T23:59:59Z");
    if (isNaN(s) || isNaN(e) || e <= s) return [[startStr, endStr]];
    const out = [];
    const step = (e - s) / n;
    for (let i = 0; i < n; i++) {
      const a = new Date(s + step * i).toISOString().slice(0, 10);
      const b = new Date(s + step * (i + 1)).toISOString().slice(0, 10);
      out.push([a, b]);
    }
    return out;
  }

  function startSearch(cfg, resume) {
    if (!resume && !preflightOK(estUnits(cfg))) { log("cancelled: over remaining quota.", "warn"); return; }
    if (!resume && el.deep && el.deep.checked) return deepDig(cfg);
    return run(cfg, resume);
  }

  async function deepDig(cfg) {
    if (!getKeys().length) { log("no api key set. enter one above and Save.", "warn"); return; }
    const q = buildQuery(cfg);
    if (!q && !cfg["channel-id"]) { log("empty query. type something to dig for.", "warn"); return; }

    const filters = {
      minViews: num(cfg["min-views"]), maxViews: num(cfg["max-views"]),
      minLikes: num(cfg["min-likes"]), minDur: num(cfg["min-dur"]), maxDur: num(cfg["max-dur"]),
    };
    const depth = Math.max(1, Math.min(5, num(cfg.maxpages) || 2));
    const slices = Math.max(2, Math.min(40, num(cfg.slices) || 8));
    const start = cfg.after || "2005-01-01";
    const end = cfg.before || new Date().toISOString().slice(0, 10);
    const bounds = sliceDates(start, end, slices);

    session = { cfg, pageToken: "", items: [], seen: new Set(), scanned: 0, exhausted: true, sort: cfg.sort };
    clearConsole();
    el.ledger.innerHTML = ""; el.results.hidden = true; el.empty.hidden = true; el.moreWrap.hidden = true;
    log(`deep dig: <b style="color:var(--color-ink)">${esc(q || "(channel scope)")}</b> · ${bounds.length} slices · ${esc(start)} to ${esc(end)}`, "dim");
    log(`splitting the range to get past YouTube's ~500 cap · est ${fmtInt(bounds.length * depth * 101)} units`, "dim");
    if (hideSeenOn()) log(`hiding ${fmtInt(seenStore().size)} already-seen videos`, "dim");

    controller = new AbortController();
    setRunning(true);
    el.consoleState.textContent = "deep digging…";
    keyIdx = 0; runUnits = 0;

    try {
      for (let i = 0; i < bounds.length; i++) {
        if (controller.signal.aborted) break;
        const [a, b] = bounds[i];
        log(`slice ${i + 1}/${bounds.length} · ${a} to ${b}`);
        let pageToken = "", sliceHits = 0;
        for (let p = 0; p < depth; p++) {
          const sp = buildSearchParams({ ...cfg, after: a, before: b }, pageToken);
          const pg = await fetchPage(sp, controller.signal);
          if (pg.found === 0) break;
          session.scanned += pg.found;
          for (const it of pg.items) {
            const uid = it.kind + ":" + it.id;
            if (session.seen.has(uid)) continue;
            if (!passesFilters(it, filters)) continue;
            session.seen.add(uid);
            session.items.push(it);
            sliceHits++;
          }
          pageToken = pg.nextPageToken;
          if (!pageToken) break;
        }
        const vis = visibleItems(session.items).length;
        log(`slice ${i + 1}: +${sliceHits} found · ${vis} shown`, sliceHits ? "hit" : "dim");
        sortItems(session.items, cfg.sort);
        render(session.items, cfg);
        el.statFound.querySelector("b").textContent = fmtInt(vis);
      }
      session.sort = cfg.sort;
      sortItems(session.items, cfg.sort);
      el.consoleState.textContent = "done";
      const vis = visibleItems(session.items).length;
      log(`deep dig complete: scanned ${session.scanned}, kept ${vis} across ${bounds.length} slices. ${runUnits === 0 ? "all cached (0u)." : "spent ~" + fmtInt(runUnits) + "u."}`, "ok");
      quotaTip();
      render(session.items, cfg);
      el.statFound.querySelector("b").textContent = fmtInt(vis);
      paintQuota(); updateMore();
    } catch (err) {
      if (err.name === "AbortError") { log("aborted by user.", "warn"); el.consoleState.textContent = "stopped"; }
      else {
        el.consoleState.textContent = "error";
        const r = err.reason;
        if (r === "quotaExceeded") log("quota exhausted for today (10,000 units). Try tomorrow or use another key.", "warn");
        else if (r === "keyInvalid" || r === "badRequest") log(`invalid api key / request: ${esc(err.message)}`, "warn");
        else if (r === "accessNotConfigured") log("this key can't reach the YouTube Data API v3. Enable it in Google Cloud → APIs.", "warn");
        else log(`error [${esc(r)}]: ${esc(err.message)}`, "warn");
      }
      if (session && session.items.length) { sortItems(session.items, cfg.sort); render(session.items, cfg); }
    } finally {
      setRunning(false); controller = null; paintStarBtn();
    }
  }

  // ============================================================ boot
  function typeOn(node, text, speed = 42) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { node.textContent = text; return; }
    let i = 0;
    (function step() { node.textContent = text.slice(0, i); if (i++ <= text.length) setTimeout(step, speed + (Math.random() * 20 - 10)); })();
  }

  // ============================================================ init
  function init() {
    const savedKey = localStorage.getItem(STORE_KEY);
    if (savedKey) f.apikey.value = savedKey;
    loadCfg();
    paintKey(); paintQuota(); paintEcho(); paintType();

    typeOn($("#boot-text"), "advanced youtube search");

    el.saveKey.addEventListener("click", () => {
      const v = f.apikey.value.trim();
      if (v) { localStorage.setItem(STORE_KEY, v); log("api key saved to this browser.", "ok"); }
      else localStorage.removeItem(STORE_KEY);
      paintKey();
    });
    el.toggleKey.addEventListener("click", () => {
      const show = f.apikey.type === "password";
      f.apikey.type = show ? "text" : "password";
      el.toggleKey.textContent = show ? "hide" : "show";
    });
    f.apikey.addEventListener("input", paintKey);
    [f.q, f.exclude, f.maxpages].forEach((n) => n.addEventListener("input", paintEcho));
    f.type.addEventListener("change", paintType);
    el.form.addEventListener("input", saveCfg);

    $$(".chip[data-days]").forEach((c) => c.addEventListener("click", () => {
      const days = c.dataset.days;
      if (!days) { f.after.value = ""; f.before.value = ""; }
      else {
        const d = new Date(); d.setDate(d.getDate() - (+days));
        f.after.value = d.toISOString().slice(0, 10); f.before.value = "";
      }
      $$(".chip[data-days]").forEach((x) => x.setAttribute("aria-pressed", x === c ? "true" : "false"));
      saveCfg();
    }));

    // presets (built-in + custom) via delegation
    el.presetsRow.addEventListener("click", (e) => {
      const del = e.target.closest(".preset-del");
      if (del) { deletePreset(del.dataset.del); return; }
      const btn = e.target.closest(".preset");
      if (!btn) return;
      if (btn.dataset.preset) applyPreset(btn.dataset.preset);
      else if (btn.dataset.custom) applyCustomPreset(btn.dataset.custom);
    });
    el.savePreset.addEventListener("click", saveCurrentAsPreset);

    // starred searches
    el.starBtn.addEventListener("click", toggleStar);
    el.starsList.addEventListener("click", (e) => {
      const del = e.target.closest(".star-del");
      if (del) { const list = getStars(); list.splice(+del.dataset.idx, 1); saveJSON(STORE_STARS, list); renderStars(); paintStarBtn(); return; }
      const app = e.target.closest(".star-apply");
      if (app) applyStarByIdx(+app.dataset.idx);
    });

    renderPresets(); renderStars(); paintStarBtn();

    // mode toggle + url-mode controls
    $$(".modetab").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
    ["u-sort", "u-date", "u-type", "u-duration"].forEach((id) => document.getElementById(id)?.addEventListener("change", updateYtPreview));
    $$(".u-feat").forEach((cb) => cb.addEventListener("change", updateYtPreview));
    el.copyYt.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(buildYtUrl()); log("youtube url copied.", "ok"); }
      catch { log("copy failed. select the url and copy it manually.", "warn"); }
    });
    setMode(localStorage.getItem("zerodig.mode") === "url" ? "url" : "api");

    // memory: dismiss / open-marks-seen via delegation on the results list
    el.ledger.addEventListener("click", (e) => {
      const dis = e.target.closest(".result__dismiss");
      if (dis) {
        e.preventDefault();
        const li = dis.closest(".result");
        if (!li) return;
        const id = li.dataset.id;
        markSeen(id);
        if (session) session.items = session.items.filter((it) => !(it.kind === "video" && it.id === id));
        li.remove();
        if (session) {
          const vis = visibleItems(session.items).length;
          el.resultN.textContent = fmtInt(vis);
          el.statFound.querySelector("b").textContent = fmtInt(vis);
          if (!vis) { el.results.hidden = true; el.empty.hidden = false; }
        }
        return;
      }
      const card = e.target.closest(".result");
      if (card && card.dataset.kind === "video") { markSeen(card.dataset.id); card.classList.add("is-seen"); }
    });

    // memory controls
    el.hideSeen.checked = localStorage.getItem("zerodig.hideseen") !== "0";
    el.hideSeen.addEventListener("change", () => {
      localStorage.setItem("zerodig.hideseen", el.hideSeen.checked ? "1" : "0");
      if (session) { render(session.items, session.cfg); el.statFound.querySelector("b").textContent = fmtInt(visibleItems(session.items).length); }
    });
    el.markAllSeen.addEventListener("click", () => {
      if (!session) return;
      const vids = session.items.filter((it) => it.kind === "video").map((it) => it.id);
      markSeenMany(vids);
      $$(".result--video", el.ledger).forEach((li) => li.classList.add("is-seen"));
      log(`marked ${vids.length} videos as seen. Dig again for fresh ones.`, "ok");
    });
    el.resetSeen.addEventListener("click", () => {
      if (!confirm("Clear the memory of seen videos?")) return;
      clearSeen();
      if (session) { render(session.items, session.cfg); el.statFound.querySelector("b").textContent = fmtInt(visibleItems(session.items).length); }
      log("memory cleared.", "dim");
    });
    paintMem();

    // deep dig
    el.deep.checked = localStorage.getItem("zerodig.deep") === "1";
    el.deepOpts.hidden = !el.deep.checked;
    el.deep.addEventListener("change", () => {
      localStorage.setItem("zerodig.deep", el.deep.checked ? "1" : "0");
      el.deepOpts.hidden = !el.deep.checked;
      paintEstimate();
    });
    f.slices.addEventListener("input", paintEstimate);

    // cache
    if (el.clearCacheBtn) el.clearCacheBtn.addEventListener("click", () => { clearCache(); log("cache cleared.", "dim"); });
    paintCache();
    window.addEventListener("beforeunload", persistCache);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") persistCache(); });

    el.form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (document.body.dataset.mode === "url") openYt();
      else startSearch(readCfg(), false);
    });
    el.stop.addEventListener("click", () => controller?.abort());
    el.digMore.addEventListener("click", () => { if (session) run(session.cfg, true); });

    paintEstimate();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
