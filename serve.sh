#!/usr/bin/env bash
# Serve SeedHammer Studio locally at http://localhost:8788, loopback
# only. localhost is a secure context, so the service worker, the Copy
# buttons and the bridge fetch all behave exactly as on the hosted site.
#
# Assembles a fresh dist/ on every start (the same file set pages.yml
# deploys plus the local .wasm-provenance stamp; local-only files never
# get served), so a rebuilt wasm is never served stale. Override the port with
# STUDIO_PORT, remembering the origin must then be re-allowed in the
# bridge's SH_BRIDGE_ORIGINS.
set -euo pipefail
cd "$(dirname "$0")"

PORT=${STUDIO_PORT:-8788}

for f in emu/emu.wasm emu/wasm_exec.js studio-core.wasm; do
  [ -s "$f" ] || { echo "error: $f missing; run ./install.sh first" >&2; exit 1; }
done

rm -rf dist
mkdir -p dist/textplate
cp index.html glyphs.js sw.js manifest.webmanifest \
   icon.svg icon-192.png icon-512.png icon-maskable.png \
   nfc-bus.js emu.js canvas.js tracer.js studio-core.js dist/
cp emu/emu.wasm emu/wasm_exec.js studio-core.wasm dist/
cp textplate/index.html textplate/glyphs.js dist/textplate/
if [ -f .wasm-provenance ]; then cp .wasm-provenance dist/; fi

echo "SeedHammer Studio at http://localhost:$PORT (Ctrl-C stops)"
exec python3 -m http.server "$PORT" --bind 127.0.0.1 --directory dist
