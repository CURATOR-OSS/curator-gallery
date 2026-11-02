// Curator – bridge between the page (page.js) and the extension background (background.js).
// Runs in the extension's "isolated world": the page can't see or change this code.
// It does one thing: when page.js asks for fut.gg prices, it passes the request to background.js
// and returns the answer. Any other message is ignored.
(function () {
  "use strict";
  const MAX_IDS = 5000;
  document.documentElement.setAttribute("data-curator-bridge", "1");

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const d = ev.data;
    if (!d || typeof d !== "object" || d.source !== "cur-page" || d.kind !== "futgg-prices") return;
    const requested = d.requested;
    if (!Number.isInteger(requested)) return;
    const reply = (r) => window.postMessage(Object.assign({ source: "curator-bridge", requested }, r), location.origin);

    const platformName = d.platformName === "pc" ? "pc" : "console";
    const ids = Array.isArray(d.ids) ? d.ids.filter((x) => Number.isInteger(x) && x > 0).slice(0, MAX_IDS) : [];
    if (!ids.length) return reply({ ok: false, reason: "Empty request." });

    try {
      chrome.runtime.sendMessage({ kind: "futgg-prices", platformName, ids }, (r) => {
        if (chrome.runtime.lastError || !r || typeof r !== "object") {
          return reply({ ok: false, reason: "The extension didn't respond (reload the page)." });
        }
        reply({ ok: r.ok === true, reason: r.reason, prices: r.prices, published: r.published });
      });
    } catch (e) {
      reply({ ok: false, reason: "The extension was updated: reload the page." });
    }
  });
})();
