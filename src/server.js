'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const QRCode = require('qrcode');
const { Server: SocketIOServer } = require('socket.io');

const { createState } = require('./state');
const { createSettingsStore } = require('./settingsStore');
const { createBackend } = require('./backends');
const { getLocalIPv4Addresses } = require('./netInfo');
const { createTray } = require('./tray');
const singleInstance = require('./singleInstance');
const paths = require('./paths');

// A packaged (LSUIElement) build has no Terminal to read console output
// from -- Finder discards it. Tee console.log/error/warn to a file under
// the per-user data dir (see paths.js) so a Finder-launched build's backend
// connect failures are actually readable, not just silently lost. Kept for
// both packaged and dev runs (harmless, and useful for `npm start` too).
function setupFileLogging() {
  try {
    const logDir = paths.getLogDir();
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'callboard.log');
    const stream = fs.createWriteStream(logPath, { flags: 'a' });
    const write = (level, args) => {
      const line = `[${new Date().toISOString()}] [${level}] ${args.map((a) => (a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
      stream.write(line);
    };
    for (const level of ['log', 'warn', 'error']) {
      const orig = console[level].bind(console);
      console[level] = (...args) => {
        orig(...args);
        write(level, args);
      };
    }
    // Node's default for an uncaught exception is to log to stderr and
    // exit -- with no listener at all that's invisible in a packaged,
    // Finder-launched build. Log it to the file (so it's actually
    // readable) and preserve the exit, rather than swallowing it and
    // leaving the process running in an undefined state.
    process.on('uncaughtException', (err) => {
      console.error('[server] uncaught exception:', err);
      process.exit(1);
    });
    process.on('unhandledRejection', (reason) => {
      console.error('[server] unhandled rejection:', reason);
    });
    console.log(`[server] logging to ${logPath}`);
  } catch (err) {
    // Logging is best-effort -- never let a logging setup failure prevent
    // the server itself from starting.
    console.error('[server] failed to set up file logging:', err.message);
  }
}
setupFileLogging();

const CONFIG_PATH = paths.getConfigPath();
// Lock file lives next to config.json rather than in the OS data dir
// directly: with CALLBOARD_CONFIG pointing dev/mock runs at the repo's
// own config.json, this keeps them a separate "instance identity" from
// an installed copy running out of Application Support/AppData, so
// testing locally doesn't just bounce off an already-running real
// install (or vice versa).
const LOCK_DIR = path.dirname(CONFIG_PATH);

// Launching Callboard again while it's already running (its Launchpad/
// Start Menu icon, with the LaunchAgent/Startup copy still up) would
// otherwise silently bind a second instance on the next free port --
// see singleInstance.js. Bail out before touching config/backends/etc.
if (singleInstance.checkExisting(LOCK_DIR)) {
  process.exit(0);
}

const store = createSettingsStore(CONFIG_PATH);
const USE_MOCK = process.env.USE_MOCK === '1';

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
// Self-hosted so the app works on the show LAN without internet access.
app.use('/vendor/fontawesome', express.static(
  path.join(__dirname, '..', 'node_modules', '@fortawesome', 'fontawesome-free')
));
app.use(express.json());

function settingsPayload() {
  const cfg = store.get();
  return {
    server: cfg.server,
    backend: cfg.backend,
    qlab: cfg.qlab,
    vmix: cfg.vmix,
    departments: cfg.departments,
    capabilities: backend.capabilities
  };
}

app.get('/api/settings', (req, res) => {
  res.json(settingsPayload());
});

// What the tray's "Open Callboard" opens: always plain localhost, since
// it runs on the same machine as the server.
function localUrl() {
  return boundPort ? `http://localhost:${boundPort}` : null;
}

// Connection info for the "how do I reach this on the LAN" screen: every
// local IPv4 with a QR code each -- no .local hostname, so this is the
// only way in on Settings > Connect.
async function systemPayload() {
  const addresses = getLocalIPv4Addresses();
  const urls = [];

  for (const addr of addresses) {
    urls.push({ label: addr.iface, url: `http://${addr.address}:${boundPort}` });
  }

  for (const entry of urls) {
    entry.qr = await QRCode.toDataURL(entry.url, { margin: 1, scale: 4 });
  }

  return {
    hostname: os.hostname(),
    port: boundPort,
    urls
  };
}

app.get('/api/system', (req, res) => {
  systemPayload()
    .then((payload) => res.json(payload))
    .catch((err) => res.status(500).json({ error: err.message }));
});

app.post('/api/settings', (req, res) => {
  const prevType = store.get().backend.type;
  try {
    store.update(req.body || {});
  } catch (err) {
    res.status(400).json({ error: err.message });
    return;
  }

  if (!USE_MOCK) {
    const nextType = store.get().backend.type;
    if (nextType !== prevType) {
      // Switched show-control app entirely -- tear down the old
      // connection/timers and stand up the new backend from scratch
      // rather than trying to reuse/repurpose the old instance.
      console.log(`[server] backend switched ${prevType} -> ${nextType}, reconnecting...`);
      backend.stop();
      backend = createBackend(nextType, { store, state, onStateChange: broadcastState });
      backend.start();
    } else {
      backend.applyConfig();
    }
  }

  const payload = settingsPayload();
  io.emit('settings', payload);
  broadcastState();
  res.json(payload);
});

const server = http.createServer(app);
const io = new SocketIOServer(server);

const state = createState();

function broadcastState() {
  io.emit('state', state.toClientPayload());
}

io.on('connection', (socket) => {
  // Send current state + settings immediately to the newly connected client.
  socket.emit('state', state.toClientPayload());
  socket.emit('settings', settingsPayload());

  socket.on('refresh', async () => {
    try {
      await backend.refreshAll();
      broadcastState();
    } catch (err) {
      console.error('[server] manual refresh failed:', err.message);
    }
  });

  // Operator clicked a non-live timeline to preview it -- fetch its
  // marker detail on demand (see qlab.js's tiered-poll comment: full
  // detail is only ever fetched for the active timeline + whatever a
  // client has explicitly asked to view). No-op for backends without
  // markers (capabilities.markers === false).
  socket.on('selectTimeline', async (id) => {
    if (typeof id !== 'string' || !id) return;
    try {
      await backend.refreshMarkersFor(id);
      broadcastState();
    } catch (err) {
      console.error('[server] selectTimeline failed:', err.message);
    }
  });

  socket.on('timeSync', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const serverReceiveMs = Date.now();
    ack({
      clientSendMs: payload && payload.clientSendMs,
      serverReceiveMs,
      serverSendMs: Date.now()
    });
  });
});

