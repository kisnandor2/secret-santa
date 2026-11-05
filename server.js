// Process entry: config, listen, signals — see plan-impl.md §10
import { createApp } from './src/app.js';

// TODO: const app = createApp(); await app.listen();
// TODO: on SIGTERM/SIGINT call app.close() with a 3 s hard process.exit(0) fallback.
// TODO: on uncaughtException log the error and exit with status 1.
void createApp;
