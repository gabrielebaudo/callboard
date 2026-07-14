'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../src/state');

test('state payload exposes server and playback sample timing metadata', () => {
  const state = createState();
  state.setTimelines([{ id: 'a', name: 'A', number: '1', kind: 'timeline' }]);
  state.setTimelinePlayback('a', {
    currentTime: 12.5,
    duration: 30,
    isRunning: true,
    isPlaying: true,
    sampledAtMs: 1234567890
  });

  const payload = state.toClientPayload(1234567999);
  assert.equal(payload.serverNowMs, 1234567999);
  assert.equal(payload.timelines[0].sampledAtMs, 1234567890);
  assert.ok(payload.timelines[0].sampleSeq > 0);
});
