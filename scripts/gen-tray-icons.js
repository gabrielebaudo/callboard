'use strict';

// Generates the icon assets checked into build/icons/ from the master
// Logo.svg at the repo root. Re-run after changing the design:
//   node scripts/gen-tray-icons.js
//
// Rasterizes via macOS's built-in `sips` (no extra install, but macOS-only
// -- consistent with the rest of the packaging pipeline, which already
// requires `iconutil` and only runs on a Mac, see build/macos/build-app.sh).
//
// Two source marks:
// - App icon (Dock/Launchpad/Finder/Start Menu/installer): Logo.svg is
//   full-bleed (background rect fills the entire 1024x1024), which is
//   correct for Windows -- no system mask there, "0% padding" is just
//   "don't shrink it down". macOS is different: since Big Sur, macOS
//   does NOT auto-mask app icons, so every well-formed mac icon bakes in
//   its OWN rounded-square background already sized/positioned to match
//   its sibling Dock/Finder icons -- per Apple's official template, that
//   means the background itself is only an 824x824 square (radius
//   185.4), centered with a 100px gutter on all sides of the 1024x1024
//   canvas (confirmed via Apple Developer Forums thread 670578). A
//   full-bleed 1024x1024 background, as Logo.svg has, reads visibly
//   larger/more zoomed-in than every other Dock icon next to it -- so
//   the mac iconset renders a scaled-down (824/1024 = 0.8046875) +
//   inset (+100,+100) copy of the whole design instead of Logo.svg raw.
// - Tray mark (menu bar / system tray, 16-22px): the outer ring path only,
//   solid white on transparent, no background rect and no inner
//   playhead/track-bar detail -- those are a few px wide in the full
//   design and disappear into noise at tray size. White + alpha (no
//   background) is also what lets it read on both light and dark menu
//   bars.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const APP_ICON_SVG = path.join(ROOT, 'Logo.svg');
const outDir = path.join(ROOT, 'build', 'icons');
const iconsetDir = path.join(outDir, 'AppIcon.iconset');
fs.mkdirSync(iconsetDir, { recursive: true });

// Just the outer "C" ring from Logo.svg, recolored solid white, no
// background rect and no inner playhead/bars -- see header note.
const TRAY_MARK_SVG = `<svg width="1024" height="1024" viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M509 112C627.171 112 733.374 163.244 806.599 244.723L751.144 295.222C691.637 228.797 605.2 187 509 187C329.507 187 184 332.507 184 512C184 691.493 329.507 837 509 837C606.977 837 694.827 793.644 754.413 725.072L804.905 781.149C731.741 861.54 626.264 912 509 912C288.086 912 109 732.914 109 512C109 291.086 288.086 112 509 112Z" fill="#FFFFFF"/>
</svg>
`;
const trayMarkSvgPath = path.join(os.tmpdir(), 'callboard-tray-mark.svg');
fs.writeFileSync(trayMarkSvgPath, TRAY_MARK_SVG);

// macOS-only inset copy of the full logo -- see header note. Apple's
// official numbers: 824x824 background centered in the 1024x1024 canvas,
// i.e. a uniform 824/1024 scale plus a 100px translate on every side.
const MAC_SAFE_SCALE = 824 / 1024;
const MAC_GUTTER = 100;
const logoSvgSource = fs.readFileSync(APP_ICON_SVG, 'utf8');
const logoInner = logoSvgSource.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const MAC_APP_ICON_SVG = `<svg width="1024" height="1024" viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg">
<g transform="translate(${MAC_GUTTER} ${MAC_GUTTER}) scale(${MAC_SAFE_SCALE})">
${logoInner}
</g>
</svg>
`;
const macAppIconSvgPath = path.join(os.tmpdir(), 'callboard-app-icon-mac.svg');
fs.writeFileSync(macAppIconSvgPath, MAC_APP_ICON_SVG);

function rasterize(svgPath, size) {
  const outPath = path.join(os.tmpdir(), `callboard-icon-${path.basename(svgPath, '.svg')}-${size}.png`);
  execFileSync('sips', ['-s', 'format', 'png', svgPath, '-z', String(size), String(size), '--out', outPath], { stdio: 'pipe' });
  return fs.readFileSync(outPath);
}

// Minimal ICO wrapping one or more PNG-format images (Vista+ supports PNG
// payloads inside ICO directly -- no need to hand-roll a BMP/AND-mask).
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  const dataParts = [];
  let offset = header.length + images.length * 16;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // width (0 means 256)
    entry[1] = size >= 256 ? 0 : size; // height
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(entry);
    dataParts.push(png);
  }

  return Buffer.concat([header, ...entries, ...dataParts]);
}

// ---- Tray mark: 16px + 32px (@2x), white ring on transparent -----------
const trayPng16 = rasterize(trayMarkSvgPath, 16);
const trayPng32 = rasterize(trayMarkSvgPath, 32);
fs.writeFileSync(path.join(outDir, 'tray-icon.png'), trayPng16);
fs.writeFileSync(path.join(outDir, 'tray-icon@2x.png'), trayPng32);
fs.writeFileSync(path.join(outDir, 'tray-icon.ico'), encodeIco([{ size: 32, png: trayPng32 }]));

// ---- App icon: iconset (macOS -- fed to `iconutil` by build-app.sh to --
// make AppIcon.icns), a standalone 256px PNG, and a multi-res .ico for
// Windows (taskbar/Start Menu tile/installer window each pick what fits).
const appIconSizes = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024]
];
// iconset uses the mac-inset render (see header note); ico/256/favicon
// below use the full-bleed one -- separate caches since sizes overlap.
const renderedMac = new Map();
for (const [filename, size] of appIconSizes) {
  if (!renderedMac.has(size)) renderedMac.set(size, rasterize(macAppIconSvgPath, size));
  fs.writeFileSync(path.join(iconsetDir, filename), renderedMac.get(size));
}

const renderedFull = new Map();
function full(size) {
  if (!renderedFull.has(size)) renderedFull.set(size, rasterize(APP_ICON_SVG, size));
  return renderedFull.get(size);
}
fs.writeFileSync(path.join(outDir, 'app-icon-256.png'), full(256));
fs.writeFileSync(
  path.join(outDir, 'app-icon.ico'),
  encodeIco([16, 32, 48, 256].map((size) => ({ size, png: full(size) })))
);

// ---- Browser favicon: same full app icon (background + ring + bars), --
// tab-sized rasters straight into public/ so index.html can link it.
const publicDir = path.join(ROOT, 'public');
fs.writeFileSync(path.join(publicDir, 'favicon-32.png'), full(32));
fs.writeFileSync(path.join(publicDir, 'favicon-16.png'), full(16));

console.log(`Wrote ${outDir}/tray-icon.png, tray-icon@2x.png, tray-icon.ico, app-icon.ico, app-icon-256.png`);
console.log(`Wrote ${iconsetDir}/ (10 sizes)`);
console.log(`Wrote ${publicDir}/favicon-16.png, favicon-32.png`);
