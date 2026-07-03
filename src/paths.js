'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_NAME = 'Callboard';
const DEFAULT_CONFIG = require('../config.default.json');

/**
 * Per-user, per-OS data directory. Config (and, later, logs) live here
 * instead of next to the code so a packaged build -- where the code sits
 * in a read-only app bundle / pkg snapshot -- has somewhere writable to
 * persist Settings.
 */
function getDataDir() {
  if (process.env.CALLBOARD_DATA_DIR) {
    return process.env.CALLBOARD_DATA_DIR;
  }
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', APP_NAME);
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_NAME);
    default:
      // Linux/other: no installer targets this OS, this is dev/CI-only.
      return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), APP_NAME.toLowerCase());
  }
}

// Reserved for future file logging (console-only today).
function getLogDir() {
  return path.join(getDataDir(), 'logs');
}

/**
 * Resolve the config.json path to use, creating the per-user data dir and
 * seeding a first-run config if none exists yet.
 *
 * CALLBOARD_CONFIG lets dev/mock/tests point at an explicit file (e.g. the
 * repo-root config.json checked into this repo) instead of the per-user
 * data dir, so local development keeps editing a file under version
 * control rather than silently forking off into Application Support.
 */
function getConfigPath() {
  const configPath = process.env.CALLBOARD_CONFIG
    ? process.env.CALLBOARD_CONFIG
    : path.join(getDataDir(), 'config.json');

  // Ensure the file exists before settingsStore reads it -- seed a fresh
  // config if it's missing, whichever path we resolved. Covers both the
  // normal first run (data dir) and an explicit CALLBOARD_CONFIG pointed
  // at a path that doesn't exist yet, which used to crash on read.
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  if (!fs.existsSync(configPath)) {
    seedConfig(configPath);
  }

  return configPath;
}

function seedConfig(configPath) {
  // First run: migrate a legacy repo-root config.json (pre-Callboard
  // installs that ran `node src/server.js` straight from a checkout) if
  // one is sitting next to the app; otherwise seed from the bundled
  // default. A packaged (pkg) build never sits next to a repo checkout,
  // so this is dev/source-checkout only -- skip it entirely when packaged.
  //
  // The path below is deliberately NOT built as a literal
  // `path.join(__dirname, '..', 'config.json')` call: pkg's asset
  // auto-detection statically scans for exactly that pattern (all-literal
  // args) and silently bundles whatever file it resolves to into the
  // shipped binary. A developer's real config.json can carry a venue's
  // real host/passcode -- baking it into every distributed build would
  // leak it. Building the path from runtime variables keeps it outside
  // that detector, on top of the process.pkg guard below.
  let seed = DEFAULT_CONFIG;
  if (!process.pkg) {
    const parentDir = path.dirname(__dirname);
    const legacyFile = ['config', 'json'].join('.');
    const legacyPath = path.join(parentDir, legacyFile);
    try {
      if (fs.existsSync(legacyPath)) {
        seed = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
        console.log(`[paths] migrated legacy config from ${legacyPath}`);
      }
    } catch (err) {
      console.error(`[paths] failed to read legacy config, using defaults: ${err.message}`);
    }
  }
  fs.writeFileSync(configPath, JSON.stringify(seed, null, 2) + '\n', 'utf8');
}

module.exports = { APP_NAME, getDataDir, getLogDir, getConfigPath };
