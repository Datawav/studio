# wasmemu — browser firmware emulator

Runs the unmodified SeedHammer II GUI (`seedhammer.com/gui`) as WebAssembly on
a canvas. It is a `GOOS=js` build of the real firmware, so what you see is what
the device draws: the same screens, the same scan funnel, the same curves
engraving planner. SeedHammer Studio embeds it as a tab; `index.html` is a
standalone host for local runs.

## Build

```
FIRMWARE_DIR=~/seedhammer ./build.sh   # writes ./emu.wasm (git-ignored) and ./wasm_exec.js
cp emu.wasm ..                         # the page serves the repo-root copy
```

`emu.wasm` and `wasm_exec.js` are build outputs, never committed. The Pages
workflow builds them from the firmware checkout pinned by `FIRMWARE_REF` — a
sync index like `0.1`, tagged on the firmware repo, one per firmware/Studio
sync point — and
stages `emu/emu.wasm` into the deployed site root; for a local run you must
copy it to the repo root yourself (the page fetches `./emu.wasm`), or the tab
keeps serving a stale build. `wasm_exec.js` must come from the same Go that
built `emu.wasm`. `../install.sh` runs this build plus `core/`, keeps the
root copy in lockstep, and stamps the firmware ref into
`../.wasm-provenance`.

## Host bridge

The host page registers a few `window` globals the emulator calls (or calls
into):

- `seedhammerBlit(pixels, x, y, w, h)` — Go paints a dirty screen chunk.
- `seedhammerTouch(x, y, pressed)` — the only navigation input; SeedHammer II is
  a touch device.
- `seedhammerSynthTap(bytes)` — deliver a complete NDEF message as if a tag were
  scanned. The host builds it: a `seedhammer.com:curves` record for a Studio
  editor payload, or a Well-Known Text record for a seed / descriptor / plain
  text. `Platform.NFCReader` parses it back through the production `nfc/ndef`
  readers, so the firmware scan funnel runs unchanged.

## Status / follow-ups

- Ported off the retired SH2E `engrave/wire` format onto `curves` (2026-07-20).
  Boots and renders the live firmware UI.
- The offline SVG plate-dump panel from the old combined sim is not carried yet;
  the emulator renders everything on the canvas.
- The interactive tap→engrave flow is wired; drive it into the scan screen to
  exercise it end to end.
