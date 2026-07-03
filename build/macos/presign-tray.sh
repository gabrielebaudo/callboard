#!/bin/bash
# Ad-hoc signs the systray helper binaries in node_modules BEFORE `pkg`
# bundles them. The `systray` package ships its native menu-bar helper
# unsigned; on Apple Silicon an unsigned Mach-O is killed on launch, so
# on any Mac other than the one that built it the tray icon would silently
# never appear. pkg embeds these files byte-for-byte and systray writes
# them back out verbatim at runtime, so a signature applied here survives
# all the way to the extracted copy in ~/.cache. Must run before
# `npm run build:mac` (package:mac wires it in). Mac-only (codesign).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TRAYBIN="$ROOT_DIR/node_modules/systray/traybin"

for bin in tray_darwin tray_darwin_release; do
  if [ -f "$TRAYBIN/$bin" ]; then
    codesign --force --sign - "$TRAYBIN/$bin"
    echo "[presign-tray] signed $bin"
  fi
done
