'use strict';

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const SysTray = require('systray').default;

const ICON_PNG = path.join(__dirname, '..', 'build', 'icons', 'tray-icon.png');
const ICON_ICO = path.join(__dirname, '..', 'build', 'icons', 'tray-icon.ico');

function openUrl(url) {
  const cmd = process.platform === 'darwin' ? `open "${url}"`
    : process.platform === 'win32' ? `start "" "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) console.error('[tray] failed to open browser:', err.message);
  });
}

/**
 * Menu bar (macOS/Linux) / system tray (Windows) icon: "Open Callboard"
 * jumps to the recommended URL in the default browser, "Quit" runs the
 * caller's shutdown and exits. Uses the `systray` package (a small
 * per-OS native helper binary, no Chromium) rather than Electron, to
 * keep the packaged app in the tens-of-MB range instead of ~200MB.
 *
 * `getUrl()` is called fresh on every click rather than captured once at
 * startup, so it always reflects the port actually bound (may differ
 * from the configured one, see server.js's EADDRINUSE fallback).
 */
function createTray({ getUrl, onQuit }) {
  let tray = null;

  function start() {
    const iconPath = process.platform === 'win32' ? ICON_ICO : ICON_PNG;
    const icon = fs.readFileSync(iconPath).toString('base64');

    tray = new SysTray({
      menu: {
        icon,
        title: '',
        tooltip: 'Callboard',
        items: [
          { title: 'Open Callboard', tooltip: 'Open the viewer in your browser', checked: false, enabled: true },
          { title: 'Quit', tooltip: 'Stop Callboard', checked: false, enabled: true }
        ]
      },
      debug: false,
      // Packaged (pkg) builds can't exec a binary living inside their own
      // virtual snapshot -- copyDir extracts the native tray helper to a
      // real directory on disk first. Harmless no-op in dev.
      copyDir: true
    });

    tray.onClick((action) => {
      if (action.seq_id === 0) {
        const url = getUrl();
        if (url) openUrl(url);
      } else if (action.seq_id === 1) {
        stop();
        onQuit();
      }
    });
  }

  function stop() {
    if (tray) {
      tray.kill(false);
      tray = null;
    }
  }

  return { start, stop };
}

module.exports = { createTray };
