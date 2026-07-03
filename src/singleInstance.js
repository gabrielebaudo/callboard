'use strict';

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

function lockFilePath(dataDir) {
  return path.join(dataDir, 'instance.lock');
}

function isAlive(pid) {
  try {
    // Signal 0 doesn't actually send a signal, just checks the pid exists
    // and this process is allowed to signal it.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function openUrl(url) {
  const cmd = process.platform === 'darwin' ? `open "${url}"`
    : process.platform === 'win32' ? `start "" "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

/**
 * Launching Callboard a second time (e.g. clicking its Launchpad/Start
 * Menu icon while the LaunchAgent/Startup copy is already running) would
 * otherwise just fall through to the EADDRINUSE port-fallback in
 * server.js and quietly bind a second instance on the next port --
 * confusing (two tray icons, "which one is live"). If a lock file naming
 * a still-alive pid exists, open that instance's URL and exit instead of
 * starting a second one.
 *
 * Returns true if this process should exit now (another instance is
 * running and was focused), false if it should proceed to start
 * normally (and should call claim() once it knows its own port).
 */
function checkExisting(dataDir) {
  const lockPath = lockFilePath(dataDir);
  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return false; // no lock file, or unreadable/corrupt -- proceed normally
  }

  if (!existing.pid || !isAlive(existing.pid)) {
    return false; // stale lock from a process that's gone -- proceed normally
  }

  console.log(`[server] Callboard is already running (pid ${existing.pid}) -- opening it instead of starting a second copy`);
  if (existing.port) {
    openUrl(`http://localhost:${existing.port}`);
  }
  return true;
}

function claim(dataDir, port) {
  fs.writeFileSync(lockFilePath(dataDir), JSON.stringify({ pid: process.pid, port }), 'utf8');
}

function release(dataDir) {
  try {
    fs.unlinkSync(lockFilePath(dataDir));
  } catch {
    // already gone -- fine
  }
}

module.exports = { checkExisting, claim, release };
