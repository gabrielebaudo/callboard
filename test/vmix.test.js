'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');

const createVmixBackend = require('../src/backends/vmix');
const { createState } = require('../src/state');

// A minimal stand-in for a real vMix session: four inputs of mixed types.
// Only two matter to this backend -- whatever's on Program (active=3) and
// whatever's in Preview (preview=1) -- everything else (input 4, a camera
// that's neither) must never appear as a track, regardless of type/duration.
const SAMPLE_XML = `<vmix><active>3</active><preview>1</preview><inputs>` +
  `<input key="still-key-1" number="1" type="Image" title="Logo.png" state="Paused" position="0" duration="0"/>` +
  `<input key="media-key-2" number="2" type="Video" title="Lower Third.mp4" state="Paused" position="1000" duration="20000"/>` +
  `<input key="media-key-3" number="3" type="Video" title="Intro.mp4" state="Running" position="5000" duration="15000"/>` +
  `<input key="cam-key-4" number="4" type="Camera" title="Camera 1" state="Paused" position="0" duration="0"/>` +
  `</inputs></vmix>`;

function frame(xml) {
  return `XML ${Buffer.byteLength(xml, 'utf8')}\r\n${xml}`;
}

// Starts a fake vMix TCP endpoint that always replies to "XML\r\n" with the
// given xml, framed exactly like the real vMix TCP API (see vmix.js's
// module comment / the official docs). Returns { port, close }.
function startFakeVmix(xml) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        if (buf.includes('XML\r\n')) {
          buf = '';
          socket.write(frame(xml));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => server.close() });
    });
  });
}

function fakeStore(host, port) {
  const cfg = { host, tcpPort: port, pollMs: 30, broadcastThrottleMs: 0 };
  return { getVmix: () => cfg, get: () => ({ vmix: cfg }) };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor timed out');
}

test('vmix backend: surfaces exactly Program + Preview, never any other input', async () => {
  const fake = await startFakeVmix(SAMPLE_XML);
  const state = createState();
  const store = fakeStore('127.0.0.1', fake.port);
  const backend = createVmixBackend({ store, state, onStateChange: () => {} });

  try {
    backend.start();
    await waitFor(() => state.raw.timelines.length > 0);

    // Exactly two synthetic slots, regardless of how many real inputs
    // exist or what type they are (a still on Preview counts; the idle
    // camera on neither Program nor Preview never shows up at all).
    assert.equal(state.raw.timelines.length, 2);
    const ids = state.raw.timelines.map((t) => t.id).sort();
    assert.deepEqual(ids, ['vmix-preview', 'vmix-program']);

    const program = state.getTimeline('vmix-program');
    assert.equal(program.name, 'Intro.mp4');
    assert.equal(program.playback.isRunning, true);
    assert.equal(program.playback.currentTime, 5); // 5000ms -> 5s
    assert.equal(program.playback.duration, 15); // 15000ms -> 15s

    const preview = state.getTimeline('vmix-preview');
    assert.equal(preview.name, 'Logo.png');
    // A still genuinely isn't running -- but see the next test for proof
    // Preview's isRunning DOES track real playback (just never promotes
    // it to the live/active slot).
    assert.equal(preview.playback.isRunning, false);
    assert.equal(preview.playback.isPaused, false);

    // Program is always the live slot -- being on air is structural.
    assert.equal(state.raw.activeTimelineId, 'vmix-program');
    assert.equal(state.raw.connectedToBackend, true);

    assert.deepEqual(backend.capabilities, { markers: false, departments: false });
  } finally {
    backend.stop();
    fake.close();
  }
});

