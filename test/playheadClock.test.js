'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createPlayheadClock } = require('../public/playheadClock');

// Reproduces the "forward then back" drift the smoothing exists to kill:
// server samples arrive every ~200ms with jittery latency, frames read the
// estimate every ~16ms. The estimate must never step backward between
// samples (that's the visible glitch), and must track real time closely.
test('playheadClock: monotonic and accurate under latency jitter', () => {
  const clock = createPlayheadClock();
  const startWall = 1000;
  clock.reset(0, startWall);

  const latencyPattern = [0.02, 0.05, 0.08, 0.03, 0.06, 0.09, 0.01]; // seconds
  let li = 0;
  let prev = -Infinity;
  let last = 0;

  for (let wall = startWall; wall <= startWall + 8000; wall += 16) {
    // Every ~200ms a server sample lands: true elapsed minus jittery latency.
    if ((wall - startWall) % 208 === 0 && wall > startWall) {
      const trueElapsed = (wall - startWall) / 1000;
      const latency = latencyPattern[li++ % latencyPattern.length];
      clock.sample(Math.max(0, trueElapsed - latency), wall);
    }
    const est = clock.estimate(wall);
    assert.ok(est >= prev - 1e-9, `estimate went backward at wall=${wall}: ${prev} -> ${est}`);
    prev = est;
    last = est;
  }

  const trueFinal = 8000 / 1000;
  assert.ok(Math.abs(last - trueFinal) < 0.3, `drifted too far from real time: ${last} vs ${trueFinal}`);
});

// A single stale/late sample (server value lands behind where we already
// interpolated) must not drag the visible clock backward.
test('playheadClock: a stale sample does not pull the clock backward', () => {
  const clock = createPlayheadClock();
  clock.reset(0, 0);
  clock.sample(1.0, 1000);

  const before = clock.estimate(1050); // ~1.05
  clock.sample(0.85, 1100);            // stale: server appears 0.25s behind
  const after = clock.estimate(1100);

  assert.ok(after >= before, `clock stepped back on a stale sample: ${before} -> ${after}`);
  assert.ok(after < 1.5, 'clock should not overshoot either');
});

// After a poll stall, the next sample can be far ahead -- that's a real gap,
// snap to it rather than crawling.
test('playheadClock: snaps forward when a sample jumps well ahead', () => {
  const clock = createPlayheadClock();
  clock.reset(0, 0);
  clock.sample(0, 0);
  clock.estimate(1000); // drifted to ~1.0 with no fresh samples
  clock.sample(3.0, 1000); // Tier A resumed: 2s ahead
  const est = clock.estimate(1000);
  assert.ok(Math.abs(est - 3.0) < 0.05, `did not snap forward: ${est}`);
});

// A deliberate seek backward (large negative error) IS honored -- snap back.
test('playheadClock: honors a real backward seek', () => {
  const clock = createPlayheadClock();
  clock.reset(5, 0);
  clock.sample(5, 0);
  clock.estimate(500); // ~5.5
  clock.sample(1.0, 500); // operator jumped the playhead back to 1s
  const est = clock.estimate(500);
  assert.ok(Math.abs(est - 1.0) < 0.05, `did not honor backward seek: ${est}`);
});

// hold() = paused/preview: a fixed value regardless of wall clock.
test('playheadClock: hold() reports a static value', () => {
  const clock = createPlayheadClock();
  clock.hold(10);
  assert.strictEqual(clock.estimate(0), 10);
  assert.strictEqual(clock.estimate(99999), 10);
});

// Resuming playback after a hold re-anchors cleanly and runs forward.
test('playheadClock: resumes cleanly after a hold', () => {
  const clock = createPlayheadClock();
  clock.hold(10);
  clock.sample(10, 5000); // first sample after resume -> re-anchor
  assert.ok(Math.abs(clock.estimate(5000) - 10) < 1e-9);
  assert.ok(Math.abs(clock.estimate(6000) - 11) < 1e-9);
});
