import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../src/store.js';
import { createPersistence } from '../src/persist.js';
import { silentLog } from '../src/log.js';
import { fakeTimers } from './helpers/fakeTimers.js';
import { seededRandomInt } from './helpers/rng.js';
import { startTestServer } from './helpers/server.js';
import { openSocket, createSession, join } from './helpers/wsClient.js';

const TTL = 120 * 60_000;
const person = (name, funFact = '') => ({ name, nameKey: name.toLowerCase(), funFact });

let dir;
let dbPath;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'santa-persist-'));
  dbPath = path.join(dir, 'sessions.db');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const makeStore = (timers) => createStore({
  ttlMs: TTL, maxSessions: 20, maxParticipants: 50,
  randomInt: seededRandomInt(42), timers, now: timers.now,
  onListenerError: (e) => { throw e; },
});

describe('persist', () => {
  it('mirrors create, join, draw and remove into sqlite', () => {
    const timers = fakeTimers();
    const store = makeStore(timers);
    const persistence = createPersistence({ dbPath, store, log: silentLog });

    const host = store.createSession({ participate: true, ...person('Host', 'hf') });
    store.join(host.code, person('Bob', 'bf'));
    const cy = store.join(host.code, person('Cy', 'cf'));
    store.removeParticipant(host.code, host.hostToken, cy.participantId);
    store.join(host.code, person('Dee', 'df'));
    store.draw(host.code, host.hostToken);

    const [row] = persistence.loadAll();
    assert.equal(row.code, host.code);
    assert.equal(row.state, 'drawn');
    assert.deepEqual(row.participants.map((p) => p.name).sort(), ['Bob', 'Dee', 'Host']);
    assert.ok(row.participants.every((p) => p.assignedTo));

    persistence.close();
  });

  it('removes a session from sqlite when it is closed', () => {
    const timers = fakeTimers();
    const store = makeStore(timers);
    const persistence = createPersistence({ dbPath, store, log: silentLog });

    const host = store.createSession({ participate: false });
    assert.equal(persistence.loadAll().length, 1);
    store.close(host.code, host.hostToken);
    assert.equal(persistence.loadAll().length, 0);

    persistence.close();
  });

  it('removes a session from sqlite on TTL expiry', () => {
    const timers = fakeTimers();
    const store = makeStore(timers);
    const persistence = createPersistence({ dbPath, store, log: silentLog });

    store.createSession({ participate: false });
    assert.equal(persistence.loadAll().length, 1);
    timers.advance(TTL);
    assert.equal(persistence.loadAll().length, 0);

    persistence.close();
  });

  it('a fresh store restores sessions loaded from the same sqlite file', () => {
    const timers = fakeTimers();
    const store = makeStore(timers);
    const persistence = createPersistence({ dbPath, store, log: silentLog });

    const r = store.createSession({ participate: true, ...person('Host', 'hf') });
    store.join(r.code, person('Bob', 'bf'));
    store.join(r.code, person('Cy', 'cf'));
    store.draw(r.code, r.hostToken);
    const expectedResult = store.resultFor(r.code, r.participantId);
    persistence.close(); // simulates a crash: no 'closed' event, rows stay on disk

    const timers2 = fakeTimers();
    const store2 = makeStore(timers2);
    const persistence2 = createPersistence({ dbPath, store: store2, log: silentLog });
    const { restored, expired } = store2.restoreSessions(persistence2.loadAll());
    assert.deepEqual(restored, [r.code]);
    assert.deepEqual(expired, []);

    assert.deepEqual(store2.authenticate(r.code, r.hostToken), { role: 'host', participantId: r.participantId });
    assert.deepEqual(store2.resultFor(r.code, r.participantId), expectedResult);
    assert.equal(store2.hostView(r.code).state, 'drawn');

    persistence2.close();
  });

  it('multiple sessions in one DB file persist and restore independently', () => {
    const timers = fakeTimers();
    const store = makeStore(timers);
    const persistence = createPersistence({ dbPath, store, log: silentLog });

    const a = store.createSession({ participate: true, ...person('HostA', 'ha') });
    store.join(a.code, person('Bob', 'bf'));
    store.join(a.code, person('Cy', 'cf'));
    store.draw(a.code, a.hostToken);

    const b = store.createSession({ participate: true, ...person('HostB', 'hb') });
    store.join(b.code, person('Dee', 'df'));
    store.join(b.code, person('Eve', 'ef'));

    let rows = persistence.loadAll();
    assert.equal(rows.length, 2);
    const rowA = rows.find((r) => r.code === a.code);
    const rowB = rows.find((r) => r.code === b.code);
    assert.equal(rowA.state, 'drawn');
    assert.equal(rowB.state, 'waiting');
    assert.deepEqual(rowA.participants.map((p) => p.name).sort(), ['Bob', 'Cy', 'HostA']);
    assert.deepEqual(rowB.participants.map((p) => p.name).sort(), ['Dee', 'Eve', 'HostB']);

    // closing one session must not touch the other's rows
    store.close(a.code, a.hostToken);
    rows = persistence.loadAll();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].code, b.code);

    persistence.close();

    // restore into a fresh store: only b's rows are left to restore
    const timers2 = fakeTimers();
    const store2 = makeStore(timers2);
    const persistence2 = createPersistence({ dbPath, store: store2, log: silentLog });
    const { restored, expired } = store2.restoreSessions(persistence2.loadAll());
    assert.deepEqual(restored, [b.code]);
    assert.deepEqual(expired, []);
    assert.equal(store2.hostView(b.code).participants.length, 3);
    persistence2.close();
  });

  it('a session survives a full app restart against the same DB_PATH', async () => {
    const serverA = await startTestServer({ DB_PATH: dbPath });
    const created = await createSession(serverA.base, { name: 'Host', funFact: 'hf' });
    const { code, hostToken, participantId: hostPid } = created.body;
    const bob = await join(serverA.base, code, { name: 'Bob', funFact: 'bf' });
    await join(serverA.base, code, { name: 'Cy', funFact: 'cf' });

    const hostWs = await openSocket(serverA.wsUrl, { auth: { code, token: hostToken } });
    await hostWs.next('welcome');
    hostWs.send({ type: 'start_draw' });
    await hostWs.next('draw_complete');
    const expectedResult = await hostWs.next('draw_result');
    await hostWs.close();

    // Crash, not a clean shutdown: app.close() tears the process down without
    // the store ever emitting 'closed', so the persisted rows must survive.
    await serverA.app.close();

    const serverB = await startTestServer({ DB_PATH: dbPath });
    try {
      const bobWs = await openSocket(serverB.wsUrl, { auth: { code, token: bob.body.token } });
      const welcome = await bobWs.next('welcome');
      assert.equal(welcome.state, 'drawn');
      const bobResult = await bobWs.next('draw_result');
      assert.notEqual(bobResult.assignedName, 'Bob');
      await bobWs.close();

      const hostWs2 = await openSocket(serverB.wsUrl, { auth: { code, token: hostToken } });
      const hostWelcome = await hostWs2.next('welcome');
      assert.equal(hostWelcome.participantId, hostPid);
      const hostResult = await hostWs2.next('draw_result');
      assert.equal(hostResult.assignedName, expectedResult.assignedName);
      await hostWs2.close();
    } finally {
      await serverB.close();
    }
  });

  it('app.js removes from the DB a session whose TTL elapsed while the process was down', async () => {
    const serverA = await startTestServer({ DB_PATH: dbPath });
    const created = await createSession(serverA.base, { participate: false });
    const { code } = created.body;
    await serverA.app.close();

    // Simulate the session's TTL having elapsed while nothing was running.
    const db = new DatabaseSync(dbPath);
    db.prepare('UPDATE sessions SET created_at = ? WHERE code = ?').run(Date.now() - 999_000_000, code);
    db.close();

    const serverB = await startTestServer({ DB_PATH: dbPath });
    try {
      assert.equal(serverB.app.store.size(), 0);
      assert.equal(serverB.app.persistence.loadAll().length, 0);

      const res = await fetch(`${serverB.base}/api/sessions/${code}/join`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Bob' }),
      });
      assert.equal(res.status, 404);
    } finally {
      await serverB.close();
    }
  });
});
