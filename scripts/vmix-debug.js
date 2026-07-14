#!/usr/bin/env node
'use strict';

/**
 * Standalone probe: connects to vMix over its TCP API (port 8099, same
 * port Companion uses) and dumps raw + parsed state. Run this against a
 * real vMix instance BEFORE trusting src/backends/vmix.js, to confirm:
 *   - the exact "XML <len>\r\n<payload>" framing matches what vmix.js's
 *     drainBuffer() expects
 *   - each <input>'s key/number/title/type/state/position/duration
 *     attributes match what applyXml() reads
 *   - position/duration really are milliseconds (start/stop playback on
 *     a media input in vMix and watch position count up here)
 *   - which inputs have a real duration (become tracks) vs which don't
 *     (cameras/titles/colours -- correctly excluded)
 *   - <active>/<preview> input numbers, and that state="Running" on the
 *     active input is what should drive the clock/playhead
 *
 * Usage: node scripts/vmix-debug.js [host] [port]
 *   defaults to config.json's vmix.host/vmix.tcpPort if omitted.
 */

const path = require('path');
const fs = require('fs');
const net = require('net');
const { XMLParser } = require('fast-xml-parser');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const vmixCfg = config.vmix || {};

const host = process.argv[2] || vmixCfg.host || '127.0.0.1';
const port = Number(process.argv[3]) || vmixCfg.tcpPort || 8099;

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

console.log(`Connecting to vMix TCP API at ${host}:${port}...`);
const socket = net.createConnection({ host, port });

let recvBuffer = Buffer.alloc(0);
let pollCount = 0;
const MAX_POLLS = 8;

socket.on('connect', () => {
  console.log('Connected. Polling XML every 1s (start/stop a media input in vMix to watch position move)...\n');
  poll();
  const timer = setInterval(() => {
    if (pollCount >= MAX_POLLS) {
      clearInterval(timer);
      console.log('\nDone. Ctrl+C to exit, or re-run after changing vMix state.');
      socket.end();
      return;
    }
    poll();
  }, 1000);
});

socket.on('error', (err) => {
  console.error('SOCKET ERROR:', err.message);
  process.exit(1);
});
socket.on('close', () => console.log('Socket closed.'));

function poll() {
  pollCount += 1;
  socket.write('XML\r\n');
}

socket.on('data', (chunk) => {
  recvBuffer = Buffer.concat([recvBuffer, chunk]);
  drainBuffer();
});

function drainBuffer() {
  for (;;) {
    const headerEnd = recvBuffer.indexOf('\r\n');
    if (headerEnd === -1) return;
    const headerLine = recvBuffer.slice(0, headerEnd).toString('utf8');
    const match = /^XML (\d+)$/.exec(headerLine.trim());
    if (!match) {
      console.log('<-- (non-XML line, dropped):', headerLine);
      recvBuffer = recvBuffer.slice(headerEnd + 2);
      continue;
    }
    const len = parseInt(match[1], 10);
    const payloadStart = headerEnd + 2;
    if (recvBuffer.length < payloadStart + len) return;
    const payload = recvBuffer.slice(payloadStart, payloadStart + len).toString('utf8');
    recvBuffer = recvBuffer.slice(payloadStart + len);
    handleXml(payload);
  }
}

function handleXml(xml) {
  console.log(`\n=== poll ${pollCount} ===`);
  const parsed = xmlParser.parse(xml);
  const root = parsed.vmix || {};
  let inputs = (root.inputs && root.inputs.input) || [];
  if (!Array.isArray(inputs)) inputs = [inputs];

  console.log(`active=${root.active}  preview=${root.preview}  inputs=${inputs.length}`);
  for (const i of inputs) {
    const isTrack = Number(i['@_duration']) > 0;
    console.log(
      `  #${i['@_number']} key=${i['@_key']} type=${i['@_type']} state=${i['@_state']} ` +
      `title="${i['@_title']}" position=${i['@_position']}ms duration=${i['@_duration']}ms` +
      (isTrack ? '  <- TRACK' : '  (no duration, excluded)')
    );
  }
}
