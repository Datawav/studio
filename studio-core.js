"use strict";
// studio-core.js — loads studio-core.wasm (the firmware's curves cost model,
// Parse + Validate) and exposes window.studioCoreReport(payload). The editor
// computes strokes and payload bytes in JS exactly; this adds the firmware's
// knot caps and real engraving time so the path-mode gauges stop guessing.
// It is optional: until (or unless) the wasm loads, the editor falls back to a
// JS estimate, so the app works with no toolchain and stays static.
(function () {
  const WASM = "studio-core.wasm", EXEC = "wasm_exec.js";
  function loadExec() {
    return new Promise((res, rej) => {
      if (globalThis.Go) return res();
      const s = document.createElement("script");
      s.src = EXEC; s.onload = () => res(); s.onerror = () => rej(new Error("load " + EXEC));
      document.head.appendChild(s);
    });
  }
  async function boot() {
    try {
      await loadExec();
      const go = new Go();
      // main() sets studioCoreReport + studioCoreReady, then calls this hook.
      window.studioCoreOnReady = () => {
        // Memoize the last payload so gauges() and the preview draw share one
        // parse+plan per recompute instead of parsing the payload twice.
        const raw = window.studioCoreReport;
        let key = null, val = null;
        window.studioCoreReport = (p) => { if (p === key) return val; val = raw(p); key = p; return val; };
        if (typeof window.recompute === "function") window.recompute();
      };
      // no-cache: always revalidate — a heuristically-cached module would
      // silently pin a stale cost model / encoder across deploys.
      const resp = await fetch(WASM, { cache: "no-cache" });
      if (!resp.ok) throw new Error("fetch " + WASM + " " + resp.status);
      const { instance } = await WebAssembly.instantiate(await resp.arrayBuffer(), go.importObject);
      go.run(instance); // never resolves (main blocks on select{}); do not await
    } catch (e) { console.warn("studio-core unavailable, using JS estimate:", e.message); }
  }
  boot();
})();
