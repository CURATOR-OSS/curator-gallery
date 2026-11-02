// Validates a list of sets with the same check the extension uses when importing.
// Usage: node tools/validate-sets.js community/sets.json
// Exits with an error if the file isn't valid or if any set fails the check.
"use strict";
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "page.js"), "utf8");
const i = src.indexOf("  const MAX_LIST_BYTES"), j = src.indexOf("  let listInfo = null;");
if (i < 0 || j < 0) { console.error("Can't find the validator in page.js"); process.exit(2); }
const m = { exports: {} };
new Function("module", src.slice(i, j) + "\nmodule.exports = { validateList, cleanSet };")(m);
const file = process.argv[2] || path.join(__dirname, "..", "community", "sets.json");
const text = fs.readFileSync(file, "utf8");
let data;
try { data = JSON.parse(text); } catch (e) { console.error("Not valid JSON:", e.message); process.exit(1); }
if (!data || !Array.isArray(data.sets)) { console.error("The “sets” list is missing."); process.exit(1); }
if (!data.sets.length) { console.log("Empty list: OK."); process.exit(0); }
let bad = 0;
const seen = new Set();
data.sets.forEach((x, n) => {
  const s = m.exports.cleanSet(x);
  if (!s) { bad++; console.error("✘ set " + n + " (" + (x && x.slug) + "): fails the check"); return; }
  if (seen.has(s.slug)) { bad++; console.error("✘ duplicate slug: " + s.slug); }
  seen.add(s.slug);
  if (s.name !== x.name) console.warn("! " + s.slug + ": the name was cleaned to “" + s.name + "”");
});
let r;
try { r = m.exports.validateList(text); } catch (e) { console.error("✘ " + e.message); process.exit(1); }
console.log("Valid sets: " + r.sets.length + " · dropped: " + r.rejected);
process.exit(bad || r.rejected ? 1 : 0);