const backendType = USE_MOCK ? 'mock' : store.get().backend.type;
let backend = createBackend(backendType, { store, state, onStateChange: broadcastState });
backend.start();

// boundPort is the port actually listened on, which may differ from the
// configured one if it was taken (see startServer's fallback below).
let boundPort = null;

const desiredPort = store.get().server?.port || 3000;
const MAX_PORT_ATTEMPTS = 10;

function startServer(port, attemptsLeft) {
  const onError = (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.warn(`[server] port ${port} in use, trying ${port + 1}...`);
      startServer(port + 1, attemptsLeft - 1);
    } else {
      console.error(`[server] failed to bind port ${port}: ${err.message}`);
      process.exit(1);
    }
  };
  server.once('error', onError);
  server.listen(port, () => {
    server.removeListener('error', onError);
    boundPort = port;
    console.log(`[server] Callboard listening on http://localhost:${boundPort}`);
    if (port !== desiredPort) {
      console.warn(`[server] configured port ${desiredPort} was in use; bound ${port} instead`);
    }
    if (!USE_MOCK) {
      console.log(`[server] Backend: ${backendType}`);
    }
    startTray();
    singleInstance.claim(LOCK_DIR, port);
  });
}

startServer(desiredPort, MAX_PORT_ATTEMPTS);

// Menu bar (macOS/Linux) / system tray (Windows) icon -- lets an operator
// quit or jump to the UI without a terminal. Set CALLBOARD_NO_TRAY=1 to
// skip it (headless dev/CI boxes with no GUI session to attach to).
const tray = process.env.CALLBOARD_NO_TRAY === '1'
  ? null
  : createTray({ getUrl: localUrl, onQuit: shutdown });

function startTray() {
  if (!tray) return;
  try {
    tray.start();
  } catch (err) {
    // No GUI session, missing display server, unsupported platform,
    // etc. -- the server itself is unaffected, just no icon.
    console.error('[server] tray icon failed to start:', err.message);
  }
}

function shutdown() {
  console.log('[server] shutting down...');
  singleInstance.release(LOCK_DIR);
  if (tray) tray.stop();
  backend.stop();
  server.close(() => process.exit(0));
  // Force-exit if something (e.g. an open socket) keeps the process alive.
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
