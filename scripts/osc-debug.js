#!/usr/bin/env node
'use strict';

/**
 * Standalone probe: connects to QLab over TCP OSC and dumps raw replies
 * to the console. Run this against the real show file BEFORE trusting
 * src/backends/qlab.js, to confirm:
 *   - /workspaces and /workspace/{id}/cueLists reply shapes
 *   - that a Timeline Group child's `preWait` really equals its
 *     position on the Timeline (drag a cue in QLab, re-run, compare)
 *   - that `actionElapsed` on the running Group cue tracks playback
 *   - real `colorName` strings used by the show
 *
 * Also used to confirm two facts needed for multi-timeline support:
 *   - the integer QLab returns for a Group cue's `mode` property when
 *     that group is in Timeline mode (vs List/Start Random/etc), so
 *     multiple Timeline Groups can be auto-discovered by mode instead
 *     of matching one hardcoded name
 *   - whether a Group's `actionElapsed` persists (>0) or resets to 0
 *     once playback is stopped, which decides whether "elapsed time"
 *     can be used as part of a done/finished heuristic
 *
 * Usage: node scripts/osc-debug.js
 */

const path = require('path');
const fs = require('fs');
const osc = require('osc');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const qlabCfg = config.qlab;

const port = new osc.TCPSocketPort({
  address: qlabCfg.host,
  port: qlabCfg.tcpPort
});

const pending = new Map();

function send(address, args) {
  console.log(`\n--> SEND ${address}`, args === undefined ? '' : args);
  port.send({ address, args: args === undefined ? [] : [].concat(args) });
}

function request(address, args, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    send(address, args);
    const timer = setTimeout(() => reject(new Error(`timeout: ${address}`)), timeoutMs);
    if (!pending.has(address)) pending.set(address, []);
    pending.get(address).push({ resolve, reject, timer });
  });
}

port.on('message', (msg) => {
  const jsonArg = msg.args && msg.args[0];
  let reply = null;
  if (typeof jsonArg === 'string') {
    try { reply = JSON.parse(jsonArg); } catch (e) { /* not JSON */ }
  }
  if (!reply) {
    console.log('<-- RAW', msg);
    return;
  }
  console.log(`<-- REPLY ${reply.address} [${reply.status}]`, JSON.stringify(reply.data, null, 2));

  const list = pending.get(reply.address);
  if (list && list.length) {
    const entry = list.shift();
    clearTimeout(entry.timer);
    entry.resolve(reply);
  }
});

port.on('error', (err) => console.error('SOCKET ERROR:', err.message));
port.on('close', () => console.log('Socket closed.'));

port.on('ready', async () => {
  console.log(`Connected to QLab at ${qlabCfg.host}:${qlabCfg.tcpPort}`);

  try {
    const workspacesReply = await request('/workspaces');
    const workspaces = workspacesReply.data || [];
    if (workspaces.length === 0) {
      console.log('No open workspaces found. Open a workspace in QLab and re-run.');
      process.exit(1);
    }

    const workspaceId = qlabCfg.workspaceId || workspaces[0].uniqueID;
    console.log(`Using workspace: ${workspaceId}`);

    await request(`/workspace/${workspaceId}/connect`, [qlabCfg.passcode || '']);
    send(`/workspace/${workspaceId}/updates`, 1);

    const cueListsReply = await request(`/workspace/${workspaceId}/cueLists`);
    const cueLists = cueListsReply.data || [];

    // ---- multi-timeline discovery probe -----------------------------
    // Walk every cue in every list, fetch `mode` for anything typed
    // "Group", and print name/listName/mode side by side. Run this
    // against a show with at least one known Timeline Group (and
    // ideally one List/Start-Random group for contrast) and read off
    // the integer QLab reports for Timeline mode -- do not guess it.
    console.log('\n--- Group cue `mode` scan (for multi-timeline discovery) ---');
    const groupCues = [];
    (function collectGroups(cues) {
      for (const cue of cues || []) {
        if (cue.type === 'Group') groupCues.push(cue);
        if (cue.cues) collectGroups(cue.cues);
      }
    })(cueLists.flatMap((l) => l.cues || []));

    if (groupCues.length === 0) {
      console.log('No Group cues found in any cue list.');
    }
    for (const cue of groupCues) {
      const reply = await request(
        `/workspace/${workspaceId}/cue_id/${cue.uniqueID}/valuesForKeys`,
        JSON.stringify(['uniqueID', 'name', 'listName', 'type', 'mode'])
      );
      const d = reply.data || {};
      console.log(`  "${d.name}" (listName=${d.listName})  mode=${d.mode}`);
    }
    console.log('--- end mode scan --- (note the mode value for your known Timeline Group above)\n');

    let timelineGroup = null;
    (function walk(cues) {
      for (const cue of cues || []) {
        if (cue.listName === qlabCfg.timelineGroupName || cue.name === qlabCfg.timelineGroupName) {
          timelineGroup = cue;
          return;
        }
        if (cue.cues) walk(cue.cues);
      }
    })(cueLists.flatMap((l) => l.cues || []));

    if (!timelineGroup) {
      console.log(`\nTimeline Group "${qlabCfg.timelineGroupName}" not found. Check config.json timelineGroupName against your show.`);
      console.log('Top-level cues found:', JSON.stringify(cueLists, null, 2));
      process.exit(1);
    }

    console.log(`\nFound Timeline Group: ${timelineGroup.uniqueID} (${timelineGroup.cues?.length || 0} children)`);

    for (const child of timelineGroup.cues || []) {
      await request(
        `/workspace/${workspaceId}/cue_id/${child.uniqueID}/valuesForKeys`,
        JSON.stringify(['uniqueID', 'number', 'listName', 'name', 'type', 'colorName', 'notes', 'preWait', 'duration'])
      );
    }

    console.log('\nPolling Timeline Group actionElapsed 5x (trigger playback in QLab to see it move)...');
    for (let i = 0; i < 5; i++) {
      await request(
        `/workspace/${workspaceId}/cue_id/${timelineGroup.uniqueID}/valuesForKeys`,
        JSON.stringify(['actionElapsed', 'duration', 'isRunning', 'isPaused'])
      );
      await new Promise((r) => setTimeout(r, 1000));
    }

    // ---- stopped-actionElapsed probe (for the "done" status heuristic) --
    // Let playback run for a bit, then manually STOP the Timeline Group in
    // QLab (not pause) and watch these 5 polls: does actionElapsed persist
    // at whatever value it stopped on, or reset to 0?
    console.log('\nNow manually STOP the Timeline Group in QLab (not pause).');
    console.log('Polling actionElapsed/isRunning/isPaused 5x post-stop to see if elapsed persists or resets...');
    for (let i = 0; i < 5; i++) {
      await request(
        `/workspace/${workspaceId}/cue_id/${timelineGroup.uniqueID}/valuesForKeys`,
        JSON.stringify(['actionElapsed', 'isRunning', 'isPaused'])
      );
      await new Promise((r) => setTimeout(r, 1500));
    }

    console.log('\nDone. Ctrl+C to exit.');
  } catch (err) {
    console.error('DEBUG SCRIPT ERROR:', err.message);
    process.exit(1);
  }
});

console.log(`Connecting to QLab at ${qlabCfg.host}:${qlabCfg.tcpPort}...`);
port.open();
