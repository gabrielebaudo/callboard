#!/bin/bash
# Assembles dist/Callboard.app from the pkg binaries in dist/. A real
# .app bundle (not a bare executable) is what makes Callboard show up in
# Spotlight/Launchpad and lets it be double-clicked from ~/Applications
# like any other Mac app. Run after: npm run build:mac
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
APP_DIR="$DIST_DIR/Callboard.app"
VERSION="$(node -p "require('$ROOT_DIR/package.json').version")"

for f in "$DIST_DIR/callboard-arm64" "$DIST_DIR/callboard-x64"; do
  if [ ! -f "$f" ]; then
    echo "Missing $f -- run 'npm run build:mac' first." >&2
    exit 1
  fi
done

rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"

cp "$DIST_DIR/callboard-arm64" "$APP_DIR/Contents/MacOS/callboard-arm64"
cp "$DIST_DIR/callboard-x64" "$APP_DIR/Contents/MacOS/callboard-x64"
chmod +x "$APP_DIR/Contents/MacOS/callboard-arm64" "$APP_DIR/Contents/MacOS/callboard-x64"

# `pkg` builds one executable per CPU architecture (there's no reliable
# way to fuse them into a single universal binary -- lipo corrupts the
# snapshot data pkg appends after the Mach-O, confirmed by hand). The
# bundle's actual CFBundleExecutable is this tiny dispatch script instead
# of a real Mach-O -- Finder/Launchpad/launchd only care that it's
# executable, not that it's a compiled binary.
cat > "$APP_DIR/Contents/MacOS/callboard" <<'LAUNCHER'
#!/bin/bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "$(uname -m)" in
  arm64) exec "$DIR/callboard-arm64" "$@" ;;
  x86_64) exec "$DIR/callboard-x64" "$@" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
LAUNCHER
chmod +x "$APP_DIR/Contents/MacOS/callboard"

if command -v iconutil >/dev/null 2>&1 && [ -d "$ROOT_DIR/build/icons/AppIcon.iconset" ]; then
  iconutil -c icns "$ROOT_DIR/build/icons/AppIcon.iconset" -o "$APP_DIR/Contents/Resources/AppIcon.icns"
fi

cat > "$APP_DIR/Contents/Info.plist" <<PLIST
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

# Ad-hoc code signing (no paid Developer ID -- this is `--sign -`, a free
# self-signature; same approach as the Lumentrace desktop builds). On
# Apple Silicon an unsigned Mach-O is SIGKILL'd on launch, so the bundle
# MUST carry at least an ad-hoc signature to run on another Mac; a clean
# ad-hoc sign also avoids the "app is damaged" Gatekeeper message (users
# get the bypassable "unidentified developer" one instead). This does NOT
# get past Gatekeeper -- first launch still needs a right-click > Open
# (macOS <=14) or Privacy & Security > Open Anyway (macOS 15+). No
# hardened runtime: it's only needed for notarization and would block the
# unsigned nested binaries under library validation.
#
# --deep signs the two nested pkg Mach-Os in one pass; remove any stale
# signature first so re-runs are clean.
codesign --remove-signature "$APP_DIR" 2>/dev/null || true
codesign --force --deep --sign - "$APP_DIR"
codesign --verify --deep --strict "$APP_DIR" && echo "   ad-hoc signature OK"

echo "Built $APP_DIR"
