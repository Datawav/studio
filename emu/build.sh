#!/usr/bin/env bash
# Build the SeedHammer II firmware emulator to emu.wasm. The emulator is a
# GOOS=js compile of seedhammer.com/gui, so it needs the firmware module.
# go.mod replaces seedhammer.com with ./firmware; this points that at the
# checkout given by FIRMWARE_DIR (Studio CI checks the firmware out at a
# pinned SHA; locally, point it at your clone). emu.wasm and wasm_exec.js are
# build outputs, never committed.
set -euo pipefail
cd "$(dirname "$0")"

: "${FIRMWARE_DIR:?set FIRMWARE_DIR to a seedhammer firmware checkout}"
FIRMWARE_DIR=$(cd "$FIRMWARE_DIR" && pwd)

if [ -e firmware ] && [ ! -L firmware ]; then
  echo "error: firmware exists and is not a symlink; move it aside" >&2
  exit 1
fi
rm -rf firmware
ln -s "$FIRMWARE_DIR" firmware

GOROOT=$(go env GOROOT)
install -m 644 "$GOROOT/lib/wasm/wasm_exec.js" wasm_exec.js
GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o emu.wasm .

echo "built emu.wasm ($(wc -c < emu.wasm) bytes) from firmware $FIRMWARE_DIR"
