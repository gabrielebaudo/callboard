'use strict';

const net = require('net');
const { XMLParser } = require('fast-xml-parser');

// vMix's TCP API (the same port Companion uses) is a plain text protocol,
// \r\n-terminated, distinct from QLab's SLIP-framed OSC. A poll reply looks
// like:
//   XML 5176\r\n
//   <vmix>...</vmix>
// where 5176 is the exact byte length of the XML payload that follows the
// header line -- there is no trailing terminator to strip, the length is
// authoritative. Confirmed against the official TCP API docs
// (https://wp.vmix.com/help28/TCPAPI.html) and the community reference at
// vmixapi.com; verify against a real instance with scripts/vmix-debug.js
// before trusting live data on a new setup, same discipline as osc-debug.js.
const VMIX_PORT_DEFAULT = 8099;

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

// Stable synthetic ids for the two slots this backend ever surfaces (see
// module comment). Deliberately NOT the underlying input's own key/GUID --
// an operator cutting between clips changes which real input is on
// Program/Preview constantly, and keying on the real GUID would make the
// track disappear and reappear as a "new" one on every cut (DOM churn,
// dropped selection). Keying on a fixed role instead means the same card
// just updates its name/time in place across a cut.
const PROGRAM_ID = 'vmix-program';
const PREVIEW_ID = 'vmix-preview';

/**
 * Wraps a TCP connection to vMix. Read-only: only ever sends `XML\r\n` to
 * poll full state, never a FUNCTION (transport/edit) command.
 *
 * Unlike QLab, vMix pushes no continuous playhead feed worth relying on for
 * position/duration (SUBSCRIBE ACTS/TALLY covers tally and shortcut state,
 * not media position) -- so this backend polls the full `XML` snapshot on a
 * single timer (`pollMs`) rather than QLab's two-tier scheme. One XML reply
 * carries every input at once, so there's nothing to tier.
 *
 * Unlike QLab (which surfaces every discovered timeline), this backend only
 * ever exposes exactly two synthetic tracks: whatever is currently on
 * Program and whatever is currently in Preview (see PROGRAM_ID/PREVIEW_ID).
 * vMix sessions routinely have 100+ inputs (cameras, titles, colours,
 * stills, media) -- listing them all would be noise for what this backend
 * is actually for: a remote "what's on air right now" readout, not a show
 * running-order. No duration filter either (an earlier version excluded
 * stills/images; Program is deliberately shown even when it's a still, so
 * an operator can identify it by name -- see the Program/Preview badge
 * rules below).
 *
 * The **Program** slot is always the live one (green LIVE badge), full
 * stop -- being on air is a structural fact independent of whether the
 * underlying media happens to be playing. **Preview** never gets that
 * badge (an operator can cue up and play a clip in Preview before taking
 * it live, but that never makes it "the" live one). Both slots' own
 * isRunning DOES reflect real playback though, so selecting either one
 * shows its playhead/clock moving when its media is actually
 * state="Running" with a real duration -- a still is "identifiable but
 * static" either way, same as a stopped QLab timeline having no moving
 * playhead.
 *
 * vMix has no cue/marker concept, so capabilities.markers is false: the
 * client hides departments, marker flags, and the running order for this
 * backend.
 *
 * @param {{store: ReturnType<typeof import('../settingsStore').createSettingsStore>, state: ReturnType<typeof import('../state').createState>, onStateChange: Function}} deps
 */
