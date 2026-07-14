'use strict';

const fs = require('fs');

const CONFIG_KEYS = ['server', 'backend', 'qlab', 'vmix', 'departments'];
const BACKEND_TYPES = ['qlab', 'vmix'];

/**
 * Small mutable settings store backed by config.json. Loads once at
 * startup, and persists back to disk on every update() so hand-edits
 * and web-UI edits both work. Not a database -- this is app
 * configuration only (departments, backend connection); markers/tracks
 * themselves always come live from whichever backend is configured,
 * never from here.
 *
 * `backend.type` selects which of the `qlab`/`vmix` connection sections
 * is actually in use (see src/backends/index.js) -- both sections are
 * always kept in config.json so switching backends in Settings doesn't
 * lose the other one's host/port.
 */
function createSettingsStore(configPath) {
  let config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  function get() {
    return config;
  }

  function getQlab() {
    return config.qlab;
  }

  function getVmix() {
    return config.vmix;
  }

  function getDepartments() {
    return config.departments;
  }

  function validatePatch(patch) {
    for (const key of Object.keys(patch)) {
      if (!CONFIG_KEYS.includes(key)) {
        throw new Error(`Unknown settings section: "${key}"`);
      }
    }
    if (patch.backend && patch.backend.type !== undefined && !BACKEND_TYPES.includes(patch.backend.type)) {
      throw new Error(`backend.type must be one of: ${BACKEND_TYPES.join(', ')}`);
    }
    if (patch.departments) {
      if (!Array.isArray(patch.departments)) {
        throw new Error('departments must be an array of {key,label}');
      }
      const seen = new Set();
      for (const d of patch.departments) {
        if (!d || typeof d.key !== 'string' || !d.key.trim()) {
          throw new Error('Every department needs a non-empty key');
        }
        const key = d.key.trim().toUpperCase();
        if (seen.has(key)) throw new Error(`Duplicate department key: "${key}"`);
        seen.add(key);
      }
    }
    if (patch.server) {
      const { port } = patch.server;
      if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
        throw new Error('server.port must be a positive integer <= 65535');
      }
    }
    if (patch.qlab) {
      const {
        tcpPort, playheadPollMs, broadcastThrottleMs, markerRefreshMs, statusPollMs,
        standbyThresholdS, imminentThresholdS
      } = patch.qlab;
      if (tcpPort !== undefined && (!Number.isInteger(tcpPort) || tcpPort <= 0)) {
        throw new Error('qlab.tcpPort must be a positive integer');
      }
      if (playheadPollMs !== undefined && (!Number.isInteger(playheadPollMs) || playheadPollMs < 50)) {
        throw new Error('qlab.playheadPollMs must be an integer >= 50');
      }
      if (broadcastThrottleMs !== undefined && (!Number.isInteger(broadcastThrottleMs) || broadcastThrottleMs < 50)) {
        throw new Error('qlab.broadcastThrottleMs must be an integer >= 50');
      }
      if (markerRefreshMs !== undefined && (!Number.isInteger(markerRefreshMs) || markerRefreshMs < 1000)) {
        throw new Error('qlab.markerRefreshMs must be an integer >= 1000');
      }
      if (statusPollMs !== undefined && (!Number.isInteger(statusPollMs) || statusPollMs < 200)) {
        throw new Error('qlab.statusPollMs must be an integer >= 200');
      }
      if (standbyThresholdS !== undefined && (!Number.isFinite(standbyThresholdS) || standbyThresholdS < 0)) {
        throw new Error('qlab.standbyThresholdS must be a number >= 0');
      }
      if (imminentThresholdS !== undefined && (!Number.isFinite(imminentThresholdS) || imminentThresholdS < 0)) {
        throw new Error('qlab.imminentThresholdS must be a number >= 0');
      }
    }
    if (patch.vmix) {
      const { tcpPort, pollMs, broadcastThrottleMs } = patch.vmix;
      if (tcpPort !== undefined && (!Number.isInteger(tcpPort) || tcpPort <= 0)) {
        throw new Error('vmix.tcpPort must be a positive integer');
      }
      if (pollMs !== undefined && (!Number.isInteger(pollMs) || pollMs < 50)) {
        throw new Error('vmix.pollMs must be an integer >= 50');
      }
      if (broadcastThrottleMs !== undefined && (!Number.isInteger(broadcastThrottleMs) || broadcastThrottleMs < 50)) {
        throw new Error('vmix.broadcastThrottleMs must be an integer >= 50');
      }
    }
  }

  /**
   * Deep-merge a patch into config, persist to disk, return the new config.
   * Sections other than `departments` (which is replaced wholesale, since
   * it's an ordered list the UI owns) are shallow-merged per key.
   */
  function update(patch) {
    validatePatch(patch);

    const next = { ...config };
    for (const [section, value] of Object.entries(patch)) {
      if (section === 'departments') {
        next[section] = value;
      } else {
        next[section] = { ...config[section], ...value };
      }
    }

    fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
    config = next;
    return config;
  }

  return { get, getQlab, getVmix, getDepartments, update };
}

module.exports = { createSettingsStore };
