// Process entry: config, listen, signals — see plan-impl.md §10
import { createApp } from './src/app.js';
import { createLogger } from './src/log.js';
import { loadConfig } from './src/config.js';

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const app = createApp({ log });
const port = await app.listen();
log.info('listening', { port });

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info('shutdown', { signal });
  setTimeout(() => process.exit(0), 3000).unref();
  await app.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  log.error('uncaught_exception', { err });
  process.exit(1);
});
