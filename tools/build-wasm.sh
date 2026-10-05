#!/bin/sh
# Rebuild vendor/esp32sim.wasm: esp32sim at a pinned revision plus our Cardputer ADV patch.
#
#   tools/build-wasm.sh            # clone into .build/esp32sim, patch, build, copy
#
# Needs git and a rustup toolchain (stable, 1.78 or newer); the wasm32-unknown-unknown target
# is added automatically. Takes about a minute after the first build.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REV=6d959ce26189bb010e133e51ff1650dc4f414477
SRC="$ROOT/.build/esp32sim"

if [ ! -d "$SRC/.git" ]; then
  git clone https://github.com/joakimeriksson/esp32sim "$SRC"
fi
cd "$SRC"
git fetch -q origin "$REV" 2>/dev/null || git fetch -q origin
git checkout -q -f "$REV"
git clean -q -fd
git apply "$ROOT/vendor/esp32sim-patches/cardputer-adv.patch"
tools/wasm-build.sh
cp web/wasm/esp32sim.wasm "$ROOT/vendor/esp32sim.wasm"
cp web/wasm/jit.mjs "$ROOT/src/jit.mjs"
echo "updated vendor/esp32sim.wasm"

# The mask ROM is Espressif's (Apache-2.0); fetch it only if it is missing.
if [ ! -f "$ROOT/vendor/esp32s3_rev0_rom.elf" ]; then
  tools/fetch-demo-assets.sh --no-linux
  cp web/wasm/fw/esp32s3_rev0_rom.elf "$ROOT/vendor/"
fi
