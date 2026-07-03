'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createServerClock } = require('../public/serverClock');
const { createPlayheadClock } = require('../public/playheadClock');

test('serverClock: maps a server sample into client wall-clock time', () => {
  const clock = createServerClock();

  // Server emits payload at 10.000s, client receives at 10.080s.
  clock.observe(10000, 10080);

  // Sample itself was taken 150ms before broadcast.
  assert.equal(clock.toClientMs(9850), 9930);
  assert.equal(clock.getOffsetMs(), 80);
});

test('serverClock: NTP-style sync estimates clock offset without folding in network latency', () => {
  const clock = createServerClock();

  const sample = clock.observeSync({
    clientSendMs: 1000,
    serverReceiveMs: 1010,
    serverSendMs: 1012,
    clientReceiveMs: 1032
  });

  assert.equal(sample.rttMs, 30);
  assert.equal(clock.getOffsetMs(), 5);
  assert.equal(clock.toClientMs(2000), 2005);
});

test('timing model: delayed delivery does not become visible playback drift', () => {
  const playhead = createPlayheadClock();
  const serverClock = createServerClock();

  const startServerMs = 50000;
  const startClientMs = 50080; // client clock runs 5ms ahead, 30ms each way

  serverClock.observeSync({
    clientSendMs: 49950,
    serverReceiveMs: 49975,
    serverSendMs: 49977,
    clientReceiveMs: 50007
  });
  playhead.reset(0, serverClock.toClientMs(startServerMs));

  let prev = -Infinity;
  let last = 0;

  // Poll cadence ~200ms, sample is captured 120ms before each payload is
  // delivered to the browser. The client must still render near true time,
  // not "sample time plus delivery lag".
  for (let frameClientMs = startClientMs; frameClientMs <= startClientMs + 5000; frameClientMs += 16) {
    const elapsedClientMs = frameClientMs - startClientMs;

    if (elapsedClientMs > 0 && elapsedClientMs % 208 === 0) {
      const serverNowMs = startServerMs + elapsedClientMs;
      const sampleServerMs = serverNowMs - 120;
      const receiveClientMs = serverNowMs + 35;

      playhead.sample(elapsedClientMs / 1000 - 0.12, serverClock.toClientMs(sampleServerMs));
    }

    const est = playhead.estimate(frameClientMs);
    assert.ok(est >= prev - 1e-9, `estimate went backward: ${prev} -> ${est}`);
    prev = est;
    last = est;
  }

  const trueElapsed = 5;
  assert.ok(Math.abs(last - trueElapsed) < 0.3, `drifted too far from real time: ${last} vs ${trueElapsed}`);
});