function createVmixBackend({ store, state, onStateChange }) {
  let socket = null;
  let recvBuffer = Buffer.alloc(0);
  let pollTimer = null;
  let reconnectTimer = null;
  let lastBroadcastAt = 0;
  let lastHost = vmixCfg().host;
  let lastPort = vmixCfg().tcpPort;
  let pollBusy = false;
  // Bumped on every (re)connect so a reply that arrives after we've already
  // torn down/reconnected the socket is ignored instead of resolving a
  // request that belongs to a dead connection -- same guard qlab.js uses.
  let socketEpoch = 0;
  let pendingXml = null; // { resolve, reject, timer, epoch }

  function vmixCfg() {
    return store.getVmix();
  }

  function maybeBroadcast() {
    const now = Date.now();
    const throttleMs = vmixCfg().broadcastThrottleMs || 200;
    if (now - lastBroadcastAt >= throttleMs) {
      lastBroadcastAt = now;
      onStateChange();
    }
  }

  function connectSocket() {
    const cfg = vmixCfg();
    const epoch = ++socketEpoch;
    recvBuffer = Buffer.alloc(0);
    socket = net.createConnection({ host: cfg.host, port: cfg.tcpPort || VMIX_PORT_DEFAULT });

    socket.on('connect', () => {
      if (epoch !== socketEpoch) return;
      state.setConnected(true);
      onStateChange();
      startPolling();
    });
    socket.on('data', (chunk) => {
      if (epoch !== socketEpoch) return;
      recvBuffer = Buffer.concat([recvBuffer, chunk]);
      drainBuffer(epoch);
    });
    socket.on('error', (err) => {
      if (epoch !== socketEpoch) return;
      console.error('[vmix] socket error:', err.message);
    });
    socket.on('close', () => {
      if (epoch !== socketEpoch) return; // already superseded by a newer connection
      console.warn('[vmix] connection closed, will retry');
      state.setConnected(false);
      onStateChange();
      teardownTimers();
      rejectPending(new Error('vMix connection closed'));
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectSocket();
    }, 3000);
  }

  function teardownTimers() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function closeSocket() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    teardownTimers();
    socketEpoch += 1; // invalidate any reply still in flight on the old socket
    rejectPending(new Error('vMix connection closing'));
    if (socket) {
      socket.removeAllListeners('close'); // avoid triggering scheduleReconnect on manual close
      try { socket.destroy(); } catch (err) { /* ignore */ }
      socket = null;
    }
  }

  function rejectPending(err) {
    if (!pendingXml) return;
    clearTimeout(pendingXml.timer);
    pendingXml.reject(err);
    pendingXml = null;
  }

  // Parses as many complete "XML <len>\r\n<payload>" frames as are
  // currently buffered. Any other line (e.g. an OK/ER reply to a command
  // we don't send) is dropped -- we only ever issue XML polls.
  function drainBuffer(epoch) {
    for (;;) {
      const headerEnd = recvBuffer.indexOf('\r\n');
      if (headerEnd === -1) return; // wait for more data
      const headerLine = recvBuffer.slice(0, headerEnd).toString('utf8');
      const match = /^XML (\d+)$/.exec(headerLine.trim());
      if (!match) {
        recvBuffer = recvBuffer.slice(headerEnd + 2);
        continue;
      }
      const len = parseInt(match[1], 10);
      const payloadStart = headerEnd + 2;
      if (recvBuffer.length < payloadStart + len) return; // wait for rest of payload
      const payload = recvBuffer.slice(payloadStart, payloadStart + len).toString('utf8');
      recvBuffer = recvBuffer.slice(payloadStart + len);
      if (epoch === socketEpoch && pendingXml) {
        clearTimeout(pendingXml.timer);
        const resolve = pendingXml.resolve;
        pendingXml = null;
        resolve(payload);
      }
    }
  }

  function requestXml(timeoutMs = 3000) {
    if (!socket) return Promise.reject(new Error('vMix socket not connected'));
    if (pendingXml) return Promise.reject(new Error('vMix XML request already in flight'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingXml = null;
        reject(new Error('vMix XML request timed out'));
      }, timeoutMs);
      pendingXml = { resolve, reject, timer };
      socket.write('XML\r\n');
    });
  }

  function startPolling() {
    teardownTimers();
    pollTimer = setInterval(() => {
      pollXml().catch((err) => console.error('[vmix] poll failed:', err.message));
    }, vmixCfg().pollMs || 200);
    pollXml().catch((err) => console.error('[vmix] initial poll failed:', err.message));
  }

  // ---- single poll: full XML snapshot -> generic timeline/playback state
  async function pollXml() {
    if (pollBusy) return;
    pollBusy = true;
    try {
      const xml = await requestXml();
      applyXml(xml);
      maybeBroadcast();
    } finally {
      pollBusy = false;
    }
  }

  function applyXml(xml) {
    const sampledAtMs = Date.now();
    const parsed = xmlParser.parse(xml);
    const root = parsed.vmix || {};
    let inputs = (root.inputs && root.inputs.input) || [];
    if (!Array.isArray(inputs)) inputs = [inputs]; // fast-xml-parser collapses a single child to an object

    const byNumber = new Map(inputs.map((i) => [Number(i['@_number']), i]));
    const programInput = byNumber.get(Number(root.active)) || null;
    const previewInput = byNumber.get(Number(root.preview)) || null;

    const timelines = [];
    if (programInput) timelines.push({ id: PROGRAM_ID, name: programInput['@_title'], number: 1, kind: 'track' });
    if (previewInput) timelines.push({ id: PREVIEW_ID, name: previewInput['@_title'], number: 2, kind: 'track' });
    state.setTimelines(timelines);

    if (programInput) {
      // Only Running drives the moving playhead -- vMix reports
      // state="Paused" as the default RESTING state of a stopped/idle
      // clip (confirmed empirically against a live 107-input session:
      // every non-Program input read "Paused" regardless of position),
      // not a real "paused mid-show" signal like QLab's isPaused. See
      // module comment for why isPaused is always false here.
      const running = programInput['@_state'] === 'Running';
      state.setTimelinePlayback(PROGRAM_ID, {
        isRunning: running,
        isPaused: false,
        isPlaying: running,
        currentTime: Number(programInput['@_position']) / 1000 || 0,
        duration: Number(programInput['@_duration']) / 1000 || 0,
        sampledAtMs
      });
    }
    if (previewInput) {
      // Preview's own isRunning DOES reflect real playback -- an operator
      // can cue up and play a clip in Preview before taking it live, and
      // selecting the Preview card should show its playhead moving same
      // as any other track (app.js's renderPlayhead keys off the
      // SELECTED track's own isRunning, not a global "active" flag).
      // What Preview never gets is the LIVE
      // badge or activeTimelineId itself -- that's Program-only, set
      // below regardless of either slot's playback state.
      const running = previewInput['@_state'] === 'Running';
      state.setTimelinePlayback(PREVIEW_ID, {
        isRunning: running,
        isPaused: false,
        isPlaying: running,
        currentTime: Number(previewInput['@_position']) / 1000 || 0,
        duration: Number(previewInput['@_duration']) / 1000 || 0,
        sampledAtMs
      });
    }

    // Program is always the live slot -- being on air is structural, not
    // tied to whether the underlying media is actually Running (a still
    // on Program is still what's live right now).
    state.setActiveTimeline(programInput ? PROGRAM_ID : null);
    state.deriveStatuses();
  }

  function start() {
    connectSocket();
  }

  function stop() {
    closeSocket();
    state.setConnected(false);
  }

  /**
   * Called after a Settings save. Reconnects only if host/port actually
   * changed; a pollMs change takes effect on the next poll-timer restart
   * (immediately, since we only ever have one connection at a time).
   */
  function applyConfig() {
    const cfg = vmixCfg();
    const connectionChanged = cfg.host !== lastHost || cfg.tcpPort !== lastPort;
    lastHost = cfg.host;
    lastPort = cfg.tcpPort;

    if (connectionChanged) {
      console.log('[vmix] connection settings changed, reconnecting...');
      closeSocket();
      connectSocket();
    } else if (socket) {
      startPolling(); // pick up a changed pollMs without a full reconnect
    }
  }

  // vMix has no cue/marker concept -- these exist only to satisfy the
  // shared backend contract server.js calls uniformly.
  async function refreshMarkersFor() {}
  async function refreshAll() {
    await pollXml();
  }

  return {
    start,
    stop,
    applyConfig,
    refreshMarkersFor,
    refreshAll,
    capabilities: { markers: false, departments: false }
  };
}

module.exports = createVmixBackend;
