'use strict';

const osc = require('osc');
const { resolveDepartment } = require('../markerParser');

// Keys pulled from each cue in one shot via /valuesForKeys, per QLab 5's
// OSC dictionary. `preWait` doubles as the cue's offset inside a
// Timeline-mode Group (dragging a cue on QLab's Timeline sets preWait).
const CUE_VALUE_KEYS = [
  'uniqueID', 'number', 'listName', 'name', 'type', 'colorName',
  'notes', 'preWait', 'duration', 'actionElapsed', 'percentActionElapsed',
  'isRunning', 'isPaused', 'parent'
];

// Confirmed empirically (scripts/osc-debug.js `mode` scan against a real
// show, 2026-07): a Group cue's `mode` reads 3 when set to Timeline mode
// in the inspector's Mode tab. Only Group cues with this mode are
// auto-discovered as Timeline Groups; everything else (List/Start
// Random/etc groups, or non-Group cues) is ignored.
const QLAB_TIMELINE_MODE = 3;

/**
 * Wraps a TCP OSC connection to QLab. Read-only: only ever sends
 * queries, /connect, /updates, and reply-triggering requests -- never
 * playback/edit commands.
 *
 * The show can have many Timeline Groups (one per song/scene). This
 * module auto-discovers all of them (by `mode`, see QLAB_TIMELINE_MODE)
 * and polls them at two tiers to bound OSC traffic as the track count
 * grows:
 *   - Tier A (fast, ~150ms): only the currently ACTIVE timeline's
 *     playhead, for a smooth running clock.
 *   - Tier B (slow, ~1s): every discovered timeline's cheap status
 *     fields (isRunning/isPaused/actionElapsed/duration), to decide
 *     which one is active and to derive upcoming/live/done.
 * Full per-cue marker detail (names, departments, notes) is only
 * fetched for the active timeline and any timeline a client has
 * explicitly asked to preview (see refreshMarkersFor), never for every
 * discovered timeline on every cycle.
 *
 * Reads connection settings live from `store` (src/settingsStore.js) on
 * every use, rather than capturing them once, so a web Settings save can
 * trigger a reconnect via applyConfig() without restarting the process.
 *
 * @param {{store: ReturnType<typeof import('../settingsStore').createSettingsStore>, state: ReturnType<typeof import('../state').createState>, onStateChange: Function}} deps
 */
