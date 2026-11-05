import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHttpApp } from '../src/http.js';
import { createStore } from '../src/store.js';
import { silentLog } from '../src/log.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));

// Exercises the Express layer on its own (no WebSocket hub) — see plan-impl.md §11.3
describe('http', () => {
  let server, base, store;

  before(async () => {
    store = createStore({ ttlMs: 60_000, maxSessions: 3, maxParticipants: 4 });
    server = http.createServer(createHttpApp({ store, publicDir, log: silentLog }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(() => store.dispose()); // maxSessions is tiny; start every test empty

  after(async () => {
    store.dispose();
    await new Promise((resolve) => server.close(resolve));
  });

  const post = (path, body, headers = { 'content-type': 'application/json' }) =>
    fetch(base + path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

  const createHosted = async (name = 'Hostie') => (await post('/api/sessions', { name, funFact: 'hosts' })).json();

  async function expectError(res, status, error) {
    assert.equal(res.status, status);
    const body = await res.json();
    assert.equal(body.error, error);
    assert.equal(typeof body.message, 'string');
    assert.ok(body.message.length > 0);
  }

  it('healthz returns 200 with session count', async () => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.sessions, 'number');
  });

  it('/ returns HTML with security headers', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  it('deep links fall back to index.html', async () => {
    const res = await fetch(`${base}/some/deep/link?s=FROSTY-427`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
  });

  it('create with host participating returns code, hostToken and participantId', async () => {
    const res = await post('/api/sessions', { name: 'Alice', funFact: 'likes snow' });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.match(body.code, /^[A-Z]{3,10}-\d{3}$/);
    assert.equal(typeof body.hostToken, 'string');
    assert.equal(typeof body.participantId, 'string');
  });

  it('create with host opted out returns participantId null', async () => {
    const res = await post('/api/sessions', { participate: false });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).participantId, null);
  });

  it('join returns normalized code, participantId and token', async () => {
    const { code } = await createHosted();
    const res = await post(`/api/sessions/${code.toLowerCase()}/join`, { name: 'Bob', funFact: 'juggles' });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.code, code);
    assert.equal(typeof body.participantId, 'string');
    assert.equal(typeof body.token, 'string');
    assert.notEqual(body.token, '');
  });

  it('create without a name while participating gives 400 INVALID_INPUT', async () => {
    await expectError(await post('/api/sessions', {}), 400, 'INVALID_INPUT');
  });

  it('join with invalid code format gives 400 INVALID_INPUT', async () => {
    await expectError(await post('/api/sessions/nope/join', { name: 'Bob' }), 400, 'INVALID_INPUT');
  });

  it('join unknown session gives 404 NOT_FOUND', async () => {
    await expectError(await post('/api/sessions/ZZZZZ-999/join', { name: 'Bob' }), 404, 'NOT_FOUND');
  });

  it('join with the host name (any case) gives 409 NAME_TAKEN', async () => {
    const { code } = await createHosted('Alice');
    await expectError(await post(`/api/sessions/${code}/join`, { name: '  ALICE ' }), 409, 'NAME_TAKEN');
  });

  it('join after the draw gives 409 ALREADY_DRAWN', async () => {
    const { code, hostToken } = await createHosted();
    await post(`/api/sessions/${code}/join`, { name: 'B' });
    await post(`/api/sessions/${code}/join`, { name: 'C' });
    store.draw(code, hostToken);
    await expectError(await post(`/api/sessions/${code}/join`, { name: 'D' }), 409, 'ALREADY_DRAWN');
  });

  it('join a full session gives 409 SESSION_FULL', async () => {
    const { code } = await createHosted(); // maxParticipants 4, host counts as one
    for (const name of ['B', 'C', 'D']) assert.equal((await post(`/api/sessions/${code}/join`, { name })).status, 201);
    await expectError(await post(`/api/sessions/${code}/join`, { name: 'E' }), 409, 'SESSION_FULL');
  });

  it('too many sessions gives 503 SESSION_LIMIT', async () => {
    for (let i = 0; i < 3; i++) assert.equal((await post('/api/sessions', { participate: false })).status, 201);
    await expectError(await post('/api/sessions', { participate: false }), 503, 'SESSION_LIMIT');
  });

  it('malformed JSON gives 400 INVALID_INPUT', async () => {
    await expectError(await post('/api/sessions', '{"name": '), 400, 'INVALID_INPUT');
  });

  it('body over 2 kB gives 400 INVALID_INPUT', async () => {
    // otherwise-valid body padded with an ignored field, so only the 2 kB limit can reject it
    await expectError(await post('/api/sessions', { participate: false, pad: 'x'.repeat(3000) }), 400, 'INVALID_INPUT');
  });

  it('api responses have Cache-Control no-store', async () => {
    const ok = await post('/api/sessions', { participate: false });
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    const bad = await post('/api/sessions', {});
    assert.equal(bad.headers.get('cache-control'), 'no-store');
  });

  it('malformed percent-encoding in the code gives 400, not 500', async () => {
    await expectError(await post('/api/sessions/%E0%A4%A/join', { name: 'Bob' }), 400, 'INVALID_INPUT');
  });

  it('unknown /api path gives 404 JSON', async () => {
    const res = await fetch(`${base}/api/nope`);
    await expectError(res, 404, 'NOT_FOUND');
  });

  it('XSS-shaped name round-trips unchanged as data', async () => {
    const name = '<img src=x onerror=alert(1)>';
    const { code, hostToken } = await (await post('/api/sessions', { name, funFact: '<b>hi</b>' })).json();
    const view = store.hostView(code);
    assert.equal(view.participants[0].name, name);
    assert.equal(view.participants[0].funFact, '<b>hi</b>');
    assert.equal(typeof hostToken, 'string');
  });
});
