#!/bin/bash
# Assembles dist/Callboard-arm64.app and dist/Callboard-x64.app from the
# pkg binaries in dist/. A real .app bundle (not a bare executable) is
# what makes Callboard show up in Spotlight/Launchpad and lets it be
# double-clicked from ~/Applications like any other Mac app.
# Run after: npm run build:mac
#
# ONE BUNDLE PER ARCH, ON PURPOSE -- this used to be a single universal
# Callboard.app whose CFBundleExecutable was a compiled dispatcher
# (build/macos/launcher.c) that `execv`'d into the arch-matching pkg
# binary. That broke macOS's Local Network privacy (TCC): `execv`
# REPLACES the process image, so the running binary was no longer the
# bundle's own executable -- `codesign -dv` showed its Info.plist as
# "not bound" -- and TCC had no bound app identity to attach
# NSLocalNetworkUsageDescription to, so QLab/vMix connections were
# silently denied from the built app (`npm start` only "worked" because
# Terminal.app was the already-approved responsible process). Signing
# the nested binary with the bundle's own identifier did NOT fix this --
# bundle-ID match alone isn't enough, the running image itself must be
# the bound bundle executable. A supervisor variant (parent process
# stays alive, `posix_spawn`s the nested binary as a child) was
# considered and rejected: whether TCC's responsible-process chain
# actually covers Local Network attribution for a spawned child is
# undocumented behavior, not a guaranteed contract -- confirmed via
# outside consult. Making the pkg binary itself the bundle's
# CFBundleExecutable removes the dispatcher (and the question) entirely:
# the running image IS the bound bundle, full stop. `pkg` can't fuse
# arm64/x64 into one true universal binary anyway (lipo corrupts the
# snapshot data pkg appends after the Mach-O, confirmed by hand), so two
# single-arch bundles was already the shape of the underlying binaries --
# this just stops fighting that with a dispatcher.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
VERSION="$(node -p "require('$ROOT_DIR/package.json').version")"

for f in "$DIST_DIR/callboard-arm64" "$DIST_DIR/callboard-x64"; do
  if [ ! -f "$f" ]; then
    echo "Missing $f -- run 'npm run build:mac' first." >&2
    exit 1
  fi
done

build_bundle() {
  local arch="$1" # arm64 | x64
  local app_dir="$DIST_DIR/Callboard-$arch.app"

  rm -rf "$app_dir"
  mkdir -p "$app_dir/Contents/MacOS" "$app_dir/Contents/Resources"

  # The pkg binary IS the bundle executable -- no dispatcher, no exec,
  # no nested Mach-O. This is the whole fix (see header comment above).
  cp "$DIST_DIR/callboard-$arch" "$app_dir/Contents/MacOS/callboard"
  chmod +x "$app_dir/Contents/MacOS/callboard"

  if command -v iconutil >/dev/null 2>&1 && [ -d "$ROOT_DIR/build/icons/AppIcon.iconset" ]; then
    iconutil -c icns "$ROOT_DIR/build/icons/AppIcon.iconset" -o "$app_dir/Contents/Resources/AppIcon.icns"
  fi

  cat > "$app_dir/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Callboard</string>
  <key>CFBundleDisplayName</key>
  <string>Callboard</string>
  <key>CFBundleIdentifier</key>
  <string>app.callboard</string>
  <key>CFBundleExecutable</key>
  <string>callboard</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$VERSION</string>
  <key>CFBundleVersion</key>
  <string>$VERSION</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <!-- No Dock icon / app switcher entry: this is a background server +
       menu bar icon, not a windowed app -- a Dock icon with nothing to
       show a window for reads as broken. -->
  <key>LSUIElement</key>
  <true/>
  <!-- Local Network permission (macOS 15+): Callboard serves the timeline
       to other devices and reads state from QLab/vMix -- all on the show
       LAN. Without this usage string macOS silently denies local-network
       access (LAN connections fail) and the app never even appears under
       System Settings > Privacy & Security > Local Network. Must be
       present BEFORE signing (editing the plist invalidates the
       signature). No mDNS/Bonjour anymore -- Connect screen is IP+QR
       only -- so no NSBonjourServices entry needed either. -->
  <key>NSLocalNetworkUsageDescription</key>
  <string>Callboard uses the local network to serve the timeline to other devices on the show LAN and read state from QLab or vMix.</string>
</dict>
</plist>
PLIST

  # Ad-hoc code signing (no paid Developer ID -- this is `--sign -`, a
  # free self-signature). On Apple Silicon an unsigned Mach-O is
  # SIGKILL'd on launch, so the bundle MUST carry at least an ad-hoc
  # signature to run on another Mac; a clean ad-hoc sign also avoids the
  # "app is damaged" Gatekeeper message (users get the bypassable
  # "unidentified developer" one instead). This does NOT get past
  # Gatekeeper -- first launch still needs a right-click > Open
  # (macOS <=14) or Privacy & Security > Open Anyway (macOS 15+). No
  # hardened runtime: only needed for notarization. Single binary, no
  # nested Mach-O to sign separately or --deep through -- that
  # nested-identity complexity went away with the dispatcher.
  codesign --remove-signature "$app_dir" 2>/dev/null || true
  codesign --force --identifier app.callboard --sign - "$app_dir/Contents/MacOS/callboard"
  codesign --force --sign - "$app_dir"
  codesign --verify --deep --strict "$app_dir" && echo "   ad-hoc signature OK ($arch)"

  echo "Built $app_dir"
}

build_bundle arm64
build_bundle x64
