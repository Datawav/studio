#!/usr/bin/env bash
# Build SeedHammer Studio's wasm from a firmware checkout and prepare
# local serving: ./serve.sh then http://localhost:8788.
#
#   ./install.sh [--firmware DIR]   build emu.wasm + studio-core.wasm
#   ./install.sh --verify           check the build outputs, mutate nothing
#
# The firmware checkout is found via --firmware, $SEEDHAMMER_DIR,
# ../seedhammer, or ~/seedhammer; when none exists it offers to clone
# the fork (an existing checkout is never pulled or otherwise touched).
# Wasm is built from that checkout's HEAD and the ref is stamped into
# .wasm-provenance.
set -euo pipefail
CALLER_PWD=$PWD   # a relative --firmware/SEEDHAMMER_DIR resolves against the caller's cwd
cd "$(dirname "$0")"

FORK_URL=https://github.com/Gangleri42/seedhammer

# The script cd's to its own directory above, so a relative $0 from the
# caller's cwd would dangle; the file is always ./<basename> after the cd.
usage() { sed -n '2,13p' "$(basename "$0")" | sed 's/^# \{0,1\}//'; }
fail() { echo "error: $*" >&2; exit 1; }

FW=${SEEDHAMMER_DIR:-}
VERIFY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --firmware)
      [ $# -ge 2 ] && [ -n "$2" ] || fail "--firmware needs a directory"
      FW=$2; shift 2 ;;
    --verify) VERIFY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# Verify inspects build outputs only; it needs no firmware checkout and
# must mutate nothing, so it runs before any resolution or cloning.
if [ "$VERIFY" = 1 ]; then
  st=0
  for f in emu/emu.wasm emu/wasm_exec.js studio-core.wasm wasm_exec.js .wasm-provenance; do
    if [ -s "$f" ]; then echo "OK       $f ($(wc -c <"$f") bytes)"
    else echo "FAIL     $f missing or empty (run ./install.sh)"; st=1; fi
  done
  if [ -s emu.wasm ] && cmp -s emu.wasm emu/emu.wasm; then
    echo "OK       root emu.wasm matches emu/emu.wasm"
  else
    echo "FAIL     root emu.wasm stale or missing vs emu/emu.wasm (run ./install.sh)"; st=1
  fi
  if command -v python3 >/dev/null 2>&1; then echo "OK       python3 present (serve.sh)"
  else echo "FAIL     python3 missing (serve.sh needs it)"; st=1; fi
  if [ -s .wasm-provenance ]; then sed 's/^/         /' .wasm-provenance; fi
  exit $st
fi

# The firmware go.mod identifies a checkout; anything else is a wrong dir.
is_firmware() { [ -f "$1/go.mod" ] && head -1 "$1/go.mod" | grep -q '^module seedhammer\.com$'; }

find_go() {
  if command -v go >/dev/null 2>&1; then command -v go
  elif [ -x "$HOME/.local/go/bin/go" ]; then echo "$HOME/.local/go/bin/go"
  else fail "no Go toolchain found; seedhammer/install.sh installs one, or install Go >= 1.21 (GOTOOLCHAIN=auto fetches the pinned go1.25.10)"
  fi
}

case $FW in ''|/*) : ;; *) FW=$CALLER_PWD/$FW ;; esac
if [ -z "$FW" ]; then
  for cand in ../seedhammer "$HOME/seedhammer"; do
    if is_firmware "$cand"; then FW=$cand; break; fi
  done
fi
if [ -z "$FW" ]; then
  echo "no firmware checkout found (looked at ../seedhammer and ~/seedhammer)"
  if [ -t 0 ]; then
    printf 'clone %s to ../seedhammer? [y/N] ' "$FORK_URL"
    read -r r
    case $r in y|Y) : ;; *) fail "declined; point me at one with --firmware DIR" ;; esac
  else
    fail "no terminal to confirm a clone; pass --firmware DIR"
  fi
  git clone "$FORK_URL" ../seedhammer
  FW=../seedhammer
fi
is_firmware "$FW" || fail "$FW is not a seedhammer firmware checkout (go.mod module mismatch)"
FW=$(cd "$FW" && pwd)

GO=$(find_go)
# go.mod in emu/ and core/ pins go 1.25.10; GOTOOLCHAIN=auto switches to
# it inside those dirs, so the version that really builds the wasm must
# be read from in there, not from the bootstrap go on PATH.
GO_ACTUAL=$(cd emu && "$GO" env GOVERSION)
echo "firmware: $FW (built from its current tip)"
echo "go:       $GO_ACTUAL (bootstrap: $("$GO" version | awk '{print $3}'))"

PATH=$(dirname "$GO"):$PATH FIRMWARE_DIR=$FW ./emu/build.sh
PATH=$(dirname "$GO"):$PATH FIRMWARE_DIR=$FW ./core/build.sh
# The page served from the repo root reads the root copies; keep them in
# lockstep with emu/ so the stale-root-copy trap can't spring.
cp emu/emu.wasm emu.wasm

if ref=$(git -C "$FW" rev-parse HEAD 2>/dev/null); then
  dirty=
  [ -n "$(git -C "$FW" status --porcelain --untracked-files=no)" ] && dirty=+dirty
  # The sync index the deployed site pins, when the build sits on one.
  version=$(git -C "$FW" describe --tags --always 2>/dev/null || echo unknown)
else
  ref=unknown-not-a-git-checkout
  dirty=
  version=unknown
fi
cat > .wasm-provenance <<EOF
firmware_version=$version$dirty
firmware_ref=$ref$dirty
go=$GO_ACTUAL
built=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

echo
echo "built. next: ./serve.sh  ->  http://localhost:8788"
echo "Send needs the NFC bridge with http://localhost:8788 in SH_BRIDGE_ORIGINS;"
echo "the bridge unit installed by seedhammer/install.sh already includes it."
