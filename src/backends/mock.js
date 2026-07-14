'use strict';

const { MOCK_TIMELINES } = require('../mockData');

/**
 * Simulated backend for USE_MOCK=1 -- drives the exact same state.js
 * setter contract a real backend (qlab.js, vmix.js) uses, so the UI
 * exercises the real render path without any external show-control app
 * running. See mockData.js for what the three timelines + one plain
 * track model.
 *
 * @param {{state: ReturnType<typeof import('../state').createState>, onStateChange: Function}} deps
 */
function createMockBackend({ state, onStateChange }) {
  let tickTimer = null;

  function sampleStamp() {
    return { sampledAtMs: Date.now() };
  }

  function start() {
    console.log('[mock] USE_MOCK=1 -> serving simulated data');
    state.setConnected(true);
    state.setTimelines(MOCK_TIMELINES.map((t) => ({ id: t.id, name: t.name, number: t.number, kind: t.kind })));
    MOCK_TIMELINES.forEach((t) => state.setTimelineMarkers(t.id, t.markers));

    let activeIdx = MOCK_TIMELINES.findIndex((t) => t.status === 'live');
    if (activeIdx < 0) activeIdx = 0;
    // Real QLab reports a stopped/never-played group's duration too
    // (confirmed empirically), so every mock track gets its duration up
    // front regardless of status.
    MOCK_TIMELINES.forEach((t) => state.setTimelinePlayback(t.id, { duration: t.duration, ...sampleStamp() }));
    MOCK_TIMELINES.forEach((t, idx) => {
      if (idx < activeIdx) {
        // Flip isRunning true then back off so the sticky everStarted flag
        // is set, matching how a real "done" track got there.
        state.setTimelinePlayback(t.id, { isRunning: true, ...sampleStamp() });
        state.setTimelinePlayback(t.id, { isRunning: false, isPaused: false, currentTime: t.duration, ...sampleStamp() });
      }
    });
    state.setTimelinePlayback(MOCK_TIMELINES[activeIdx].id, {
      isPlaying: true, isRunning: true, currentTime: 0, duration: MOCK_TIMELINES[activeIdx].duration, ...sampleStamp()
    });
    state.setActiveTimeline(MOCK_TIMELINES[activeIdx].id);
    state.deriveStatuses();

    const tickMs = 200;
    tickTimer = setInterval(() => {
      const active = MOCK_TIMELINES[activeIdx];
      const current = state.getTimeline(active.id);
      const next = current.playback.currentTime + tickMs / 1000;
      if (next >= active.duration) {
        state.setTimelinePlayback(active.id, {
          isRunning: false, isPaused: false, isPlaying: false, currentTime: active.duration, ...sampleStamp()
        });
        activeIdx = (activeIdx + 1) % MOCK_TIMELINES.length;
        const nextActive = MOCK_TIMELINES[activeIdx];
        state.setTimelinePlayback(nextActive.id, {
          isPlaying: true, isRunning: true, currentTime: 0, duration: nextActive.duration, ...sampleStamp()
        });
        state.setActiveTimeline(nextActive.id);
      } else {
        state.setTimelinePlayback(active.id, { currentTime: next, ...sampleStamp() });
      }
      state.deriveStatuses();
      onStateChange();
    }, tickMs);
  }

  function stop() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
  }

  // Mock markers are already fully in memory; refresh/select are no-ops
  // that just re-broadcast current state (handled by server.js callers).
  async function refreshMarkersFor() {}
  async function refreshAll() {}
  function applyConfig() {}

  return {
    start,
    stop,
    applyConfig,
    refreshMarkersFor,
    refreshAll,
    capabilities: { markers: true, departments: true }
  };
}

module.exports = createMockBackend;