function createQlabOsc({ store, state, onStateChange }) {
  let port = null;
  let workspaceId = store.getQlab().workspaceId || null;
  let reconnectTimer = null;
  let playheadPollTimer = null;
  let statusPollTimer = null;
  let markerRefreshTimer = null;
  let lastBroadcastAt = 0;
  let lastHost = store.getQlab().host;
  let lastPort = store.getQlab().tcpPort;

  // Cue-list children per discovered timeline group, cached from the last
  // discovery pass so refreshMarkersFor() doesn't need a fresh /cueLists
  // round trip for every marker-detail fetch. Refreshed each time
  // discoverTimelines() runs.
  let groupChildrenById = new Map();

  // Pending request/response correlation: QLab echoes the requested OSC
  // address back in its reply, so we match callbacks by address -- the
  // reply itself carries no other identifying info, so at most ONE
  // request per address can ever be outstanding or a reply could resolve
  // the wrong waiter. request() enforces that by queuing: a call to an
  // address that already has one in flight waits for it to settle (this
  // is a genuinely different call, possibly with different `args`, e.g.
  // discoverTimelines()'s classification read and pollStatuses()'s status
  // read can both target the same Group cue's address -- coalescing them
  // onto one promise would silently hand one caller the other's reply
  // shape) rather than firing a second, ambiguous request in parallel.
  const pending = new Map(); // address -> {resolve, reject, timer}
  const addressChains = new Map(); // address -> tail promise of the queue

  // Bumped on every (re)connect. Message/close listeners captured the
  // epoch of the socket generation they belong to; a stale listener
  // still firing after closeSocket()/reconnect (e.g. a reply that was
  // already in flight on the old TCP socket) is ignored rather than
  // resolving/rejecting a request that belongs to the new connection.
  let socketEpoch = 0;

  function qlabCfg() {
    return store.getQlab();
  }

  function send(address, args) {
    if (!port) return;
    port.send({ address, args: args === undefined ? [] : [].concat(args) });
  }

  function sendAndAwaitReply(address, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      send(address, args);
      const timer = setTimeout(() => {
        pending.delete(address);
        reject(new Error(`OSC request timed out: ${address}`));
      }, timeoutMs);
      pending.set(address, { resolve, reject, timer });
    });
  }

  function request(address, args, timeoutMs = 3000) {
    const prevTail = addressChains.get(address) || Promise.resolve();
    // Swallow the previous request's outcome here so one timeout/rejection
    // doesn't propagate into and cancel a queued sibling -- each caller
    // still gets its own real result via the promise this call returns.
    const thisRequest = prevTail.catch(() => {}).then(() => sendAndAwaitReply(address, args, timeoutMs));
    const tail = thisRequest.catch(() => {});
    addressChains.set(address, tail);
    // Once this is the last-queued call for the address and it has
    // settled, drop the entry instead of leaving a resolved promise
    // sitting in the map forever (bounded by cue count in practice, but
    // no reason to keep dead entries around for a long-running process).
    tail.then(() => {
      if (addressChains.get(address) === tail) addressChains.delete(address);
    });
    return thisRequest;
  }

  function resolvePending(address, data) {
    const entry = pending.get(address);
    if (!entry) return;
    pending.delete(address);
    clearTimeout(entry.timer);
    entry.resolve(data);
  }

  // Reject and clear every in-flight request, e.g. on disconnect -- a
  // request that will never get a reply on this socket generation
  // should not sit around until its 3s timeout fires.
  function rejectAllPending(err) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    pending.clear();
    addressChains.clear();
  }

  function parseReply(msg) {
    // QLab replies carry a single JSON-string argument:
    // {"workspace_id":..., "address":"/osc/message/that/was/sent","status":"ok","data":...}
    const jsonArg = msg.args && msg.args[0];
    if (typeof jsonArg !== 'string') return null;
    try {
      return JSON.parse(jsonArg);
    } catch (err) {
      return null;
    }
  }

  function handleMessage(msg) {
    const reply = parseReply(msg);
    if (!reply || !reply.address) return;
    resolvePending(reply.address, reply);
  }

  function maybeBroadcast() {
    const now = Date.now();
    const throttleMs = qlabCfg().broadcastThrottleMs || 200;
    if (now - lastBroadcastAt >= throttleMs) {
      lastBroadcastAt = now;
      onStateChange();
    }
  }

  function connectSocket() {
    const cfg = qlabCfg();
    const epoch = ++socketEpoch;
    port = new osc.TCPSocketPort({
      address: cfg.host,
      port: cfg.tcpPort
    });

    port.on('ready', onSocketReady);
    port.on('message', (msg) => {
      if (epoch !== socketEpoch) return; // stale socket generation, ignore
      handleMessage(msg);
    });
    port.on('error', (err) => {
      console.error('[qlabOsc] socket error:', err.message);
      state.setLastError(`QLab connection error: ${err.message}`);
    });
    port.on('close', () => {
      if (epoch !== socketEpoch) return; // already superseded by a newer connection
      console.warn('[qlabOsc] connection closed, will retry');
      state.setConnected(false);
      onStateChange();
      teardownTimers();
      rejectAllPending(new Error('QLab connection closed'));
      scheduleReconnect();
    });

    port.open();
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectSocket();
    }, 3000);
  }

  function teardownTimers() {
    if (playheadPollTimer) clearInterval(playheadPollTimer);
    if (statusPollTimer) clearInterval(statusPollTimer);
    if (markerRefreshTimer) clearInterval(markerRefreshTimer);
    playheadPollTimer = null;
    statusPollTimer = null;
    markerRefreshTimer = null;
  }

  function closeSocket() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    teardownTimers();
    socketEpoch += 1; // invalidate any reply still in flight on the old socket
    rejectAllPending(new Error('QLab connection closing'));
    if (port) {
      port.removeAllListeners('close'); // avoid triggering scheduleReconnect on manual close
      try { port.close(); } catch (err) { /* ignore */ }
      port = null;
    }
  }

  async function onSocketReady() {
    try {
      const cfg = qlabCfg();
      if (!workspaceId) {
        const workspacesReply = await request('/workspaces');
        const list = workspacesReply.data || [];
        if (list.length === 0) throw new Error('No open workspaces in QLab');
        workspaceId = list[0].uniqueID;
        console.log(`[qlabOsc] using workspace ${workspaceId} (${list[0].displayName || ''})`);
      }

      await request(`/workspace/${workspaceId}/connect`, [cfg.passcode || '']);
      send(`/workspace/${workspaceId}/updates`, 1);

      state.setConnected(true);
      onStateChange();

      await discoverTimelines();
      await pollStatuses();
      if (state.raw.activeTimelineId) {
        await refreshMarkersFor(state.raw.activeTimelineId).catch((err) => {
          console.error('[qlabOsc] initial marker fetch failed:', err.message);
        });
      }
      onStateChange();
      startPolling();
    } catch (err) {
      console.error('[qlabOsc] handshake failed:', err.message);
      state.setLastError(`QLab handshake failed: ${err.message}`);
      state.setConnected(false);
      onStateChange();
      scheduleReconnect();
    }
  }

  function startPolling() {
    teardownTimers();
    playheadPollTimer = setInterval(pollPlayhead, qlabCfg().playheadPollMs || 150);
    statusPollTimer = setInterval(() => {
      pollStatuses().catch((err) => console.error('[qlabOsc] status poll failed:', err.message));
    }, qlabCfg().statusPollMs || 1000);
    markerRefreshTimer = setInterval(() => {
      periodicRefresh().catch((err) => console.error('[qlabOsc] periodic refresh failed:', err.message));
    }, qlabCfg().markerRefreshMs || 10000);
  }

  // Per-tier in-flight guards. setInterval fires on a fixed clock without
  // waiting for the previous async run -- if QLab stalls, ticks would
  // otherwise pile up (each with its own 3s-timeout OSC requests) faster
  // than they drain. Skipping a tick while the previous one is still
  // running keeps at most ~1 request per tier in flight at a time.
  let playheadBusy = false;
  let statusBusy = false;
  let discoveryBusy = false;

  // ---- Tier A: fast playhead poll, active timeline only -----------------
  async function pollPlayhead() {
    if (playheadBusy) return;
    const activeId = state.raw.activeTimelineId;
    if (!activeId) return;
    playheadBusy = true;
    try {
      const reply = await request(
        `/workspace/${workspaceId}/cue_id/${activeId}/valuesForKeys`,
        JSON.stringify(['actionElapsed', 'duration', 'isRunning', 'isPaused'])
      );
      const sampledAtMs = Date.now();
      const d = reply.data || {};
      state.setTimelinePlayback(activeId, {
        currentTime: Number(d.actionElapsed) || 0,
        duration: Number(d.duration) || 0,
        isRunning: Boolean(d.isRunning),
        isPaused: Boolean(d.isPaused),
        isPlaying: Boolean(d.isRunning) && !d.isPaused,
        sampledAtMs
      });
      maybeBroadcast();
    } catch (err) {
      // Transient timeouts are expected under fast polling; don't spam.
    } finally {
      playheadBusy = false;
    }
  }

  // ---- Tier B: slow status sweep across all discovered timelines --------
  async function pollStatuses() {
    if (statusBusy) return;
    if (state.raw.timelines.length === 0) return;
    statusBusy = true;
    try {
      const activeId = state.raw.activeTimelineId;
      await Promise.allSettled(state.raw.timelines.map(async (t) => {
        // Tier A already polls the active timeline every ~150ms with a
        // fresher actionElapsed. This 1s sweep's reply is up to a second
        // staler, and setTimelinePlayback writes currentTime unconditionally
        // (no backward-jump guard), so letting Tier B write the active
        // timeline here would shove its clock backward once per cycle --
        // a periodic hitch in the interpolation base that both the main
        // readout and the per-cue countdowns ride on. Leave the active one
        // to Tier A; this sweep only needs the OTHER timelines' status.
        if (t.id === activeId) return;
        try {
          const reply = await request(
            `/workspace/${workspaceId}/cue_id/${t.id}/valuesForKeys`,
            JSON.stringify(['actionElapsed', 'duration', 'isRunning', 'isPaused'])
          );
          const sampledAtMs = Date.now();
          const d = reply.data || {};
          state.setTimelinePlayback(t.id, {
            currentTime: Number(d.actionElapsed) || 0,
            duration: Number(d.duration) || 0,
            isRunning: Boolean(d.isRunning),
            isPaused: Boolean(d.isPaused),
            isPlaying: Boolean(d.isRunning) && !d.isPaused,
            sampledAtMs
          });
        } catch (err) {
          // Transient timeouts are expected; leave last known state.
        }
      }));

      // Active = first (cue-list order) timeline currently running/paused.
      // If more than one reports active simultaneously, first wins
      // deterministically -- a known limitation, not silently ignored.
      const live = state.raw.timelines.find((t) => t.playback.isRunning || t.playback.isPaused);
      state.setActiveTimeline(live ? live.id : null);
      state.deriveStatuses();
      maybeBroadcast();
    } finally {
      statusBusy = false;
    }
  }

  // ---- Discovery: every Group cue in Timeline mode, plus every top-level
  // non-Group cue with a nonzero duration (a plain "track" -- no markers,
  // just a time), in cue-list order. Nested groups (any depth) are still
  // scanned for Timeline mode; nested non-Group cues are NOT scanned as
  // tracks, because a cue inside a Timeline Group is already surfaced as
  // that group's marker (refreshMarkersFor) -- scanning it again here
  // would list it twice.
  //
  // Classification is read fresh every pass (no cache) so a cue edited in
  // QLab (mode flipped, or a track's duration crossing the >0 line) is
  // picked up within one markerRefreshMs cycle. If a classification read
  // times out for a cue that is STILL present in the /cueLists tree and
  // was already known from the previous pass, its last-known
  // name/number/kind is retained instead of dropping it -- a single slow
  // reply must not make an unrelated timeline flicker out of the list.
  // Only cues genuinely absent from the tree (or brand new ones whose
  // very first read fails) are omitted.
  async function discoverTimelines() {
    if (discoveryBusy) return;
    discoveryBusy = true;
    try {
      const reply = await request(`/workspace/${workspaceId}/cueLists`);
      const cueLists = reply.data || [];

      // Ordered candidates: every Group cue at any depth (recursed into),
      // plus every non-Group cue that sits directly under a cue list.
      const candidates = [];
      (function walk(cues, topLevel) {
        for (const cue of cues || []) {
          if (cue.type === 'Group') {
            candidates.push({ cue, isGroup: true });
            if (cue.cues && cue.cues.length) walk(cue.cues, false);
          } else if (topLevel) {
            candidates.push({ cue, isGroup: false });
          }
        }
      })(cueLists.flatMap((l) => l.cues || []), true);

      const knownById = new Map(state.raw.timelines.map((t) => [t.id, t]));
      const discovered = [];
      const nextChildrenById = new Map();

      for (const { cue, isGroup } of candidates) {
        try {
          const reply2 = await request(
            `/workspace/${workspaceId}/cue_id/${cue.uniqueID}/valuesForKeys`,
            JSON.stringify(['uniqueID', 'name', 'listName', 'mode', 'duration'])
          );
          const d = reply2.data || {};
          if (isGroup) {
            if (Number(d.mode) === QLAB_TIMELINE_MODE) {
              discovered.push({ id: d.uniqueID, name: d.listName || d.name, number: cue.number || '', kind: 'timeline' });
              nextChildrenById.set(d.uniqueID, cue.cues || []);
            }
          } else if (Number(d.duration) > 0) {
            discovered.push({ id: d.uniqueID, name: d.listName || d.name, number: cue.number || '', kind: 'track' });
          }
        } catch (err) {
          console.warn(`[qlabOsc] failed to read cue ${cue.uniqueID}:`, err.message);
          const known = knownById.get(cue.uniqueID);
          if (known) {
            discovered.push({ id: known.id, name: known.name, number: known.number, kind: known.kind });
            if (isGroup) nextChildrenById.set(known.id, cue.cues || groupChildrenById.get(known.id) || []);
          }
        }
      }

      groupChildrenById = nextChildrenById;
      state.setTimelines(discovered);
    } finally {
      discoveryBusy = false;
    }
  }

  // ---- Marker detail for one timeline (active, or explicitly viewed) ----
  async function refreshMarkersFor(id) {
    const tl = state.getTimeline(id);
    if (tl && tl.kind === 'track') return; // plain tracks have no marker cues to fetch
    const children = groupChildrenById.get(id) || [];
    const appConfig = store.get();
    const markers = [];

    for (const child of children) {
      try {
        const reply = await request(
          `/workspace/${workspaceId}/cue_id/${child.uniqueID}/valuesForKeys`,
          JSON.stringify(CUE_VALUE_KEYS)
        );
        const d = reply.data || {};
        const { department, title } = resolveDepartment(d.listName || d.name, appConfig);
        markers.push({
          id: d.uniqueID,
          number: d.number,
          name: d.listName || d.name,
          department,
          title,
          time: Number(d.preWait) || 0,
          type: d.type,
          color: d.colorName,
          notes: d.notes || '',
          parent: d.parent
        });
      } catch (err) {
        console.warn(`[qlabOsc] failed to read cue ${child.uniqueID}:`, err.message);
      }
    }

    markers.sort((a, b) => a.time - b.time);
    state.setTimelineMarkers(id, markers);
    onStateChange();
  }

  /**
   * Runs on the markerRefreshMs cadence: re-discover (to pick up newly
   * added/removed timeline groups), then re-fetch marker detail only for
   * timelines that actually need it -- the active one, plus any a client
   * has already loaded by browsing it. This keeps steady-state OSC load
   * at O(tracks) status pings + O(live + viewed) full detail fetches,
   * never O(all tracks x their cues).
   */
  let periodicRefreshBusy = false;
  async function periodicRefresh() {
    if (periodicRefreshBusy) return;
    periodicRefreshBusy = true;
    try {
      await discoverTimelines();
      const idsToRefresh = new Set();
      const activeTl = state.raw.activeTimelineId ? state.getTimeline(state.raw.activeTimelineId) : null;
      if (activeTl && activeTl.kind !== 'track') idsToRefresh.add(activeTl.id);
      for (const t of state.raw.timelines) {
        if (t.kind !== 'track' && t.markersLoaded) idsToRefresh.add(t.id);
      }
      for (const id of idsToRefresh) {
        await refreshMarkersFor(id).catch((err) => {
          console.error(`[qlabOsc] marker refresh failed for ${id}:`, err.message);
        });
      }
      onStateChange();
    } finally {
      periodicRefreshBusy = false;
    }
  }

  function start() {
    connectSocket();
  }

  /**
   * Called after a Settings save. Reconnects only if the connection
   * parameters actually changed. Timeline discovery no longer depends on
   * any configured name, so there is nothing else in `qlab.*` that
   * requires re-resolving anything.
   */
  function applyConfig() {
    const cfg = qlabCfg();
    const connectionChanged = cfg.host !== lastHost || cfg.tcpPort !== lastPort;

    lastHost = cfg.host;
    lastPort = cfg.tcpPort;

    if (connectionChanged) {
      console.log('[qlabOsc] connection settings changed, reconnecting...');
      workspaceId = cfg.workspaceId || null;
      groupChildrenById = new Map();
      closeSocket();
      connectSocket();
    }
  }

  function stop() {
    closeSocket();
    state.setConnected(false);
  }

  return {
    start,
    stop,
    applyConfig,
    refreshMarkersFor,
    refreshAll: periodicRefresh,
    capabilities: { markers: true, departments: true }
  };
}

module.exports = createQlabOsc;
