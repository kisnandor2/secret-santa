// startTestServer(): real app on port 0 — see plan-impl.md §11.1
import { createApp } from '../../src/app.js';
import { silentLog } from '../../src/log.js';

export async function startTestServer(overrides = {}) {
  const app = createApp({ PORT: 0, HEARTBEAT_MS: 200, AUTH_TIMEOUT_MS: 200, log: silentLog, ...overrides });
  const port = await app.listen(0);
  return {
    app,
    base: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    close: () => app.close(),
  };
}
