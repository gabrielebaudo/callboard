// Smoothed playhead clock: turns the server's discrete, latency-jittered
// time samples into a monotonic estimate the UI can read every frame.
//
// The naive approach (base = last sample, add wall-clock elapsed, reset on
// every sample) glitches: server samples arrive with variable latency, so
// one late/staler sample lands "behind" where interpolation already reached
// and yanks the clock backward -- the classic forward-then-back drift.
//
// This instead dead-reckons and corrects gently:
//   - between samples, advance 1:1 with the wall clock;
//   - on each sample, compare the server time to where we predicted we'd be
//     and ease toward it (a fraction of the error) rather than snapping;
//   - only SNAP (hard reset) when the error is large -- a genuine seek,
//     pause->play, or a resumed poll after a stall, not routine jitter;
//   - never report a time below one already reported *since the last snap*,
//     so small negative corrections can't push the visible clock backward.
//     A real seek is a snap, which clears that floor, so seeking back still
//     works.
//
// Shared by the browser (public/app.js) and the node test suite
// (test/playheadClock.test.js) -- all times in seconds, wall clock in ms,
// both passed in so the logic is pure and deterministically testable.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.createPlayheadClock = factory().createPlayheadClock;
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function createPlayheadClock(opts) {
    opts = opts || {};
    // Errors above this (seconds) are treated as real jumps and snapped;
    // below it, as jitter and eased. 0.75s comfortably clears normal LAN
    // latency jitter while staying under a typical deliberate seek.
    const snapThreshold = opts.snapThreshold != null ? opts.snapThreshold : 0.75;
    // Fraction of the residual error absorbed per sample. Small = smoother
    // but slower to converge; 0.15 settles within a few samples.
    const gain = opts.gain != null ? opts.gain : 0.15;

    let base = 0;          // server time (s) anchored at baseWall
    let baseWall = 0;      // wall clock (ms) that `base` is anchored to
    let started = false;   // false = holding a static value (paused/preview)
    let monoFloor = -Infinity; // lowest value estimate() may return until next snap

    // Anchor the clock to a known server time and let it run from there.
    // Clears the monotonic floor, so this is also how a real seek is honored.
    function reset(serverTime, wallNow) {
      base = serverTime;
      baseWall = wallNow;
      started = true;
      monoFloor = -Infinity;
    }

    // Freeze at a static value (timeline paused, stopped, or previewing a
    // non-playing one -- nothing to extrapolate).
    function hold(serverTime) {
      base = serverTime;
      started = false;
      monoFloor = -Infinity;
    }

    // Feed a fresh server sample. Call once per received server state, not
    // per frame.
    function sample(serverTime, wallNow) {
      if (!started) {
        reset(serverTime, wallNow);
        return;
      }
      const predicted = base + (wallNow - baseWall) / 1000;
      const err = serverTime - predicted;
      if (Math.abs(err) > snapThreshold) {
        reset(serverTime, wallNow); // seek / pause->play / poll resumed after a stall
        return;
      }
      base = predicted + err * gain; // ease toward the server, don't snap
      baseWall = wallNow;
    }

    // Current estimate. Call every frame with the current wall clock.
    function estimate(wallNow) {
      if (!started) return base;
      let v = base + (wallNow - baseWall) / 1000;
      if (v < monoFloor) v = monoFloor; // clamp out sub-snap backward jitter
      else monoFloor = v;
      return v;
    }

    return { reset, hold, sample, estimate };
  }

  return { createPlayheadClock };
}));
