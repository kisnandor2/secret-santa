// Express app: routes, security headers, static — see plan-impl.md §9
import path from 'node:path';
import express from 'express';
import { AppError } from './errors.js';
import { normalizeCode, parseCreateBody, parseJoinBody } from './validate.js';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:", // canvas-confetti may render in a blob worker
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

export function createHttpApp({ store, publicDir, log }) {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true, sessions: store.size() }));

  const api = express.Router();
  api.use(express.json({ limit: '2kb', strict: true }));
  api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  api.post('/sessions', (req, res) => {
    const out = store.createSession(parseCreateBody(req.body));
    log.info('session_created', { code: out.code, hostParticipates: out.participantId !== null });
    res.status(201).json(out);
  });

  api.post('/sessions/:code/join', (req, res) => {
    const code = normalizeCode(req.params.code);
    const out = store.join(code, parseJoinBody(req.body));
    log.info('participant_joined', { code });
    res.status(201).json({ code, ...out });
  });

  api.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'Unknown API endpoint.' }));
  app.use('/api', api);

  app.use(express.static(publicDir, { index: 'index.html', etag: true, maxAge: 0 }));

  // SPA fallback: deep links like /?s=CODE or /anything render the app
  const indexFile = path.join(publicDir, 'index.html');
  app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(indexFile) : next()));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: err.code, message: err.message });
    }
    if (err.status >= 400 && err.status < 500) { // body-parser (bad JSON, too large), bad URL encoding, etc.
      return res.status(400).json({ error: 'INVALID_INPUT', message: 'Request body must be valid JSON under 2 kB.' });
    }
    log.error('http_error', { err });
    res.status(500).json({ error: 'INTERNAL', message: 'Something went wrong.' });
  });

  return app;
}
