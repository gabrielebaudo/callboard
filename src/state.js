'use strict';

/**
 * In-memory application state, shared between the backend layer (whichever
 * show-control app is configured -- src/backends/*.js) and the WebSocket
 * layer. This is the single source of truth the server holds about the
 * active backend's current playback + markers. It is NOT a marker
 * database: markers are always re-derived from the backend's own cues/
 * inputs (see src/backends/qlab.js, vmix.js).
 *
 * This shape is backend-neutral by design: every backend converts its own
 * vocabulary (QLab's preWait/actionElapsed/colorName, vMix's
 * position/duration/state) into the generic fields below before writing
 * here, so the fields no longer mention any one backend once they land in
 * `timelines`.
 *
 * A show can have several timelines (QLab: one per Timeline Group; vMix:
 * one per media input) -- `timelines` is an ordered array (source order),
 * each carrying its own playback + markers. `activeTimelineId` is
 * whichever one is currently running/paused, decided by the backend's own
 * polling.
 */
function createState() {
  const state = {
    connectedToBackend: false,
    activeTimelineId: null,
    timelines: [], // [{ id, name, number, listIndex, kind, playback, markers, markersLoaded, everStarted, status }]
    lastRefreshAt: null,
    nextPlaybackSampleSeq: 1
  };

  function setConnected(connected) {
    state.connectedToBackend = connected;
  }

  function emptyPlayback() {
    return {
      isPlaying: false,
      isRunning: false,
      isPaused: false,
      currentTime: 0,
      duration: 0,
      sampledAtMs: null,
      sampleSeq: 0
    };
  }

  /**
   * Replace the discovered set of timelines, merging by id so a
   * re-discovery (periodic, to pick up newly added groups) doesn't wipe
   * out playback/markers/everStarted already known for surviving ids.
   *
   * `d.kind` is `'timeline'` (a Timeline-mode Group, has markers) or
   * `'track'` (a plain cue with just a duration, no marker cues). A new
   * track defaults to `markersLoaded: true` with an empty marker array --
   * it's "loaded with nothing to show", not "pending a fetch" -- since
   * there is nothing to fetch for it (see each backend's refreshMarkersFor,
   * e.g. src/backends/qlab.js).
   */
  function setTimelines(discovered) {
    const previousById = new Map(state.timelines.map((t) => [t.id, t]));
    state.timelines = discovered.map((d, idx) => {
      const prev = previousById.get(d.id);
      // A cue's kind can change between passes (e.g. a Group flipped into
      // or out of Timeline mode in QLab). Carrying the old markers across
      // that transition would let a track that used to be a timeline keep
      // showing stale cue notes, or vice versa -- treat it like a fresh
      // entry for marker purposes.
      const kindChanged = !!prev && prev.kind !== d.kind;
      const carryOver = prev && !kindChanged;
      return {
        id: d.id,
        name: d.name,
        number: d.number,
        listIndex: idx,
        kind: d.kind,
        playback: prev ? prev.playback : emptyPlayback(),
        markers: carryOver ? prev.markers : [],
        markersLoaded: carryOver ? prev.markersLoaded : d.kind === 'track',
        everStarted: prev ? prev.everStarted : false,
        status: prev ? prev.status : 'upcoming'
      };
    });
    // Active id may no longer exist if that group vanished from the show.
    if (state.activeTimelineId && !state.timelines.some((t) => t.id === state.activeTimelineId)) {
      state.activeTimelineId = null;
    }
  }

  function getTimeline(id) {
    return state.timelines.find((t) => t.id === id) || null;
  }

  function setTimelinePlayback(id, {
    isPlaying, isRunning, isPaused, currentTime, duration, sampledAtMs, sampleSeq
  } = {}) {
    const t = getTimeline(id);
    if (!t) return;
    const touched = (
      isPlaying !== undefined ||
      isRunning !== undefined ||
      isPaused !== undefined ||
      currentTime !== undefined ||
      duration !== undefined ||
      sampledAtMs !== undefined ||
      sampleSeq !== undefined
    );
    if (isPlaying !== undefined) t.playback.isPlaying = isPlaying;
    if (isRunning !== undefined) t.playback.isRunning = isRunning;
    if (isPaused !== undefined) t.playback.isPaused = isPaused;
    if (currentTime !== undefined) t.playback.currentTime = currentTime;
    if (duration !== undefined) t.playback.duration = duration;
    if (sampledAtMs !== undefined) t.playback.sampledAtMs = sampledAtMs;
    if (sampleSeq !== undefined) {
      t.playback.sampleSeq = sampleSeq;
      if (sampleSeq >= state.nextPlaybackSampleSeq) state.nextPlaybackSampleSeq = sampleSeq + 1;
    } else if (touched) {
      t.playback.sampleSeq = state.nextPlaybackSampleSeq++;
    }
    if (touched && sampledAtMs === undefined) t.playback.sampledAtMs = Date.now();
    if (t.playback.isRunning || t.playback.isPaused) t.everStarted = true;
  }

  function setTimelineMarkers(id, markers) {
    const t = getTimeline(id);
    if (!t) return;
    t.markers = markers;
    t.markersLoaded = true;
    state.lastRefreshAt = Date.now();
  }

  function setActiveTimeline(id) {
    state.activeTimelineId = id;
  }

  /**
   * Recompute each timeline's upcoming/live/done status from its
   * playback + everStarted flag. "done" is a best-effort approximation:
   * QLab exposes no "finished and won't restart" signal, so a track a
   * human stopped early also reads as done. Deliberately does NOT use
   * currentTime/duration as a signal -- whether actionElapsed persists
   * or resets after a manual stop was not confirmed empirically, so we
   * don't depend on it.
   */
  function deriveStatuses() {
    for (const t of state.timelines) {
      const live = t.playback.isRunning || t.playback.isPaused;
      if (live) t.status = 'live';
      else if (t.everStarted) t.status = 'done';
      else t.status = 'upcoming';
    }
  }

  /** Shape sent to browser clients over Socket.IO. */
  function toClientPayload(serverNowMs = Date.now()) {
    return {
      type: 'state',
      serverNowMs,
      connectedToBackend: state.connectedToBackend,
      activeTimelineId: state.activeTimelineId,
      timelines: state.timelines.map((t) => ({
        id: t.id,
        name: t.name,
        number: t.number,
        listIndex: t.listIndex,
        kind: t.kind,
        status: t.status,
        markersLoaded: t.markersLoaded,
        markers: t.markers,
        ...t.playback
      })),
      lastRefreshAt: state.lastRefreshAt
    };
  }

  return {
    raw: state,
    setConnected,
    setTimelines,
    getTimeline,
    setTimelinePlayback,
    setTimelineMarkers,
    setActiveTimeline,
    deriveStatuses,
    toClientPayload
  };
}

module.exports = { createState };