test('vmix backend: Program stays the live slot even as a static still (not Running)', async () => {
  // Program (#3) is now the still that was on Preview above -- reads
  // state="Paused" (vMix's resting state for anything not playing). Per
  // the locked rule, Program is ALWAYS the live slot regardless of the
  // underlying media's play state -- only the moving playhead depends on
  // Running, not the LIVE badge/active-timeline itself.
  const xml = `<vmix><active>1</active><preview>2</preview><inputs>` +
    `<input key="still-key-1" number="1" type="Image" title="Logo.png" state="Paused" position="0" duration="0"/>` +
    `<input key="media-key-2" number="2" type="Video" title="Lower Third.mp4" state="Paused" position="1000" duration="20000"/>` +
    `</inputs></vmix>`;
  const fake = await startFakeVmix(xml);
  const state = createState();
  const store = fakeStore('127.0.0.1', fake.port);
  const backend = createVmixBackend({ store, state, onStateChange: () => {} });

  try {
    backend.start();
    await waitFor(() => state.raw.timelines.length > 0);
    assert.equal(state.raw.activeTimelineId, 'vmix-program');
    const program = state.getTimeline('vmix-program');
    assert.equal(program.name, 'Logo.png');
    assert.equal(program.playback.isRunning, false); // not playing, but still the live slot
  } finally {
    backend.stop();
    fake.close();
  }
});

test('vmix backend: a playing Preview reports isRunning but never becomes the active slot', async () => {
  // An operator can cue up and play a clip in Preview before taking it
  // live -- Preview's OWN isRunning must reflect that (so selecting it
  // shows a moving playhead), but it must never be promoted to
  // activeTimelineId/the LIVE badge. Program here is a paused still.
  const xml = `<vmix><active>1</active><preview>2</preview><inputs>` +
    `<input key="still-key-1" number="1" type="Image" title="Logo.png" state="Paused" position="0" duration="0"/>` +
    `<input key="media-key-2" number="2" type="Video" title="Queued clip.mp4" state="Running" position="3000" duration="20000"/>` +
    `</inputs></vmix>`;
  const fake = await startFakeVmix(xml);
  const state = createState();
  const store = fakeStore('127.0.0.1', fake.port);
  const backend = createVmixBackend({ store, state, onStateChange: () => {} });

  try {
    backend.start();
    await waitFor(() => state.raw.timelines.length > 0);

    const preview = state.getTimeline('vmix-preview');
    assert.equal(preview.name, 'Queued clip.mp4');
    assert.equal(preview.playback.isRunning, true);
    assert.equal(preview.playback.currentTime, 3);

    // Program is still the active/live slot, even though it's the one
    // NOT actually playing.
    assert.equal(state.raw.activeTimelineId, 'vmix-program');
  } finally {
    backend.stop();
    fake.close();
  }
});

test('vmix backend: Program/Preview ids are stable across a cut (no DOM-churning GUID swap)', async () => {
  // First poll: input 3 on Program. We flip a live server's response
  // in-flight to simulate an operator cutting to input 2 -- the slot id
  // (vmix-program) must not change, only its name/playback.
  const server = net.createServer();
  let currentXml = SAMPLE_XML;
  server.on('connection', (socket) => {
    socket.on('data', (chunk) => {
      if (chunk.toString('utf8').includes('XML\r\n')) socket.write(frame(currentXml));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const state = createState();
  const store = fakeStore('127.0.0.1', port);
  const backend = createVmixBackend({ store, state, onStateChange: () => {} });

  try {
    backend.start();
    await waitFor(() => state.getTimeline('vmix-program')?.name === 'Intro.mp4');

    // Cut Program from input 3 to input 2.
    currentXml = `<vmix><active>2</active><preview>1</preview><inputs>` +
      `<input key="still-key-1" number="1" type="Image" title="Logo.png" state="Paused" position="0" duration="0"/>` +
      `<input key="media-key-2" number="2" type="Video" title="Lower Third.mp4" state="Running" position="0" duration="20000"/>` +
      `<input key="media-key-3" number="3" type="Video" title="Intro.mp4" state="Paused" position="15000" duration="15000"/>` +
      `</inputs></vmix>`;

    await waitFor(() => state.getTimeline('vmix-program')?.name === 'Lower Third.mp4');
    // Same id throughout -- the card updated in place, it didn't get
    // removed and re-added under the new input's own GUID.
    assert.equal(state.raw.timelines.length, 2);
    assert.equal(state.raw.activeTimelineId, 'vmix-program');
  } finally {
    backend.stop();
    server.close();
  }
});
