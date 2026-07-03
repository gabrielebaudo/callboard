#!/bin/bash
# Builds dist/Callboard.dmg -- the classic drag-and-drop disk image:
# Callboard.app on the left, an Applications-folder alias on the right,
# drag one onto the other to install. No installer script, no terminal,
# no LaunchAgent -- Callboard is just an app you run, and once running it
# lives in the menu bar (see src/tray.js). Run after: npm run build:mac
#
# Requires create-dmg (brew install create-dmg) for the positioned
# drag-and-drop layout. Falls back to a plain hdiutil dmg (app + link,
# default Finder layout) if create-dmg isn't present or bails.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
STAGE_DIR="$DIST_DIR/dmg-stage"
DMG_PATH="$DIST_DIR/Callboard.dmg"
ICNS="$DIST_DIR/Callboard.app/Contents/Resources/AppIcon.icns"

bash "$ROOT_DIR/build/macos/build-app.sh"

# Stage holds only the app -- create-dmg synthesizes the Applications
# alias itself via --app-drop-link, and hdiutil's fallback adds one below.
rm -rf "$STAGE_DIR" "$DMG_PATH"
mkdir -p "$STAGE_DIR"
cp -R "$DIST_DIR/Callboard.app" "$STAGE_DIR/"

made_dmg=0
if command -v create-dmg >/dev/null 2>&1; then
  # create-dmg exits non-zero on cosmetic AppleScript/Finder hiccups (no
  # GUI session, etc.) even after writing a valid dmg, so don't let -e
  # kill the script here -- check for the file afterwards instead.
  create-dmg \
    --volname "Callboard" \
    ${ICNS:+--volicon "$ICNS"} \
    --window-pos 200 120 \
    --window-size 640 400 \
    --icon-size 128 \
    --icon "Callboard.app" 160 200 \
    --app-drop-link 480 200 \
    --no-internet-enable \
    "$DMG_PATH" \
    "$STAGE_DIR" && made_dmg=1 || true
  [ -f "$DMG_PATH" ] && made_dmg=1
fi

if [ "$made_dmg" -eq 0 ]; then
  echo "[build-dmg] create-dmg unavailable/failed -- building plain dmg with hdiutil" >&2
  # Add the Applications alias by hand so the fallback dmg is still
  # drag-and-drop, just without the positioned/background layout.
  ln -s /Applications "$STAGE_DIR/Applications"
  hdiutil create -volname "Callboard" -srcfolder "$STAGE_DIR" -ov -format UDZO "$DMG_PATH"
fi

echo "Built $DMG_PATH"
