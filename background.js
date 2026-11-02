// Curator – extension background (service worker).
// Its only job: download fut.gg's public price list and return the prices of the requested cards.
//  - It only connects to https://r2.fut.gg (the only site allowed in manifest.json).
//  - URLs are built here from checked parts: nobody can ask it to download anything else.
//  - Downloads 3 files (index, IDs and prices; about 180 KB) at most once every 5 minutes.
//  - Whatever it downloads is read with JSON.parse (data, never code) and checked to be numbers.
//  - Saves nothing to disk: prices stay in memory only.
"use strict";

const BASE = "https://r2.fut.gg";
const YEAR = "27";
const REFRESH_MS = 5 * 60 * 1000;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_IDS = 5000;
const RE_PART = /^[A-Za-z0-9_-]{1,64}$/;
const EA_PAGES = [
  /^https:\/\/www\.ea\.com\/ea-sports-fc\/ultimate-team\/web-app/,
  /^https:\/\/www\.ea\.com\/[a-z]{2}(-[a-z]{2})?\/ea-sports-fc\/ultimate-team\/web-app/
];

const cache = {};   // platform -> { map, at, published }
const inFlight = {}; // platform -> promise

async function fetchJSON(url) {
  const r = await fetch(url, { credentials: "omit", cache: "no-cache", redirect: "error" });
  if (!r.ok) throw new Error("fut.gg responded " + r.status);
  const text = await r.text();
  if (text.length > MAX_BYTES) throw new Error("fut.gg file too large.");
  return JSON.parse(text);
}

function buildUrl(manifest, key) {
  const version = manifest._version;
  const part = manifest[key];
  if (!Number.isInteger(version) || version < 0 || version > 1e6) throw new Error("fut.gg list has an unexpected format.");
  if (typeof part !== "string" || !RE_PART.test(part)) throw new Error("fut.gg list has an unexpected format.");
  return BASE + "/" + YEAR + "/" + key + ".v" + version + "." + encodeURIComponent(part) + ".json";
}

const isInt = (x) => Number.isInteger(x) && x >= 0 && x <= 1e9;

async function load(platformName) {
  const manifest = await fetchJSON(BASE + "/" + YEAR + "/manifest.json");
  if (!manifest || typeof manifest !== "object") throw new Error("fut.gg list has an unexpected format.");
  const priceKey = platformName === "pc" ? "player-prices-pc-dyn" : "player-prices-ps5-dyn";
  const [index, prices] = await Promise.all([
    fetchJSON(buildUrl(manifest, "player-prices-index")),
    fetchJSON(buildUrl(manifest, priceKey))
  ]);
  // Index: first ID and successive differences
  if (!index || !isInt(index.id0) || !Array.isArray(index.d)) throw new Error("fut.gg index has an unexpected format.");
  if (!prices || !Array.isArray(prices.p) || !Array.isArray(prices.s)) throw new Error("fut.gg prices have an unexpected format.");
  const n = index.d.length + 1;
  if (prices.p.length !== n || prices.s.length !== n || n > 200000) throw new Error("fut.gg prices have an unexpected format.");
  const map = new Map();
  let id = index.id0;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const delta = index.d[i - 1];
      if (!isInt(delta)) throw new Error("fut.gg index has an unexpected format.");
      id += delta;
    }
    const p = prices.p[i], s = prices.s[i];
    map.set(id, [isInt(p) && p > 0 ? p : null, isInt(s) ? s : 0]);
  }
  const pubAt = manifest._published_at && manifest._published_at[priceKey];
  return { map, at: Date.now(), published: isInt(pubAt) ? pubAt : null };
}

async function obtain(platformName) {
  const c = cache[platformName];
  if (c && Date.now() - c.at < REFRESH_MS) return c;
  if (!inFlight[platformName]) {
    inFlight[platformName] = load(platformName)
      .then((x) => { cache[platformName] = x; return x; })
      .finally(() => { delete inFlight[platformName]; });
  }
  try {
    return await inFlight[platformName];
  } catch (e) {
    if (c) return c; // if it fails, use the latest we have
    throw e;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // Only messages from our own extension, from EA's web app
  if (sender.id !== chrome.runtime.id) return false;
  const url = (sender.tab && sender.tab.url) || sender.url || "";
  if (!EA_PAGES.some((re) => re.test(url))) return false;
  if (!msg || msg.kind !== "futgg-prices") return false;

  const platformName = msg.platformName === "pc" ? "pc" : "console";
  const ids = Array.isArray(msg.ids) ? msg.ids.filter((x) => Number.isInteger(x) && x > 0).slice(0, MAX_IDS) : [];
  obtain(platformName)
    .then((c) => {
      const prices = {};
      for (const id of ids) {
        const v = c.map.get(id);
        if (v) prices[id] = v;
      }
      reply({ ok: true, prices, published: c.published });
    })
    .catch((e) => reply({ ok: false, reason: "Couldn't download fut.gg prices: " + String(e && e.message || e).slice(0, 150) }));
  return true; // asynchronous response
});
