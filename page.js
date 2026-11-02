// Curator (open source) - an unofficial helper for the FUT Gallery
// Runs inside EA's web app. It only acts when you press a button; it buys only through “Buy cart”, after you accept the warning.
// It talks to no server other than EA's (and only through the web app itself). fut.gg prices come through the extension's background worker.

(function () {
  "use strict";
  if (window.__curatorLoaded) return;
  window.__curatorLoaded = true;

  // ---------- Settings ----------
  const PER_PAGE = 91;        // EA returns up to 91 cards per concept search
  const MAX_PAGES = 10;       // maximum pages per filter ID
  const PAUSE_MIN_MS = 600;     // random pause between searches (minimum)
  const PAUSE_MAX_MS = 1100;    // random pause between searches (maximum)
  const TIMEOUT_MS = 20000;  // if EA doesn't answer within this time, that search is dropped

  let BASE_SETS = Array.isArray(window.CURATOR_SETS) ? window.CURATOR_SETS : []; // revalidated further down
  let SETS = BASE_SETS.slice(); // replaced when a list is imported

  // ---------- Utilities ----------
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let pauseFactor = 1; // pauses are longer during “Check all”
  const randomPause = () => wait((PAUSE_MIN_MS + Math.random() * (PAUSE_MAX_MS - PAUSE_MIN_MS)) * pauseFactor);
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
  const fmt = (n) => num(n).toLocaleString("en-US");
  const sortedGrades = (set) => [...set.grades].sort((a, b) => a.score - b.score);

  // ---------- 1. Raw data capture ----------
  // EA sends "isCollected" and "gradingScore" in the response, but the card object
  // the web app builds drops them. That's why we read the raw response of the request.
  const raws = new Map(); // definitionId -> raw data we use (see absorb)
  let rawExample = null;

  // Some raw EA fields, checked against real cards (2026-10-27):
  //   skillmoves comes minus 1 (a 4★ Messi has 3); weakfootabilitytypecode comes as is;
  //   preferredPosition / possiblePositions come as text ("CAM", ["RM","CAM",...]).
  function fromRaw(x) {
    const hc = x.hyperCosmetics;
    return {
      isCollected: x.isCollected === true,
      gradingScore: num(x.gradingScore),
      nation: x.nation ?? null,
      club: x.teamid ?? null,
      league: x.leagueId ?? null,
      rarity: x.rareflag ?? null,
      rating: x.rating ?? null,
      positions: [x.preferredPosition].concat(Array.isArray(x.possiblePositions) ? x.possiblePositions : [])
        .filter((p) => typeof p === "string" && p),
      weakFoot: x.weakfootabilitytypecode != null ? num(x.weakfootabilitytypecode) : null,
      skillMoves: x.skillmoves != null ? num(x.skillmoves) + 1 : null,
      holo: Array.isArray(hc) ? hc.length > 0 : !!(hc && typeof hc === "object" && Object.keys(hc).length)
    };
  }

  function absorb(json) {
    const pending = [json];
    let rounds = 0;
    while (pending.length && rounds++ < 5000) {
      const x = pending.pop();
      if (!x || typeof x !== "object") continue;
      if (Array.isArray(x)) { for (const y of x) pending.push(y); continue; }
      const hasFields = "isCollected" in x || "gradingScore" in x;
      const id = x.resourceId ?? x.definitionId ?? x.id;
      if (hasFields && id != null) {
        raws.set(Number(id), fromRaw(x));
        if (!rawExample) rawExample = x;
        continue;
      }
      for (const k in x) {
        const v = x[k];
        if (v && typeof v === "object") pending.push(v);
      }
    }
  }

  function tryAbsorbText(text) {
    if (typeof text !== "string" || text.length < 2) return;
    if (text.indexOf("gradingScore") === -1 && text.indexOf("isCollected") === -1) return;
    try { absorb(JSON.parse(text)); } catch (e) { /* not JSON */ }
  }

  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener("load", function () {
      try {
        if (this.responseType === "" || this.responseType === "text") tryAbsorbText(this.responseText);
        else if (this.responseType === "json" && this.response) absorb(this.response);
      } catch (e) { /* ignore */ }
    });
    return xhrSend.apply(this, arguments);
  };

  const fetchOriginal = window.fetch;
  if (typeof fetchOriginal === "function") {
    window.fetch = function () {
      const p = fetchOriginal.apply(this, arguments);
      p.then((resp) => {
        try { resp.clone().text().then(tryAbsorbText).catch(() => {}); } catch (e) { /* ignore */ }
      }).catch(() => {});
      return p;
    };
  }

  // ---------- 2. Find EA's pieces ----------
  function readGlobal(name) {
    try { return window[name]; } catch (e) { return undefined; }
  }
  function globalNames() {
    try { return Object.getOwnPropertyNames(window); } catch (e) { return []; }
  }

  function findCriteriaClass() {
    const direct = readGlobal("UTSearchCriteriaDTO");
    if (typeof direct === "function") return { cls: direct, how: "name UTSearchCriteriaDTO" };
    const methods = ["hasValidDefId", "resetDefId", "isModified"];
    for (const k of globalNames()) {
      const v = readGlobal(k);
      if (typeof v !== "function" || !v.prototype) continue;
      try {
        if (methods.every((m) => Object.prototype.hasOwnProperty.call(v.prototype, m))) return { cls: v, how: "shape (global '" + k + "')" };
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  function findSearchTypes() {
    const direct = readGlobal("SearchType");
    if (direct && typeof direct === "object" && "PLAYER" in direct) return { value: direct, how: "name SearchType" };
    const keys = ["ANY", "PLAYER", "BALL", "CLUB_INFO", "STADIUM"];
    for (const k of globalNames()) {
      const v = readGlobal(k);
      if (!v || typeof v !== "object") continue;
      try { if (keys.every((c) => c in v)) return { value: v, how: "shape (global '" + k + "')" }; } catch (e) { /* ignore */ }
    }
    return null;
  }

  function services() {
    const s = readGlobal("services");
    return s && typeof s === "object" ? s : null;
  }

  // EA's card factory (to draw cards the same way the web app does)
  function cardFactory() {
    const f = readGlobal("UTItemViewFactory");
    return f && typeof f.createLargeItem === "function" ? f : null;
  }

  let pieces = null;
  function preparePieces() {
    if (pieces) return pieces;
    const s = services();
    const criteria = findCriteriaClass();
    const kinds = findSearchTypes();
    const ok = !!(s && s.Item && typeof s.Item.searchConceptItems === "function" && criteria && kinds);
    const result = { ok, services: s, criteria, kinds };
    if (ok) pieces = result;
    return result;
  }

  function diagnosis() {
    pieces = null;
    const p = preparePieces();
    return [
      ["EA services object", !!p.services],
      ["Concept search (services.Item.searchConceptItems)",
        !!(p.services && p.services.Item && typeof p.services.Item.searchConceptItems === "function")],
      ["Search criteria class" + (p.criteria ? " → " + p.criteria.how : ""), !!p.criteria],
      ["Search types" + (p.kinds ? " → " + p.kinds.how : ""), !!p.kinds],
      ["EA card rendering (UTItemViewFactory)", !!cardFactory()],
      ["Raw data captured so far: " + raws.size, raws.size > 0]
    ];
  }

  // ---------- 3. Search the cards of a set ----------
  function searchPage(kind, id, offset) {
    const p = preparePieces();
    if (!p.ok) return Promise.reject(new Error("Some EA pieces are missing. Run the diagnostics."));
    return new Promise((resolve) => {
      let finished = false;
      const done = (list) => { if (!finished) { finished = true; resolve(list); } };
      let observable;
      try {
        const c = new p.criteria.cls();
        c.type = p.kinds.value.PLAYER;
        c.count = PER_PAGE;
        c.offset = offset;
        c[kind] = [id]; // "league", "club" or "rarities"
        observable = p.services.Item.searchConceptItems(c);
      } catch (e) {
        console.warn("[Curator] search error", e);
        return done([]);
      }
      if (!observable || typeof observable.observe !== "function") return done([]);
      const callCtx = {};
      observable.observe(callCtx, function (obs, result) {
        try { obs.unobserve(callCtx); } catch (e) { /* ignore */ }
        const items = result && result.response && result.response.items;
        done(Array.isArray(items) ? items : []);
      });
      setTimeout(() => done([]), TIMEOUT_MS);
    });
  }

  function callMethod(obj, method) {
    try { return typeof obj[method] === "function" ? obj[method]() : undefined; } catch (e) { return undefined; }
  }

  // Builds the card by combining EA's object and the raw data from the response.
  function toCard(item) {
    const id = num(item.definitionId);
    const raw = raws.get(id) || {};
    const data = item._staticData || {};
    const rating = raw.rating ?? num(item.rating);
    return {
      definitionId: id,
      player: id % 16777216, // same number for every version of a player
      name: data.name || [data.firstName, data.lastName].filter(Boolean).join(" ") || "",
      rating,
      level: rating < 65 ? "bronze" : rating < 75 ? "silver" : "gold",
      rarity: raw.rarity ?? num(item.rareflag),
      // If the value is missing it stays null and the card doesn't count for the nation/club/league tags
      nation: raw.nation ?? (item.nationId != null ? num(item.nationId) : null),
      club: raw.club ?? (item.teamId != null ? num(item.teamId) : null),
      league: raw.league ?? (item.leagueId != null ? num(item.leagueId) : null),
      positions: raw.positions && raw.positions.length ? raw.positions : [],
      weakFoot: raw.weakFoot ?? num(callMethod(item, "getWeakFoot")),
      skillMoves: raw.skillMoves ?? num(callMethod(item, "getSkillMoves")),
      holo: raw.holo ?? (callMethod(item, "hasHyperCosmetics") === true),
      isCollected: raw.isCollected ?? (item.isCollected === true),
      gradingScore: raw.gradingScore ?? num(item.gradingScore),
      hasRaw: raws.has(id)
    };
  }

  // EA card objects (not copied to the JSON), so they can be drawn
  const entities = new Map(); // definitionId -> EA object

  async function readSet(set, onProgress, shouldStop) {
    if (set.eaFilter.unsupported) throw new Error("This set (" + set.name + ") can't be read with EA's search.");
    const kind = set.eaFilter.kind;
    const filterIdList = filterIds(set.eaFilter);
    const byId = new Map();
    let searches = 0;
    let truncated = false;
    for (const id of filterIdList) {
      for (let page = 0; page < MAX_PAGES; page++) {
        if (shouldStop()) return finish(true);
        if (searches > 0) await randomPause();
        searches++;
        onProgress("Search " + searches + " (page " + (page + 1) + ")…");
        const items = await searchPage(kind, id, page * PER_PAGE);
        let newOnes = 0;
        for (const it of items) {
          const c = toCard(it);
          if (c.definitionId && !byId.has(c.definitionId)) {
            byId.set(c.definitionId, c);
            entities.set(c.definitionId, it);
            newOnes++;
          }
        }
        // EA may return fewer than 91 even when there are more pages (it filters some cards),
        // so we only stop when a page comes back empty or with no new cards.
        if (!items.length || !newOnes) break;
        if (page === MAX_PAGES - 1) truncated = true;
      }
    }
    return finish(false);

    function finish(stopped) {
      // Raw data may arrive after the card is built: we build it again.
      const cards = [...byId.values()].map((c) => {
        const ent = entities.get(c.definitionId);
        return ent && raws.has(c.definitionId) ? toCard(ent) : c;
      });
      return { cards, stopped, searches, truncated };
    }
  }

  // ---------- 3a. Imported list of sets (safe) ----------
  // The file is read ONLY as data (JSON.parse, never run), with a size limit, and only
  // known fields with checked type and range are copied (allowlist). Everything else is dropped.
  // Text is cleaned and always shown as text (textContent), never as HTML.
  // By default it stays in memory only; saving is optional and only the cleaned version is saved.
  const MAX_LIST_BYTES = 1024 * 1024;
  const MAX_SETS = 400;
  const KEY_SETS = "curator_imported_sets";
  const RE_SLUG = /^[a-z0-9-]{1,80}$/;
  const VALID_GRADES = ["D", "C", "B", "A", "S"];
  const RE_CODE = /[<>"`{}\\]|script|javascript|vbscript|data:|on[a-z]+\s*=|&#|%3c|eval\s*\(|=>/i;

  const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
  function cleanText(v, max) {
    if (typeof v !== "string") return "";
    // Only letters (any language), digits, space and common punctuation. No <, >, double quotes, etc.
    return v.replace(/[^\p{L}\p{N} .,'’&()\-\/+!:]/gu, "").replace(/\s+/g, " ").trim().slice(0, max);
  }

  function membershipScope(text) {
    const t = String(text || "");
    const womenTeam = /women/i.test(t);
    const menTeam = /\bmen('?s)?\b/i.test(t.replace(/women('?s)?/gi, ""));
    return womenTeam && menTeam ? "both" : womenTeam ? "women" : menTeam ? "men" : "both";
  }

  // Converts ONE set from the external list to our format. Returns null if anything fails.
  function cleanSet(x) {
    if (!x || typeof x !== "object" || Array.isArray(x)) return null;
    if (typeof x.slug !== "string" || !RE_SLUG.test(x.slug)) return null;
    // If a text looks like code, the whole set is dropped (real names never contain this)
    if (RE_CODE.test(String(x.name)) || RE_CODE.test(String(x.membership || ""))) return null;
    if (typeof x.name !== "string" || x.name.length > 120) return null;
    const name = cleanText(x.name, 60);
    if (!name) return null;
    if (!isInt(x.required, 1, 50)) return null;
    const category = typeof x.category === "string" && RE_SLUG.test(x.category) ? x.category : "other";
    // Grades: only D..S, no repeats, with integer score and tokens in range
    if (!Array.isArray(x.grades) || x.grades.length < 1 || x.grades.length > 5) return null;
    const grades = [];
    for (const g of x.grades) {
      if (!g || typeof g !== "object") return null;
      if (!VALID_GRADES.includes(g.grade) || grades.some((y) => y.grade === g.grade)) return null;
      if (!isInt(g.score, 0, 1e9) || !isInt(g.tokens, 0, 10000)) return null;
      // Grade reward (e.g. "8 Gallery Tokens", "Inter Miami CF Kit"): optional, clean text only
      const reward = typeof g.reward === "string" && g.reward.length <= 80 && !RE_CODE.test(g.reward) ? cleanText(g.reward, 50) : "";
      grades.push({ grade: g.grade, score: g.score, tokens: g.tokens, reward });
    }
    // EA filter
    const kind = x.eaEntityKind;
    const id = x.eaEntityId;
    const rarities = Array.isArray(x.eaRarityIds) && x.eaRarityIds.length <= 20 && x.eaRarityIds.every((r) => isInt(r, 0, 100000)) ? x.eaRarityIds.slice() : [];
    let eaFilter;
    if (x.slug === "holographics") eaFilter = { unsupported: true, kind: "rarities", ids: [] }; // EA has no search for these
    else if (kind === "league" && isInt(id, 1, 1e9)) eaFilter = { kind: "league", ids: [id] };
    else if (kind === "club" && isInt(id, 1, 1e9)) eaFilter = { kind: "club", ids: [id], scope: membershipScope(x.membership) };
    else if ((kind === "rarity" || kind == null) && rarities.length) eaFilter = { kind: "rarities", ids: [...new Set(isInt(id, 0, 1e5) ? rarities.concat([id]) : rarities)] };
    else return null;
    return { slug: x.slug, name, category, slots: x.required, eaFilter, grades };
  }

  // Validates the whole list. Returns { sets, rejected, date } or throws an error with the reason.
  function validateList(text) {
    if (typeof text !== "string") throw new Error("Empty file.");
    if (text.length > MAX_LIST_BYTES) throw new Error("The file is too large (1 MB max).");
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error("The file is not valid JSON."); }
    if (!data || typeof data !== "object" || !Array.isArray(data.sets)) throw new Error("The file has no list of sets.");
    if (data.sets.length > MAX_SETS) throw new Error("Too many sets (max " + MAX_SETS + ").");
    const sets = [], seen = new Set();
    let rejected = 0;
    for (const x of data.sets) {
      const s = cleanSet(x);
      if (!s || seen.has(s.slug)) { rejected++; continue; }
      seen.add(s.slug);
      sets.push(s);
    }
    if (!sets.length) throw new Error("No set in the file passed validation.");
    const date = typeof data.lastUpdated === "string" && !isNaN(Date.parse(data.lastUpdated)) ? new Date(data.lastUpdated).toISOString() : null;
    return { sets, rejected, date };
  }

  let listInfo = null; // { qty, rejected, date, saved }
  function applyList(r, save) {
    SETS = r.sets;
    listInfo = { qty: r.sets.length, rejected: r.rejected, date: r.date, saved: !!save };
    try {
      if (save) localStorage.setItem(KEY_SETS, JSON.stringify({ sets: r.sets, date: r.date }));
      else localStorage.removeItem(KEY_SETS);
    } catch (e) { listInfo.saved = false; }
  }
  function resetList() {
    SETS = BASE_SETS.slice();
    listInfo = null;
    try { localStorage.removeItem(KEY_SETS); } catch (e) { /* ignore */ }
  }
  // Revalidates a list already in our format (the one bundled in sets.js or the one saved in the browser).
  function normalizeSets(list) {
    return (Array.isArray(list) ? list : []).filter((s) => s && typeof s === "object" && RE_SLUG.test(s.slug) &&
      typeof s.name === "string" && isInt(s.slots, 1, 50) && s.eaFilter && Array.isArray(s.grades))
      .map((s) => ({ slug: s.slug, name: cleanText(s.name, 60), category: RE_SLUG.test(s.category) ? s.category : "other", slots: s.slots,
        eaFilter: { kind: ["league", "club", "rarities"].includes(s.eaFilter.kind) ? s.eaFilter.kind : "league", unsupported: s.eaFilter.unsupported === true,
          ids: (Array.isArray(s.eaFilter.ids) ? s.eaFilter.ids : []).filter((i) => isInt(i, 0, 1e9)).slice(0, 20),
          scope: ["both", "women", "men"].includes(s.eaFilter.scope) ? s.eaFilter.scope : "both" },
        grades: s.grades.filter((g) => g && VALID_GRADES.includes(g.grade) && isInt(g.score, 0, 1e9) && isInt(g.tokens, 0, 10000))
          .map((g) => ({ grade: g.grade, score: g.score, tokens: g.tokens, reward: cleanText(g.reward, 50) })) }))
      .filter((s) => s.name && s.grades.length && (s.eaFilter.unsupported || s.eaFilter.ids.length));
  }
  // The list bundled with the extension (sets.js) goes through the check too
  BASE_SETS = normalizeSets(BASE_SETS);
  SETS = BASE_SETS.slice();

  // On start: if you saved a clean list, it's validated again before use.
  (function loadSavedList() {
    try {
      const g = localStorage.getItem(KEY_SETS);
      if (!g) return;
      const d = JSON.parse(g);
      const sets = normalizeSets(d.sets);
      if (sets.length) {
        SETS = sets;
        listInfo = { qty: sets.length, rejected: 0, date: typeof d.date === "string" ? d.date : null, saved: true };
      }
    } catch (e) { /* invalid saved list: ignored */ }
  })();

  // ---------- 3a.2 Build the list of sets yourself ----------
  // Club, league and rarity names taken from the text dictionary of EA's own web app
  // (the keys “global.teamabbr15.<year>.team<ID>”, “global.leagueFull.<year>.league<ID>” and “item.raretype<ID>”).
  let eaNamesCache = null;
  function eaNames() {
    if (eaNamesCache) return eaNamesCache;
    const r = { club: [], league: [], rarity: [] };
    try {
      const L = services() && services().Localization;
      const dict = L && L.repository && L.repository._collection;
      if (!dict || typeof dict !== "object") return r;
      const years = { club: 0, league: 0 };
      const club = new Map(), league = new Map();
      for (const k of Object.keys(dict)) {
        let m = k.match(/^global\.teamabbr15\.(\d{4})\.team(\d+)$/);
        if (m) { const a = Number(m[1]); if (a >= years.club) { if (a > years.club) club.clear(); years.club = a; club.set(Number(m[2]), String(dict[k])); } continue; }
        m = k.match(/^global\.leagueFull\.(\d{4})\.league(\d+)$/);
        if (m) { const a = Number(m[1]); if (a >= years.league) { if (a > years.league) league.clear(); years.league = a; league.set(Number(m[2]), String(dict[k])); } continue; }
        m = k.match(/^item\.raretype(\d+)$/);
        if (m) r.rarity.push({ id: Number(m[1]), name: cleanText(String(dict[k]), 60) });
      }
      r.club = [...club].map(([id, n]) => ({ id, name: cleanText(n, 60) }));
      r.league = [...league].map(([id, n]) => ({ id, name: cleanText(n, 60) }));
      for (const k of Object.keys(r)) r[k] = r[k].filter((x) => x.name && isInt(x.id, 0, 1e9)).sort((a, b) => a.name.localeCompare(b.name, "en"));
      if (r.club.length || r.league.length) eaNamesCache = r;
    } catch (e) { /* no dictionary */ }
    return r;
  }
  // From our format to the file format (the same one the import accepts)
  function toExternal(s) {
    const scope = s.eaFilter.scope === "men" ? "Mens" : s.eaFilter.scope === "women" ? "Womens" : s.eaFilter.kind === "club" ? "Mens or Womens" : "";
    return {
      slug: s.slug, name: s.name, category: s.category, required: s.slots,
      eaEntityKind: s.eaFilter.unsupported ? null : s.eaFilter.kind === "rarities" ? (s.eaFilter.ids.length === 1 ? "rarity" : null) : s.eaFilter.kind,
      eaEntityId: s.eaFilter.kind === "rarities" ? (s.eaFilter.ids.length === 1 ? s.eaFilter.ids[0] : null) : (s.eaFilter.ids[0] ?? null),
      eaRarityIds: s.eaFilter.kind === "rarities" ? s.eaFilter.ids.slice() : [],
      membership: (scope ? s.slots + " " + s.name + " " + scope + " players" : ""),
      grades: s.grades.map((g) => ({ grade: g.grade, score: g.score, tokens: g.tokens, reward: g.reward || "" }))
    };
  }
  function exportList() {
    const data = { sets: SETS.map(toExternal) };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    a.download = "curator-sets.json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  // Adds or replaces a set (in file format) in the current list and saves it. Goes through the same check as the import.
  function saveOwnSet(external) {
    const s = cleanSet(external);
    if (!s) throw new Error("The set didn't pass validation (check name, slots and grades).");
    const list = SETS.filter((x) => x.slug !== s.slug).concat([s]);
    if (list.length > MAX_SETS) throw new Error("Too many sets (max " + MAX_SETS + ").");
    applyList({ sets: list, rejected: 0, date: new Date().toISOString() }, true);
    return s;
  }
  function deleteOwnSet(slug) {
    const list = SETS.filter((x) => x.slug !== slug);
    applyList({ sets: list, rejected: 0, date: new Date().toISOString() }, true);
  }
  const slugOf = (text) => String(text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);

  // IDs for the search. For clubs it uses the men's/women's pairs EA provides (TeamConfig.getTeamLinks).
  function filterIds(eaFilter) {
    if (eaFilter.kind !== "club") return eaFilter.ids;
    const id = eaFilter.ids[0];
    let men = id, women = null;
    try {
      const pairs = readGlobal("repositories").TeamConfig.getTeamLinks(); // Map: women -> men
      if (pairs.has(id)) { women = id; men = pairs.get(id); }
      else for (const [f, m] of pairs) if (m === id) { women = f; break; }
    } catch (e) { /* no pairs: the ID is used as is */ }
    if (eaFilter.scope === "men") return [men];
    if (eaFilter.scope === "women") return [women ?? id];
    return [...new Set([men, women].filter((x) => x != null))];
  }

  // ---------- 3b. First Owner (cards you packed yourself) ----------
  // Detected on the cards you own today: if the card has had only 1 owner, you packed it.
  // Cards you already sold can't be checked: they're marked by hand with the star.
  // Everything is saved in this browser (localStorage), per FUT profile. It never leaves your computer.
  function currentProfile() {
    try {
      const s = services();
      const p = s.Authentication.getUtasSession().user.getSelectedPersona();
      const id = p && (p.id ?? p.personaId ?? p._id ?? p.nucPersId);
      if (id != null) return String(id);
    } catch (e) { /* ignore */ }
    return "no-profile";
  }
  const foKey = () => "curator_first_owner_" + currentProfile();

  function loadFO() {
    try {
      const d = JSON.parse(localStorage.getItem(foKey()) || "{}");
      return { auto: d.auto || {}, manual: d.manual || {}, checkedAt: d.checkedAt || null };
    } catch (e) { return { auto: {}, manual: {}, checkedAt: null }; }
  }
  let foData = null;
  const fo = () => foData || (foData = loadFO());
  function saveFO() {
    try { localStorage.setItem(foKey(), JSON.stringify(fo())); } catch (e) { /* no storage: kept in memory */ }
  }

  // true = you packed it, false = you didn't, null = unknown
  function isFirstOwner(defId) {
    const d = fo();
    const m = d.manual[defId];
    if (m === "yes") return true;
    if (m === "no") return false;
    const a = d.auto[defId];
    if (a === "yes") return true;
    if (a === "no") return false;
    return null;
  }

  // Star cycle: no mark → "I packed it" → "I didn't pack it" → no mark
  function toggleFOMark(defId) {
    const d = fo();
    const m = d.manual[defId];
    if (m === "yes") d.manual[defId] = "no";
    else if (m === "no") delete d.manual[defId];
    else d.manual[defId] = "yes";
    saveFO();
  }

  function ownerCount(item) {
    try { return Number(typeof item.getOwnerCount === "function" ? item.getOwnerCount() : item.owners); } catch (e) { return NaN; }
  }

  // Records a club card. Returns true if anything changed.
  function noteClubCard(item) {
    try {
      if (!item || item.concept === true) return false;
      const isPlayerItem = typeof item.isPlayer === "function" ? item.isPlayer() : item.type === "player";
      if (!isPlayerItem) return false;
      if (typeof item.loans === "number" && item.loans > -1) return false; // on loan: doesn't count
      const defId = num(item.definitionId);
      let owners = ownerCount(item);
      if (!defId || !Number.isInteger(owners) || owners < 1) return false;
      // If it's on the market and isn't yours (for example, on your watch list), it doesn't count as packed by you
      try {
        const sub = typeof item.getAuctionData === "function" ? item.getAuctionData() : null;
        if (sub && Number(sub.tradeId) > 0 && !sub.tradeOwner) owners = Math.max(owners, 2);
      } catch (e) { /* ignore */ }
      const d = fo();
      const fresh = owners === 1 || d.auto[defId] === "yes" ? "yes" : "no"; // if any copy was yours first, it stays "yes"
      if (d.auto[defId] === fresh) return false;
      d.auto[defId] = fresh;
      return true;
    } catch (e) { return false; }
  }

  // Goes through the whole club one page at a time (with pauses) plus the piles already in memory.
  async function reviewClub(onProgress, shouldStop) {
    const s = services();
    const p = preparePieces();
    if (!s || !s.Club || typeof s.Club.search !== "function" || !p.criteria || !p.kinds) throw new Error("Can't find EA's club search.");
    const seen = new Set();
    const clubCards = new Map(); // definitionId -> { club, league, rarity } (to update the sets)
    const register = (it) => {
      try {
        const id = num(it && it.definitionId);
        if (!id || it.concept === true || clubCards.has(id)) return;
        clubCards.set(id, { club: it.teamId != null ? num(it.teamId) : null, league: it.leagueId != null ? num(it.leagueId) : null, rarity: it.rareflag != null ? num(it.rareflag) : null });
      } catch (e) { /* ignore */ }
    };
    let changes = 0, searches = 0, total = 0;
    for (let page = 0; page < 60; page++) {
      if (shouldStop()) break;
      if (searches > 0) await randomPause();
      searches++;
      const c = new p.criteria.cls();
      c.type = p.kinds.value.PLAYER;
      c.count = PER_PAGE;
      c.offset = total; // EA sometimes returns more than 91: we move ahead by what arrived
      const res = await new Promise((resolve) => {
        let settled = false;
        const done = (x) => { if (!settled) { settled = true; resolve(x); } };
        try {
          const obs = s.Club.search(c);
          const ctx = {};
          obs.observe(ctx, (o, x) => { try { o.unobserve(ctx); } catch (e) { /* ignore */ } done(x); });
        } catch (e) { done(null); }
        setTimeout(() => done(null), TIMEOUT_MS);
      });
      const items = (res && res.success && res.response && res.response.items) || [];
      let newOnes = 0;
      for (const it of items) {
        if (!it || seen.has(it.id)) continue;
        seen.add(it.id); newOnes++; total++;
        register(it);
        if (noteClubCard(it)) changes++;
      }
      onProgress("Checking your club: " + total + " cards…");
      if (!items.length || !newOnes || (res.response && res.response.retrievedAll)) break;
    }
    // Piles in memory (no requests to EA): unassigned, storage and transfer list
    try {
      const repo = s.Item.itemDao.itemRepo;
      for (const pile of ["unassigned", "storage", "transfer"]) {
        const x = repo && repo[pile];
        const col = x && ((x.items && x.items._collection) || x._collection);
        const list = col ? (Array.isArray(col) ? col : Object.values(col)) : [];
        for (const it of list) { register(it); if (noteClubCard(it)) changes++; }
      }
    } catch (e) { /* ignore */ }
    fo().checkedAt = new Date().toISOString();
    saveFO();
    const firstOwners = Object.values(fo().auto).filter((v) => v === "yes").length;
    return { cards: total, searches, changes, firstOwners, clubCards };
  }

  // ---------- 3c. Prices (EA market search, only when you ask) ----------
  // For each card: searches the market (21 results), takes the cheapest buy-now price and, if there are
  // many listings, searches once more with that price as the maximum (at most 2 searches per card).
  // Each price is kept for 3 hours in this browser, per platform (console / PC).
  // Brake: 1.5 to 3 s pauses between searches and an hourly search cap (counting those in the last hour).
  const PRICE_MAX_AGE_MS = 3 * 60 * 60 * 1000;
  const MARKET_PAUSE_MIN_MS = 1500;
  const MARKET_PAUSE_MAX_MS = 3000;
  const SEARCHES_PER_CARD = 2;
  const HOURLY_SEARCH_CAP = 80;
  const KEY_SEARCH_LOG = "curator_market_searches";
  const marketPause = () => wait(MARKET_PAUSE_MIN_MS + Math.random() * (MARKET_PAUSE_MAX_MS - MARKET_PAUSE_MIN_MS));

  // Log of searches in the last hour (timestamps only, in this browser)
  let searchLog = null;
  function searchesLastHour() {
    if (!searchLog) {
      try { searchLog = JSON.parse(localStorage.getItem(KEY_SEARCH_LOG) || "[]"); } catch (e) { searchLog = []; }
      if (!Array.isArray(searchLog)) searchLog = [];
    }
    const since = Date.now() - 60 * 60 * 1000;
    searchLog = searchLog.filter((t) => typeof t === "number" && t > since);
    return searchLog;
  }
  function logSearch() {
    searchesLastHour().push(Date.now());
    try { localStorage.setItem(KEY_SEARCH_LOG, JSON.stringify(searchLog)); } catch (e) { /* kept in memory */ }
  }
  const searchesLeft = () => Math.max(0, HOURLY_SEARCH_CAP - searchesLastHour().length);
  // Minutes until a search frees up
  function minutesToResume() {
    const r = searchesLastHour();
    if (r.length < HOURLY_SEARCH_CAP) return 0;
    return Math.max(1, Math.ceil((r[0] + 60 * 60 * 1000 - Date.now()) / 60000));
  }

  function platformName() {
    try {
      const p = services().Authentication.getUtasSession().user.getSelectedPersona();
      const pl = p && (p.platform ?? p._platform);
      const enumPl = readGlobal("GamePlatform") || {};
      if ((enumPl.PC != null && pl === enumPl.PC) || String(pl).toLowerCase() === "pc") return "pc";
    } catch (e) { /* ignore */ }
    return "console";
  }
  const pricesKey = () => "curator_prices_" + platformName();
  let prices = null;
  function priceTable() {
    if (prices) return prices;
    try { prices = JSON.parse(localStorage.getItem(pricesKey()) || "{}"); } catch (e) { prices = {}; }
    return prices;
  }
  function savePrices() {
    try {
      const t = priceTable(), now = Date.now();
      for (const k of Object.keys(t)) if (now - t[k].at > PRICE_MAX_AGE_MS * 8) delete t[k]; // drop old entries
      localStorage.setItem(pricesKey(), JSON.stringify(t));
    } catch (e) { /* no storage: kept in memory */ }
  }
  // ---- fut.gg prices (main source) ----
  // The extension (background.js) downloads fut.gg's public price list (one file with every player,
  // at most once every 5 minutes) and hands this page only the prices of the requested cards,
  // through bridge.js. This page doesn't connect to fut.gg or any other site.
  const FUTGG_MAX_AGE_MS = 30 * 60 * 1000; // after this, they're considered stale
  const FUTGG_REFRESH_MS = 5 * 60 * 1000;  // no new request before this
  const futgg = { prices: new Map(), at: 0, published: null };
  let futggRequestId = 0;
  const bridgeAvailable = () => document.documentElement.getAttribute("data-curator-bridge") === "1";

  function askBridge(message, maxTime) {
    return new Promise((resolve) => {
      const id = ++futggRequestId;
      let settled = false;
      const done = (x) => { if (!settled) { settled = true; window.removeEventListener("message", listen); resolve(x); } };
      function listen(ev) {
        if (ev.source !== window || ev.origin !== location.origin) return;
        const d = ev.data;
        if (!d || typeof d !== "object" || d.source !== "curator-bridge" || d.requested !== id) return;
        done(d);
      }
      window.addEventListener("message", listen);
      window.postMessage(Object.assign({ source: "cur-page", requested: id }, message), location.origin);
      setTimeout(() => done({ ok: false, reason: "The extension didn't respond." }), maxTime);
    });
  }

  // Asks the extension for fut.gg prices for these cards. Returns { ok, qty, reason }
  async function loadFutggPrices(ids, force) {
    if (!bridgeAvailable()) return { ok: false, reason: "fut.gg prices need the extension installed in Chrome." };
    if (!force && futgg.at && Date.now() - futgg.at < FUTGG_REFRESH_MS && ids.every((id) => futgg.prices.has(id))) {
      return { ok: true, qty: ids.length, cache: true };
    }
    const list = [...new Set(ids.map(Number).filter((x) => Number.isInteger(x) && x > 0))].slice(0, 5000);
    const r = await askBridge({ kind: "futgg-prices", platformName: platformName(), ids: list }, 30000);
    if (!r.ok) return { ok: false, reason: typeof r.reason === "string" ? r.reason.slice(0, 200) : "Error requesting prices." };
    // Validate the response: known numbers only
    const prices = r.prices && typeof r.prices === "object" ? r.prices : {};
    let qty = 0;
    const now = Date.now();
    for (const id of list) {
      const v = prices[id];
      if (Array.isArray(v) && v.length === 2 && (v[0] === null || (Number.isInteger(v[0]) && v[0] >= 0 && v[0] <= 1e9))) {
        futgg.prices.set(id, { price: v[0] || null, at: now, source: "fut.gg", sbc: v[1] === 1, objective: v[1] === 2 });
        qty++;
      } else {
        futgg.prices.set(id, { price: null, at: now, source: "fut.gg", noData: true });
      }
    }
    futgg.at = now;
    futgg.published = Number.isInteger(r.published) ? r.published * 1000 : null;
    return { ok: true, qty };
  }

  // ---- Settings (in this browser) ----
  // resale: a card counts in the Gallery even if you sell it, so the real cost is what you pay minus what
  //          you get back reselling it at the same price (EA keeps 5%). SBC/objective cards can't be resold.
  // foMode:  "marks" (First Owner from your marks) or "pct" (assume a % of your collected cards are First Owner).
  const KEY_SETTINGS = "curator_settings";
  const settings = (() => {
    const base = { resale: true, foMode: "marks", foPct: 30 };
    try {
      const g = JSON.parse(localStorage.getItem(KEY_SETTINGS) || "{}");
      if (typeof g.resale === "boolean") base.resale = g.resale;
      if (g.foMode === "pct" || g.foMode === "marks") base.foMode = g.foMode;
      if (Number.isInteger(g.foPct) && g.foPct >= 0 && g.foPct <= 100) base.foPct = g.foPct;
    } catch (e) { /* defaults */ }
    return base;
  })();
  function saveSettings() { try { localStorage.setItem(KEY_SETTINGS, JSON.stringify(settings)); } catch (e) { /* kept in memory */ } }

  const EA_TAX = 0.05;
  const netAfterResale = (price) => price - Math.floor(price * (1 - EA_TAX));
  const canResell = (p) => !!p && !p.sbc && !p.objective;
  // A card's cost for the planner: 0 if you've owned it; otherwise its price (or what you lose reselling it).
  // undefined = no price.
  function cardCost(c) {
    if (c.isCollected) return 0;
    const p = priceOf(c.definitionId);
    if (!p || p.price == null) return undefined;
    return settings.resale && canResell(p) ? netAfterResale(p.price) : p.price;
  }
  function cardBuyCost(c) {
    if (c.isCollected) return 0;
    const p = priceOf(c.definitionId);
    return p && p.price != null ? p.price : undefined;
  }

  // Gets fut.gg prices for the cards missing from the open set. Returns a text to show.
  async function refreshSetPrices(force) {
    const ids = view.cards.filter((c) => !c.isCollected).map((c) => c.definitionId);
    if (!ids.length) return "You already have every card in this set.";
    const r = await loadFutggPrices(ids, force);
    if (!r.ok) return "No fut.gg prices: " + r.reason;
    const withPrice = ids.filter((id) => { const p = priceOf(id); return p && p.price != null; }).length;
    return "fut.gg prices: " + withPrice + " of " + ids.length + " missing cards" +
      (withPrice < ids.length ? " (the rest have no fut.gg price; you can look them up with the 🔍)" : "") + ".";
  }

  // { price: number or null (none for sale / no data), at: date, source } or undefined if there's no price.
  // fut.gg first; if fut.gg has no data, the one you looked up by hand on the EA market (🔍).
  function priceOf(defId) {
    const f = futgg.prices.get(defId);
    if (f && !f.noData && f.price != null && Date.now() - f.at < FUTGG_MAX_AGE_MS) return f;
    const p = priceTable()[defId];
    if (p && Date.now() - p.at < PRICE_MAX_AGE_MS) return Object.assign({ source: "EA market" }, p);
    if (f && Date.now() - f.at < FUTGG_MAX_AGE_MS) return f; // fut.gg said "no price"
    return undefined;
  }

  function sameCard(id, defId) {
    if (Number(id) === Number(defId)) return true;
    const mask = readGlobal("ItemIdMask");
    try { return mask && typeof mask.DATABASE === "number" && (Number(id) & mask.DATABASE) === (Number(defId) & mask.DATABASE); } catch (e) { return false; }
  }

  // One market search. Returns { ok, halt, items }
  function searchMarket(defId, maximum) {
    const s = services(), p = preparePieces();
    return new Promise((resolve) => {
      let settled = false;
      const done = (x) => { if (!settled) { settled = true; resolve(x); } };
      try {
        try { s.Item.clearTransferMarketCache(); } catch (e) { /* ignore */ }
        const c = new p.criteria.cls();
        c.type = p.kinds.value.PLAYER;
        c.defId = [defId];
        c.count = 21;
        c.offset = 0;
        if (maximum) c.maxBuy = maximum;
        const obs = s.Item.searchTransferMarket(c, 1);
        if (!obs || typeof obs.observe !== "function") return done({ ok: false, items: [] });
        const ctx = {};
        obs.observe(ctx, (o, r) => {
          try { o.unobserve(ctx); } catch (e) { /* ignore */ }
          if (!r || !r.success) {
            const state = r && (r.status ?? r.code);
            // 429 / 512 / 521 and similar: EA asks to slow down
            return done({ ok: false, halt: state != null && Number(state) !== 404, items: [], state });
          }
          const d = r.data || r.response || {};
          const items = Array.isArray(d.items) ? d.items : Array.isArray(d.auctionInfo) ? d.auctionInfo : Array.isArray(r.auctionInfo) ? r.auctionInfo : [];
          done({ ok: true, items });
        });
      } catch (e) { done({ ok: false, items: [] }); }
      setTimeout(() => done({ ok: false, items: [] }), TIMEOUT_MS);
    });
  }

  function cheapestPrice(items, defId) {
    let min = null;
    for (const it of items) {
      try {
        const sub = typeof it.getAuctionData === "function" ? it.getAuctionData() : (it.auctionData || it);
        if (!sub) continue;
        const state = sub.tradeState ?? sub._tradeState;
        if (state === "closed" || state === "expired") continue;
        const id = typeof it.definitionId === "number" ? it.definitionId : (it.itemData && (it.itemData.resourceId ?? it.itemData.definitionId)) || it.resourceId;
        if (!sameCard(id, defId)) continue;
        const bin = Number(sub.buyNowPrice) || 0;
        if (bin > 0 && (min === null || bin < min)) min = bin;
      } catch (e) { /* ignore */ }
    }
    return min;
  }

  // Looks up a card's price on the EA market (only with the 🔍, at most 2 searches and with an hourly cap).
  // Returns { price, searches, halt, cap }
  async function lookUpPrice(defId) {
    let price = null, searches = 0;
    for (let i = 0; i < SEARCHES_PER_CARD; i++) {
      if (searchesLeft() <= 0) {
        if (searches === 0) return { price: null, searches, halt: false, cap: true };
        break;
      }
      if (i > 0) await marketPause();
      logSearch();
      const r = await searchMarket(defId, price);
      searches++;
      if (r.halt) return { price: null, searches, halt: true };
      if (!r.ok) break;
      const min = cheapestPrice(r.items, defId);
      if (min === null) break;                 // nothing (cheaper) for sale
      if (price !== null && min >= price) break; // didn't go lower
      price = min;
      if (r.items.length < 21) break;          // we saw every listing up to that price
    }
    priceTable()[defId] = { price, at: Date.now() };
    savePrices();
    return { price, searches, halt: false };
  }

  // ---------- 4. Score: base + tag bonuses ----------
  // Tags and levels from fut.gg's public page (fut.gg/fut-gallery/tags, 2026-10-27).
  // Each level: [minimum cards, percentage].
  //   kind "count":     counts the matching cards; the % applies to the sum of their points.
  //   kind "same":      counts the largest group (same nation/club/league/player).
  //   kind "different": counts how many distinct values there are and adds the best card of each.
  // Each bonus is rounded down and only the 10 largest bonuses count.
  const MAX_TAGS = 10;
  const DEFENDERS = ["RB", "CB", "LB"];
  const MIDFIELDERS = ["CDM", "CM", "CAM", "LM", "RM"];
  const ATTACKERS = ["ST", "LW", "RW"];
  const TAGS = [
    { name: "Same nation", kind: "same", field: "nation", levels: [[5, 1], [10, 2], [20, 4]] },
    { name: "Different nations", kind: "different", field: "nation", levels: [[5, 1], [10, 2], [20, 4]] },
    { name: "Same club", kind: "same", field: "club", levels: [[5, 1], [10, 2], [20, 4]] },
    { name: "Different clubs", kind: "different", field: "club", levels: [[5, 1], [10, 2], [20, 4]] },
    { name: "Same league", kind: "same", field: "league", levels: [[5, 1], [10, 2], [20, 8]] },
    { name: "Different leagues", kind: "different", field: "league", levels: [[5, 1], [10, 2], [20, 4]] },
    { name: "Bronze", kind: "count", matches: (c) => c.level === "bronze", levels: [[5, 20], [10, 40], [20, 80]] },
    { name: "Silver", kind: "count", matches: (c) => c.level === "silver", levels: [[5, 15], [10, 30], [20, 60]] },
    { name: "Gold", kind: "count", matches: (c) => c.level === "gold", levels: [[5, 1], [10, 2], [20, 4]] },
    { name: "Holographic", kind: "count", matches: (c) => c.holo === true, levels: [[2, 8], [4, 12], [6, 20]] },
    { name: "Icon", kind: "count", matches: (c) => c.rarity === 12, levels: [[2, 10], [4, 15], [6, 25]] },
    { name: "Hero", kind: "count", matches: (c) => c.rarity === 72, levels: [[2, 8], [4, 12], [6, 20]] },
    { name: "TOTW", kind: "count", matches: (c) => c.rarity === 3, levels: [[3, 4], [6, 8], [10, 15]] },
    { name: "Goalkeepers", kind: "count", matches: (c) => c.positions.includes("GK"), levels: [[3, 3], [6, 6], [10, 15]] },
    { name: "Multiple versions", kind: "same", field: "player", levels: [[2, 10], [3, 15], [4, 20]] },
    { name: "5★ weak foot", kind: "count", matches: (c) => c.weakFoot >= 5, levels: [[3, 3], [5, 6], [10, 12]] },
    { name: "5★ skill moves", kind: "count", matches: (c) => c.skillMoves >= 5, levels: [[3, 3], [5, 6], [10, 12]] },
    { name: "Defenders", kind: "count", matches: (c) => c.positions.some((p) => DEFENDERS.includes(p)), levels: [[5, 3], [10, 6], [15, 10]] },
    { name: "Midfielders", kind: "count", matches: (c) => c.positions.some((p) => MIDFIELDERS.includes(p)), levels: [[5, 3], [10, 6], [15, 10]] },
    { name: "Attackers", kind: "count", matches: (c) => c.positions.some((p) => ATTACKERS.includes(p)), levels: [[5, 3], [10, 6], [15, 10]] }
    ,{ name: "First Owner", fo: true, kind: "count", matches: (c) => c.isCollected && isFirstOwner(c.definitionId) === true, levels: [[5, 150], [10, 300], [20, 500]] }
  ];

  function percentFor(tag, qty) {
    let pct = 0;
    for (const [minimum, p] of tag.levels) if (qty >= minimum) pct = p;
    return pct;
  }

  // Returns how many cards count for the tag and the points total the % applies to.
  function measureTag(tag, cards) {
    // First Owner in “assume %” mode: the chosen % of your collected lineup cards (rounded down)
    if (tag.fo && settings.foMode === "pct") {
      const mine = cards.filter((c) => c.isCollected);
      const f = settings.foPct / 100;
      return { qty: Math.floor(mine.length * f), points: Math.floor(mine.reduce((s, c) => s + c.gradingScore, 0) * f), assumed: true };
    }
    if (tag.kind === "count") {
      const ok = cards.filter(tag.matches);
      return { qty: ok.length, points: ok.reduce((s, c) => s + c.gradingScore, 0) };
    }
    const groups = new Map(); // value -> { qty, points, best }
    for (const c of cards) {
      const v = c[tag.field];
      if (v == null) continue;
      const g = groups.get(v) || { qty: 0, points: 0, best: 0 };
      g.qty++; g.points += c.gradingScore; g.best = Math.max(g.best, c.gradingScore);
      groups.set(v, g);
    }
    if (tag.kind === "different") {
      let points = 0;
      for (const g of groups.values()) points += g.best;
      return { qty: groups.size, points };
    }
    // "same": the largest group (on a tie, the tied groups are added)
    let largest = 0;
    for (const g of groups.values()) largest = Math.max(largest, g.qty);
    let points = 0;
    for (const g of groups.values()) if (g.qty === largest) points += g.points;
    return { qty: largest, points };
  }

  function scoreLineup(cards) {
    const base = cards.reduce((s, c) => s + c.gradingScore, 0);
    const detail = [];
    for (const tag of TAGS) {
      const m = measureTag(tag, cards);
      const pct = percentFor(tag, m.qty);
      if (!pct) continue;
      detail.push({ name: tag.name + (m.assumed ? " (assumed " + settings.foPct + "%)" : ""), qty: m.qty, pct, bonus: Math.floor((m.points * pct) / 100), counts: false });
    }
    detail.sort((a, b) => b.bonus - a.bonus);
    let bonus = 0;
    detail.forEach((d, i) => { if (i < MAX_TAGS) { d.counts = true; bonus += d.bonus; } });
    return { base, bonus, total: base + bonus, detail };
  }

  // ---------- 4b. Optimal lineup (the one with the most points INCLUDING bonuses) ----------
  // Method:
  //  1) If there are few possible combinations (<= EXACT_LIMIT), it tries them all: exact result.
  //  2) Otherwise it starts from several points (most points, largest nation/club/league group,
  //     bronzes and silvers first, and some random ones) and in each one swaps cards one at a time while the
  //     total goes up. It keeps the best. It stops on a time limit so the page doesn't freeze.
  const EXACT_LIMIT = 20000;
  const OPTIMIZE_MS = 1500;
  let optimizeBudget = OPTIMIZE_MS; // less time per set during “Check all”

  function combinations(n, k) {
    let r = 1;
    for (let i = 1; i <= k; i++) { r = (r * (n - k + i)) / i; if (r > 1e9) return Infinity; }
    return Math.round(r);
  }

  const totalOf = (list) => scoreLineup(list).total;

  function exact(cands, k) {
    let best = null, bestTotal = -1;
    const idx = [];
    (function pick(since) {
      if (idx.length === k) {
        const t = totalOf(idx.map((i) => cands[i]));
        if (t > bestTotal) { bestTotal = t; best = idx.slice(); }
        return;
      }
      for (let i = since; i <= cands.length - (k - idx.length); i++) { idx.push(i); pick(i + 1); idx.pop(); }
    })(0);
    return { list: best.map((i) => cands[i]), total: bestTotal };
  }

  // Swaps cards one at a time (one leaves the lineup, one from outside comes in) while the total goes up.
  function improveBySwapping(start, cands, limit) {
    let current = start.slice();
    let total = totalOf(current);
    let improved = true;
    while (improved && performance.now() < limit) {
      improved = false;
      const inside = new Set(current);
      const outOfRange = cands.filter((c) => !inside.has(c));
      for (let i = 0; i < current.length && !improved; i++) {
        for (const c of outOfRange) {
          const trial = current.slice();
          trial[i] = c;
          const t = totalOf(trial);
          if (t > total) { current = trial; total = t; improved = true; break; }
        }
      }
    }
    return { list: current, total };
  }

  function startingPoints(cands, k) {
    const byPoints = [...cands].sort((a, b) => b.gradingScore - a.gradingScore);
    const starts = [byPoints.slice(0, k)];
    // Largest group of each field first (triggers "Same nation/club/league")
    for (const field of ["nation", "club", "league"]) {
      const counts = new Map();
      for (const c of cands) if (c[field] != null) counts.set(c[field], (counts.get(c[field]) || 0) + 1);
      const big = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (big) {
        const ofGroup = byPoints.filter((c) => c[field] === big[0]);
        starts.push(ofGroup.concat(byPoints.filter((c) => c[field] !== big[0])).slice(0, k));
      }
    }
    // Bronzes and silvers first (their tags pay high percentages)
    for (const level of ["bronze", "silver"]) {
      const ofLevel = byPoints.filter((c) => c.level === level);
      if (ofLevel.length >= 5) starts.push(ofLevel.concat(byPoints.filter((c) => c.level !== level)).slice(0, k));
    }
    return starts;
  }

  function randomStart(cands, k) {
    const shuffled = [...cands];
    for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
    return shuffled.slice(0, k);
  }

  // Best combination of k cards (most points with bonuses) among "cands". Returns { list, total, method }
  function optimizeOver(cands, k) {
    if (cands.length <= k) return { list: cands.slice(), total: totalOf(cands), method: "all" };
    if (combinations(cands.length, k) <= EXACT_LIMIT) {
      const r = exact(cands, k);
      return { list: r.list, total: r.total, method: "exact" };
    }
    const limit = performance.now() + optimizeBudget;
    let best = null;
    const tryStart = (start) => {
      const r = improveBySwapping(start, cands, limit);
      if (!best || r.total > best.total) best = r;
    };
    for (const start of startingPoints(cands, k)) {
      if (performance.now() >= limit && best) break;
      tryStart(start);
    }
    // While time remains, more random starts (at least 4). Stops early if 30 in a row don't improve.
    let noImprove = 0, randomTries = 0;
    while ((randomTries < 4 || performance.now() < limit) && noImprove < 30) {
      const before = best.total;
      tryStart(randomStart(cands, k));
      randomTries++;
      noImprove = best.total > before ? 0 : noImprove + 1;
      if (performance.now() >= limit && randomTries >= 4) break;
    }
    return { list: best.list, total: best.total, method: "search" };
  }

  // Returns { ids, total, method }
  function optimizeLineup(set, cards) {
    const cands = cards.filter((c) => c.isCollected);
    const r = optimizeOver(cands, Math.min(set.slots, cands.length));
    return { ids: r.list.map((c) => c.definitionId), total: r.total, method: r.method };
  }

  // ---------- 4c. Planner: what to buy to reach a grade spending as little as possible ----------
  // Candidates: cards you've owned (cost 0) + missing cards with a price (cost their price).
  // 1) Ceiling: the best possible lineup with those candidates. If the requested grade can't be reached, it plans the best possible one.
  // 2) If there are few combinations, it tries them all and keeps the cheapest one that reaches the score.
  // 3) Otherwise: starts from the ceiling and cheapens it (swaps expensive cards for cheap ones, one and two at a time, while it still reaches the score);
  //    and also starts from the cheapest ones and climbs one at a time (the one adding the most points per coin) until it gets there. It keeps the cheapest.
  const costOf = (list) => list.reduce((s, c) => s + c.cost, 0);

  function exactPlan(cands, k, goal) {
    let best = null;
    const idx = [];
    (function pick(since) {
      if (idx.length === k) {
        const list = idx.map((i) => cands[i]);
        const cost = costOf(list);
        if (best && cost > best.cost) return;
        const total = totalOf(list);
        if (total >= goal && (!best || cost < best.cost || (cost === best.cost && total > best.total))) best = { list, cost, total };
        return;
      }
      for (let i = since; i <= cands.length - (k - idx.length); i++) { idx.push(i); pick(i + 1); idx.pop(); }
    })(0);
    return best;
  }

  // Swaps expensive cards for cheaper ones while the total still reaches the goal
  function cheapen(list, cands, goal, limit) {
    let current = list.slice();
    let improved = true;
    while (improved && performance.now() < limit) {
      improved = false;
      const inside = new Set(current);
      const outside = cands.filter((c) => !inside.has(c)).sort((a, b) => a.cost - b.cost || b.gradingScore - a.gradingScore);
      const expensive = current.map((c, i) => i).filter((i) => current[i].cost > 0).sort((a, b) => current[b].cost - current[a].cost);
      // one at a time
      for (const i of expensive) {
        for (const c of outside) {
          if (c.cost >= current[i].cost) break;
          const trial = current.slice(); trial[i] = c;
          if (totalOf(trial) >= goal) { current = trial; improved = true; break; }
        }
        if (improved) break;
      }
      if (improved) continue;
      // two at a time: the 3 most expensive with any other, by pairs of the 12 cheapest outside
      const cheapest = outside.slice(0, 16);
      external:
      for (const i of expensive.slice(0, 6)) {
        for (let j = 0; j < current.length; j++) {
          if (j === i) continue;
          const outCost = current[i].cost + current[j].cost;
          for (let a = 0; a < cheapest.length; a++) for (let b = a + 1; b < cheapest.length; b++) {
            if (cheapest[a].cost + cheapest[b].cost >= outCost) continue;
            const trial = current.slice(); trial[i] = cheapest[a]; trial[j] = cheapest[b];
            if (totalOf(trial) >= goal) { current = trial; improved = true; break external; }
          }
        }
      }
    }
    return current;
  }

  // From the cheapest ones, swaps one at a time adding the one with the most points per coin, until it reaches the goal
  function climbFromCheapest(cands, k, goal, limit, start) {
    const order = [...cands].sort((a, b) => a.cost - b.cost || b.gradingScore - a.gradingScore);
    let current = start ? start.slice() : order.slice(0, k);
    let total = totalOf(current);
    for (let step = 0; total < goal && step < 200 && performance.now() < limit; step++) {
      const inside = new Set(current);
      const outside = cands.filter((c) => !inside.has(c));
      let best = null;
      for (let i = 0; i < current.length; i++) for (const c of outside) {
        if (c.gradingScore <= current[i].gradingScore) continue;
        const ratio = (c.gradingScore - current[i].gradingScore) / (Math.max(0, c.cost - current[i].cost) + 1);
        if (!best || ratio > best.ratio) best = { i, c, ratio };
      }
      if (!best) break;
      const trial = current.slice(); trial[best.i] = best.c;
      const t = totalOf(trial);
      if (t <= total) break;
      current = trial; total = t;
    }
    return total >= goal ? current : null;
  }

  // Returns { ok, reason?, grade, requested, ids, buys, cost, total, noPrice, method }
  function planBuy(set, cards, requestedGrade) {
    const noPrice = cards.filter((c) => cardCost(c) === undefined).length;
    const cands = cards.filter((c) => cardCost(c) !== undefined)
      .map((c) => Object.assign(Object.create(c), c, { cost: cardCost(c), buyCost: cardBuyCost(c) }));
    const k = set.slots;
    if (cands.length < k) return { ok: false, reason: "missing", missing: k - cands.length, noPrice };
    const ladder = sortedGrades(set);
    const ceiling = optimizeOver(cands, k);
    const reachable = [...ladder].reverse().find((g) => ceiling.total >= g.score) || null;
    if (!reachable) return { ok: false, reason: "none", noPrice };
    const requested = ladder.find((g) => g.grade === requestedGrade) || reachable;
    const objective = requested.score <= reachable.score ? requested : reachable;
    const goal = objective.score;
    let best, method;
    if (combinations(cands.length, k) <= EXACT_LIMIT) {
      best = exactPlan(cands, k, goal); method = "exact";
    } else {
      const limit = performance.now() + optimizeBudget;
      let list = cheapen(ceiling.list, cands, goal, limit);
      const tryStart = (start) => {
        const climb = climbFromCheapest(cands, k, goal, limit, start);
        if (!climb) return false;
        const b = cheapen(climb, cands, goal, limit);
        if (costOf(b) < costOf(list)) { list = b; return true; }
        return false;
      };
      tryStart(null); // from the cheapest ones
      // Removing the bought cards of the best plan one at a time (in case it's better without that one)
      for (const c of list.filter((x) => x.cost > 0)) {
        if (performance.now() >= limit) break;
        const withoutIt = cands.filter((x) => x !== c);
        const order = [...withoutIt].sort((a, b) => a.cost - b.cost || b.gradingScore - a.gradingScore);
        tryStart(order.slice(0, k));
      }
      // Random starts while time remains (stops if 30 in a row don't improve)
      for (let noImprove = 0; noImprove < 30 && performance.now() < limit; ) {
        noImprove = tryStart(randomStart(cands, k)) ? 0 : noImprove + 1;
      }
      best = { list, cost: costOf(list), total: totalOf(list) }; method = "search";
    }
    const buys = best.list.filter((c) => !c.isCollected).sort((x, y) => y.buyCost - x.buyCost);
    return {
      ok: true, grade: objective.grade, requested: requested.grade, ids: best.list.map((c) => c.definitionId),
      buys: buys.map((c) => ({ definitionId: c.definitionId, name: c.name, price: c.buyCost, net: c.cost })),
      cost: best.cost, buyCost: buys.reduce((s, c) => s + c.buyCost, 0), resale: settings.resale,
      total: best.total, noPrice, method
    };
  }

  function evaluate(set, chosen) {
    const p = scoreLineup(chosen);
    const score = p.total;
    const full = chosen.length >= set.slots;
    const ladder = sortedGrades(set);
    let current = null;
    let tokens = 0;
    if (full) for (const g of ladder) if (score >= g.score) { current = g; tokens += num(g.tokens); }
    const next = ladder.find((g) => g.score > score) || null;
    // Grade it would reach by score if every slot were filled
    const wouldReach = [...ladder].reverse().find((g) => score >= g.score) || null;
    const tokensAll = ladder.reduce((s, g) => s + num(g.tokens), 0);
    return { score, base: p.base, bonus: p.bonus, detail: p.detail, full, current, wouldReach, next, tokens, tokensAll,
      missingSlots: Math.max(0, set.slots - chosen.length) };
  }

  // ---------- 4d. Summary of all sets ----------
  // For each checked set a small summary is saved (not the cards), per FUT profile, in this browser.
  const allSetsKey = () => "curator_all_sets_" + currentProfile();
  const ALL_SETS_MAX_AGE_MS = 12 * 60 * 60 * 1000; // “Check all” skips sets checked less than 12 h ago
  let allSets = null;
  function allSetsTable() {
    if (allSets) return allSets;
    try { allSets = JSON.parse(localStorage.getItem(allSetsKey()) || "{}"); } catch (e) { allSets = {}; }
    if (!allSets || typeof allSets !== "object" || Array.isArray(allSets)) allSets = {};
    return allSets;
  }
  function saveAllSets() {
    try { localStorage.setItem(allSetsKey(), JSON.stringify(allSetsTable())); } catch (e) { /* kept in memory */ }
  }

  // Calculates a set's summary from its cards already read (and whatever prices there are). quick = less calculation time.
  function summarizeSet(set, cards, quick) {
    const before = optimizeBudget;
    if (quick) optimizeBudget = 200;
    try {
      const opt = optimizeLineup(set, cards);
      const ids = new Set(opt.ids);
      const ev = evaluate(set, cards.filter((c) => ids.has(c.definitionId)));
      const ladder = sortedGrades(set);
      const maximum = ladder[ladder.length - 1];
      const hasGrade = (g) => ev.full && ev.score >= g.score;
      // Next grade you don't have yet
      const nextGrade = ladder.find((g) => !hasGrade(g)) || null;
      // For each grade you don't have yet: the cheapest plan (cost, purchase, points and tokens it adds)
      let accumulated = 0;
      const steps = [];
      for (const g of ladder) {
        accumulated += num(g.tokens);
        if (hasGrade(g)) continue;
        const p = planBuy(set, cards, g.grade);
        if (!(p.ok && p.grade === g.grade)) { steps.push({ g: g.grade, ok: false }); continue; }
        steps.push({ g: g.grade, ok: true, cost: p.cost, buyCost: p.buyCost, cards: p.buys.length,
          tokens: Math.max(0, accumulated - ev.tokens), points: Math.max(0, p.total - ev.score), total: p.total });
      }
      const stepOf = (g) => g && steps.find((x) => x.g === g.grade);
      const costFor = (g) => { if (!g) return null; if (hasGrade(g)) return 0; const x = stepOf(g); return x && x.ok ? x.cost : null; };
      const costNext = costFor(nextGrade);
      const costMax = costFor(maximum);
      const missing = cards.filter((c) => !c.isCollected);
      return {
        steps, resale: settings.resale,
        sPossible: maximum && !hasGrade(maximum) && costMax != null,
        at: Date.now(),
        owned: cards.length - missing.length, total: cards.length, slots: set.slots,
        score: ev.score, full: ev.full,
        grade: ev.current ? ev.current.grade : null,
        nextGrade: nextGrade ? nextGrade.grade : null,
        missingPoints: nextGrade ? Math.max(0, nextGrade.score - ev.score) : 0,
        missingSlots: ev.missingSlots,
        costNext, costMax, maxGrade: maximum.grade,
        tokens: ev.tokens, tokensTotal: ev.tokensAll,
        noPrice: missing.filter((c) => { const p = priceOf(c.definitionId); return !p || p.price == null; }).length
      };
    } finally { optimizeBudget = before; }
  }
  function saveSummary(set, cards, quick) {
    try {
      const before = allSetsTable()[set.slug];
      const r = summarizeSet(set, cards, quick);
      // “S possible (new)”: since when S can be reached (shown as new for 7 days)
      if (r.sPossible) r.sSince = before && before.sPossible && before.sSince ? before.sSince : (before ? Date.now() : null);
      allSetsTable()[set.slug] = r;
      saveAllSets();
    } catch (e) { console.warn("[Curator] couldn't summarize", set.slug, e); }
  }

  // ---------- 4e. Budget and goal across all sets ----------
  // Each set contributes at most ONE option: going up to a grade (with its cost and what it adds in tokens or points).
  // groups: [{ key, options: [{ cost, value, ... }] }]
  //  - maximizeWithBudget: the largest total value without going over budget.
  //  - minimizeForGoal: the lowest cost that reaches the requested value.
  // Dynamic programming with costs (or values) bucketed into at most ~4000 steps; always rounded
  // to the safe side (costs up, values down), so it never promises something it can't deliver.
  const DP_STEPS = 4000;
  function maximizeWithBudget(groups, maxCost) {
    const unit = Math.max(1, Math.ceil(maxCost / (DP_STEPS * 5)));
    const B = Math.floor(maxCost / unit);
    let dp = new Float64Array(B + 1);
    const choice = [];
    for (const gr of groups) {
      const fresh = Float64Array.from(dp);
      const picked = new Int16Array(B + 1).fill(-1);
      gr.options.forEach((op, k) => {
        const w = Math.ceil(op.cost / unit);
        if (w > B || !(op.value > 0)) return;
        for (let b = B; b >= w; b--) {
          const v = dp[b - w] + op.value;
          if (v > fresh[b]) { fresh[b] = v; picked[b] = k; }
        }
      });
      choice.push(picked);
      dp = fresh;
    }
    // Rebuild from the budget that gives the most value (and, at equal value, the cheapest)
    let bestB = 0;
    for (let b = 1; b <= B; b++) if (dp[b] > dp[bestB]) bestB = b;
    const chosen = [];
    for (let i = groups.length - 1, b = bestB; i >= 0; i--) {
      const k = choice[i][b];
      if (k >= 0) { const op = groups[i].options[k]; chosen.push({ group: groups[i], option: op }); b -= Math.ceil(op.cost / unit); }
    }
    chosen.reverse();
    // Pass with exact costs: if there's money left, swap a set's option for one that adds more (or add a set)
    let cost = chosen.reduce((s, x) => s + x.option.cost, 0);
    for (let improved = true, rounds = 0; improved && rounds < 50; rounds++) {
      improved = false;
      for (const gr of groups) {
        const i = chosen.findIndex((x) => x.group === gr);
        const current = i >= 0 ? chosen[i].option : null;
        for (const op of gr.options) {
          const extra = op.cost - (current ? current.cost : 0);
          if (op.value > (current ? current.value : 0) && cost + extra <= maxCost) {
            if (i >= 0) chosen[i] = { group: gr, option: op }; else chosen.push({ group: gr, option: op });
            cost += extra; improved = true; break;
          }
        }
        if (improved) break;
      }
    }
    return { chosen, value: chosen.reduce((s, x) => s + x.option.value, 0), cost };
  }
  function minimizeForGoal(groups, goal) {
    if (!(goal > 0)) return { chosen: [], value: 0, cost: 0, reached: true };
    const unit = Math.max(1, Math.ceil(goal / DP_STEPS));
    const M = Math.ceil(goal / unit);
    let dp = new Float64Array(M + 1).fill(Infinity);
    dp[0] = 0;
    const choice = [];
    for (const gr of groups) {
      const fresh = Float64Array.from(dp);
      const picked = new Int16Array(M + 1).fill(-1);
      const since = new Int32Array(M + 1).fill(-1);
      gr.options.forEach((op, k) => {
        const v = Math.floor(op.value / unit);
        if (v <= 0) return;
        for (let m = 0; m <= M; m++) {
          if (dp[m] === Infinity) continue;
          const dest = Math.min(M, m + v);
          const c = dp[m] + op.cost;
          if (c < fresh[dest]) { fresh[dest] = c; picked[dest] = k; since[dest] = m; }
        }
      });
      choice.push({ picked, since });
      dp = fresh;
    }
    if (dp[M] === Infinity) {
      // Out of reach: return the most possible (all the best options of each set)
      let best = 0; for (let m = 1; m <= M; m++) if (dp[m] < Infinity) best = m;
      const r = rebuild(best); r.reached = false; return r;
    }
    const r = rebuild(M); r.reached = true; return r;
    function rebuild(done) {
      const chosen = [];
      for (let i = groups.length - 1, m = done; i >= 0; i--) {
        const k = choice[i].picked[m];
        if (k >= 0) { chosen.push({ group: groups[i], option: groups[i].options[k] }); m = choice[i].since[m]; }
      }
      chosen.reverse();
      return { chosen, value: chosen.reduce((s, x) => s + x.option.value, 0), cost: chosen.reduce((s, x) => s + x.option.cost, 0) };
    }
  }
  // Builds the groups from the saved summaries. valueKey: "tokens" or "points".
  function groupsFromAll(valueKey) {
    const t = allSetsTable();
    return SETS.filter((s) => t[s.slug] && Array.isArray(t[s.slug].steps)).map((s) => ({
      set: s, r: t[s.slug],
      options: t[s.slug].steps.filter((x) => x.ok).map((x) => Object.assign({}, x, { value: x[valueKey] || 0 })).filter((x) => x.value > 0)
    })).filter((g) => g.options.length);
  }

  // ---------- 4f. Cards saved per set (this browser's IndexedDB, per profile) ----------
  // A small copy of each card (only the data the calculations use) is saved when a set is read.
  // It's used to know which sets each card counts for, for the cart, and to update from the club without searching.
  const DB_NAME = "curator_db";
  const CARD_FIELDS = ["definitionId", "player", "name", "rating", "level", "rarity", "nation", "club", "league", "positions", "weakFoot", "skillMoves", "holo", "isCollected", "gradingScore"];
  const cardStore = new Map(); // slug -> { at, cards }
  let cardsLoaded = null;   // promise of the initial load
  let countsIndex = null;     // definitionId -> [slug]
  let dbPromise = null;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((ok) => {
      try {
        const r = indexedDB.open(DB_NAME, 1);
        r.onupgradeneeded = () => { try { r.result.createObjectStore("sets"); } catch (e) { /* already exists */ } };
        r.onsuccess = () => ok(r.result);
        r.onerror = () => ok(null);
        r.onblocked = () => ok(null);
      } catch (e) { ok(null); }
    });
    return dbPromise;
  }
  const cardsKey = (slug) => currentProfile() + "|" + slug;
  function compact(c) { const o = {}; for (const k of CARD_FIELDS) o[k] = c[k]; return o; }
  // Revalidates whatever is read from the database (in case something changed it)
  function validStoredCard(x) {
    if (!x || typeof x !== "object" || !isInt(x.definitionId, 1, 2e9) || !isInt(x.gradingScore, 0, 1e7)) return null;
    const n = (v) => (v == null ? null : isInt(v, 0, 1e9) ? v : null);
    return {
      definitionId: x.definitionId, player: x.definitionId % 16777216, name: cleanText(String(x.name || ""), 60),
      rating: isInt(x.rating, 0, 99) ? x.rating : 0, level: ["bronze", "silver", "gold"].includes(x.level) ? x.level : "gold",
      rarity: n(x.rarity), nation: n(x.nation), club: n(x.club), league: n(x.league),
      positions: Array.isArray(x.positions) ? x.positions.filter((p) => typeof p === "string" && /^[A-Z]{1,4}$/.test(p)).slice(0, 6) : [],
      weakFoot: isInt(x.weakFoot, 0, 5) ? x.weakFoot : 0, skillMoves: isInt(x.skillMoves, 0, 5) ? x.skillMoves : 0,
      holo: x.holo === true, isCollected: x.isCollected === true, gradingScore: x.gradingScore
    };
  }
  async function storeSetCards(slug, cards) {
    const v = { at: Date.now(), cards: cards.map(compact) };
    cardStore.set(slug, v);
    countsIndex = null;
    const db = await openDB();
    if (!db) return;
    try { db.transaction("sets", "readwrite").objectStore("sets").put(v, cardsKey(slug)); } catch (e) { /* no database: kept in memory */ }
  }
  function ensureCards() {
    if (cardsLoaded) return cardsLoaded;
    cardsLoaded = (async () => {
      const db = await openDB();
      if (!db) return;
      const pref = currentProfile() + "|";
      await new Promise((ok) => {
        try {
          const req = db.transaction("sets", "readonly").objectStore("sets").openCursor();
          req.onsuccess = () => {
            const cur = req.result;
            if (!cur) return ok();
            const k = String(cur.key);
            if (k.startsWith(pref) && !cardStore.has(k.slice(pref.length))) {
              const v = cur.value;
              if (v && Array.isArray(v.cards)) cardStore.set(k.slice(pref.length), { at: num(v.at), cards: v.cards.slice(0, 2000).map(validStoredCard).filter(Boolean) });
            }
            cur.continue();
          };
          req.onerror = () => ok();
        } catch (e) { ok(); }
      });
      countsIndex = null;
    })();
    return cardsLoaded;
  }
  // Which (checked) sets a card counts for
  function countsFor(defId) {
    if (!countsIndex) {
      countsIndex = new Map();
      for (const [slug, v] of cardStore) for (const c of v.cards) {
        const l = countsIndex.get(c.definitionId);
        if (l) l.push(slug); else countsIndex.set(c.definitionId, [slug]);
      }
    }
    return countsIndex.get(defId) || [];
  }
  const setBySlug = (slug) => SETS.find((s) => s.slug === slug) || null;
  // Marks cards as collected in every saved set (bought or found in the club).
  // Returns the slugs that changed.
  function markCollected(ids) {
    const changedSets = new Set();
    for (const [slug, v] of cardStore) {
      let didChange = false;
      for (const c of v.cards) if (!c.isCollected && ids.has(c.definitionId)) { c.isCollected = true; didChange = true; }
      if (didChange) { changedSets.add(slug); storeSetCards(slug, v.cards); }
    }
    return changedSets;
  }

  // With the cards seen in your club: those already in a saved set are marked as collected
  // and that set is recalculated (no searching). Those not in any saved set but from a club, league or
  // rarity of a checked set mark that set as “changed” so it gets checked again.
  function updateFromClub(clubCards) {
    if (!clubCards || !clubCards.size) return { updated: [], toReview: [] };
    const ids = new Set(clubCards.keys());
    const updated = [...markCollected(ids)];
    for (const slug of updated) {
      const set = setBySlug(slug), v = cardStore.get(slug);
      if (set && v) saveSummary(set, v.cards, true);
    }
    const t = allSetsTable();
    const toReview = [];
    const known = new Set();
    for (const v of cardStore.values()) for (const c of v.cards) known.add(c.definitionId);
    for (const set of SETS) {
      if (set.eaFilter.unsupported || !t[set.slug] || updated.includes(set.slug)) continue;
      let setIds;
      try { setIds = new Set(filterIds(set.eaFilter)); } catch (e) { continue; }
      for (const [id, x] of clubCards) {
        if (known.has(id)) continue;
        const field = set.eaFilter.kind === "club" ? x.club : set.eaFilter.kind === "league" ? x.league : x.rarity;
        if (field != null && setIds.has(field)) { toReview.push(set.slug); t[set.slug].changed = true; break; }
      }
    }
    if (toReview.length) saveAllSets();
    return { updated, toReview };
  }

  // ---------- 4g. Best buys and cart ----------
  // Quick estimate of how much a card adds to the Gallery score, adding every set it counts for:
  // in each set, if your lineup isn't full it adds its score; if it's full, what it beats the lowest one by.
  // (It's an estimate: it ignores tag bonuses. The cart calculates the exact effect.)
  let lineupCache = null;
  function quickLineup(slug) {
    if (!lineupCache) lineupCache = new Map();
    if (lineupCache.has(slug)) return lineupCache.get(slug);
    const set = setBySlug(slug), v = cardStore.get(slug);
    if (!set || !v) return null;
    const mine = v.cards.filter((c) => c.isCollected).sort((a, b) => b.gradingScore - a.gradingScore).slice(0, set.slots);
    const r = { isFull: mine.length >= set.slots, minimum: mine.length ? mine[mine.length - 1].gradingScore : 0 };
    lineupCache.set(slug, r);
    return r;
  }
  function estimatedGain(c) {
    let points = 0;
    const sets = [];
    for (const slug of countsFor(c.definitionId)) {
      const a = quickLineup(slug);
      if (!a) continue;
      const g = a.isFull ? Math.max(0, c.gradingScore - a.minimum) : c.gradingScore;
      if (g > 0) { points += g; sets.push(slug); }
    }
    return { points, sets };
  }
  function bestBuys(limit) {
    lineupCache = null;
    const views = new Map();
    for (const v of cardStore.values()) for (const c of v.cards) if (!c.isCollected && !views.has(c.definitionId)) views.set(c.definitionId, c);
    const list = [];
    for (const c of views.values()) {
      const cost = cardCost(c);
      if (cost === undefined) continue;
      const g = estimatedGain(c);
      if (g.points <= 0) continue;
      list.push({ card: c, cost, buyCost: cardBuyCost(c), points: g.points, sets: g.sets, perCoin: g.points / Math.max(1, cost) });
    }
    list.sort((a, b) => b.perCoin - a.perCoin || b.points - a.points);
    return list.slice(0, limit);
  }

  // Cart (per profile, in this browser): definitionId -> { name }
  const cartKey = () => "curator_cart_" + currentProfile();
  let cart = null;
  function cartTable() {
    if (cart) return cart;
    cart = new Map();
    try {
      const g = JSON.parse(localStorage.getItem(cartKey()) || "[]");
      if (Array.isArray(g)) for (const x of g.slice(0, 300)) if (x && isInt(x.id, 1, 2e9)) cart.set(x.id, { name: cleanText(String(x.name || ""), 60) });
    } catch (e) { /* empty */ }
    return cart;
  }
  function saveCart() {
    try { localStorage.setItem(cartKey(), JSON.stringify([...cartTable()].map(([id, x]) => ({ id, name: x.name })))); } catch (e) { /* in memory */ }
  }
  function addToCart(cards) {
    let n = 0;
    for (const c of cards) if (c && !c.isCollected && !cartTable().has(c.definitionId)) { cartTable().set(c.definitionId, { name: c.name || "" }); n++; }
    saveCart();
    return n;
  }
  function removeFromCart(id) { cartTable().delete(id); saveCart(); }

  // Exact effect of the cart on every set its cards count for (with tag bonuses and grades)
  function cartEffect() {
    const ids = new Set(cartTable().keys());
    const slugs = new Set();
    for (const id of ids) for (const s of countsFor(id)) slugs.add(s);
    const rows = [];
    const before = optimizeBudget;
    optimizeBudget = 150;
    try {
      for (const slug of slugs) {
        const set = setBySlug(slug), v = cardStore.get(slug);
        if (!set || !v) continue;
        const now = basicSummary(set, v.cards);
        let after = basicSummary(set, v.cards.map((c) => ids.has(c.definitionId) ? Object.assign({}, c, { isCollected: true }) : c));
        // Adding cards can never make a set worse (the previous lineup is still available):
        // if the quick calculation found a worse one, the previous one is kept.
        if (after.score < now.score) after = Object.assign({}, now, { missingSlots: Math.min(now.missingSlots, after.missingSlots) });
        rows.push({ set, before: now, after, points: after.score - now.score, tokens: after.tokens - now.tokens });
      }
    } finally { optimizeBudget = before; }
    rows.sort((a, b) => b.tokens - a.tokens || b.points - a.points);
    let buyCost = 0, cost = 0, noPrice = 0;
    for (const id of ids) {
      const c = findStoredCard(id) || { definitionId: id, isCollected: false };
      const p = cardBuyCost(c), k = cardCost(c);
      if (p === undefined) noPrice++; else { buyCost += p; cost += k; }
    }
    return { rows, buyCost, cost, noPrice, points: rows.reduce((s, f) => s + f.points, 0), tokens: rows.reduce((s, f) => s + f.tokens, 0) };
  }
  function basicSummary(set, cards) {
    const opt = optimizeLineup(set, cards);
    const ids = new Set(opt.ids);
    const ev = evaluate(set, cards.filter((c) => ids.has(c.definitionId)));
    return { score: ev.score, grade: ev.current ? ev.current.grade : null, tokens: ev.tokens, missingSlots: ev.missingSlots };
  }
  function findStoredCard(id) {
    for (const v of cardStore.values()) { const c = v.cards.find((x) => x.definitionId === id); if (c) return c; }
    if (view.cards) { const c = view.cards.find((x) => x.definitionId === id); if (c) return c; }
    return null;
  }

  // ---------- 4h. Buying (optional, at your own risk) ----------
  // Buys the cart's cards with “buy now”, one at a time, with pauses, never above a maximum overpay
  // over the fut.gg price or a total coin cap. Stops on any EA limit warning.
  // Neither resells nor moves anything by default: cards stay in “Unassigned”.
  const DAILY_ACTION_CAP = 150;
  const KEY_ACTIONS = "curator_market_actions";
  // EA codes that mean “stop”: too many requests, verification, session, maintenance
  const STOP_CODES = [401, 403, 426, 429, 458, 494, 512, 521];
  const NO_COINS_CODE = 470;
  function actionsToday() {
    const today = new Date().toISOString().slice(0, 10);
    try { const g = JSON.parse(localStorage.getItem(KEY_ACTIONS) || "{}"); return g.day === today && isInt(g.n, 0, 1e6) ? g.n : 0; } catch (e) { return 0; }
  }
  function logAction() {
    const today = new Date().toISOString().slice(0, 10);
    try { localStorage.setItem(KEY_ACTIONS, JSON.stringify({ day: today, n: actionsToday() + 1 })); } catch (e) { /* ignore */ }
  }
  // Valid EA prices (steps): downward
  function eaPrice(v) {
    const stepList = [[1000, 50], [10000, 100], [50000, 250], [100000, 500], [Infinity, 1000]];
    for (const [until, step] of stepList) if (v < until) return Math.max(200, Math.floor(v / step) * step);
    return 200;
  }
  // EA price steps (uses the web app's if available; otherwise the known table)
  function stepUp(v) {
    try { const u = readGlobal("UTCurrencyInputControl"); if (u && typeof u.getIncrementAboveVal === "function") { const b = u.getIncrementBelowVal(u.getIncrementAboveVal(v)); return b >= v ? b : u.getIncrementAboveVal(b); } } catch (e) { /* table */ }
    const a = eaPrice(v); return a >= v ? a : eaPrice(v + (v < 1000 ? 50 : v < 10000 ? 100 : v < 50000 ? 250 : v < 100000 ? 500 : 1000));
  }
  function stepBelow(v) { // the next valid step below
    try { const u = readGlobal("UTCurrencyInputControl"); if (u && typeof u.getIncrementBelowVal === "function") return u.getIncrementBelowVal(v); } catch (e) { /* table */ }
    return eaPrice(v - 1);
  }
  function priceLimitsOf(item) {
    try {
      const l = typeof item.getPriceLimits === "function" ? item.getPriceLimits() : (item._itemPriceLimits || item.itemPriceLimits || item._priceLimits || item.priceLimits);
      if (l && Number(l.minimum) > 0 && Number(l.maximum) > 0) return { min: Number(l.minimum), max: Number(l.maximum) };
    } catch (e) { /* no limits */ }
    return null;
  }
  // Sale price: base × (1 + adjust), on valid steps and within EA's limits. Returns { bid, buy } or null.
  function sellPrice(base, adjustPct, lim) {
    let buy = eaPrice(base * (1 + adjustPct / 100));
    if (lim) buy = Math.min(lim.max, Math.max(lim.min, buy));
    let bid = stepBelow(buy);
    if (lim && bid < lim.min) { bid = lim.min; if (bid >= buy) buy = stepUp(bid + 1); if (buy > lim.max) return null; }
    if (!(bid > 0) || bid >= buy) return null;
    return { bid, buy };
  }
  function observeEA(obs) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (x) => { if (!settled) { settled = true; resolve(x); } };
      if (!obs || typeof obs.observe !== "function") return done({ ok: false, code: null });
      const ctx = {};
      try {
        obs.observe(ctx, (o, r) => {
          try { o.unobserve(ctx); } catch (e) { /* ignore */ }
          const code = r && r.error && r.error.code != null ? Number(r.error.code) : r && r.status != null ? Number(r.status) : null;
          done({ ok: !!(r && r.success), code });
        });
      } catch (e) { done({ ok: false, code: null }); }
      setTimeout(() => done({ ok: false, code: null, timedOut: true }), TIMEOUT_MS);
    });
  }
  // What to do with the bought card. options: { mode: "keep"|"club"|"transfers"|"sale", base: "paid"|"market", adjust, duration }
  async function afterBuying(item, options, paid, market) {
    const s = services();
    if (options.mode === "keep") return { ok: true, text: "in “Unassigned”" };
    const piles = readGlobal("ItemPile") || {};
    if (options.mode === "club" || options.mode === "transfers") {
      const pile = options.mode === "club" ? piles.CLUB : piles.TRANSFER;
      if (pile == null || typeof s.Item.move !== "function") return { ok: false, text: "couldn't move it (left in “Unassigned”)" };
      await marketPause();
      const r = await observeEA(s.Item.move(item, pile));
      return r.ok ? { ok: true, text: options.mode === "club" ? "to the club" : "to the transfer list" } : { ok: false, text: "couldn't move it (left in “Unassigned”)", halt: STOP_CODES.includes(r.code), code: r.code };
    }
    // List for sale
    if (typeof s.Item.list !== "function") return { ok: false, text: "couldn't list it for sale" };
    let lim = priceLimitsOf(item);
    if (!lim && typeof s.Item.requestMarketData === "function") {
      await marketPause(); logAction();
      await observeEA(s.Item.requestMarketData(item));
      lim = priceLimitsOf(item);
    }
    const base = options.base === "market" && market ? market : paid;
    const listPrice = sellPrice(base, options.adjust, lim);
    if (!listPrice) return { ok: false, text: "sale price outside EA's limits (left in “Unassigned”)" };
    if (actionsToday() >= DAILY_ACTION_CAP) return { ok: false, text: "not listed: daily action limit", halt: true };
    await marketPause(); logAction();
    const r = await observeEA(s.Item.list(item, listPrice.bid, listPrice.buy, options.duration));
    return r.ok ? { ok: true, text: "listed for 🪙 " + fmt(listPrice.buy), sale: listPrice.buy }
      : { ok: false, text: "couldn't list it for sale (code " + (r.code ?? "?") + ")", halt: STOP_CODES.includes(r.code), code: r.code };
  }

  function buyNow(item, price) {
    const s = services();
    return new Promise((resolve) => {
      let settled = false;
      const done = (x) => { if (!settled) { settled = true; resolve(x); } };
      try {
        const obs = s.Item.bid(item, price);
        if (!obs || typeof obs.observe !== "function") return done({ ok: false, code: null });
        const ctx = {};
        obs.observe(ctx, (o, r) => {
          try { o.unobserve(ctx); } catch (e) { /* ignore */ }
          const code = r && r.error && r.error.code != null ? Number(r.error.code) : r && r.status != null ? Number(r.status) : null;
          done({ ok: !!(r && r.success), code });
        });
      } catch (e) { done({ ok: false, code: null }); }
      setTimeout(() => done({ ok: false, code: null, timedOut: true }), TIMEOUT_MS);
    });
  }
  // One card: searches up to the limit and buys the cheapest listing (if someone beats you to it, tries the next).
  // Returns { ok, price } or { ok:false, reason, halt?, noCoins? }
  async function buyCard(defId, limit) {
    if (actionsToday() >= DAILY_ACTION_CAP) return { ok: false, halt: true, reason: "daily limit of " + DAILY_ACTION_CAP + " market actions" };
    if (searchesLeft() <= 0) return { ok: false, halt: true, reason: "cap of " + HOURLY_SEARCH_CAP + " searches per hour" };
    logAction(); logSearch();
    const r = await searchMarket(defId, limit);
    if (r.halt) return { ok: false, halt: true, reason: "EA is limiting the market (code " + r.state + ")" };
    if (!r.ok) return { ok: false, reason: "search failed" };
    const listings = [];
    for (const it of r.items) {
      try {
        const sub = typeof it.getAuctionData === "function" ? it.getAuctionData() : (it.auctionData || it);
        const state = sub && (sub.tradeState ?? sub._tradeState);
        if (!sub || state === "closed" || state === "expired") continue;
        const id = typeof it.definitionId === "number" ? it.definitionId : (it.itemData && (it.itemData.resourceId ?? it.itemData.definitionId)) || it.resourceId;
        if (!sameCard(id, defId)) continue;
        const bin = Number(sub.buyNowPrice) || 0;
        if (bin > 0 && bin <= limit) listings.push({ it, bin });
      } catch (e) { /* ignore */ }
    }
    listings.sort((a, b) => a.bin - b.bin);
    if (!listings.length) return { ok: false, reason: "none for sale up to 🪙 " + fmt(limit) };
    for (const listing of listings.slice(0, 2)) {
      await marketPause();
      logAction();
      const c = await buyNow(listing.it, listing.bin);
      if (c.ok) return { ok: true, price: listing.bin, item: listing.it };
      if (c.code === NO_COINS_CODE) return { ok: false, noCoins: true, halt: true, reason: "not enough coins" };
      if (c.code === 461 || c.code === 478) continue; // someone else bought it first: try the next one
      return { ok: false, halt: true, reason: "EA rejected the purchase (code " + (c.code ?? "unknown") + ")" };
    }
    return { ok: false, reason: "someone else bought them first" };
  }

  // ---------- 5. Interface ----------
  const styles = `
    /* Palette: dark blue, gold for selection, green for points */
    #cur-launcher{position:fixed;right:16px;bottom:16px;z-index:2147483000;background:rgba(255,200,50,.16);color:#ffc832;
      border:1px solid rgba(255,200,50,.5);border-radius:20px;padding:8px 14px;font:600 13px system-ui,sans-serif;cursor:pointer;
      box-shadow:0 2px 8px #0008;backdrop-filter:blur(4px)}
    #cur-launcher:hover{background:rgba(255,200,50,.26)}
    #cur-overlay{position:fixed;inset:0;z-index:2147483001;background:rgba(5,7,12,.72);display:none;align-items:center;justify-content:center}
    #cur-overlay.open{display:flex}
    #cur-window{position:relative;width:min(1180px,calc(100vw - 24px));height:calc(100vh - 24px);display:flex;flex-direction:column;
      background:#0e121a;color:#e0e0e0;border:1px solid rgba(255,255,255,.1);border-radius:12px;font:13px/1.4 system-ui,sans-serif;overflow:hidden}
    #cur-header{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 24px;border-bottom:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03)}
    #cur-header h3{margin:0 8px 0 0;font-size:15px;color:#fff}
    #cur-window button{background:rgba(255,255,255,.05);color:#e0e0e0;border:1px solid rgba(255,255,255,.25);border-radius:6px;
      padding:5px 10px;cursor:pointer;font:inherit;transition:background-color .15s,border-color .15s}
    #cur-window button:hover{background:rgba(255,255,255,.11);border-color:rgba(255,255,255,.35)}
    #cur-window button:disabled{opacity:.45;cursor:default}
    #cur-window button.primary,#cur-window button.active{color:#ffc832;background:rgba(255,200,50,.12);border-color:rgba(255,200,50,.35)}
    #cur-window button.primary:hover,#cur-window button.active:hover{background:rgba(255,200,50,.2);border-color:rgba(255,200,50,.5)}
    #cur-window select{background:rgba(255,255,255,.05);color:#e0e0e0;border:1px solid rgba(255,255,255,.25);border-radius:6px;padding:5px}
    #cur-window select option{background:#161d28}
    #cur-close{margin-left:auto}
    #cur-status{padding:6px 24px;color:#9a9aa2;font-size:12px;border-bottom:1px solid rgba(255,255,255,.06)}
    #cur-summary{display:none;position:sticky;top:0;padding:12px;border-radius:12px;background:rgba(12,16,24,.72);border:1px solid rgba(255,255,255,.07)}
    #cur-summary.visible{display:block}
    #cur-summary .cur-row{flex-direction:column;align-items:flex-start;gap:6px}
    .cur-row{display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin-bottom:10px;color:#b6b6bf}
    .cur-stat b{font-size:15px;color:#fff}
    .cur-progress{display:flex;align-items:center;gap:10px;margin:4px 0 6px}
    /* Grade: diamond with a border in the grade's colour */
    .cur-grade-badge{width:22px;height:22px;flex:none;display:flex;align-items:center;justify-content:center;transform:rotate(45deg);
      border:2px solid currentColor;border-radius:4px;background:rgba(255,255,255,.04);color:#6f6f78;box-sizing:border-box}
    .cur-grade-badge > span{transform:rotate(-45deg);font-weight:800;font-size:12px}
    .cur-grade-badge.D{color:#e2703a}.cur-grade-badge.C{color:#b9c2ce}.cur-grade-badge.B{color:#f2c14e}.cur-grade-badge.A{color:#4aa8ff}.cur-grade-badge.S{color:#a855f7}
    .cur-bar{flex:1;height:6px;background:rgba(255,255,255,.12);border-radius:3px;overflow:hidden}
    .cur-bar > div{height:100%;background:#2fbf88;border-radius:3px}
    .cur-note{color:#9a9aa2;font-size:12px}
    .cur-optimal{display:flex;flex-direction:column;align-items:flex-start;gap:6px;margin-top:10px}
    .cur-tags{margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,.08);display:flex;flex-direction:column;gap:4px}
    .cur-tags-title{font-weight:700;color:#fff;margin-bottom:2px}
    .cur-tag{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#b6b6bf}
    .cur-tag b{color:#2fbf88}
    .cur-tag.not-counted{opacity:.45;text-decoration:line-through}
    #cur-filters{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
    /* Card grid sizes */
    #cur-body{flex:1;overflow:auto;padding:12px 24px;display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:16px;align-items:start}
    #cur-body.all-sets{grid-template-columns:minmax(0,1fr)}
    #cur-left{min-width:0;display:flex;flex-direction:column;gap:10px}
    #cur-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(154px,1fr));gap:10px;padding:12px;border-radius:12px;
      background:rgba(12,16,24,.72);border:1px solid rgba(255,255,255,.07)}
    #cur-grid:empty{display:none}
    .cur-tile{position:relative;display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px 4px;border-radius:10px;
      border:1px solid transparent;cursor:pointer;user-select:none;transition:background-color .15s,border-color .15s,opacity .15s}
    .cur-tile:hover{background:rgba(255,255,255,.07)}
    .cur-tile.missing{opacity:.62}
    .cur-tile.missing:hover{opacity:1}
    .cur-tile.chosen{border-color:#ffc832;background:rgba(255,200,50,.1);opacity:1}
    .cur-points{display:flex;align-items:center;justify-content:center;gap:5px;font-weight:700;font-size:12px;color:#2fbf88}
    .cur-gem{width:9px;height:9px;transform:rotate(45deg);background:#2fbf88;border-radius:2px}
    .cur-art{width:100%;min-height:120px;display:flex;align-items:center;justify-content:center}
    .cur-art > *{flex:0 0 auto;max-width:144px}
    .cur-art .cur-no-art{font-size:12px;text-align:center;color:#9a9aa2;padding:24px 4px}
    .cur-foot{font-size:13px;line-height:1.3}
    .cur-foot.owned{color:#2fbf88}.cur-foot.missing{color:#9a9aa2}
    #cur-window .cur-fo{position:absolute;top:4px;right:4px;z-index:2;width:22px;height:22px;padding:0;border-radius:50%;
      border:1px solid transparent;background:rgba(255,255,255,.06);color:rgba(255,255,255,.35);font-size:13px;line-height:1}
    #cur-window .cur-fo:hover{background:rgba(255,255,255,.12)}
    #cur-window .cur-fo.yes{background:rgba(255,200,50,.16);color:#ffc832}
    #cur-window .cur-fo.no{text-decoration:line-through;color:rgba(255,255,255,.5)}
    #cur-window .cur-fo.manual{border-color:currentColor}
    .cur-plan{margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,.08);display:flex;flex-direction:column;gap:6px}
    .cur-plan-grades{display:flex;gap:6px}
    .cur-chk{display:flex;gap:6px;align-items:center;cursor:pointer}
    .cur-fo-mode{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:4px}
    .cur-input.cur-pct{width:52px;padding:2px 4px}
    .cur-all-bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:10px}
    .cur-help{margin-bottom:10px;padding:8px 12px;border-radius:12px;background:rgba(12,16,24,.72);border:1px solid rgba(255,255,255,.07);font-size:12px;color:#b6b6bf}
    .cur-help summary{cursor:pointer;color:#fff;font-weight:600}
    .cur-help ol{margin:8px 0 2px 18px;padding:0;display:flex;flex-direction:column;gap:4px}
    #cur-window button.cur-danger{color:#ff9b7a;border-color:rgba(255,120,90,.5);background:rgba(255,120,90,.1)}
    #cur-window button.cur-danger:hover{background:rgba(255,120,90,.2)}
    #cur-modal{position:absolute;inset:0;background:rgba(5,7,12,.75);display:flex;align-items:center;justify-content:center;z-index:5}
    .cur-modal-box{width:min(560px,calc(100% - 32px));max-height:calc(100% - 32px);overflow:auto;background:#121722;border:1px solid rgba(255,255,255,.15);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px}
    .cur-modal-box ul{margin:0 0 0 18px;padding:0;display:flex;flex-direction:column;gap:3px}
    .cur-notice{padding:10px;border-radius:8px;background:rgba(255,120,90,.12);border:1px solid rgba(255,120,90,.4);color:#ffb59e;font-size:12px}
    .cur-buy-progress{display:flex;flex-direction:column;gap:3px;font-size:12px}
    .cur-option-row{display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:13px;color:#b6b6bf}
    .cur-option-row b{color:#fff}
    .cur-option-row b.cur-no{color:#ff7a7a}.cur-option-row b.cur-ok{color:#2fbf88}
    .cur-sale{display:flex;flex-direction:column;gap:8px;padding-left:10px;border-left:2px solid rgba(255,255,255,.1)}
    .cur-steps{display:flex;gap:4px;align-items:center}
    #cur-window button.cur-step{padding:3px 6px;min-width:30px}
    .cur-input.cur-wide{width:220px}
    .cur-set-form{margin-top:10px;max-width:640px}
    .cur-input{background:rgba(255,255,255,.05);color:#e0e0e0;border:1px solid rgba(255,255,255,.25);border-radius:6px;padding:5px 8px;font:inherit;width:140px}
    .cur-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-bottom:10px}
    .cur-card{padding:12px;border-radius:12px;background:rgba(12,16,24,.72);border:1px solid rgba(255,255,255,.07);display:flex;flex-direction:column;gap:2px}
    .cur-card b{font-size:20px;color:#fff}
    .cur-blocks{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:10px;align-items:start}
    .cur-block{padding:12px;border-radius:12px;background:rgba(12,16,24,.72);border:1px solid rgba(255,255,255,.07);display:flex;flex-direction:column;gap:6px;margin-bottom:10px}
    .cur-list-row{display:flex;justify-content:space-between;gap:10px;padding:5px 6px;border-radius:6px;cursor:pointer;font-size:12px}
    .cur-list-row:hover{background:rgba(255,255,255,.06)}
    .cur-chip{margin-left:6px;padding:1px 6px;border-radius:8px;background:rgba(168,85,247,.2);color:#c99bff;font-size:10px;font-weight:700}
    .cur-table-wrap{overflow-x:auto;border-radius:12px;background:rgba(12,16,24,.72);border:1px solid rgba(255,255,255,.07)}
    table.cur-all{width:100%;border-collapse:collapse;font:12px/1.4 system-ui,sans-serif;color:#e0e0e0}
    .cur-all th{text-align:left;padding:8px;color:#9a9aa2;font-weight:600;border-bottom:1px solid rgba(255,255,255,.1);white-space:nowrap;position:sticky;top:0;background:#121722}
    .cur-all th.sortable{cursor:pointer}.cur-all th.sortable:hover{color:#fff}
    .cur-all td{padding:7px 8px;border-bottom:1px solid rgba(255,255,255,.05);white-space:nowrap}
    .cur-all tbody tr{cursor:pointer}.cur-all tbody tr:hover{background:rgba(255,255,255,.05)}
    .cur-all td.cur-num{color:#ffc832;font-weight:600}
    #cur-window select.cur-select-small{padding:2px 4px;font-size:12px}
    .cur-all td.cur-actions{display:flex;gap:6px;justify-content:flex-end}
    .cur-rewards{display:flex;flex-direction:column;gap:2px;font-size:12px;color:#b6b6bf}
    .cur-rewards .cur-plan-item{justify-content:flex-start}
    .cur-grade-chip{width:16px;font-weight:800;color:#6f6f78}
    .cur-grade-chip.D{color:#e2703a}.cur-grade-chip.C{color:#b9c2ce}.cur-grade-chip.B{color:#f2c14e}.cur-grade-chip.A{color:#4aa8ff}.cur-grade-chip.S{color:#a855f7}
    #cur-window .cur-plan-grade{width:34px;padding:4px 0;font-weight:800}
    #cur-window .cur-plan-grade.D{color:#e2703a}#cur-window .cur-plan-grade.C{color:#b9c2ce}#cur-window .cur-plan-grade.B{color:#f2c14e}
    #cur-window .cur-plan-grade.A{color:#4aa8ff}#cur-window .cur-plan-grade.S{color:#a855f7}
    #cur-window .cur-plan-grade.active{border-color:currentColor;background:rgba(255,255,255,.1)}
    .cur-plan-result{display:flex;flex-direction:column;gap:3px;font-size:12px;color:#b6b6bf}
    .cur-plan-result b{color:#ffc832}
    .cur-plan-item{display:flex;justify-content:space-between;gap:8px}
    .cur-tile.buy{border-color:#ffc832;border-style:dashed;opacity:1}
    .cur-buy{position:absolute;top:30px;left:50%;transform:translateX(-50%);z-index:2;background:#ffc832;color:#1a1300;font-size:10px;
      font-weight:800;padding:2px 6px;border-radius:4px;letter-spacing:.5px}
    .cur-price-summary{margin-top:10px;font-size:12px;color:#b6b6bf;display:flex;flex-direction:column;gap:2px}
    .cur-price-summary b{color:#ffc832}
    .cur-price{font-size:12px;color:#ffc832;font-weight:600}
    #cur-window .cur-lens{position:absolute;top:4px;right:4px;z-index:2;width:24px;height:24px;padding:0;border-radius:50%;
      font-size:12px;line-height:1;background:rgba(21,29,41,.9);border:1px solid rgba(255,255,255,.25)}
    #cur-window .cur-lens:hover{border-color:#ffc832;background:rgba(255,200,50,.18)}
    @media (max-width:700px){
      #cur-body{grid-template-columns:1fr;padding:12px}
      #cur-summary{position:static}
      #cur-grid{grid-template-columns:repeat(auto-fill,minmax(152px,1fr));padding:8px}
      .cur-tile{padding:4px 2px}
    }
    #cur-diag table{border-collapse:collapse;margin-top:6px}
    #cur-diag td{padding:3px 6px;border-bottom:1px solid rgba(255,255,255,.08)}
    .cur-ok{color:#2fbf88}.cur-no{color:#ff7a7a}
  `;

  function el(tag, props, children) {
    const e = document.createElement(tag);
    if (props) Object.assign(e, props);
    for (const h of children || []) e.appendChild(typeof h === "string" ? document.createTextNode(h) : h);
    return e;
  }

  // View state
  const view = {
    set: null,
    cards: [],
    chosen: new Set(), // definitionIds of the lineup cards
    eaFilter: "all",
    turn: 0,            // to cancel old renders if a set is read again
    eaViews: [],
    method: null,      // how the lineup was chosen: exact, search, all, manual or plan
    plan: null         // last purchase plan calculated
  };
  let lastResult = null;
  let stopFlag = false;
  let ui = null;

  function mount() {
    if (document.getElementById("cur-launcher")) return;
    document.head.appendChild(el("style", { textContent: styles }));

    const launcher = el("button", { id: "cur-launcher", textContent: "Curator" });
    const selector = el("select");
    const bSets = el("button", { textContent: "Sets…", title: "Import the full list of sets (.json file)" });
    const bRead = el("button", { textContent: "Read set", className: "primary" });
    const bAll = el("button", { textContent: "All sets", title: "Table with your grade and what's missing in each set" });
    const bStop = el("button", { textContent: "Stop", disabled: true });
    const bDiag = el("button", { textContent: "Diagnostics" });
    const bClub = el("button", { textContent: "Check club", title: "Finds the cards in your club that you packed yourself (First Owner)" });
    const bPrices = el("button", { textContent: "Refresh prices", disabled: true,
      title: "Gets fut.gg prices for the cards you're missing (doesn't search the EA market)" });
    const bCopy = el("button", { textContent: "Copy JSON", disabled: true });
    const bCloseWin = el("button", { id: "cur-close", textContent: "Close ✕" });
    const state = el("div", { id: "cur-status", textContent: "Doesn't buy or submit anything unless you use “Buy cart”. Pick a set and press “Read set”." });
    const summary = el("div", { id: "cur-summary" });
    const diag = el("div", { id: "cur-diag" });
    const grid = el("div", { id: "cur-grid" });
    // Left: diagnostics and card grid. Right: 260 px panel with the summary.
    const body = el("div", { id: "cur-body" }, [el("div", { id: "cur-left" }, [diag, grid]), summary]);
    const windowEl = el("div", { id: "cur-window" }, [
      el("div", { id: "cur-header" }, [el("h3", { textContent: "Curator" }), selector, bSets, bRead, bAll, bClub, bPrices, bStop, bDiag, bCopy, bCloseWin]),
      state, body
    ]);
    const overlay = el("div", { id: "cur-overlay" }, [windowEl]);
    document.body.append(launcher, overlay);
    ui = { overlay, selector, bRead, bAll, bClub, bPrices, bStop, bDiag, bCopy, state, summary, diag, grid };
    fillSelector();

    // Import panel
    bSets.onclick = () => {
      diag.textContent = "";
      const fileInput = el("input", { type: "file", accept: ".json,application/json" });
      const remember = el("input", { type: "checkbox" });
      const info = el("div", { className: "cur-note" });
      const paintInfo = () => {
        info.textContent = listInfo
          ? "Current list: " + listInfo.qty + " sets" + (listInfo.date ? " (from " + new Date(listInfo.date).toLocaleDateString("en-US") + ")" : "") +
            (listInfo.rejected ? " · " + listInfo.rejected + " dropped for failing validation" : "") +
            (listInfo.saved ? " · saved in this browser" : " · in memory only (cleared when the tab closes)")
          : "Current list: the one bundled with the extension (" + BASE_SETS.length + " sets" + "). You only need to import when new sets come out.";
      };
      paintInfo();
      fileInput.onchange = () => {
        const f = fileInput.files && fileInput.files[0];
        if (!f) return;
        if (f.size > MAX_LIST_BYTES) { info.textContent = "The file is too large (1 MB max)."; return; }
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const r = validateList(String(reader.result));
            applyList(r, remember.checked);
            fillSelector();
            paintInfo();
            state.textContent = "List imported: " + r.sets.length + " sets." + (r.rejected ? " " + r.rejected + " dropped." : "");
          } catch (e) { info.textContent = "Not imported: " + e.message; }
        };
        reader.onerror = () => { info.textContent = "Couldn't read the file."; };
        reader.readAsText(f);
      };
      const bReset = el("button", { textContent: "Back to the bundled list" });
      bReset.onclick = () => { resetList(); fillSelector(); paintInfo(); };
      const bExport = el("button", { textContent: "Export my list (.json)", title: "To keep it or share it with the community" });
      bExport.onclick = () => { exportList(); state.textContent = "List exported: " + SETS.length + " sets."; };
      diag.append(
        el("b", { textContent: "List of sets" }),
        el("div", { className: "cur-note", textContent: "Choose a .json file with the list of sets (for example, the community one in the repository). It is read as data only (never run), and only the needed fields are copied, each one checked." }),
        fileInput,
        el("label", { className: "cur-note" }, [remember, " Save the (cleaned) list in this browser"]),
        info, el("div", { className: "cur-all-bar" }, [bExport, bReset]),
        setForm(() => { fillSelector(); paintInfo(); })
      );
    };
    const lock = (yes) => { bRead.disabled = yes; bAll.disabled = yes; bClub.disabled = yes; bDiag.disabled = yes; bPrices.disabled = yes || !view.set; bStop.disabled = !yes; };

    // “All sets”: shows the table with what's saved. From there you can check all (one at a time, with pauses).
    bAll.onclick = () => { allSetsView = true; drawAllSets(); };

    // Buys the cart's cards (after accepting the warning). options: { overpay: %, cap: coins }
    ui.buyCart = async (options, paint) => {
      if (!preparePieces().ok || !services().Item || typeof services().Item.bid !== "function") { state.textContent = "Can't find EA's market purchase function."; return; }
      stopFlag = false;
      lock(true);
      ui.buying = true;
      const list = [...cartTable()].map(([id, x]) => ({ id, name: x.name, card: findStoredCard(id) }));
      const results = [];
      const bought = [];
      let spent = 0, halted = null, listed = 0, profit = 0;
      try {
        for (let i = 0; i < list.length; i++) {
          if (stopFlag) break;
          const it = list[i];
          const price = it.card ? cardBuyCost(it.card) : undefined;
          if (price === undefined) { results.push({ id: it.id, name: it.name, state: "no price: not bought" }); paint(results); continue; }
          const limit = Math.max(price, eaPrice(price * (1 + options.overpay / 100)));
          if (spent + limit > options.cap) { results.push({ id: it.id, name: it.name, state: "skipped: it could go over the coin cap" }); paint(results); continue; }
          state.textContent = "Buying " + (i + 1) + " of " + list.length + ": " + (it.name || "#" + it.id) + " (up to 🪙 " + fmt(limit) + ")…";
          if (results.length) await marketPause();
          const r = await buyCard(it.id, limit);
          if (r.ok) {
            spent += r.price;
            bought.push(it.id);
            removeFromCart(it.id);
            const row = { id: it.id, name: it.name, ok: true, state: "bought for 🪙 " + fmt(r.price) };
            results.push(row);
            paint(results);
            if (options.after && options.after.mode !== "keep") {
              row.state += " · …";
              paint(results);
              const d = await afterBuying(r.item, options.after, r.price, price);
              row.state = "bought for 🪙 " + fmt(r.price) + " · " + d.text;
              if (d.sale) { listed++; profit += Math.floor(d.sale * (1 - EA_TAX)) - r.price; }
              if (!d.ok) row.ok = false;
              if (d.halt) { halted = "EA rejected the action (code " + (d.code ?? "?") + ")"; paint(results); break; }
            }
          } else {
            results.push({ id: it.id, name: it.name, state: r.reason });
            if (r.halt) { halted = r.reason; paint(results); break; }
          }
          paint(results);
        }
      } catch (e) {
        halted = "error: " + (e && e.message ? e.message : e);
      } finally {
        ui.buying = false;
        lock(false);
      }
      // Bought cards already count in the Gallery: update saved sets, summaries and the open set
      if (bought.length) {
        const ids = new Set(bought);
        for (const slug of markCollected(ids)) { const set = setBySlug(slug), v = cardStore.get(slug); if (set && v) saveSummary(set, v.cards, true); }
        for (const c of view.cards || []) if (ids.has(c.definitionId)) c.isCollected = true;
      }
      state.textContent = (halted ? "Stopped: " + halted + ". " + (/daily limit/.test(halted) ? "You can continue tomorrow. " : /cap of .* per hour/.test(halted) ? "You can continue in " + minutesToResume() + " min. " : /limit|reject/.test(halted) ? "Take a break (an hour or more) before using the market again. " : "") : stopFlag ? "Stopped. " : "Done. ") +
        bought.length + " bought" + " for 🪙 " + fmt(spent) + "." +
        (listed ? " " + listed + " listed (if they sell at that price: " + (profit >= 0 ? "+" : "") + fmt(profit) + " after tax)." : "") +
        (bought.length && !(options.after && options.after.mode !== "keep") ? " They're in “Unassigned”: if you resell them, they still count in the Gallery." : "");
    };

    // Goes through the sets one by one: reads their cards (EA concept search), gets fut.gg prices
    // and saves the summary. Skips sets checked less than 12 h ago, unless asked to check all again.
    ui.reviewAll = async (again) => {
      if (!preparePieces().ok) { state.textContent = "Some EA pieces are missing: press “Diagnostics”."; return; }
      const t = allSetsTable();
      const pending = SETS.filter((s) => !s.eaFilter.unsupported && (again || !t[s.slug] || t[s.slug].changed || Date.now() - t[s.slug].at > ALL_SETS_MAX_AGE_MS));
      if (!pending.length) { state.textContent = "Every set was checked less than 12 hours ago."; return; }
      stopFlag = false;
      lock(true);
      ui.reviewing = true;
      pauseFactor = 1.6; // pauses of ~1 to 1.8 s between searches
      let doneCount = 0, searches = 0;
      const start = Date.now();
      try {
        for (const set of pending) {
          if (stopFlag) break;
          if (doneCount > 0) await randomPause();
          const left = pending.length - doneCount;
          const eta = doneCount ? Math.ceil(((Date.now() - start) / doneCount) * left / 60000) : null;
          const prefix = "Set " + (doneCount + 1) + " of " + pending.length + ": " + set.name + (eta ? " (~" + eta + " min left)" : "") + " — ";
          state.textContent = prefix + "reading…";
          const r = await readSet(set, (m) => { state.textContent = prefix + m; }, () => stopFlag);
          searches += r.searches;
          if (r.stopped) break;
          if (bridgeAvailable()) {
            state.textContent = prefix + "prices…";
            await loadFutggPrices(r.cards.filter((c) => !c.isCollected).map((c) => c.definitionId), false);
          }
          saveSummary(set, r.cards, true);
          if (!r.truncated) storeSetCards(set.slug, r.cards);
          doneCount++;
          if (allSetsView) drawAllSets();
        }
        state.textContent = (stopFlag ? "Stopped. " : "Done. ") + doneCount + " sets checked in " + searches + " searches." +
          (stopFlag ? " Press “Check all” to pick up where it stopped." : "");
      } catch (e) {
        state.textContent = "Error: " + (e && e.message ? e.message : e);
      } finally {
        pauseFactor = 1;
        ui.reviewing = false;
        lock(false);
        if (allSetsView) drawAllSets();
      }
    };

    bPrices.onclick = async () => {
      if (!view.set) return;
      lock(true);
      try {
        state.textContent = "Getting fut.gg prices…";
        state.textContent = await refreshSetPrices(true);
        drawSummary();
        drawGrid();
      } finally { lock(false); }
    };

    bClub.onclick = async () => {
      stopFlag = false;
      bRead.disabled = true; bClub.disabled = true; bDiag.disabled = true; bStop.disabled = false; bPrices.disabled = true;
      try {
        const r = await reviewClub((t) => { state.textContent = t; }, () => stopFlag);
        await ensureCards();
        const upd = stopFlag ? { updated: [], toReview: [] } : updateFromClub(r.clubCards);
        // The open set also learns about the new cards
        if (view.set && r.clubCards) for (const c of view.cards) if (!c.isCollected && r.clubCards.has(c.definitionId)) c.isCollected = true;
        state.textContent = (stopFlag ? "Stopped. " : "Done. ") + "Checked " + r.cards + " cards in your club in " + r.searches +
          " searches. " + r.firstOwners + " you packed yourself (First Owner)." +
          (upd.updated.length ? " New cards: went up in " + upd.updated.length + " set" + (upd.updated.length === 1 ? "" : "s") + "." : "") +
          (upd.toReview.length ? " There are " + upd.toReview.length + " set" + (upd.toReview.length === 1 ? "" : "s") + " with new cards worth checking (“All sets” → “Check remaining”)." : "") +
          (view.set ? " Press “Best lineup” to recalculate with the bonus." : "");
        if (allSetsView) drawAllSets();
        else if (view.set) { drawSummary(); drawGrid(); }
      } catch (e) {
        state.textContent = "Error: " + (e && e.message ? e.message : e);
      } finally {
        bRead.disabled = false; bClub.disabled = false; bDiag.disabled = false; bStop.disabled = true; bPrices.disabled = !view.set;
      }
    };

    launcher.onclick = () => overlay.classList.add("open");
    bCloseWin.onclick = () => overlay.classList.remove("open");
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.classList.remove("open"); });

    bDiag.onclick = () => {
      diag.textContent = "";
      const table = el("table");
      for (const [text, ok] of diagnosis()) {
        table.appendChild(el("tr", null, [
          el("td", { className: ok ? "cur-ok" : "cur-no", textContent: ok ? "✔" : "✘" }),
          el("td", { textContent: text })
        ]));
      }
      diag.append(el("b", { textContent: "Diagnostics" }), table);
      if (rawExample) diag.appendChild(el("div", { className: "cur-note", textContent: "Fields of a raw card: " + Object.keys(rawExample).join(", ") }));
    };

    bStop.onclick = () => { stopFlag = true; state.textContent = "Stopping…"; };

    bRead.onclick = async () => {
      const set = SETS[Number(selector.value)];
      if (!set) return;
      if (!preparePieces().ok) { state.textContent = "Some EA pieces are missing: press “Diagnostics”."; return; }
      stopFlag = false;
      bRead.disabled = true; bClub.disabled = true; bDiag.disabled = true; bStop.disabled = false; bCopy.disabled = true; bPrices.disabled = true;
      diag.textContent = "";
      try {
        const r = await readSet(set, (t) => { state.textContent = t; }, () => stopFlag);
        view.set = set;
        view.cards = r.cards;
        view.plan = null;
        let priceNotice = "";
        if (bridgeAvailable()) {
          state.textContent = "Getting fut.gg prices…";
          priceNotice = " " + (await refreshSetPrices(false));
        }
        state.textContent = "Working out the best lineup…";
        await wait(30); // lets the notice show before calculating
        const opt = optimizeLineup(set, r.cards);
        view.chosen = new Set(opt.ids);
        view.method = opt.method;
        view.eaFilter = "all";
        lastResult = { set: set.slug, readAt: new Date().toISOString(), searches: r.searches, incomplete: r.truncated || r.stopped, cards: r.cards };
        if (!r.stopped && !r.truncated) { saveSummary(set, r.cards, false); storeSetCards(set.slug, r.cards); } // updates its row in “All sets”
        allSetsView = false;
        const withoutRaw = r.cards.filter((c) => !c.hasRaw).length;
        state.textContent = (r.stopped ? "Stopped. " : "Done. ") + r.cards.length + " cards in " + r.searches + " searches." +
          (r.truncated ? " Reached the page limit: there may be more." : "") +
          (withoutRaw ? " Note: " + withoutRaw + " cards without EA data." : "") + priceNotice;
        drawSummary();
        drawGrid();
        bCopy.disabled = false;
        bPrices.disabled = false;
      } catch (e) {
        state.textContent = "Error: " + (e && e.message ? e.message : e);
      } finally {
        bRead.disabled = false; bClub.disabled = false; bDiag.disabled = false; bStop.disabled = true; bPrices.disabled = !view.set;
      }
    };

    bCopy.onclick = async () => {
      if (!lastResult) return;
      const data = Object.assign({}, lastResult, { lineup: [...view.chosen] });
      try {
        await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
        state.textContent = "JSON copied to the clipboard.";
      } catch (e) {
        console.log("[Curator] result", data);
        state.textContent = "Couldn't copy. It's in the console (F12).";
      }
    };
  }

  function fillSelector() {
    const sel = ui.selector;
    const before = sel.value;
    sel.textContent = "";
    const byCategory = new Map();
    SETS.forEach((s, i) => {
      const c = s.category || "example";
      if (!byCategory.has(c)) byCategory.set(c, []);
      byCategory.get(c).push({ s, i });
    });
    for (const [cat, list] of byCategory) {
      const group = el("optgroup", { label: cat.replace(/-/g, " ") });
      list.sort((a, b) => a.s.name.localeCompare(b.s.name, "en"))
        .forEach(({ s, i }) => group.appendChild(el("option", { value: String(i), textContent: s.name + " (" + s.slots + ")" + (s.eaFilter.unsupported ? " – unavailable" : "") })));
      sel.appendChild(group);
    }
    if (before && SETS[Number(before)]) sel.value = before;
    if (!SETS.length) {
      sel.appendChild(el("option", { value: "", textContent: "— no sets —" }));
      ui.state.textContent = "No sets loaded: press “Sets…” to import the community list or add your own.";
      return;
    }
    // Notice if the imported list is old
    if (listInfo && listInfo.date && Date.now() - Date.parse(listInfo.date) > 7 * 24 * 3600 * 1000) {
      ui.state.textContent = "The list of sets is more than 7 days old: there may be new sets. Re-import it from “Sets…”.";
    }
  }

  // ---------- “All sets” view ----------
  let allSetsView = false;
  let allSetsTab = "overview"; // "overview" | "table" | "budget" | "best" | "cart"
  let cardsReady = false;
  let objectivesRequested = false;
  const tableSort = { col: "perToken", asc: true };
  const tableFilters = { category: "", text: "", hideUnfillable: true, hideFinished: false };
  const budget = { mode: "budget", what: "tokens", qty: 100000, result: null };
  const GRADE_ORDER = { D: 1, C: 2, B: 3, A: 4, S: 5 };

  // Gallery level: score each level requires (community values; EA hasn't officially published them)
  const GALLERY_LEVELS = [[2, 5e3], [3, 25e3], [4, 125e3], [5, 5e5], [6, 75e4], [7, 125e4], [8, 15e5], [9, 225e4], [10, 3e6], [11, 5e6], [12, 7e6], [13, 11e6], [14, 15e6]];
  const LEVEL_REWARDS = [[5, "Squad Foundations Crown"], [10, "Pick 1 of 5 holographic base Heroes"], [15, "Pick 1 of 5 holographic base Icons"],
    [20, "Pick 1 of 5 holographic base Heroes 88+"], [25, "Pick 1 of 5 holographic base Icons 92+"]];
  function levelFor(score) {
    let level = 1, next = null;
    for (const [n, p] of GALLERY_LEVELS) { if (score >= p) level = n; else if (!next) next = { level: n, score: p }; }
    return { level, next };
  }

  // Delivered grade (graded in the game) per set. Three sources, per profile, in this browser:
  //  - "EA": read from the Gallery objectives EA sends to the web app (event sets with D..S objectives).
  //  - "manual": you marked it.
  //  - "assumed": marked by the “assume everything I reach today was delivered” button.
  // EA overrides the other two. The rest of the app uses claimedTable() (each set's final grade).
  const claimedKey = () => "curator_delivered_grade_" + currentProfile();
  const assumedKey = () => "curator_assumed_grade_" + currentProfile();
  const objectivesKey = () => "curator_objectives_" + currentProfile();
  let manualMarks = null, assumedMarks = null, eaObjectives = null, claimedMap = null;
  function readJSON(key) {
    try { const v = JSON.parse(localStorage.getItem(key) || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch (e) { return {}; }
  }
  function loadClaims() {
    if (manualMarks) return;
    manualMarks = readJSON(claimedKey());
    for (const k of Object.keys(manualMarks)) if (!GRADE_ORDER[manualMarks[k]]) delete manualMarks[k];
    assumedMarks = readJSON(assumedKey());
    const o = readJSON(objectivesKey());
    eaObjectives = {
      at: isInt(o.at, 0, 1e14) ? o.at : 0,
      levelMin: isInt(o.levelMin, 1, 100) ? o.levelMin : null,
      levelMax: isInt(o.levelMax, 1, 100) ? o.levelMax : null,
      sets: {}
    };
    if (o.sets && typeof o.sets === "object") for (const k of Object.keys(o.sets)) if (RE_SLUG.test(k) && (o.sets[k] === null || GRADE_ORDER[o.sets[k]])) eaObjectives.sets[k] = o.sets[k];
  }
  function claimedTable() {
    if (claimedMap) return claimedMap;
    loadClaims();
    claimedMap = Object.assign({}, manualMarks);
    for (const [slug, g] of Object.entries(eaObjectives.sets)) { if (g) claimedMap[slug] = g; else delete claimedMap[slug]; }
    return claimedMap;
  }
  function claimSourceOf(slug) {
    loadClaims();
    if (slug in eaObjectives.sets) return "EA";
    if (!manualMarks[slug]) return null;
    return assumedMarks[slug] ? "assumed" : "manual";
  }
  function saveClaims() {
    try {
      localStorage.setItem(claimedKey(), JSON.stringify(manualMarks));
      localStorage.setItem(assumedKey(), JSON.stringify(assumedMarks));
    } catch (e) { /* kept in memory */ }
    claimedMap = null;
  }
  function setClaimed(slug, grade) {
    loadClaims();
    if (grade && GRADE_ORDER[grade]) manualMarks[slug] = grade; else delete manualMarks[slug];
    delete assumedMarks[slug];
    saveClaims();
  }
  // Marks as delivered (assumed) the grade your cards reach today in every checked set without a mark.
  // Returns how many it marked.
  function assumeDelivered() {
    loadClaims();
    const t = allSetsTable();
    let n = 0;
    for (const s of SETS) {
      const r = t[s.slug];
      if (!r || !r.grade || (s.slug in eaObjectives.sets) || manualMarks[s.slug]) continue;
      manualMarks[s.slug] = r.grade; assumedMarks[s.slug] = true; n++;
    }
    saveClaims();
    return n;
  }
  function clearAssumed() {
    loadClaims();
    let n = 0;
    for (const k of Object.keys(assumedMarks)) { delete manualMarks[k]; delete assumedMarks[k]; n++; }
    saveClaims();
    return n;
  }

  // Reads the Gallery objectives (the same request the web app makes when you open “Objectives”).
  // They give: your Gallery level (“Reach Gallery Level N” objectives) and the grade of event sets
  // that have “Achieve X Rank in the ... Gallery Set” objectives. At most once every 30 minutes.
  const OBJECTIVES_MAX_AGE_MS = 30 * 60 * 1000;
  const normName = (x) => String(x || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  async function readGalleryObjectives(force) {
    loadClaims();
    if (!force && eaObjectives.at && Date.now() - eaObjectives.at < OBJECTIVES_MAX_AGE_MS) return { ok: true, cache: true };
    const s = services();
    if (!s || !s.Objectives || typeof s.Objectives.requestCategories !== "function") return { ok: false, reason: "The web app has no objectives available." };
    const r = await observeResponse(s.Objectives.requestCategories());
    const cats = r && r.success && r.response && Array.isArray(r.response.categories) ? r.response.categories : null;
    if (!cats) return { ok: false, reason: "EA didn't return the objectives." };
    const achieved = (o) => num(o._state) >= 2 || (num(o._progress) > 0 && num(o._progress) >= Math.max(1, num(o.multiplier)));
    let levelMin = 1, levelMax = null;
    const bySet = new Map(); // normalized name -> { best: grade|null }
    for (const cat of cats) {
      const col = cat && cat.groups && cat.groups._collection;
      if (!col) continue;
      for (const g of Object.values(col)) {
        const objs = g && g.objectives && g.objectives._collection ? Object.values(g.objectives._collection) : [];
        for (const o of objs) {
          const d = String(o && o.description || "");
          let m = d.match(/^Reach Gallery Level (\d+)\.?$/i);
          if (m) {
            const n = Number(m[1]);
            if (achieved(o)) levelMin = Math.max(levelMin, n);
            else levelMax = levelMax == null ? n - 1 : Math.min(levelMax, n - 1);
            continue;
          }
          m = d.match(/^Achieve ([DCBAS]) Rank in the (.+?) Gallery Set\.?$/i);
          if (m) {
            const key = normName(m[2]);
            const x = bySet.get(key) || { best: null };
            const gr = m[1].toUpperCase();
            if (achieved(o) && (!x.best || GRADE_ORDER[gr] > GRADE_ORDER[x.best])) x.best = gr;
            bySet.set(key, x);
          }
        }
      }
    }
    const sets = {};
    for (const [key, x] of bySet) {
      const set = SETS.find((st) => normName(st.name) === key);
      if (set) sets[set.slug] = x.best; // null = the set has objectives but you haven't delivered any grade yet
    }
    eaObjectives = { at: Date.now(), levelMin, levelMax: levelMax != null && levelMax >= levelMin ? levelMax : null, sets };
    try { localStorage.setItem(objectivesKey(), JSON.stringify(eaObjectives)); } catch (e) { /* in memory */ }
    claimedMap = null;
    return { ok: true, sets: Object.keys(sets).length };
  }
  function observeResponse(obs) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (x) => { if (!settled) { settled = true; resolve(x); } };
      if (!obs || typeof obs.observe !== "function") return done(null);
      const ctx = {};
      try { obs.observe(ctx, (o, r) => { try { o.unobserve(ctx); } catch (e) { /* ignore */ } done(r); }); } catch (e) { done(null); }
      setTimeout(() => done(null), TIMEOUT_MS);
    });
  }
  const tokensUpTo = (set, grade) => sortedGrades(set).filter((g) => grade && GRADE_ORDER[g.grade] <= GRADE_ORDER[grade]).reduce((s, g) => s + num(g.tokens), 0);

  // Opens a set (reads it) and, if asked, calculates the plan for that grade
  async function openSet(set, grade) {
    if (ui.reviewing) return;
    const i = SETS.indexOf(set);
    if (i < 0) return;
    ui.selector.value = String(i);
    await ui.bRead.onclick();
    if (grade) {
      const b = ui.summary.querySelector(".cur-plan-grade." + grade);
      if (b) await b.onclick();
    }
  }

  const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 60 ? Math.max(1, m) + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " d ago"; };
  // null = that grade can't be reached with the cards that have a price
  const coins = (v, r) => v == null ? (r && r.noPrice ? "out of reach (" + r.noPrice + " without price)" : "out of reach") : v === 0 ? "already reached" : "🪙 " + fmt(v);
  const costLabel = () => settings.resale ? "what you lose when reselling" : "purchase price";

  function drawAllSets() {
    const { diag, grid, summary } = ui;
    for (const v of view.eaViews) { try { v.dealloc && v.dealloc(); } catch (e) { /* ignore */ } }
    view.eaViews = [];
    grid.textContent = "";
    summary.classList.remove("visible");
    document.getElementById("cur-body").classList.add("all-sets");
    diag.textContent = "";
    const t = allSetsTable();
    const readable = SETS.filter((s) => !s.eaFilter.unsupported);
    const reviewed = readable.filter((s) => t[s.slug]).length;

    // Top bar: tabs and checking
    const bReview = el("button", { className: "primary", textContent: reviewed ? "Check remaining" : "Check all",
      title: "Reads sets not checked yet or checked more than 12 h ago" });
    const bAgain = el("button", { textContent: "Check all again" });
    bReview.onclick = () => ui.reviewAll(false);
    bAgain.onclick = () => ui.reviewAll(true);
    bReview.disabled = bAgain.disabled = !!ui.reviewing;
    if (!cardsReady) { ensureCards().then(() => { cardsReady = true; if (allSetsView) drawAllSets(); }); }
    if (!objectivesRequested) {
      objectivesRequested = true;
      readGalleryObjectives(false).then((r) => { if (r.ok && !r.cache && allSetsView) drawAllSets(); }).catch(() => {});
    }
    const nCart = cartTable().size;
    const tabs = [["overview", "Overview"], ["table", "Table"], ["budget", "Budget and goal"], ["best", "Best buys"], ["cart", "Cart" + (nCart ? " (" + nCart + ")" : "")]].map(([k, txt]) => {
      const b = el("button", { textContent: txt, className: allSetsTab === k ? "active" : "" });
      b.onclick = () => { allSetsTab = k; drawAllSets(); };
      return b;
    });
    const pending = readable.length - reviewed;
    const minutes = Math.max(1, Math.round(pending * 2.5 * 1.6 / 60));
    diag.appendChild(el("div", { className: "cur-all-bar" }, [
      el("b", { textContent: "All sets" }), ...tabs,
      el("span", { className: "cur-note", textContent: reviewed + " of " + readable.length + " checked" +
        (pending ? " · checking the rest takes ~" + minutes + " min (2-3 EA player searches per set, with pauses; doesn't use the market)" : "") }),
      bReview, bAgain
    ]));
    if (allSetsTab === "overview") drawOverviewPanel(diag, t, readable, reviewed);
    else if (allSetsTab === "budget") drawBudgetPanel(diag, t, reviewed);
    else if (allSetsTab === "best") drawBestBuysPanel(diag);
    else if (allSetsTab === "cart") drawCartPanel(diag);
    else drawTablePanel(diag, t, readable);
  }

  // A short clickable list for the overview
  function listBlock(titleEl, note, rows, empty) {
    const box = el("div", { className: "cur-block" }, [el("div", { className: "cur-tags-title", textContent: titleEl })]);
    if (note) box.appendChild(el("div", { className: "cur-note", textContent: note }));
    if (!rows.length) box.appendChild(el("div", { className: "cur-note", textContent: empty }));
    for (const f of rows) {
      const row = el("div", { className: "cur-list-row", title: "Open " + f.set.name }, [
        el("span", null, [el("b", { textContent: f.set.name }), f.chip ? el("span", { className: "cur-chip", textContent: f.chip }) : el("span")]),
        el("span", { className: "cur-note", textContent: f.detail })
      ]);
      row.onclick = () => openSet(f.set, f.grade);
      box.appendChild(row);
    }
    return box;
  }

  function drawOverviewPanel(diag, t, readable, reviewed) {
    const withData = readable.filter((s) => t[s.slug]);
    const score = withData.reduce((s, x) => s + num(t[x.slug].score), 0);
    const tokens = withData.reduce((s, x) => s + num(t[x.slug].tokens), 0);
    const tokensTotal = readable.reduce((s, x) => s + sortedGrades(x).reduce((a, g) => a + num(g.tokens), 0), 0);
    const lv = levelFor(score);
    const partial = reviewed < readable.length ? " (estimated from " + reviewed + " of " + readable.length + " checked sets)" : "";

    const help = el("details", { className: "cur-help" }, [el("summary", { textContent: "How the Gallery works" }),
      el("ol", null, [
        "Every card you've ever owned counts for its sets (its club, its league and its rarity), even if you sold it later.",
        "Each set gets a grade from D to S based on its best cards (each card's points + tag bonuses). Higher grades pay Gallery tokens.",
        "Tokens are spent on players in the Gallery store. The sum of your set scores raises your Gallery level, which has its own rewards.",
        "The cheapest way up: buy a card, let it count and resell it. You only lose EA's 5% tax. “Best buys” and the cart help you choose which ones."
      ].map((x) => el("li", { textContent: x })))]);
    diag.appendChild(help);
    const tiles = el("div", { className: "cur-cards" }, [
      el("div", { className: "cur-card" }, [el("div", { className: "cur-note", textContent: "Gallery score" }), el("b", { textContent: fmt(score) }),
        el("div", { className: "cur-note", textContent: "Sum of your cards' best score in each set" + partial })]),
      (() => {
        loadClaims();
        const ea = eaObjectives.levelMin != null && eaObjectives.at ? eaObjectives : null;
        const eaText = ea ? (ea.levelMax && ea.levelMax > ea.levelMin ? "According to EA: between level " + ea.levelMin + " and " + ea.levelMax : "According to EA: level " + ea.levelMin + " or higher") : null;
        const outOfRange = ea && (lv.level < ea.levelMin || (ea.levelMax && lv.level > ea.levelMax));
        return el("div", { className: "cur-card" }, [el("div", { className: "cur-note", textContent: "Gallery level" }), el("b", { textContent: "Level " + lv.level + " (estimated)" }),
          el("div", { className: "cur-note", textContent: lv.next ? fmt(lv.next.score - score) + " to go for level " + lv.next.level : "Highest known level" }),
          ...(eaText ? [el("div", { className: outOfRange ? "cur-no" : "cur-ok", textContent: eaText + (outOfRange ? " (the estimate doesn't match: you may not have graded all your sets, or some sets haven't been checked)" : "") })] : [])]);
      })(),
      el("div", { className: "cur-card" }, [el("div", { className: "cur-note", textContent: "Tokens your cards reach" }), el("b", { textContent: tokens + " of " + tokensTotal }),
        el("div", { className: "cur-note", textContent: "You have to claim them in the game (see “Ready to grade”)" })])
    ]);
    diag.appendChild(tiles);

    // Level rewards
    const rewards = el("div", { className: "cur-block" }, [el("div", { className: "cur-tags-title", textContent: "Gallery level rewards" }),
      el("div", { className: "cur-note", textContent: "The score for each level comes from the community; EA hasn't published them." })]);
    for (const [n, txt] of LEVEL_REWARDS) {
      const req = (GALLERY_LEVELS.find((x) => x[0] === n) || [])[1];
      rewards.appendChild(el("div", { className: "cur-plan-item" }, [el("span", { textContent: "Level " + n + ": " + txt }),
        el("span", { className: lv.level >= n ? "cur-ok" : "cur-note", textContent: lv.level >= n ? "reached" : req ? fmt(req) + " pts" : "unknown score" })]));
    }

    // Ready to grade
    const claims = claimedTable();
    const readyList = withData.filter((s) => t[s.slug].grade && GRADE_ORDER[t[s.slug].grade] > (GRADE_ORDER[claims[s.slug]] || 0))
      .map((s) => ({ set: s, tokens: tokensUpTo(s, t[s.slug].grade) - tokensUpTo(s, claims[s.slug]), r: t[s.slug] }))
      .sort((a, b) => b.tokens - a.tokens);
    const bReady = listBlock("Ready to grade in the game",
      "Your cards already reach a better grade than the one you marked as claimed. Grade it in the in-game Gallery and mark the grade in the set.",
      readyList.slice(0, 12).map((x) => {
        const reward = (sortedGrades(x.set).find((g) => g.grade === x.r.grade) || {}).reward;
        return { set: x.set, detail: x.r.grade + " ready" + (claims[x.set.slug] ? " (delivered " + claims[x.set.slug] + ", " + claimSourceOf(x.set.slug) + ")" : "") +
          (x.tokens > 0 ? " · +" + x.tokens + " tokens" : reward ? " · " + reward : "") };
      }),
      reviewed ? "Nothing pending." : "Check the sets to see which ones you can grade.");
    if (readyList.length > 12) bReady.appendChild(el("div", { className: "cur-note", textContent: "Y " + (readyList.length - 12) + " more." }));

    // S possible now
    const now = Date.now();
    const sPossibleList = withData.filter((s) => t[s.slug].sPossible).sort((a, b) => (t[a.slug].costMax ?? 1e18) - (t[b.slug].costMax ?? 1e18));
    const newSets = sPossibleList.filter((s) => t[s.slug].sSince && now - t[s.slug].sSince < 7 * 864e5);
    const bS = listBlock("S possible now", "Sets where S can be reached with the cards for sale (and you don't have it yet).",
      sPossibleList.slice(0, 12).map((s) => ({ set: s, grade: t[s.slug].maxGrade, chip: newSets.includes(s) ? "new" : "",
        detail: coins(t[s.slug].costMax, t[s.slug]) + " (" + costLabel() + ")" })), "No set has S within reach right now.");

    // Closest to complete
    const close = withData.filter((s) => t[s.slug].missingSlots > 0 && t[s.slug].total >= t[s.slug].slots)
      .sort((a, b) => t[a.slug].missingSlots - t[b.slug].missingSlots);
    const bNear = listBlock("Closest to complete", "Sets needing the fewest cards to fill every slot.",
      close.slice(0, 10).map((s) => ({ set: s, detail: t[s.slug].missingSlots === 1 ? "1 card missing" : "missing " + t[s.slug].missingSlots + " cards" })),
      reviewed ? "No incomplete sets." : "Check the sets to see which ones are nearly full.");

    // Cheapest next tokens
    const cheapList = withData.map((s) => {
      const p = (t[s.slug].steps || []).filter((x) => x.ok && x.tokens > 0).sort((a, b) => a.cost - b.cost)[0];
      return p ? { set: s, p } : null;
    }).filter(Boolean).sort((a, b) => a.p.cost / a.p.tokens - b.p.cost / b.p.tokens);
    const bCheap = listBlock("Cheapest next tokens", "The cheapest grade with tokens in each set, sorted by coins per token (" + costLabel() + ").",
      cheapList.slice(0, 12).map((x) => ({ set: x.set, grade: x.p.g, detail: "Grade " + x.p.g + ", +" + x.p.tokens + " tokens, buying " + x.p.cards + " · " + coins(x.p.cost) })),
      "Nothing has a price yet: check the sets.");

    diag.appendChild(el("div", { className: "cur-blocks" }, [bReady, bS, bCheap, bNear, rewards]));
  }

  function drawBudgetPanel(diag, t, reviewed) {
    const box = el("div", { className: "cur-block" });
    const selMode = el("select", null, [
      el("option", { value: "budget", textContent: "I have these coins" }),
      el("option", { value: "goal", textContent: "I want to reach" })]);
    selMode.value = budget.mode;
    const selWhat = el("select", null, [el("option", { value: "tokens", textContent: "tokens" }), el("option", { value: "points", textContent: "Gallery points" })]);
    selWhat.value = budget.what;
    const amountInput = el("input", { type: "number", min: "0", step: "1000", value: String(budget.qty), className: "cur-input" });
    const bCalc = el("button", { className: "primary", textContent: "Calculate" });
    const text = () => budget.mode === "budget" ? ["With", "coins, get as many"] : ["Reach", "", "spending as little as possible"];
    const line = el("div", { className: "cur-all-bar" });
    const paintLine = () => {
      line.textContent = "";
      if (budget.mode === "budget") line.append(selMode, amountInput, el("span", { textContent: "coins → maximize" }), selWhat, bCalc);
      else line.append(selMode, amountInput, selWhat, el("span", { textContent: "spending as little as possible" }), bCalc);
    };
    selMode.onchange = () => { budget.mode = selMode.value; budget.result = null; drawAllSets(); };
    selWhat.onchange = () => { budget.what = selWhat.value; };
    bCalc.onclick = () => {
      const v = Math.floor(Number(amountInput.value));
      if (!Number.isFinite(v) || v <= 0 || v > 1e10) { ui.state.textContent = "Enter a valid number."; return; }
      budget.qty = v; budget.what = selWhat.value;
      const groups = groupsFromAll(budget.what);
      budget.result = budget.mode === "budget" ? maximizeWithBudget(groups, v) : minimizeForGoal(groups, v);
      budget.result.mode = budget.mode; budget.result.what = budget.what; budget.result.qty = v;
      drawAllSets();
    };
    paintLine();
    box.append(el("div", { className: "cur-tags-title", textContent: "Budget and goal" }), line,
      el("div", { className: "cur-note", textContent: "Chooses, across all checked sets, which grades are worth raising (at most one per set). Cost = " + costLabel() +
        " (change it in any set's planner; it applies from the next check). " +
        "Each set is calculated separately: if one card works for two sets, the real cost may be lower." }));
    diag.appendChild(box);
    if (!reviewed) { diag.appendChild(el("div", { className: "cur-note", textContent: "Check the sets first (“Check all” button)." })); return; }

    const r = budget.result;
    if (!r) return;
    const unit = r.what === "tokens" ? "tokens" : "points";
    const thead = r.mode === "budget"
      ? "With 🪙 " + fmt(r.qty) + ": +" + fmt(r.value) + " " + unit + " for 🪙 " + fmt(r.cost)
      : (r.reached ? "For +" + fmt(r.qty) + " " + unit + ": 🪙 " + fmt(r.cost) + " (reaches +" + fmt(r.value) + ")"
        : "Out of reach with the cards that have a price: at most +" + fmt(r.value) + " " + unit + " for 🪙 " + fmt(r.cost));
    const buyTotal = r.chosen.reduce((s, x) => s + num(x.option.buyCost), 0);
    const res = el("div", { className: "cur-block" }, [el("div", { className: "cur-tags-title", textContent: thead }),
      el("div", { className: "cur-note", textContent: r.chosen.length + " sets · buy cards for 🪙 " + fmt(buyTotal) +
        (settings.resale ? " (if you resell them, you lose about 🪙 " + fmt(r.cost) + ")" : "") + ". Click a set to see which cards to buy." })]);
    if (!r.chosen.length) res.appendChild(el("div", { className: "cur-note", textContent: "Nothing fits that budget." }));
    const rows = r.chosen.slice().sort((a, b) => b.option.value - a.option.value).map((x) => {
      const tr = el("tr", { title: "Open " + x.group.set.name + " with the plan for " + x.option.g }, [
        el("td", null, [el("b", { textContent: x.group.set.name })]),
        el("td", null, [el("span", { className: "cur-grade-chip " + x.option.g, textContent: x.option.g })]),
        el("td", { textContent: String(x.option.cards) }),
        el("td", { className: "cur-num", textContent: "🪙 " + fmt(num(x.option.buyCost)) }),
        el("td", { className: "cur-num", textContent: "🪙 " + fmt(x.option.cost) }),
        el("td", { textContent: "+" + x.option.tokens }),
        el("td", { textContent: "+" + fmt(x.option.points) })
      ]);
      tr.onclick = () => openSet(x.group.set, x.option.g);
      return tr;
    });
    if (rows.length) {
      res.appendChild(el("div", { className: "cur-table-wrap" }, [el("table", { className: "cur-all" }, [
        el("thead", null, [el("tr", null, ["Set", "Grade", "Cards to buy", "🪙 buy", "🪙 " + (settings.resale ? "you lose" : "cost"), "Tokens", "Points"].map((x) => el("th", { textContent: x })))]),
        el("tbody", null, rows)])]));
    }
    diag.appendChild(res);
  }

  const setNames = (slugs, max) => {
    const n = slugs.map((x) => (setBySlug(x) || { name: x }).name);
    return n.slice(0, max).join(", ") + (n.length > max ? " y " + (n.length - max) + " more" : "");
  };

  function drawBestBuysPanel(diag) {
    const box = el("div", { className: "cur-block" }, [el("div", { className: "cur-tags-title", textContent: "Best buys: most Gallery points per coin" }),
      el("div", { className: "cur-note", textContent: "Each card adds to every set it counts for (its club, its league, its rarity). The points are a quick estimate " +
        "(no tag bonuses); the cart calculates the exact effect. Cost = " + costLabel() + ". Only uses sets already checked with this version." })]);
    diag.appendChild(box);
    if (!cardStore.size) { box.appendChild(el("div", { className: "cur-note", textContent: cardsReady ? "No saved sets yet: check the sets (or “Check all again” if you checked them with an older version)." : "Loading…" })); return; }
    const list = bestBuys(60);
    const budgetInput = el("input", { type: "number", min: "0", step: "1000", value: "20000", className: "cur-input" });
    const bPick = el("button", { className: "primary", textContent: "Pick the best for this budget" });
    bPick.onclick = () => {
      let rest = Math.floor(Number(budgetInput.value)) || 0, n = 0;
      for (const x of bestBuys(500)) {
        if (cartTable().has(x.card.definitionId)) continue;
        if (x.cost <= rest) { addToCart([x.card]); rest -= x.cost; n++; }
      }
      ui.state.textContent = n ? "Added " + n + " cards to the cart." : "Nothing fits that budget.";
      drawAllSets();
    };
    box.appendChild(el("div", { className: "cur-all-bar" }, [el("span", { textContent: "Budget (" + costLabel() + "):" }), budgetInput, bPick]));
    if (!list.length) { box.appendChild(el("div", { className: "cur-note", textContent: "No priced cards add points." })); return; }
    const rows = list.map((x) => {
      const inCart = cartTable().has(x.card.definitionId);
      const b = el("button", { textContent: inCart ? "In the cart" : "Add", disabled: inCart });
      b.onclick = (e) => { e.stopPropagation(); addToCart([x.card]); drawAllSets(); };
      return el("tr", null, [
        el("td", null, [el("b", { textContent: x.card.name || "#" + x.card.definitionId }), el("div", { className: "cur-note", textContent: x.card.rating + " · counts for: " + setNames(countsFor(x.card.definitionId), 3) })]),
        el("td", { textContent: "≈ +" + fmt(x.points) }),
        el("td", { className: "cur-num", textContent: "🪙 " + fmt(x.buyCost) }),
        el("td", { className: "cur-num", textContent: "🪙 " + fmt(x.cost) }),
        el("td", { textContent: fmt(Math.round(x.perCoin * 1000)) }),
        el("td", null, [b])
      ]);
    });
    box.appendChild(el("div", { className: "cur-table-wrap" }, [el("table", { className: "cur-all" }, [
      el("thead", null, [el("tr", null, ["Card", "Points", "🪙 buy", "🪙 " + (settings.resale ? "you lose" : "cost"), "Points per 1,000 🪙", ""].map((x) => el("th", { textContent: x })))]),
      el("tbody", null, rows)])]));
  }

  function drawCartPanel(diag) {
    const box = el("div", { className: "cur-block" }, [el("div", { className: "cur-tags-title", textContent: "Cart" })]);
    diag.appendChild(box);
    const ids = [...cartTable().keys()];
    if (!ids.length) {
      box.appendChild(el("div", { className: "cur-note", textContent: "The cart is empty. Add cards from “Best buys” or from a set's plan (“Add to cart”)." }));
      return;
    }
    const summaryEl = el("div", { className: "cur-note", textContent: "Calculating the effect on your sets…" });
    box.appendChild(summaryEl);
    const effectTable = el("div");
    const bEmpty = el("button", { textContent: "Empty cart" });
    bEmpty.onclick = () => { for (const id of ids) removeFromCart(id); drawAllSets(); };
    const noPriceIds = ids.filter((id) => { const c = findStoredCard(id); return !c || cardBuyCost(c) === undefined; });
    const bPricesFutgg = el("button", { textContent: "Refresh prices", title: "Gets fresh fut.gg prices for the cards in the cart (doesn't use the EA market)" });
    bPricesFutgg.onclick = async () => {
      bPricesFutgg.disabled = true;
      ui.state.textContent = "Getting fut.gg prices…";
      const r = await loadFutggPrices(ids, true);
      ui.state.textContent = r.ok ? "fut.gg prices updated." : "No fut.gg prices: " + r.reason;
      drawAllSets();
    };
    const bSearchMissing = el("button", { textContent: "🔍 Search the market for the " + noPriceIds.length + " without price",
      title: "Searches the EA market for the ones fut.gg doesn't have (max 2 searches per card, with an hourly cap)" });
    bSearchMissing.disabled = !noPriceIds.length || !!ui.reviewing || !!ui.buying;
    bSearchMissing.onclick = async () => {
      bSearchMissing.disabled = true;
      for (let i = 0; i < noPriceIds.length; i++) {
        const id = noPriceIds[i];
        if (i > 0) await marketPause();
        ui.state.textContent = "Searching the market " + (i + 1) + " of " + noPriceIds.length + ": " + (cartTable().get(id) || {}).name + "…";
        const r = await lookUpPrice(id);
        if (r.halt) { ui.state.textContent = "EA asked to slow down: stopped. Wait a while."; break; }
        if (r.cap) { ui.state.textContent = "You hit the cap of " + HOURLY_SEARCH_CAP + " searches per hour. You can continue in " + minutesToResume() + " min."; break; }
        if (i === noPriceIds.length - 1) ui.state.textContent = "Done: searched " + noPriceIds.length + " on the market (" + searchesLeft() + " searches left this hour).";
      }
      drawAllSets();
    };
    const bBuy = el("button", { className: "cur-danger", textContent: "Buy cart…", title: "Buys on the EA market, at your own risk" });
    bBuy.onclick = () => openBuyDialog();
    bBuy.disabled = !!ui.reviewing || !!ui.buying;
    box.appendChild(el("div", { className: "cur-all-bar" }, [bBuy, bPricesFutgg, bSearchMissing, bEmpty]));
    box.appendChild(effectTable);
    // Card list
    const rows = ids.map((id) => {
      const c = findStoredCard(id) || { definitionId: id, isCollected: false, name: cartTable().get(id).name };
      const p = cardBuyCost(c), k = cardCost(c);
      const bRemove = el("button", { textContent: "Remove" });
      bRemove.onclick = () => { removeFromCart(id); drawAllSets(); };
      const bLens = el("button", { textContent: "🔍", title: "Look up this card's price on the EA market (max 2 searches, with an hourly cap)" });
      bLens.disabled = !!ui.reviewing || !!ui.buying;
      bLens.onclick = async () => {
        bLens.disabled = true;
        ui.state.textContent = "Searching the market: " + (c.name || "#" + id) + "…";
        const r = await lookUpPrice(id);
        ui.state.textContent = r.halt ? "EA asked to slow down. Wait a while."
          : r.cap ? "You hit the cap of " + HOURLY_SEARCH_CAP + " searches per hour. You can continue in " + minutesToResume() + " min."
          : (c.name || "#" + id) + " on the EA market: " + (r.price != null ? "🪙 " + fmt(r.price) : "none for sale") + " (" + searchesLeft() + " searches left this hour).";
        drawAllSets();
      };
      return el("tr", null, [
        el("td", null, [el("b", { textContent: c.name || "#" + id }), el("div", { className: "cur-note", textContent: "counts for: " + (countsFor(id).length ? setNames(countsFor(id), 4) : "no checked set") })]),
        el("td", { className: "cur-num", textContent: p === undefined ? "no price" : "🪙 " + fmt(p) }),
        el("td", { className: "cur-num", textContent: k === undefined ? "—" : "🪙 " + fmt(k) }),
        el("td", { className: "cur-actions" }, [bLens, bRemove])
      ]);
    });
    box.appendChild(el("div", { className: "cur-table-wrap" }, [el("table", { className: "cur-all" }, [
      el("thead", null, [el("tr", null, ["Card", "🪙 buy", "🪙 " + (settings.resale ? "you lose" : "cost"), ""].map((x) => el("th", { textContent: x })))]),
      el("tbody", null, rows)])]));
    // Exact effect (may take a moment)
    setTimeout(() => {
      if (!summaryEl.isConnected) return;
      const eff = cartEffect();
      summaryEl.className = "";
      summaryEl.textContent = "";
      summaryEl.append(
        el("div", null, [el("b", { textContent: ids.length + " cards · 🪙 " + fmt(eff.buyCost) }), " in purchases" +
          (settings.resale ? " · if you resell them you lose about 🪙 " + fmt(eff.cost) : "") +
          " · +" + fmt(eff.points) + " Gallery points · +" + eff.tokens + " tokens"]),
        el("div", { className: "cur-note", textContent: (eff.noPrice ? eff.noPrice + " without price (not included in the total). " : "") + "Calculated with your cards and the cart's, including tag bonuses." }));
      if (eff.rows.length) {
        effectTable.appendChild(el("div", { className: "cur-table-wrap" }, [el("table", { className: "cur-all" }, [
          el("thead", null, [el("tr", null, ["Set", "Grade", "Points", "Tokens"].map((x) => el("th", { textContent: x })))]),
          el("tbody", null, eff.rows.map((f) => {
            const tr = el("tr", { title: "Open " + f.set.name }, [
              el("td", null, [el("b", { textContent: f.set.name })]),
              el("td", { textContent: (f.before.grade || (f.before.missingSlots ? "incomplete" : "–")) + " → " + (f.after.grade || (f.after.missingSlots ? "incomplete (missing " + f.after.missingSlots + ")" : "–")) }),
              el("td", { textContent: (f.points >= 0 ? "+" : "") + fmt(f.points) }),
              el("td", { textContent: f.tokens ? "+" + f.tokens : "—" })]);
            tr.onclick = () => openSet(f.set);
            return tr;
          }))])]));
      }
    }, 30);
  }

  // Remembered buy options (in this browser)
  const KEY_BUY_OPTIONS = "curator_buy_options";
  const DURATIONS = [[3600, "1 hour"], [10800, "3 hours"], [21600, "6 hours"], [43200, "12 hours"], [86400, "1 day"], [259200, "3 days"]];
  function buyOptions() {
    const o = { pct: 10, mode: "keep", base: "paid", adjust: 0, duration: 3600 };
    try {
      const g = JSON.parse(localStorage.getItem(KEY_BUY_OPTIONS) || "{}");
      if (isInt(g.pct, 0, 100)) o.pct = g.pct;
      if (["keep", "club", "transfers", "sale"].includes(g.mode)) o.mode = g.mode;
      if (["paid", "market"].includes(g.base)) o.base = g.base;
      if (Number.isInteger(g.adjust) && g.adjust >= -10 && g.adjust <= 10) o.adjust = g.adjust;
      if (DURATIONS.some((d) => d[0] === g.duration)) o.duration = g.duration;
    } catch (e) { /* defaults */ }
    return o;
  }

  // Warning dialog and options before buying
  function openBuyDialog() {
    const windowEl = document.getElementById("cur-window");
    const old = document.getElementById("cur-modal");
    if (old) old.remove();
    const ids = [...cartTable().keys()];
    const prices = [];
    for (const id of ids) { const c = findStoredCard(id); const p = c ? cardBuyCost(c) : undefined; if (p !== undefined) prices.push(p); }
    const total = prices.reduce((a, b) => a + b, 0);
    const opts = buyOptions();

    // Max % over market price, with buttons like in the web app
    const pct = el("input", { type: "number", min: "0", max: "100", step: "1", value: String(opts.pct), className: "cur-input cur-pct" });
    const step = (d) => { const b = el("button", { textContent: (d > 0 ? "+" : d < 0 ? "−" : "") + (Math.abs(d) === 1 ? "" : Math.abs(d)), className: "cur-step" });
      if (Math.abs(d) === 1) b.textContent = d > 0 ? "+" : "−";
      b.onclick = () => { pct.value = String(Math.max(0, Math.min(100, (Math.round(Number(pct.value)) || 0) + d))); recompute(); }; return b; };
    const cap = el("input", { type: "number", min: "0", step: "1000", className: "cur-input" });
    const selAfter = el("select", null, [["keep", "Leave in “Unassigned”"], ["club", "Send to club"], ["transfers", "Send to transfer list"], ["sale", "List for sale"]].map(([v, t]) => el("option", { value: v, textContent: t })));
    selAfter.value = opts.mode;
    const selBase = el("select", null, [["paid", "What I paid"], ["market", "Market price (fut.gg)"]].map(([v, t]) => el("option", { value: v, textContent: t })));
    selBase.value = opts.base;
    const selAdjust = el("select", null, [-10, -5, -3, -2, -1, 0, 1, 2, 3, 5, 10].map((v) => el("option", { value: String(v), textContent: (v > 0 ? "+" : "") + v + "%" })));
    selAdjust.value = String(opts.adjust);
    const selDuration = el("select", null, DURATIONS.map(([v, t]) => el("option", { value: String(v), textContent: t })));
    selDuration.value = String(opts.duration);
    const sellRow = el("div", { className: "cur-sale" }, [
      el("div", { className: "cur-option-row" }, [el("span", { textContent: "Price based on" }), selBase]),
      el("div", { className: "cur-option-row" }, [el("span", { textContent: "Adjustment" }), selAdjust]),
      el("div", { className: "cur-option-row" }, [el("span", { textContent: "Duration" }), selDuration]),
      el("div", { className: "cur-note", textContent: "They're listed right away and still count as collected." })]);
    const estimate = el("b"), maximum = el("b", { className: "cur-ok" }), profit = el("b");
    const profitRow = el("div", { className: "cur-option-row" }, [el("span", { textContent: "Estimated profit after tax" }), profit]);
    function recompute() {
      const p = Math.max(0, Math.min(100, Math.round(Number(pct.value)) || 0));
      const maxTotal = prices.reduce((a, x) => a + Math.max(x, eaPrice(x * (1 + p / 100))), 0);
      estimate.textContent = "🪙 " + fmt(total);
      maximum.textContent = "🪙 " + fmt(maxTotal);
      if (!cap.dataset.touched) cap.value = String(maxTotal);
      const sale = selAfter.value === "sale";
      sellRow.style.display = sale ? "" : "none";
      profitRow.style.display = sale ? "" : "none";
      if (sale) {
        // Estimate: buying at market price and selling based on the chosen base
        const adj = Number(selAdjust.value);
        const g = prices.reduce((a, x) => { const listPrice = sellPrice(x, adj, null); return a + (listPrice ? Math.floor(listPrice.buy * (1 - EA_TAX)) - x : -x); }, 0);
        profit.textContent = (g >= 0 ? "+" : "") + fmt(g);
        profit.className = g >= 0 ? "cur-ok" : "cur-no";
      }
    }
    cap.oninput = () => { cap.dataset.touched = "1"; };
    pct.oninput = selAfter.onchange = selBase.onchange = selAdjust.onchange = recompute;
    const accepted = el("input", { type: "checkbox" });
    const bStart = el("button", { className: "cur-danger", textContent: "Start", disabled: true });
    const bCancel = el("button", { textContent: "Cancel" });
    const progressEl = el("div", { className: "cur-buy-progress" });
    accepted.onchange = () => { bStart.disabled = !accepted.checked; };
    const modal = el("div", { id: "cur-modal" }, [el("div", { className: "cur-modal-box" }, [
      el("div", { className: "cur-tags-title", textContent: "Buy " + ids.length + " cards on the market" }),
      el("div", { className: "cur-notice", textContent:
        "⚠ Using third-party tools to buy on the transfer market is against EA's rules and can put your account at risk " +
        "(from a temporary market ban to a suspension). You use it at your own risk." }),
      el("ul", { className: "cur-note" }, [
        "Buys one card at a time, with pauses, using “buy now” at the cheapest price it finds.",
        "It stops on its own if EA reports limits (and also on reaching " + DAILY_ACTION_CAP + " market actions per day or " + HOURLY_SEARCH_CAP + " searches per hour). Today you've used " + actionsToday() + "."
      ].map((x) => el("li", { textContent: x }))),
      el("div", { className: "cur-option-row" }, [el("span", { textContent: "Cards" }), el("b", { textContent: String(ids.length) + (prices.length < ids.length ? " (" + (ids.length - prices.length) + " without price)" : "") })]),
      el("div", { className: "cur-option-row" }, [el("span", { textContent: "Estimated cost" }), estimate]),
      el("div", { className: "cur-option-row" }, [el("span", { textContent: "Maximum cost" }), maximum]),
      el("div", { className: "cur-option-row" }, [el("span", { textContent: "Max % over market price" }),
        el("span", { className: "cur-steps" }, [step(-10), step(-5), step(-1), pct, step(1), step(5), step(10)])]),
      el("div", { className: "cur-option-row" }, [el("span", { textContent: "Spend at most 🪙" }), cap]),
      el("div", { className: "cur-option-row" }, [el("span", { textContent: "After buying" }), selAfter]),
      sellRow, profitRow,
      el("label", { className: "cur-chk" }, [accepted, " I understand the risk to my account and accept it"]),
      el("div", { className: "cur-all-bar" }, [bStart, bCancel]),
      progressEl
    ])]);
    recompute();
    bCancel.onclick = () => { if (ui.buying) { stopFlag = true; ui.state.textContent = "Stopping…"; } else modal.remove(); };
    bStart.onclick = async () => {
      const sp = Math.round(Number(pct.value)), tp = Math.floor(Number(cap.value));
      if (!Number.isInteger(sp) || sp < 0 || sp > 100) { ui.state.textContent = "The % must be between 0 and 100."; return; }
      if (!Number.isFinite(tp) || tp <= 0) { ui.state.textContent = "Enter a valid coin cap."; return; }
      const after = { mode: selAfter.value, base: selBase.value, adjust: Number(selAdjust.value), duration: Number(selDuration.value) };
      try { localStorage.setItem(KEY_BUY_OPTIONS, JSON.stringify({ pct: sp, mode: after.mode, base: after.base, adjust: after.adjust, duration: after.duration })); } catch (e) { /* ignore */ }
      for (const x of modal.querySelectorAll("input, select, .cur-step")) x.disabled = true;
      bStart.disabled = true;
      bCancel.disabled = false;
      bCancel.textContent = "Stop";
      await ui.buyCart({ overpay: sp, cap: tp, after }, (results) => {
        progressEl.textContent = "";
        progressEl.appendChild(el("div", { className: "cur-tags-title", textContent: "Status of each card" }));
        for (const x of results) progressEl.appendChild(el("div", { className: "cur-plan-item" }, [el("span", { textContent: x.name || "#" + x.id }), el("span", { className: x.ok ? "cur-ok" : "cur-note", textContent: x.state })]));
      });
      bCancel.textContent = "Close";
      bCancel.onclick = () => { modal.remove(); drawAllSets(); };
    };
    windowEl.appendChild(modal);
  }

  function drawTablePanel(diag, t, readable) {
    const cats = [...new Set(readable.map((s) => s.category))].sort();
    const selCat = el("select", null, [el("option", { value: "", textContent: "All categories" }),
      ...cats.map((c) => el("option", { value: c, textContent: c.replace(/-/g, " ") }))]);
    selCat.value = tableFilters.category;
    selCat.onchange = () => { tableFilters.category = selCat.value; drawAllSets(); };
    const searchBox = el("input", { type: "search", placeholder: "Search sets…", value: tableFilters.text, className: "cur-input" });
    searchBox.oninput = () => { tableFilters.text = searchBox.value; paintRows(); };
    const chk = (key, txt, titleEl) => {
      const c = el("input", { type: "checkbox", checked: tableFilters[key] });
      c.onchange = () => { tableFilters[key] = c.checked; paintRows(); };
      return el("label", { className: "cur-note cur-chk", title: titleEl || "" }, [c, " " + txt]);
    };
    const unfillable = readable.filter((s) => t[s.slug] && t[s.slug].total < t[s.slug].slots).length;
    const bAssume = el("button", { textContent: "Assume everything I reach today was delivered",
      title: "Marks the grade your cards reach today in each set as already delivered (assumed). Afterwards it tells you when you go up a grade." });
    bAssume.onclick = () => {
      if (bAssume.dataset.sure !== "1") { bAssume.dataset.sure = "1"; bAssume.textContent = "Sure? Click again to mark"; return; }
      const n = assumeDelivered();
      ui.state.textContent = n ? "Marked " + n + " sets as delivered (assumed). Sets with a manual or EA mark were left alone." : "There were no unmarked sets with a grade.";
      drawAllSets();
    };
    const bClearAssumed = el("button", { textContent: "Clear assumed" });
    bClearAssumed.onclick = () => { const n = clearAssumed(); ui.state.textContent = "Cleared " + n + " assumed marks."; drawAllSets(); };
    const bReadEA = el("button", { textContent: "Read from EA", title: "Reads the Gallery objectives (level and event sets). It's the same request the web app makes when you open “Objectives”." });
    bReadEA.onclick = async () => {
      bReadEA.disabled = true;
      const r = await readGalleryObjectives(true);
      ui.state.textContent = r.ok ? "Gallery objectives read from EA" + (r.sets ? ": " + r.sets + " set" + (r.sets === 1 ? "" : "s") + " event sets with a detected grade." : ".") : "Couldn't read the objectives: " + r.reason;
      drawAllSets();
    };
    diag.appendChild(el("div", { className: "cur-all-bar" }, [el("span", { className: "cur-note", textContent: "Delivered grade:" }), bAssume, bClearAssumed, bReadEA]));
    diag.appendChild(el("div", { className: "cur-all-bar" }, [selCat, searchBox,
      chk("hideUnfillable", "Hide sets without enough players (" + unfillable + ")", "Sets that can't be filled yet because there aren't enough eligible cards"),
      chk("hideFinished", "Hide finished")]));

    const columns = [
      ["name", "Set"], ["cards", "Cards"], ["grade", "Grade"], ["delivered", "Delivered"], ["score", "Score"],
      [null, "Next"], ["costNext", "🪙 next"], ["costMax", "🪙 to max"], ["tokens", "Tokens"], ["perToken", "🪙 per token"], [null, "Checked"]
    ];
    const tbody = el("tbody");
    const headRow = el("tr", null, columns.map(([col, txt]) => {
      const th = el("th", { textContent: txt + (col && tableSort.col === col ? (tableSort.asc ? " ▲" : " ▼") : "") });
      if (col) {
        th.className = "sortable";
        th.onclick = () => { if (tableSort.col === col) tableSort.asc = !tableSort.asc; else { tableSort.col = col; tableSort.asc = !["cards", "grade", "score", "delivered"].includes(col); } drawAllSets(); };
      }
      return th;
    }));
    diag.appendChild(el("div", { className: "cur-table-wrap" }, [el("table", { className: "cur-all" }, [el("thead", null, [headRow]), tbody])]));
    diag.appendChild(el("div", { className: "cur-note", textContent:
      "Costs = " + costLabel() + ". “🪙 per token” = coins to reach the top grade ÷ tokens you're missing: the lower, the better. " +
      "“Check all” uses a faster calculation (it can come out slightly more expensive than the set's exact plan). Click a row to open the set." }));

    function paintRows() {
      tbody.textContent = "";
      const claims = claimedTable();
      const text = tableFilters.text.trim().toLowerCase();
      const rows = readable.filter((s) => {
        const r = t[s.slug];
        if (tableFilters.category && s.category !== tableFilters.category) return false;
        if (text && !s.name.toLowerCase().includes(text)) return false;
        if (r && tableFilters.hideUnfillable && r.total < r.slots && !r.grade) return false;
        if (r && tableFilters.hideFinished && r.grade && r.grade === r.maxGrade) return false;
        return true;
      }).map((s) => {
        const r = t[s.slug] || null;
        const remaining = r ? r.tokensTotal - r.tokens : null;
        const perToken = r && r.costMax != null && remaining > 0 ? r.costMax / remaining : null;
        return { s, r, perToken };
      });
      const value = (f) => {
        const r = f.r;
        switch (tableSort.col) {
          case "name": return f.s.name.toLowerCase();
          case "cards": return r ? r.owned / Math.max(1, r.total) : null;
          case "grade": return r ? (r.grade ? GRADE_ORDER[r.grade] : 0) : null;
          case "delivered": return GRADE_ORDER[claims[f.s.slug]] || 0;
          case "score": return r ? r.score : null;
          case "costNext": return r ? r.costNext : null;
          case "costMax": return r ? r.costMax : null;
          case "tokens": return r ? r.tokensTotal - r.tokens : null;
          default: return f.perToken;
        }
      };
      rows.sort((a, b) => {
        const x = value(a), y = value(b);
        if (x == null && y == null) return a.s.name.localeCompare(b.s.name, "en");
        if (x == null) return 1; if (y == null) return -1; // no data, always last
        const d = typeof x === "string" ? x.localeCompare(y, "en") : x - y;
        return tableSort.asc ? d : -d;
      });
      for (const { s, r, perToken } of rows) {
        const tr = el("tr", { title: "Open " + s.name });
        const name = el("td", null, [el("b", { textContent: s.name }),
          r && r.sPossible && r.sSince && Date.now() - r.sSince < 7 * 864e5 ? el("span", { className: "cur-chip", textContent: "S possible (new)" }) : el("span"),
          el("div", { className: "cur-note", textContent: s.category.replace(/-/g, " ") + " · " + s.slots + " slots" })]);
        const cells = r ? [
          name,
          el("td", { textContent: r.owned + " / " + r.total }),
          el("td", null, [el("span", { className: "cur-grade-chip " + (r.grade || ""), textContent: r.grade || (r.missingSlots ? "incomplete" : "–") })]),
          (() => {
            const source = claimSourceOf(s.slug);
            const sel = el("select", { className: "cur-select-small", title: source === "EA" ? "Detected by EA (Gallery objectives)" : "Grade you delivered in the game" },
              ["", ...sortedGrades(s).map((g) => g.grade)].map((g) => el("option", { value: g, textContent: g || "–" })));
            sel.value = claims[s.slug] || "";
            sel.disabled = source === "EA";
            sel.onclick = (e) => e.stopPropagation();
            sel.onchange = () => { setClaimed(s.slug, sel.value); paintRows(); };
            return el("td", { onclick: (e) => e.stopPropagation() }, [sel, source ? el("div", { className: "cur-note", textContent: source }) : el("span")]);
          })(),
          el("td", { textContent: fmt(r.score) }),
          el("td", { textContent: r.nextGrade ? r.nextGrade + " · " + (r.missingSlots ? (r.missingSlots === 1 ? "1 card missing" : "missing " + r.missingSlots + " cards") : "missing " + fmt(r.missingPoints) + " pts") : "complete" }),
          el("td", { className: "cur-num", textContent: r.nextGrade ? coins(r.costNext, r) : "—" }),
          el("td", { className: "cur-num", textContent: r.grade === r.maxGrade ? "—" : coins(r.costMax, r) }),
          el("td", { textContent: r.tokens + " / " + r.tokensTotal }),
          el("td", { className: "cur-num", textContent: perToken == null ? "—" : "🪙 " + fmt(Math.round(perToken)) }),
          el("td", { className: "cur-note", textContent: ago(r.at) })
        ] : [name, el("td", { className: "cur-note", colSpan: 10, textContent: "not checked" })];
        for (const c of cells) tr.appendChild(c);
        tr.onclick = () => openSet(s);
        tbody.appendChild(tr);
      }
      if (!rows.length) tbody.appendChild(el("tr", null, [el("td", { className: "cur-note", colSpan: 11, textContent: "No set matches." })]));
    }
    paintRows();
  }

  // Form to add or edit a set by copying the details from the in-game Gallery screen
  function setForm(onSave) {
    const names = eaNames();
    const box = el("div", { className: "cur-block cur-set-form" }, [el("div", { className: "cur-tags-title", textContent: "Add or edit a set" }),
      el("div", { className: "cur-note", textContent: "Copy the details from the set's screen in the in-game Gallery. The club, league or rarity is picked by name (the list comes from EA's own web app)." })]);
    const selEdit = el("select", null, [el("option", { value: "", textContent: "— New set —" }), ...SETS.map((x) => el("option", { value: x.slug, textContent: x.name }))]);
    const kind = el("select", null, [["club", "Club"], ["league", "League"], ["rarity", "Rarity"]].map(([v, t]) => el("option", { value: v, textContent: t })));
    const list = el("datalist", { id: "cur-ea-names" });
    const searchBox = el("input", { className: "cur-input cur-wide", placeholder: "Search by name…" });
    searchBox.setAttribute("list", "cur-ea-names");
    const scope = el("select", null, [["men", "Men"], ["women", "Women"], ["both", "Men and women"]].map(([v, t]) => el("option", { value: v, textContent: t })));
    const name = el("input", { className: "cur-input cur-wide", placeholder: "Set name (as in the game)" });
    const category = el("input", { className: "cur-input", placeholder: "category (e.g. premier-league)" });
    const slots = el("input", { type: "number", min: "1", max: "50", value: "15", className: "cur-input cur-pct" });
    const rows = ["D", "C", "B", "A", "S"].map((g) => ({ g,
      score: el("input", { type: "number", min: "0", className: "cur-input", placeholder: "score" }),
      tokens: el("input", { type: "number", min: "0", className: "cur-input cur-pct", placeholder: "tokens" }),
      reward: el("input", { className: "cur-input cur-wide", placeholder: "reward (optional)" }) }));
    const notice = el("div", { className: "cur-note" });
    const optionsFor = (t) => (t === "club" ? names.club : t === "league" ? names.league : names.rarity);
    const fillList = () => {
      list.textContent = "";
      for (const x of optionsFor(kind.value)) list.appendChild(el("option", { value: x.name + " #" + x.id }));
      scope.disabled = kind.value !== "club";
    };
    kind.onchange = () => { searchBox.value = ""; fillList(); };
    const picked = () => {
      const m = searchBox.value.match(/#(\d+)\s*$/);
      if (m) return { id: Number(m[1]), name: searchBox.value.replace(/\s*#\d+\s*$/, "") };
      const x = optionsFor(kind.value).find((o) => o.name.toLowerCase() === searchBox.value.trim().toLowerCase());
      return x || null;
    };
    searchBox.onchange = () => { const x = picked(); if (x && !name.value) name.value = x.name; };
    selEdit.onchange = () => {
      const st = SETS.find((x) => x.slug === selEdit.value);
      if (!st) return;
      const e = toExternal(st);
      kind.value = st.eaFilter.kind === "rarities" ? "rarity" : st.eaFilter.kind; fillList();
      const id = st.eaFilter.ids[0];
      const n = optionsFor(kind.value).find((o) => o.id === id);
      searchBox.value = (n ? n.name : st.name) + " #" + id;
      scope.value = st.eaFilter.scope || "both";
      name.value = st.name; category.value = st.category; slots.value = String(st.slots);
      for (const f of rows) { const g = e.grades.find((x) => x.grade === f.g); f.score.value = g ? g.score : ""; f.tokens.value = g ? g.tokens : ""; f.reward.value = g ? g.reward : ""; }
    };
    fillList();
    const bSave = el("button", { className: "primary", textContent: "Save set" });
    const bDeleteSet = el("button", { textContent: "Delete this set" });
    bSave.onclick = () => {
      try {
        const x = picked();
        if (!x) throw new Error("Pick the club, league or rarity from the list.");
        const grades = rows.filter((f) => f.score.value !== "").map((f) => ({ grade: f.g, score: Math.round(Number(f.score.value)), tokens: Math.round(Number(f.tokens.value) || 0), reward: f.reward.value }));
        if (!grades.length) throw new Error("Enter the score for at least one grade.");
        const nm = name.value.trim() || x.name;
        const external = { slug: selEdit.value || slugOf(nm), name: nm, category: slugOf(category.value) || (kind.value === "club" ? "clubs" : kind.value === "league" ? "leagues" : "rarities"),
          required: Math.round(Number(slots.value)), eaEntityKind: kind.value, eaEntityId: x.id, eaRarityIds: kind.value === "rarity" ? [x.id] : [],
          membership: kind.value === "club" ? slots.value + " " + nm + " " + (scope.value === "men" ? "Mens" : scope.value === "women" ? "Womens" : "Mens or Womens") + " players" : "",
          grades };
        const st = saveOwnSet(external);
        notice.className = "cur-ok"; notice.textContent = "Saved: " + st.name + " (" + st.slots + " slots, " + st.grades.length + " grades).";
        onSave();
      } catch (e) { notice.className = "cur-no"; notice.textContent = e.message; }
    };
    bDeleteSet.onclick = () => {
      if (!selEdit.value) { notice.className = "cur-note"; notice.textContent = "Pick the set you want to delete above."; return; }
      if (bDeleteSet.dataset.sure !== "1") { bDeleteSet.dataset.sure = "1"; bDeleteSet.textContent = "Sure? Click again"; return; }
      deleteOwnSet(selEdit.value); notice.className = "cur-note"; notice.textContent = "Set deleted."; onSave();
    };
    const noDict = !names.club.length && !names.league.length;
    box.append(
      el("div", { className: "cur-option-row" }, [el("span", { textContent: "Edit" }), selEdit]),
      el("div", { className: "cur-option-row" }, [el("span", { textContent: "Type" }), kind]),
      el("div", { className: "cur-option-row" }, [el("span", { textContent: "Club / league / rarity" }), searchBox, list]),
      ...(noDict ? [el("div", { className: "cur-note", textContent: "EA's dictionary hasn't loaded yet: wait for the web app to finish loading and open “Sets…” again." })] : []),
      el("div", { className: "cur-option-row" }, [el("span", { textContent: "Players" }), scope]),
      el("div", { className: "cur-option-row" }, [el("span", { textContent: "Name" }), name]),
      el("div", { className: "cur-option-row" }, [el("span", { textContent: "Category" }), category]),
      el("div", { className: "cur-option-row" }, [el("span", { textContent: "Slots" }), slots]),
      ...rows.map((f) => el("div", { className: "cur-option-row" }, [el("span", { className: "cur-grade-chip " + f.g, textContent: f.g }), f.score, f.tokens, f.reward])),
      el("div", { className: "cur-all-bar" }, [bSave, bDeleteSet]), notice);
    return box;
  }

  function drawSummary() {
    document.getElementById("cur-body").classList.remove("all-sets");
    const set = view.set;
    const r = ui.summary;
    r.textContent = "";
    r.classList.add("visible");
    const chosen = view.cards.filter((c) => view.chosen.has(c.definitionId));
    const ev = evaluate(set, chosen);
    const owned = view.cards.filter((c) => c.isCollected).length;

    // Stats row
    r.appendChild(el("div", { className: "cur-row" }, [
      el("span", { className: "cur-stat" }, [el("b", { textContent: set.name })]),
      el("span", { className: "cur-stat" }, ["Collected: ", el("b", { textContent: owned + " / " + view.cards.length })]),
      el("span", { className: "cur-stat" }, ["Lineup: ", el("b", { textContent: chosen.length + " / " + set.slots })]),
      el("span", { className: "cur-stat" }, ["Score: ", el("b", { textContent: fmt(ev.score) }),
        el("span", { className: "cur-note", textContent: "  (base " + fmt(ev.base) + " + bonus " + fmt(ev.bonus) + ")" })]),
      el("span", { className: "cur-stat" }, ["Tokens: ", el("b", { textContent: ev.tokens + " / " + ev.tokensAll })])
    ]));

    // Progress bar: from the current grade to the next one
    const base = ev.wouldReach; // by score (if the set isn't full, it doesn't count yet)
    const since = base ? base.score : 0;
    const until = ev.next ? ev.next.score : since;
    const pct = ev.next ? Math.max(0, Math.min(100, ((ev.score - since) / Math.max(1, until - since)) * 100)) : 100;
    const gradeBadge = (g) => el("span", { className: "cur-grade-badge " + (g ? g.grade : "") }, [el("span", { textContent: g ? g.grade : "–" })]);
    r.appendChild(el("div", { className: "cur-progress" }, [
      gradeBadge(base),
      el("div", { className: "cur-bar" }, [el("div", { style: "width:" + pct.toFixed(1) + "%" })]),
      gradeBadge(ev.next)
    ]));

    let text;
    if (ev.missingSlots > 0) {
      text = (ev.missingSlots === 1 ? "1 card missing" : ev.missingSlots + " cards missing") +
        " to fill the " + set.slots + " slots (a set only gets a grade when full).";
      if (base) text += " With this score, completing it would get you to " + base.grade + ".";
    } else if (ev.next) {
      text = fmt(ev.next.score - ev.score) + " points to " + ev.next.grade +
        (ev.next.reward ? " (reward: " + ev.next.reward + ")" : "") + ".";
    } else {
      text = "Top grade reached.";
    }
    r.appendChild(el("div", { className: "cur-note", textContent: text }));

    // Prices of the missing cards
    const missing = view.cards.filter((c) => !c.isCollected);
    const withPrice = missing.map((c) => ({ c, p: priceOf(c.definitionId) })).filter((x) => x.p && x.p.price != null)
      .sort((a, b) => a.p.price - b.p.price);
    if (missing.length) {
      const noPrice = missing.length - withPrice.length;
      const ago = futgg.at ? Math.max(0, Math.round((Date.now() - (futgg.published || futgg.at)) / 60000)) : null;
      r.appendChild(el("div", { className: "cur-price-summary" }, [
        withPrice.length
          ? el("div", null, ["Cheapest card you're missing: ", el("b", { textContent: (withPrice[0].c.name || "#" + withPrice[0].c.definitionId) + " 🪙 " + fmt(withPrice[0].p.price) })])
          : el("div", { className: "cur-note", textContent: bridgeAvailable() ? "No prices yet: press “Refresh prices”." : "No fut.gg prices (the extension must be installed). You can look up single cards with the 🔍." }),
        el("div", { className: "cur-note", textContent: withPrice.length + " with price · " + noPrice + " without price" +
          (ago != null ? " · fut.gg, updated " + (ago < 1 ? "less than 1 min ago" : ago + " min ago") : "") })
      ]));
    }

    // How the lineup was chosen and a button to recalculate
    const texts = {
      exact: "Optimal lineup: every possible combination was tried.",
      "search": "Optimized lineup: many combinations were tried (it may not be the absolute best).",
      all: "Lineup with every card you've owned.",
      manual: "Lineup picked by hand.",
      plan: "Lineup from the purchase plan."
    };
    const bBest = el("button", { textContent: "Best lineup", className: "primary" });
    bBest.onclick = async () => {
      bBest.disabled = true;
      bBest.textContent = "Calculating…";
      await wait(30);
      const opt = optimizeLineup(set, view.cards);
      view.chosen = new Set(opt.ids);
      view.method = opt.method;
      drawSummary();
      drawGrid();
    };
    if (!owned) {
      bBest.disabled = true;
      bBest.title = "You have no cards from this set";
    }
    r.appendChild(el("div", { className: "cur-optimal" }, [
      el("div", { className: "cur-note", textContent: owned ? (texts[view.method] || "")
        : "You don't have any cards from this set yet, so “Best lineup” has nothing to choose from. Use “Plan purchase” to see what to buy." }),
      bBest
    ]));

    // Planner
    const plan = el("div", { className: "cur-plan" }, [el("div", { className: "cur-tags-title", textContent: "Plan purchase to reach" })]);
    const chkResale = el("input", { type: "checkbox", checked: settings.resale });
    chkResale.onchange = () => { settings.resale = chkResale.checked; saveSettings(); view.plan = null; drawSummary(); drawGrid(); };
    plan.appendChild(el("label", { className: "cur-note cur-chk", title: "A card counts in the Gallery even if you sell it: you buy it, it counts, you resell it and only lose EA's 5%." },
      [chkResale, " Choose with reselling in mind (what I lose to EA's 5%)"]));
    const row = el("div", { className: "cur-plan-grades" });
    for (const g of sortedGrades(set)) {
      const b = el("button", { className: "cur-plan-grade " + g.grade + (view.plan && view.plan.ok && view.plan.grade === g.grade ? " active" : ""), textContent: g.grade, title: "Plan for " + g.grade + " (" + fmt(g.score) + " points" + (g.reward ? " · reward: " + g.reward : "") + ")" });
      b.onclick = async () => {
        for (const x of row.querySelectorAll("button")) x.disabled = true;
        if (bridgeAvailable()) {
          ui.state.textContent = "Getting fut.gg prices…";
          await refreshSetPrices(false); // if they're less than 5 min old, no new request
        }
        ui.state.textContent = "Calculating the cheapest plan for " + g.grade + "…";
        await wait(30);
        const res = planBuy(set, view.cards, g.grade);
        view.plan = res;
        if (res.ok) {
          view.chosen = new Set(res.ids);
          view.method = "plan";
          ui.state.textContent = res.grade !== res.requested
            ? res.requested + " can't be reached with the cards that have a price: the plan is for " + res.grade + "."
            : "Plan for " + res.grade + ": " + (res.buys.length ? "buy " + res.buys.length + " card" + (res.buys.length === 1 ? "" : "s") + " for 🪙 " + fmt(res.buyCost) +
              (res.resale ? " (about 🪙 " + fmt(res.cost) + " if you resell them)" : "") : "no need to buy anything") + ".";
        } else {
          ui.state.textContent = res.reason === "missing"
            ? "Not enough to fill the set: missing " + res.missing + " priced cards." +
              (bridgeAvailable() ? " fut.gg has no price for some: look them up with the 🔍." : " Without the extension there are no fut.gg prices: look up cards with the 🔍.")
            : "No grade can be reached with the cards that have a price.";
        }
        drawSummary();
        drawGrid();
      };
      row.appendChild(b);
    }
    plan.appendChild(row);
    const rewards = sortedGrades(set).filter((g) => g.reward);
    if (rewards.length) {
      plan.appendChild(el("div", { className: "cur-rewards" },
        rewards.map((g) => el("div", { className: "cur-plan-item" }, [
          el("span", { className: "cur-grade-chip " + g.grade, textContent: g.grade }),
          el("span", { textContent: g.reward })
        ]))));
    }
    const pl = view.plan;
    if (pl && pl.ok) {
      plan.appendChild(el("div", { className: "cur-plan-result" }, [
        el("div", null, ["For ", el("b", { textContent: pl.grade }), ": ",
          el("b", { textContent: pl.buys.length ? "🪙 " + fmt(pl.buyCost) : "free" }),
          pl.buys.length ? " (" + pl.buys.length + " card" + (pl.buys.length === 1 ? "" : "s") + ")" : " (already reached)"]),
        ...(pl.resale && pl.buys.length ? [el("div", { className: "cur-note", textContent: "If you resell them at the same price: you lose about 🪙 " + fmt(pl.cost) + " (EA tax). They still count in the Gallery." })] : []),
        ...pl.buys.map((c) => el("div", { className: "cur-plan-item" }, [el("span", { textContent: c.name || "#" + c.definitionId }), el("b", { textContent: "🪙 " + fmt(c.price) })])),
        ...(pl.buys.length ? [(() => {
          const b = el("button", { textContent: "Add to cart (" + pl.buys.length + ")" });
          b.onclick = () => {
            const ids = new Set(pl.buys.map((c) => c.definitionId));
            const n = addToCart(view.cards.filter((c) => ids.has(c.definitionId)));
            ui.state.textContent = n ? "Added " + n + " cards to the cart (“All sets” → “Cart”)." : "They were already in the cart.";
          };
          return b;
        })()] : []),
        el("div", { className: "cur-note", textContent: "Score with the plan: " + fmt(pl.total) + (pl.method === "exact" ? " · guaranteed cheapest plan (all were tried)" : " · optimized plan") })
      ]));
    }
    if (pl && pl.noPrice) plan.appendChild(el("div", { className: "cur-note", textContent: pl.noPrice + " missing cards have no price and weren't considered." }));
    else if (!pl) plan.appendChild(el("div", { className: "cur-note", textContent: "Uses the prices found: the more cards with a price, the better the plan." }));
    r.appendChild(plan);

    // Lineup tag bonuses
    const tags = el("div", { className: "cur-tags" }, [el("div", { className: "cur-tags-title", textContent: "Tag bonuses" })]);
    if (!ev.detail.length) {
      tags.appendChild(el("div", { className: "cur-note", textContent: "No active tags with this lineup." }));
    }
    for (const d of ev.detail) {
      tags.appendChild(el("div", { className: "cur-tag" + (d.counts ? "" : " not-counted") }, [
        el("span", { textContent: d.name + " · " + d.qty + " · " + d.pct + "%" }),
        el("b", { textContent: "+" + fmt(d.bonus) })
      ]));
    }
    if (ev.detail.length > MAX_TAGS) {
      tags.appendChild(el("div", { className: "cur-note", textContent: "Only the " + MAX_TAGS + " largest bonuses count." }));
    }
    const d = fo();
    const inSet = view.cards.filter((c) => c.isCollected);
    const foInSet = inSet.filter((c) => isFirstOwner(c.definitionId) === true).length;
    const unknown = inSet.filter((c) => isFirstOwner(c.definitionId) === null).length;
    tags.appendChild(el("div", { className: "cur-note", textContent:
      "First Owner: " + foInSet + " of your " + inSet.length + " cards in this set." +
      (d.checkedAt ? " Club checked on " + new Date(d.checkedAt).toLocaleString("en-US") + "." : " Press “Check club” to detect them.") +
      (unknown ? " " + unknown + " without data (the ones you sold): mark them with the ★ if you packed them yourself." : "") }));
    // First Owner mode: your marks or assume a %
    const rMarks = el("input", { type: "radio", name: "cur-fo-mode", checked: settings.foMode === "marks" });
    const rPct = el("input", { type: "radio", name: "cur-fo-mode", checked: settings.foMode === "pct" });
    const nPct = el("input", { type: "number", min: "0", max: "100", step: "5", value: String(settings.foPct), className: "cur-input cur-pct" });
    const applyFO = () => {
      const v = Math.round(Number(nPct.value));
      settings.foMode = rPct.checked ? "pct" : "marks";
      if (Number.isInteger(v) && v >= 0 && v <= 100) settings.foPct = v;
      saveSettings();
      drawSummary();
    };
    rMarks.onchange = rPct.onchange = applyFO;
    nPct.onchange = () => { rPct.checked = true; applyFO(); };
    tags.appendChild(el("div", { className: "cur-fo-mode cur-note" }, [
      el("span", { textContent: "First Owner:" }),
      el("label", { className: "cur-chk" }, [rMarks, " my marks"]),
      el("label", { className: "cur-chk", title: "Assumes you packed that % of your collected lineup cards yourself. Cards you buy are never First Owner." }, [rPct, " assume", nPct, "%"])
    ]));
    r.appendChild(tags);

    // Grade you've already claimed in the game (for “Ready to grade”)
    const claims = claimedTable()[set.slug] || "";
    const claimSource = claimSourceOf(set.slug);
    const claimRow = el("div", { className: "cur-plan-grades" });
    for (const g of ["", ...sortedGrades(set).map((x) => x.grade)]) {
      const b = el("button", { className: "cur-plan-grade " + g + (claims === g ? " active" : ""), textContent: g || "–",
        title: g ? "I already claimed " + g + " in the game" : "I haven't claimed any grade yet" });
      b.onclick = () => { setClaimed(set.slug, g); drawSummary(); };
      b.disabled = claimSource === "EA";
      claimRow.appendChild(b);
    }
    const settled = ev.current && GRADE_ORDER[ev.current.grade] > (GRADE_ORDER[claims] || 0);
    r.appendChild(el("div", { className: "cur-plan" }, [
      el("div", { className: "cur-tags-title", textContent: "Grade delivered in the game" + (claimSource ? " (" + claimSource + ")" : "") }), claimRow,
      ...(claimSource === "EA" ? [el("div", { className: "cur-note", textContent: "Detected by EA from this set's objectives: it updates on its own." })] : claimSource === "assumed" ? [el("div", { className: "cur-note", textContent: "Assumed mark: click a grade to correct it." })] : []),
      el("div", { className: settled ? "cur-ok" : "cur-note", textContent: settled
        ? "Your cards already reach " + ev.current.grade + ": grade it in the in-game Gallery (" +
          ((tokensUpTo(set, ev.current.grade) - tokensUpTo(set, claims)) > 0 ? "+" + (tokensUpTo(set, ev.current.grade) - tokensUpTo(set, claims)) + " tokens" : ev.current.reward || "reward") + ") and mark it here."
        : "Mark the last grade you graded in the game so the overview can tell you when you can go up." })
    ]));

    // Filters
    const filters = el("div", { id: "cur-filters" });
    [["all", "All"], ["owned", "Owned"], ["missing", "Missing"], ["lineup", "Lineup"]].forEach(([key, name]) => {
      const b = el("button", { textContent: name, className: view.eaFilter === key ? "active" : "" });
      b.onclick = () => { view.eaFilter = key; drawSummary(); drawGrid(); };
      filters.appendChild(b);
    });
    r.appendChild(filters);
  }

  function filteredCards() {
    const order = [...view.cards].sort((a, b) => b.gradingScore - a.gradingScore || b.rating - a.rating);
    if (view.eaFilter === "owned") return order.filter((c) => c.isCollected);
    if (view.eaFilter === "missing") return order.filter((c) => !c.isCollected);
    if (view.eaFilter === "lineup") return order.filter((c) => view.chosen.has(c.definitionId));
    return order;
  }

  function releaseEAViews() {
    for (const v of view.eaViews) { try { v.dealloc && v.dealloc(); } catch (e) { /* ignore */ } }
    view.eaViews = [];
  }

  function drawGrid() {
    const turn = ++view.turn;
    releaseEAViews();
    ui.grid.textContent = "";
    const list = filteredCards();
    const pending = [];
    for (const c of list) {
      const art = el("div", { className: "cur-art" });
      const tile = el("div", { className: "cur-tile " + (c.isCollected ? "owned" : "missing") + (view.chosen.has(c.definitionId) ? " chosen" : "") }, [
        el("div", { className: "cur-points" }, [el("span", { className: "cur-gem" }), el("span", { textContent: fmt(c.gradingScore) })]),
        art,
        el("div", { className: "cur-foot " + (c.isCollected ? "owned" : "missing"), textContent: c.isCollected ? "✔ You've had it" : "Missing" }),
        c.isCollected ? el("span") : priceEl(c)
      ]);
      const others = countsFor(c.definitionId).filter((x) => x !== view.set.slug);
      tile.title = (c.name || "#" + c.definitionId) + " · " + c.rating + (others.length ? " · also counts for: " + setNames(others, 5) : "");
      if (c.isCollected) tile.appendChild(foButton(c, tile));
      else tile.appendChild(lensButton(c));
      if (!c.isCollected && view.plan && view.plan.ok && view.plan.ids.includes(c.definitionId)) {
        tile.classList.add("buy");
        tile.appendChild(el("div", { className: "cur-buy", textContent: "BUY" }));
      }
      tile.onclick = () => toggleCard(c, tile);
      ui.grid.appendChild(tile);
      pending.push({ c, art });
    }
    // We draw 8 cards at a time so the page doesn't freeze
    let i = 0;
    const step = () => {
      if (turn !== view.turn) return;
      const done = Math.min(i + 8, pending.length);
      for (; i < done; i++) drawCard(pending[i].c, pending[i].art);
      if (i < pending.length) setTimeout(step, 0);
    };
    step();
  }

  function drawCard(c, art) {
    const factory = cardFactory();
    const entity = entities.get(c.definitionId);
    if (factory && entity) {
      try {
        entity.concept = !c.isCollected; // missing cards, in EA's dimmed style
        const v = factory.createLargeItem(entity);
        v.init();
        const root = v.getRootElement();
        if (root) {
          art.appendChild(root);
          v.render(entity);
          try { const statuses = readGlobal("UIItemInfoState"); if (statuses) v.setItemInfoState(statuses.MAIN); } catch (e) { /* ignore */ }
          view.eaViews.push(v);
          return;
        }
      } catch (e) { /* if it fails, we use text */ }
    }
    art.appendChild(el("div", { className: "cur-no-art" }, [
      el("b", { textContent: c.name || "#" + c.definitionId }), el("br"), "Rating " + c.rating
    ]));
  }

  // Price under the missing cards
  const priceEls = new Map(); // definitionId -> element
  function priceText(c) {
    const p = priceOf(c.definitionId);
    if (p === undefined) return "price: —";
    if (p.price === null) return p.source === "fut.gg" ? "no fut.gg price" : "none for sale";
    return "🪙 " + fmt(p.price) + (p.sbc ? " · SBC" : p.objective ? " · objective" : "");
  }
  function priceEl(c) {
    const p = priceOf(c.definitionId);
    const e = el("div", { className: "cur-price", textContent: priceText(c),
      title: p ? "Price from " + p.source + (p.price != null && canResell(p) ? " · if you buy it and resell it at the same price you lose about " + fmt(netAfterResale(p.price)) : p.price != null ? " · SBC/objective card: can't be resold" : "") : "" });
    priceEls.set(c.definitionId, e);
    return e;
  }
  function refreshPriceInGrid(c) {
    const e = priceEls.get(c.definitionId);
    if (e) e.textContent = priceText(c);
  }
  // Lens: looks up the price of that single card
  function lensButton(c) {
    const b = el("button", { type: "button", className: "cur-lens", textContent: "🔍", title: "Look up this card's price on the EA market (max 2 searches, with an hourly cap)" });
    b.onclick = async (e) => {
      e.stopPropagation();
      if (b.disabled) return;
      b.disabled = true;
      ui.state.textContent = "Looking up price for " + (c.name || "#" + c.definitionId) + "…";
      const r = await lookUpPrice(c.definitionId);
      const name = c.name || "#" + c.definitionId;
      ui.state.textContent = r.halt ? "EA asked to slow down. Wait a while."
        : r.cap ? "You hit the cap of " + HOURLY_SEARCH_CAP + " market searches per hour. You can continue in " + minutesToResume() + " min."
        : name + " on the EA market: " + (r.price != null ? "🪙 " + fmt(r.price) : "none for sale") + " (" + r.searches + (r.searches === 1 ? " search" : " searches") + "; " + searchesLeft() + " left this hour).";
      refreshPriceInGrid(c);
      drawSummary();
      b.disabled = false;
    };
    return b;
  }

  // First Owner star: gold = you packed it, crossed out = you didn't, grey = unknown. With a border = marked by hand.
  function paintFO(launcher, c) {
    const v = isFirstOwner(c.definitionId);
    const manual = fo().manual[c.definitionId] != null;
    launcher.className = "cur-fo" + (v === true ? " yes" : v === false ? " no" : "") + (manual ? " manual" : "");
    launcher.title = v === true ? "First Owner" + (manual ? " (marked by you)" : " (detected in your club)") + ". Click to change."
      : v === false ? "Not First Owner" + (manual ? " (marked by you)" : " (you bought it)") + ". Click to change."
      : "Unknown whether you packed it yourself. Click to mark it as First Owner.";
  }
  function foButton(c) {
    const b = el("button", { type: "button", textContent: "★" });
    paintFO(b, c);
    b.onclick = (e) => {
      e.stopPropagation(); // don't remove/add the card to the lineup
      toggleFOMark(c.definitionId);
      paintFO(b, c);
      view.method = view.method === "manual" ? "manual" : view.method;
      drawSummary();
    };
    return b;
  }

  function toggleCard(c, tile) {
    const id = c.definitionId;
    if (view.chosen.has(id)) {
      view.chosen.delete(id);
    } else {
      if (view.chosen.size >= view.set.slots) {
        ui.state.textContent = "The lineup already has " + view.set.slots + " cards: remove one before adding another.";
        return;
      }
      view.chosen.add(id);
    }
    tile.classList.toggle("chosen", view.chosen.has(id));
    view.method = "manual";
    drawSummary();
    if (view.eaFilter === "lineup") drawGrid();
  }

  // Wait for the web app to finish loading
  (function waitPage(tries) {
    if (document.body && services()) return mount();
    if (tries > 240) return mount(); // after 2 minutes we show the button anyway
    setTimeout(() => waitPage(tries + 1), 500);
  })(0);
})();
