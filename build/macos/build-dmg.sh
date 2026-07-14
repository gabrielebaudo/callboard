#!/bin/bash
# Builds dist/Callboard-arm64.dmg and dist/Callboard-x64.dmg -- the
# classic drag-and-drop disk image: Callboard.app on the left, an
# Applications-folder alias on the right, drag one onto the other to
# install. No installer script, no terminal, no LaunchAgent -- Callboard
# is just an app you run, and once running it lives in the menu bar (see
# src/tray.js). Run after: npm run build:mac
#
# One DMG per arch because build-app.sh now emits one bundle per arch
# (see its header comment for why) -- a user downloads/installs whichever
# matches their Mac.
#
# Requires create-dmg (brew install create-dmg) for the positioned
# drag-and-drop layout. Falls back to a plain hdiutil dmg (app + link,
# default Finder layout) if create-dmg isn't present or bails.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"

bash "$ROOT_DIR/build/macos/build-app.sh"

build_dmg() {
  local arch="$1" # arm64 | x64
  local app_dir="$DIST_DIR/Callboard-$arch.app"
  local stage_dir="$DIST_DIR/dmg-stage-$arch"
  local dmg_path="$DIST_DIR/Callboard-$arch.dmg"
  local icns="$app_dir/Contents/Resources/AppIcon.icns"

  # Stage holds only the app -- create-dmg synthesizes the Applications
  # alias itself via --app-drop-link, and hdiutil's fallback adds one below.
  rm -rf "$stage_dir" "$dmg_path"
  mkdir -p "$stage_dir"
  cp -R "$app_dir" "$stage_dir/Callboard.app"

  local made_dmg=0
  if command -v create-dmg >/dev/null 2>&1; then
    # create-dmg exits non-zero on cosmetic AppleScript/Finder hiccups (no
    # GUI session, etc.) even after writing a valid dmg, so don't let -e
    # kill the script here -- check for the file afterwards instead.
    create-dmg \
      --volname "Callboard" \
      ${icns:+--volicon "$icns"} \
      --window-pos 200 120 \
      --window-size 640 400 \
      --icon-size 128 \
      --icon "Callboard.app" 160 200 \
      --app-drop-link 480 200 \
      --no-internet-enable \
      "$dmg_path" \
      "$stage_dir" && made_dmg=1 || true
    [ -f "$dmg_path" ] && made_dmg=1
  fi

  if [ "$made_dmg" -eq 0 ]; then
    echo "[build-dmg] create-dmg unavailable/failed -- building plain dmg with hdiutil ($arch)" >&2
    # Add the Applications alias by hand so the fallback dmg is still
    # drag-and-drop, just without the positioned/background layout.
    ln -s /Applications "$stage_dir/Applications"
    hdiutil create -volname "Callboard" -srcfolder "$stage_dir" -ov -format UDZO "$dmg_path"
  fi

  rm -rf "$stage_dir"
  echo "Built $dmg_path"
}

build_dmg arm64
build_dmg x64
