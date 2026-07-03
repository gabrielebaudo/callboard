# Callboard

**Callboard is a free, open-source, read-only companion app for QLab and
vMix.** It connects to whichever one is running your show, reads its
live timeline and cue state over the network, and shows it in a browser
to everyone else on the venue's LAN — lighting, sound, video, stage
management — without giving any of them a way to touch the show itself.

Think of it as a shared callboard for the booth: the operator's QLab
workspace or vMix instance stays the single source of truth, and every
device on the network gets a live, read-only view of what's playing,
what's next, and which department's cue is coming up — on a phone,
tablet, or laptop, no install required beyond opening a browser tab.

- **QLab**: live playhead, per-cue department tags (`[LX]`, `[AUDIO]`,
  `[VIDEO]`, ...), a running-order table with two-stage "coming up"
  warnings.
- **vMix**: live Program/Preview readout — what's on air and what's
  cued next.
- **Read-only, always.** Callboard only ever queries state; it has no
  code path that can start, stop, or edit a cue. See
  [Safety](#safety).

## Setup

```bash
npm install
```

## Run

Mock mode (no backend needed, simulated markers + moving playhead — use
this to check the UI):

```bash
npm run mock
```

Live mode (QLab or vMix must be running, reachable, and configured in
the Settings drawer):

```bash
npm start
```

Then open `http://localhost:3000` locally, or `http://<host-ip>:3000`
from another device on the same LAN.

## Configuration

All configuration is web-based: open the **Settings** drawer (gear icon,
top right). Pick the active backend (QLab or vMix), set its connection
details, department list, and warning thresholds. Saves persist to
`config.json` and hot-reload the connection — no restart needed.
Timelines/tracks are always auto-discovered; there's no name to
configure for them.

## Packaged app (end users)

Ships as a self-contained desktop app — no Node install, no terminal. It
runs a background server and lives in the **menu bar** (macOS) / **system
tray** (Windows); its only UI is the browser page above. The tray icon
has **Open Callboard** (opens the interface) and **Quit**. It's an app
you launch and that stays running until you quit it — it does not
auto-start on login.

Build the installers (on a Mac with `create-dmg` and `makensis` from
Homebrew):

```bash
npm run package:mac   # -> dist/Callboard.dmg  (drag Callboard.app to Applications)
npm run package:win   # -> dist/CallboardSetup.exe  (NSIS installer)
```

Both builds are **ad-hoc signed, not notarized** (no paid Apple/Microsoft
developer certificate). The ad-hoc signature is what lets the Mac build
run at all on Apple Silicon and avoids the "app is damaged" error, but
first launch still needs a one-time manual bypass:

- **macOS ≤14:** right-click the app → **Open** → **Open**.
- **macOS 15+ (Sequoia):** double-click, then System Settings → **Privacy
  & Security** → **Open Anyway**.
- **Windows:** **More info → Run anyway** (SmartScreen).

On first launch macOS also asks to allow **Local Network** access (for
serving other devices on the show LAN) — allow it, or other devices
won't be able to reach Callboard.

Reaching it from other devices: Settings → **Connect** lists every LAN
IP Callboard is reachable on, each with a QR code.

## QLab setup

1. Preferences → Network → enable OSC input, TCP, port 53000. **View**
   privileges are enough (Callboard never edits or controls cues).
2. Callboard auto-discovers two kinds of tracks in your cue list, no
   naming convention required for either:
   - **Timelines** — one Group cue per song/scene, each in **Timeline
     mode**. Marker cues (Memo or Network) inside the group, named
     `[DEPT] Title` (e.g. `[LX] Cue 45 - Fade caldo 5s`), show up as
     department-tagged notes. Drag them on QLab's Timeline to position
     them — that sets the cue's `preWait`, which is what Callboard reads
     as its position.
   - **Plain tracks** — any other top-level cue with a duration (e.g. an
     audio file cue not inside a Timeline group). These show up too, just
     as a name and a running time — no notes, no department tags, since
     there's nothing inside them to tag.

Before trusting live data on a new show file, run:

```bash
node scripts/osc-debug.js
```

It dumps raw OSC replies against the real show and confirms `preWait`
reflects each marker's dragged position, `actionElapsed` moves during
playback, and every real Timeline Group and plain track is discovered.

## vMix setup

1. vMix's TCP API is on by default (Settings → Web Controller), port
   8099.
2. No naming convention or per-input setup: Callboard always shows
   whatever's currently on **Program** and whatever's in **Preview**.

Before trusting live data, run:

```bash
node scripts/vmix-debug.js
```

## Tests

```bash
npm test
```

## Safety

- Read-only: QLab — `/workspaces`, `/connect`, `/updates 1`,
  `/cueLists`, `valuesForKeys`; vMix — `XML` only. No transport or edit
  commands, ever, on either backend.
- On backend disconnect, the browser shows an offline banner and freezes
  the last known state — it does not guess or extrapolate forever.
- Markers/cues are never stored anywhere but the backend itself — no
  marker database, no write path. Editing a QLab marker means dragging
  its cue in QLab.
