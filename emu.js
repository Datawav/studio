// emu.js — the SeedHammer tab: the real firmware GUI compiled to WebAssembly,
// running on a canvas. It boots lazily (the wasm is several MB, fetched only
// when the tab first opens), paints the device screen, forwards touch as the
// device's only navigation input, and taps in the plate you composed on the
// editor tabs as a synthetic NFC scan (via nfc-bus.js).
"use strict";
(function () {
  const WASM_URL = "emu.wasm";
  const EXEC_URL = "wasm_exec.js";

  let state = "idle"; // idle | booting | ready | error
  let canvas, ctx, statusEl;
  let firstFrame = false;
  let pending = null; // curves payload queued to tap once the device is up
  let lastFed = null; // last payload actually tapped, to skip redundant re-taps
  let installed = false; // canvas/listeners installed once, survives boot retries

  function setStatus(m) { if (statusEl) statusEl.textContent = m; }

  function installCanvas() {
    if (installed) return; // once only, or a boot retry double-binds the pointer listeners
    installed = true;
    canvas = document.getElementById("emuScreen");
    statusEl = document.getElementById("emuStatus");
    ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;

    // Go paints the firmware screen one dirty chunk per call.
    window.seedhammerBlit = (pixels, x, y, w, h) => {
      if (!firstFrame) { firstFrame = true; onFirstFrame(); }
      ctx.putImageData(new ImageData(pixels, w, h), x, y);
    };

    // Drag = the touch navigation the device uses; there is no other input.
    const at = (e) => {
      const r = canvas.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(canvas.width - 1, Math.floor((e.clientX - r.left) * canvas.width / r.width))),
        y: Math.max(0, Math.min(canvas.height - 1, Math.floor((e.clientY - r.top) * canvas.height / r.height))),
      };
    };
    let down = false;
    canvas.addEventListener("pointerdown", (e) => {
      down = true;
      canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
      const p = at(e);
      window.seedhammerTouch && window.seedhammerTouch(p.x, p.y, true);
    });
    window.addEventListener("pointerup", (e) => {
      if (!down) return;
      down = false;
      const p = at(e);
      window.seedhammerTouch && window.seedhammerTouch(p.x, p.y, false);
    });
    window.addEventListener("pointermove", (e) => {
      if (!down) return;
      const p = at(e);
      window.seedhammerTouch && window.seedhammerTouch(p.x, p.y, true);
    });

    installPlateSink();
  }

  // The firmware's engrave step hands the emulator the planned plate (via the
  // gui plateRecorder seam), which RecordPlate renders to an SVG resembling the
  // steel and pushes here. Display + download only — it never re-enters an NFC
  // path. Registered before the wasm boots so it's present when engrave fires.
  let plateUrl = null;
  function installPlateSink() {
    window.seedhammerPlateSVG = (svg) => {
      if (plateUrl) URL.revokeObjectURL(plateUrl);
      plateUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      const holder = document.getElementById("emuPlateSvg");
      if (holder) holder.innerHTML = '<img alt="Engraved plate preview" src="' + plateUrl + '">';
      const panel = document.getElementById("emuPlate");
      if (panel) panel.hidden = false;
    };
    const dl = document.getElementById("emuPlateDl");
    if (dl) dl.onclick = () => {
      if (!plateUrl) return;
      const a = document.createElement("a");
      a.href = plateUrl;
      a.download = "seedhammer-plate.svg";
      a.click();
    };
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("failed to load " + src));
      document.head.appendChild(s);
    });
  }

  async function boot() {
    if (state === "booting" || state === "ready") return;
    state = "booting";
    installCanvas();
    setStatus("Loading the firmware…");
    try {
      await loadScript(EXEC_URL); // defines the Go class
      const go = new Go();
      let instance;
      // no-cache: always revalidate — the browser's heuristic HTTP cache can
      // otherwise hold a stale firmware build for hours.
      try {
        const r = await WebAssembly.instantiateStreaming(fetch(WASM_URL, { cache: "no-cache" }), go.importObject);
        instance = r.instance;
      } catch (_) {
        // Fallback for hosts that don't serve application/wasm.
        const buf = await (await fetch(WASM_URL, { cache: "no-cache" })).arrayBuffer();
        const r = await WebAssembly.instantiate(buf, go.importObject);
        instance = r.instance;
      }
      state = "ready";
      go.run(instance); // runs the UI loop; does not resolve until the app exits
    } catch (e) {
      state = "error";
      setStatus("Could not load the emulator: " + e.message);
    }
  }

  function onFirstFrame() {
    setStatus("Drag to navigate — it's a touch device. Use “Load composed plate” to tap in your design.");
    if (pending != null) { doFeed(pending); pending = null; }
  }

  // doFeed taps a composed curves plate into the device as a synthetic scan.
  function doFeed(payload) {
    if (!payload || !window.NFCBus) return;
    if (window.NFCBus.feedEmu(payload)) {
      lastFed = payload;
      setStatus("Tapped your plate in as an NFC scan — watch the device read it.");
    }
  }

  // The payload is bytes (a fresh Uint8Array per recompute), so the
  // skip-redundant-retap check must compare content, not identity.
  function sameFeed(a, b) {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function queueOrFeed(payload, always) {
    if (state === "error") state = "idle";
    if (state === "idle") { pending = payload; boot(); return; }
    if (state === "booting") { pending = payload; return; }
    if (always || !sameFeed(payload, lastFed)) doFeed(payload);
  }

  // activate: called when the SeedHammer tab opens from an editor tab. Boots on
  // first open and taps in the current plate; on a later reopen it re-taps only
  // if the design changed, so returning to a device mid-flow doesn't disturb it.
  function activate(payload) { queueOrFeed(payload, false); }

  // feed: the explicit "Load composed plate" button — always re-taps.
  function feed(payload) { queueOrFeed(payload, true); }

  window.SeedHammerEmu = { activate, feed, boot };
})();
