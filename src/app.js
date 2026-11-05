// createApp(): wires store + http + hub onto one http.Server — see plan-impl.md §10
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { createStore } from './store.js';
import { createPersistence } from './persist.js';
import { createHttpApp } from './http.js';
import { createHub } from './hub.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));

// overrides: any config key (PORT, SESSION_TTL_MIN, DB_PATH, ...) plus optional
// `log`, `store` and `persistence` instances
export function createApp(overrides = {}) {
  const { log: logOverride, store: storeOverride, persistence: persistenceOverride, ...configOverrides } = overrides;
  const config = { ...loadConfig(), ...configOverrides };
  const log = logOverride ?? createLogger(config.LOG_LEVEL);
  const store = storeOverride ?? createStore({
    ttlMs: config.SESSION_TTL_MIN * 60_000,
    maxSessions: config.MAX_SESSIONS,
    maxParticipants: config.MAX_PARTICIPANTS,
    onListenerError: (err) => log.error('store_listener_error', { err }),
  });

  const persistence = persistenceOverride !== undefined ? persistenceOverride
    : config.DB_PATH ? createPersistence({ dbPath: config.DB_PATH, store, log })
    : null;

  if (persistence) {
    const { restored, expired } = store.restoreSessions(persistence.loadAll());
    for (const code of expired) persistence.removeSession(code);
    log.info('sessions_restored', { restored: restored.length, expired: expired.length });
  }

  const server = http.createServer(createHttpApp({ store, publicDir, log, persistence }));
  const hub = createHub({ store, heartbeatMs: config.HEARTBEAT_MS, authTimeoutMs: config.AUTH_TIMEOUT_MS, log });

  // Must never throw: an exception here is uncaught and takes down the process (and every session).
  server.on('upgrade', (req, socket, head) => {
    let pathname = null;
    try { pathname = new URL(req.url, 'http://x').pathname; } catch { /* malformed URL, e.g. "//" */ }
    if (pathname === '/ws') hub.handleUpgrade(req, socket, head);
    else socket.destroy();
  });

  return {
    server,
    store,
    hub,
    config,
    persistence,
    listen: (port = config.PORT) => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, () => resolve(server.address().port));
    }),
    close: async () => {
      hub.closeAll();
      store.dispose();
      persistence?.close();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
