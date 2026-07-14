# CLAUDE.md — Show Timeline Viewer

## What this is

Local Node app on the show LAN: reads a live show-control app's
timeline/track state, serves a browser timeline (live playhead,
department filters where the backend has cue markers) to the team.
Show-control app stays master of the show. **Read-only** — never
writes/edits/triggers anything in the configured backend.

**Multiple backends**, one UI: QLab, vMix, more later (VLC, etc.).
Operator picks the active one in Settings; connection fields and home
screen adapt to what it offers (see "Backends").

**Many timelines** per show — one per song/scene, not one continuous
cue. App auto-discovers all, follows whichever is live; operator can
browse any other without losing track of live (see "Multi-timeline
model").

## Architecture

```
Backend app (QLab: TCP OSC 53000 / vMix: TCP API 8099)
  ↕
src/backends/*.js    — one file per backend, same contract
src/backends/index.js — registry: type string -> factory
src/state.js          — in-memory show state: array of timelines (no marker DB)
src/settingsStore.js  — config.json, read/write, validated (per-backend sections)
src/server.js         — Express + Socket.IO, serves public/ and the API
  ↕
public/app.js         — browser UI (vanilla JS, no build step)
```

`state.js` is backend-neutral by design: `time`, `currentTime`,
`duration`, `isRunning`/`isPaused`, `kind`, `status` mean the same thing
regardless of backend. Each backend converts its own vocabulary
(QLab's `preWait`/`actionElapsed`/`colorName`; vMix's
`position`/`duration`/`state`) into these generic fields before writing
to `state`, so nothing downstream needs to know which backend is running.

## Backends

Every backend module exports a factory
`({ store, state, onStateChange }) => { start, stop, applyConfig,
refreshMarkersFor, refreshAll, capabilities }`:

- `start()` / `stop()` — connect/poll; tear down cleanly (used when the
  operator switches backend in Settings without restarting the process).
- `applyConfig()` — called after a Settings save; reconnects only if
  host/port actually changed.
- `refreshMarkersFor(id)` — full cue/marker detail for one timeline on
  demand (client previewing a non-live one). No-op if no markers.
- `refreshAll()` — manual refresh (UI's Refresh button).
- `capabilities: { markers, departments }` — whether this backend has
  cue/marker detail worth showing (department filters, marker flags,
  running-order table). A `markers: false` backend still drives the
  track strip, clock, and playhead — just nothing below.

`src/server.js` picks a backend via `src/backends/index.js`'s registry,
keyed by `config.json`'s `backend.type`. Both `qlab` and `vmix`
connection sections always exist in `config.json`, so switching in
Settings doesn't lose the other one's host/port.

### QLab (`src/backends/qlab.js`)

- Transport: `osc` npm package's `TCPSocketPort` (not `osc-js` — no TCP
  support there). QLab's TCP OSC uses SLIP framing, which
  `TCPSocketPort` implements natively.
- Requests/replies correlated by OSC address: QLab echoes the requested
  address in each reply's JSON body (`{workspace_id, address, status,
  data}`).
- One `valuesForKeys` call per cue fetches everything needed (name,
  type, colorName, notes, preWait, duration, etc.).
- `capabilities: { markers: true, departments: true }`.

### vMix (`src/backends/vmix.js`)

- Transport: raw TCP text on port **8099** (same as Companion),
  `\r\n`-terminated, no OSC. Poll reply: `XML <len>\r\n<payload>`,
  `<len>` = exact byte length.
- No continuous playhead subscription exists (`SUBSCRIBE
  ACTS`/`TALLY` cover tally/shortcut state, not media position) — polls
  full `XML` snapshot on one timer (`vmix.pollMs`, default 200ms); one
  reply carries every input, so no QLab-style tiering needed.
- Surfaces **exactly two synthetic tracks**: whatever's on **Program**
  (`<active>`) and **Preview** (`<preview>`) — not every input with a
  duration. A session routinely has 100+ inputs; this backend is a
  remote "what's on air" readout, not a running order. No duration
  filter: Program shows even as a still image, identifiable by name.
- Uses **stable synthetic ids** (`vmix-program`, `vmix-preview`), never
  the input's own GUID — cutting between clips changes Program/Preview
  constantly; keying on the real GUID would make the track
  disappear/reappear as "new" every cut (DOM churn, lost selection).
  Same card updates name/time in place across a cut.
- **Program is always the live slot** (green LIVE badge,
  `activeTimelineId`) — structural fact, independent of playback state.
  **Preview never gets that badge**, even if cued/playing. Both slots'
  `isRunning` DOES track real playback; Preview shows a plain gray
  "PREVIEW" label (`VMIX_PREVIEW_ID` in `app.js`) so an operator sees
  what's queued regardless.
- Only `state="Running"` counts as activity — `isPaused` always
  `false` for vMix. Confirmed empirically (live 107-input session,
  2026-07): `state="Paused"` is vMix's default RESTING state for every
  idle clip, not a real "paused mid-show" signal like QLab's
  `isPaused`.
- `capabilities: { markers: false, departments: false }` — no
  cue/marker concept, so client hides department filters, marker
  flags, running-order table (see "UI conventions"); no "UP NEXT" badge
  either (gated on `capabilities.markers` in `app.js`).
- vMix input **Categories** are **not exposed in the TCP/XML API** —
  confirmed by grepping raw XML from a live session: every `<input>`
  carries `key/number/type/title/shortTitle/state/position/duration/loop`,
  no category. Not buildable as a settings filter.
- `position`/`duration` are milliseconds; converted to seconds before
  reaching `state.js`.

## Multi-timeline model

- **Discovery**: backend-specific. QLab: every Group cue whose `mode`
  reads `3` ("Timeline" mode in QLab's inspector; confirmed via
  `scripts/osc-debug.js`), cue-list top-to-bottom order. vMix: always
  exactly two — Program and Preview. No hand-configured names either way.
- **QLab tiered polling** (`qlab.js`), to bound OSC traffic as track
  count grows: Tier A (`playheadPollMs`, default 150ms) — only the
  active timeline's `actionElapsed`/`isRunning`/`isPaused`, for a smooth
  clock. Tier B (`statusPollMs`, default 1000ms) — every timeline's same
  cheap status fields, to decide which is active and derive
  upcoming/live/done. Full per-cue marker detail (names, departments,
  notes) fetched only for the active timeline and any timeline a client
  explicitly previews (`selectTimeline` event) — never every timeline
  every cycle. vMix needs no tiering: one `XML` poll returns everything.
- **Active timeline**: QLab — whichever discovered timeline reports
  `isRunning || isPaused`; none active → nothing "live" (icon/playhead
  hide). Multiple active at once (operator error) → first by discovery
  order wins, accepted limitation. vMix — always Program, structural,
  not derived from playback state.
- **Status heuristic** (`upcoming`/`live`/`done`): `live` while
  running/paused; `done` once ever run/paused and isn't anymore;
  `upcoming` otherwise. Sticky flag `everStarted`, not derived from
  `currentTime`/`duration` (whether QLab's `actionElapsed` persists or
  resets after a manual stop wasn't confirmed empirically). A track
  stopped early also reads "done"; a server restart forgets all
  `everStarted` flags. Both accepted limitations for a booth tool. (UI
  no longer dims "done" tracks — see "UI conventions".)
- **Client browsing**: browser tracks `activeTimelineId` (server),
  `selectedTimelineId` (on screen), `followLive` (default on, keeps
  them in sync). Clicking a non-active timeline turns `followLive` off
  to preview it; "Back to live" restores it.

## Marker model (QLab only — see capabilities.markers)

- A cue's **timeline position** = its `preWait` value (dragging a cue
  on QLab's Timeline view sets `preWait`; no separate "position"
  property — confirmed empirically).
- Playhead = active Timeline Group's `actionElapsed`, polled every
  `playheadPollMs` (Tier A above). `/update` OSC messages are
  event-driven reload signals, not a continuous time feed.
- **Department comes only from the `[DEPT] Title` name prefix.** No
  color-based fallback: unrecognized prefix → `UNCATEGORIZED`. (An
  earlier iteration also mapped cue *colors* to departments; removed as
  unnecessary.)
- A marker's *displayed* color reflects QLab's own `colorName` when set
  (fixed swatch in `app.js`), else the department color. Cosmetic only.
- vMix has no cue/marker concept — none of this applies when it's
  active.

## Configuration

All web-based, not hand-edited JSON: Settings drawer (gear icon, top
right). **Show control** section picks the active backend (QLab /
vMix); connection fields and marker-only sections (Warning thresholds,
Departments) show/hide to match. Timelines/tracks are always
auto-discovered — no name field for either backend. Saves go through
`POST /api/settings`, persist to `config.json`, hot-reload the
connection — no restart needed; switching backend type tears down the
old connection and starts the new one in place. `config.json` is still
the file on disk; edit by hand only for first-time setup or scripting.

## Running

```bash
npm install
npm run mock        # simulated data, no backend needed — check the UI
npm start            # live, backend app must be open with its API enabled
node scripts/osc-debug.js    # dumps raw OSC replies against a real QLab show
node scripts/vmix-debug.js   # dumps raw XML/parsed inputs against a real vMix instance
```

Before trusting live data on a new show/session, run the matching
debug script:
- **QLab**: `osc-debug.js` — confirm `preWait` reflects each marker's
  dragged position, `actionElapsed` moves when a Timeline Group plays,
  and the `mode` scan prints `3` for each real Timeline Group (the
  empirical fact discovery depends on).
- **vMix**: `vmix-debug.js` — confirm which inputs report a nonzero
  `duration` (those become tracks), `position`/`duration` really are
  milliseconds and count up during playback, and `<active>` plus
  `state="Running"` matches what's actually on Program.

## QLab-side setup

1. Preferences → Network → enable OSC input, TCP, port 53000. **View**
   privileges are enough (never edits or controls cues).
2. One Group cue per song/scene, each in **Timeline mode** —
   auto-discovered, no naming convention needed for the groups.
3. Marker cues (Memo or Network) inside each group, named `[DEPT] Title`,
   e.g. `[LX] Cue 45 - Fade caldo 5s`. Drag them on QLab's Timeline to
   position.

## vMix-side setup

1. vMix's TCP API is on by default (Settings → Web Controller, or
   confirm port 8099 is reachable — no opt-in like QLab's OSC toggle).
2. No naming convention or per-input setup: the viewer always shows
   whatever's on Program and in Preview, any input type.

## Safety / non-negotiables

- Only read-only requests, ever: QLab — `/workspaces`, `/connect`,
  `/updates 1`, `/cueLists`, `valuesForKeys`; vMix — `XML` only. No
  transport or edit commands, ever, on either backend.
- On backend disconnect: show a "[Backend] is offline" banner, freeze
  last known state, keep retrying. Never guess.
- Markers are never stored anywhere but the backend itself — no marker
  database. Editing a QLab marker means dragging its cue in QLab.

## UI conventions

- English only, interface voice (active verbs, plain language, no
  filler). See `public/app.js` / `index.html` for current copy.
- Dark, high-contrast theme for booth use in low light. Playhead is a
  fixed near-white color, outside the department palette, never
  confused with a gel color.
- Track under the ruler fills with a fine time grid (After
  Effects/Premiere convention), not a fake waveform — no backend here
  exposes a real one, and a decorative one previously read as real
  audio data.
- Timeline cards never dim once "done" — `everStarted` is sticky and
  never resets, so a test-triggered track wouldn't stay dimmed forever.
  Only live/paused/up-next get visual treatment.
- `capabilities.markers: false` (vMix) drops the department-filter row
  and running-order section from layout entirely, not just their
  content (`body.no-markers` in `style.css`) — home screen there is
  clock + track strip + timeline + ruler + playhead only.
- The big timeline's playhead/clock (`renderPlayhead` in `app.js`)
  shows/moves based on the *selected* track's own
  `isRunning`/`isPaused`, not whether it's the globally "active"
  timeline. Equivalent on QLab, but vMix allows a non-Program track to
  be `isRunning` too (multiple channels can play at once) — gating on
  active-id used to freeze the playhead for anything playing
  off-Program.

## macOS build (`build/macos/`)

- Ships **two single-arch bundles** — `Callboard-arm64.app`,
  `Callboard-x64.app` — not one universal app. The pkg binary itself is
  each bundle's `CFBundleExecutable`; no dispatcher. An earlier
  universal-app version used a compiled launcher that `execv`'d into
  the arch-matching pkg binary, but `execv` replaces the process image,
  so the running binary was no longer the bound bundle executable —
  macOS's Local Network TCC permission couldn't attach to it, so
  QLab/vMix connections were silently denied from the built app (only
  `npm start`/Terminal worked, since Terminal already had approval).
  Per-arch bundles remove the dispatcher and the problem: the running
  image is always the bound bundle exec.
- `pkg` can't fuse arm64/x64 into a true universal binary (`lipo`
  corrupts pkg's appended snapshot data, confirmed by hand) — hence two
  bundles rather than one.
- Ad-hoc signed (`--sign -`, no paid Developer ID) — required so
  Apple Silicon doesn't SIGKILL the unsigned Mach-O on launch. Still
  requires a first-launch Gatekeeper bypass (right-click > Open on
  macOS ≤14, Privacy & Security > Open Anyway on macOS 15+).
- `build-dmg.sh` produces one DMG per arch to match.

## Git

- `main`: released baselines only.
- `dev`: active work. Merge to `main` + tag when cutting a release.
- No remote configured yet.

## Deferred / not implemented

- Real waveform (needs the media file path via the backend's API +
  server-side decoding).
- Manual reordering of the timeline list (discovery order used as-is;
  reordering would fight the backend as master of show order).
- Graceful handling of multiple QLab Timeline Groups reporting active
  at once (first by cue-list order wins deterministically).
- Persisting `everStarted`/status across server restarts (in-memory
  only today).
- Any form of writing back to any backend.
- Additional backends (VLC, etc.) beyond QLab and vMix.
