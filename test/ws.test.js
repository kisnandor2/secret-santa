import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startTestServer } from './helpers/server.js';
import { fakeTimers } from './helpers/fakeTimers.js';
import { createStore } from '../src/store.js';
import {
  openSocket, closeAllClients, createSession, join, setupRoom,
} from './helpers/wsClient.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FORBIDDEN_KEYS = new Set(['token', 'hostToken', 'assignedTo']);

function keysOf(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { out.push(k); keysOf(v, out); }
  }
  return out;
}

// Every participant of a room, host first when participating.
const members = (room) => [...(room.host.pid ? [room.host] : []), ...room.people];

function assertPrivacy(room, store) {
  const secrets = [room.host.token, ...room.people.map((p) => p.token)];
  for (const who of [room.host, ...room.people]) {
    for (const frame of who.ws.messages) {
      for (const key of keysOf(frame)) assert.ok(!FORBIDDEN_KEYS.has(key), `frame leaked key ${key}`);
      const raw = JSON.stringify(frame);
      for (const s of secrets) assert.ok(!raw.includes(s), 'frame contains a token value');
    }
    const results = who.ws.all('draw_result');
    if (!who.pid) {
      assert.equal(results.length, 0, 'non-participating host got a result');
      continue;
    }
    assert.ok(results.length <= 1, 'more than one draw_result');
    for (const r of results) {
      assert.deepEqual({ assignedName: r.assignedName, assignedFunFact: r.assignedFunFact },
        store.resultFor(room.code, who.pid));
    }
  }
}

async function drawAndCollect(room) {
  room.host.ws.send({ type: 'start_draw' });
  await room.host.ws.next('draw_complete');
  const map = new Map();
  for (const m of members(room)) {
    const r = await m.ws.next('draw_result');
    map.set(m.name, r.assignedName);
  }
  return map;
}

function assertSingleCycle(map) {
  const names = [...map.keys()];
  for (const [giver, receiver] of map) assert.notEqual(giver, receiver);
  assert.equal(new Set(map.values()).size, names.length);
  let cur = names[0];
  const seen = new Set();
  for (let i = 0; i < names.length; i++) { seen.add(cur); cur = map.get(cur); }
  assert.equal(cur, names[0]);
  assert.equal(seen.size, names.length);
}

async function waitConnected(client, pid, expected, timeout = 1500) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const upd = client.all('participants_update').at(-1);
    const entry = upd?.participants.find((p) => p.id === pid);
    if (entry && entry.connected === expected) return upd;
    if (Date.now() > deadline) throw new Error(`pid never became connected=${expected}`);
    await wait(10);
  }
}

const latestUpdate = (client) => client.all('participants_update').at(-1);

describe('ws', () => {
  let srv;
  before(async () => { srv = await startTestServer({ MAX_SESSIONS: 1000 }); });
  after(async () => { await srv.close(); });
  afterEach(() => closeAllClients());

  const store = () => srv.app.store;

  describe('auth', () => {
    it('closes 1008 (retryable, not terminal) when no auth arrives in time', async () => {
      const c = await openSocket(srv.wsUrl);
      const { code } = await c.closed;
      assert.equal(code, 1008);
    });

    it('closes 4001 on a bad token', async () => {
      const { body } = await createSession(srv.base, { name: 'Host' });
      const c = await openSocket(srv.wsUrl, { auth: { code: body.code, token: 'nope' } });
      assert.equal((await c.closed).code, 4001);
      assert.equal(c.messages.length, 0);
    });

    it('closes 4004 on an unknown or malformed code', async () => {
      const a = await openSocket(srv.wsUrl, { auth: { code: 'FROSTY-000', token: 'x' } });
      assert.equal((await a.closed).code, 4004);
      const b = await openSocket(srv.wsUrl, { auth: { code: 'not a code', token: 'x' } });
      assert.equal((await b.closed).code, 4004);
    });

    it('closes 4001 when the first message is not auth', async () => {
      const a = await openSocket(srv.wsUrl);
      a.send({ type: 'start_draw' });
      assert.equal((await a.closed).code, 4001);
      const b = await openSocket(srv.wsUrl);
      b.send('{not json');
      assert.equal((await b.closed).code, 4001);
    });

    it('fails to upgrade on a path other than /ws', async () => {
      const url = srv.wsUrl.replace(/\/ws$/, '/other');
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.on('open', () => reject(new Error('should not open')));
        ws.on('error', () => resolve());
      });
    });

    it('accepts a normalized (lowercase) code', async () => {
      const { body } = await createSession(srv.base, { name: 'Host' });
      const c = await openSocket(srv.wsUrl, { auth: { code: body.code.toLowerCase(), token: body.hostToken } });
      const w = await c.next('welcome');
      assert.equal(w.code, body.code);
      assert.equal(w.role, 'host');
      assert.equal(w.name, 'Host');
    });
  });

  it('presence: host sees connected true, then false', async () => {
    const room = await setupRoom(srv.base, srv.wsUrl, { joiners: 0 });
    const res = await join(srv.base, room.code, { name: 'Ann' });
    await waitConnected(room.host.ws, res.body.participantId, false);
    const ann = await openSocket(srv.wsUrl, { auth: { code: room.code, token: res.body.token } });
    await ann.next('welcome');
    await waitConnected(room.host.ws, res.body.participantId, true);
    await ann.close();
    await waitConnected(room.host.ws, res.body.participantId, false);
    const hostEntry = latestUpdate(room.host.ws).participants.find((p) => p.isHost);
    assert.equal(hostEntry.connected, true);
  });

  it('authz: participant gets FORBIDDEN for host actions', async () => {
    const room = await setupRoom(srv.base, srv.wsUrl, { joiners: 3 });
    const p = room.people[0];
    p.ws.send({ type: 'start_draw' });
    p.ws.send({ type: 'remove_participant', id: room.people[1].pid });
    p.ws.send({ type: 'close_session' });
    const errs = [await p.ws.next('error'), await p.ws.next('error'), await p.ws.next('error')];
    assert.deepEqual(errs.map((e) => e.re), ['start_draw', 'remove_participant', 'close_session']);
    for (const e of errs) assert.equal(e.error, 'FORBIDDEN');
    assert.equal(store().hostView(room.code).state, 'waiting');
    assert.equal(store().hostView(room.code).participants.length, 4);
  });

  describe('draw', () => {
    it('happy path, host participating', async () => {
      const room = await setupRoom(srv.base, srv.wsUrl, { joiners: 4 });
      const map = await drawAndCollect(room);
      assert.equal(map.size, 5);
      assertSingleCycle(map);
      await wait(100);
      for (const m of members(room)) assert.equal(m.ws.all('draw_result').length, 1);
      assert.equal(room.host.ws.all('draw_complete').length, 1);
      for (const p of room.people) assert.equal(p.ws.all('draw_complete').length, 0);
      assert.deepEqual(room.host.ws.messages.slice(-3).map((m) => m.type),
        ['draw_result', 'draw_complete', 'participants_update']);
      assert.equal(latestUpdate(room.host.ws).state, 'drawn');
      assertPrivacy(room, store());
    });

    it('happy path, host opted out', async () => {
      const room = await setupRoom(srv.base, srv.wsUrl, { hostParticipates: false, joiners: 5 });
      const map = await drawAndCollect(room);
      assert.equal(map.size, 5);
      assertSingleCycle(map);
      await room.host.ws.none('draw_result');
      assert.equal(room.host.ws.all('draw_complete').length, 1);
      for (const name of map.values()) assert.ok(name.startsWith('P'));
      assertPrivacy(room, store());
    });

    it('privacy sweep over a full lifecycle with reconnects', async () => {
      const room = await setupRoom(srv.base, srv.wsUrl, { joiners: 3 });
      const extra = await openSocket(srv.wsUrl, { auth: { code: room.code, token: room.people[0].token } });
      await extra.next('welcome');
      await drawAndCollect(room);
      const late = await openSocket(srv.wsUrl, { auth: { code: room.code, token: room.host.token } });
      await late.next('draw_result');
      await extra.next('draw_result');
      assertPrivacy(room, store());
      for (const c of [extra, late]) {
        for (const frame of c.messages) {
          for (const key of keysOf(frame)) assert.ok(!FORBIDDEN_KEYS.has(key));
        }
      }
      const own = store().resultFor(room.code, room.people[0].pid);
      assert.equal(extra.all('draw_result')[0].assignedName, own.assignedName);
    });

    it('race: concurrent start_draw draws exactly once', async () => {
      const room = await setupRoom(srv.base, srv.wsUrl, { joiners: 4 });
      const host2 = await openSocket(srv.wsUrl, { auth: { code: room.code, token: room.host.token } });
      await host2.next('welcome');
      room.host.ws.send({ type: 'start_draw' });
      room.host.ws.send({ type: 'start_draw' });
      host2.send({ type: 'start_draw' });
      for (const m of members(room)) await m.ws.next('draw_result');
      await host2.next('draw_result');
      await wait(200);
      for (const m of members(room)) assert.equal(m.ws.all('draw_result').length, 1);
      assert.equal(host2.all('draw_result').length, 1);
      const errors = [...room.host.ws.all('error'), ...host2.all('error')];
      assert.equal(errors.length, 2);
      for (const e of errors) {
        assert.equal(e.error, 'ALREADY_DRAWN');
        assert.equal(e.re, 'start_draw');
      }
      for (const c of [room.host.ws, host2]) assert.equal(c.all('draw_complete').length, 1);
      assertPrivacy(room, store());
    });

    it('draw with too few participants gives TOO_FEW', async () => {
      const room = await setupRoom(srv.base, srv.wsUrl, { joiners: 1 });
      room.host.ws.send({ type: 'start_draw' });
      assert.equal((await room.host.ws.next('error')).error, 'TOO_FEW');
    });
  });

  describe('reconnect', () => {
    it('after the draw, a returning participant gets the same result', async () => {
      const room = await setupRoom(srv.base, srv.wsUrl, { joiners: 3 });
      await drawAndCollect(room);
      const p = room.people[1];
      const first = p.ws.all('draw_result')[0];
      await p.ws.close();
      const again = await openSocket(srv.wsUrl, { auth: { code: room.code, token: p.token } });
      assert.equal((await again.next('welcome')).state, 'drawn');
      assert.deepEqual(await again.next('draw_result'), first);
      assert.deepEqual(again.messages.map((m) => m.type), ['welcome', 'draw_result']);
    });

    it('offline at draw time, the result arrives on first connect', async () => {
      const room = await setupRoom(srv.base, srv.wsUrl, { joiners: 1 });
      const late = await join(srv.base, room.code, { name: 'Late' });
      room.host.ws.send({ type: 'start_draw' });
      await room.host.ws.next('draw_complete');
      const c = await openSocket(srv.wsUrl, { auth: { code: room.code, token: late.body.token } });
      assert.equal((await c.next('welcome')).state, 'drawn');
      const r = await c.next('draw_result');
      assert.deepEqual(r, { type: 'draw_result', ...store().resultFor(room.code, late.body.participantId) });
    });

    it('host reconnect before the draw', async () => {
      const room = await setupRoom(srv.base, srv.wsUrl, { joiners: 2 });
      await room.host.ws.close();
      const h = await openSocket(srv.wsUrl, { auth: { code: room.code, token: room.host.token } });
      const w = await h.next('welcome');
      assert.equal(w.role, 'host');
      assert.equal(w.state, 'waiting');
      assert.equal(w.participantId, room.host.pid);
      const upd = await h.next('participants_update');
      assert.equal(upd.participants.length, 3);
      h.send({ type: 'start_draw' });
      await h.next('draw_complete');
      await h.next('draw_result');
    });

    it('host reconnect after the draw', async () => {
      const room = await setupRoom(srv.base, srv.wsUrl, { joiners: 2 });
      await drawAndCollect(room);
      const first = room.host.ws.all('draw_result')[0];
      await room.host.ws.close();
      const h = await openSocket(srv.wsUrl, { auth: { code: room.code, token: room.host.token } });
      assert.equal((await h.next('welcome')).state, 'drawn');
      assert.equal((await h.next('participants_update')).state, 'drawn');
      await h.next('draw_complete');
      assert.deepEqual(await h.next('draw_result'), first);
      assert.deepEqual(h.messages.slice(0, 4).map((m) => m.type),
        ['welcome', 'participants_update', 'draw_complete', 'draw_result']);
    });

    it('opted-out host reconnecting after the draw gets no result', async () => {
      const room = await setupRoom(srv.base, srv.wsUrl, { hostParticipates: false, joiners: 3 });
      await drawAndCollect(room);
      const h = await openSocket(srv.wsUrl, { auth: { code: room.code, token: room.host.token } });
      await h.next('draw_complete');
      await h.none('draw_result');
      assert.equal((await h.next('welcome')).participantId, null);
    });
  });

  it('two tabs: one entry, connected until both close, both get the result', async () => {
    const room = await setupRoom(srv.base, srv.wsUrl, { joiners: 3 });
    const p = room.people[0];
    const tab2 = await openSocket(srv.wsUrl, { auth: { code: room.code, token: p.token } });
    await tab2.next('welcome');
    await waitConnected(room.host.ws, p.pid, true);
    const upd = latestUpdate(room.host.ws);
    assert.equal(upd.participants.filter((x) => x.id === p.pid).length, 1);
    assert.equal(upd.participants.length, 4);

    await p.ws.close();
    await wait(150);
    assert.equal(latestUpdate(room.host.ws).participants.find((x) => x.id === p.pid).connected, true);
    const p2 = room.people[1];
    const p2tab = await openSocket(srv.wsUrl, { auth: { code: room.code, token: p2.token } });
    await p2tab.next('welcome');

    room.host.ws.send({ type: 'start_draw' });
    const a = await tab2.next('draw_result');
    const b = await p2.ws.next('draw_result');
    const c = await p2tab.next('draw_result');
    assert.deepEqual(b, c);
    assert.equal(a.assignedName, store().resultFor(room.code, p.pid).assignedName);

    await tab2.close();
    await waitConnected(room.host.ws, p.pid, false);
  });

  it('remove: sockets get removed then 4011, list shrinks, token rejected', async () => {
    const room = await setupRoom(srv.base, srv.wsUrl, { joiners: 3 });
    const victim = room.people[1];
    const tab2 = await openSocket(srv.wsUrl, { auth: { code: room.code, token: victim.token } });
    await tab2.next('welcome');
    await waitConnected(room.host.ws, victim.pid, true);
    const before = latestUpdate(room.host.ws).participants.length;

    room.host.ws.send({ type: 'remove_participant', id: victim.pid });
    for (const c of [victim.ws, tab2]) {
      await c.next('removed');
      assert.equal((await c.closed).code, 4011);
      assert.deepEqual(c.messages.map((m) => m.type), ['welcome', 'removed']);
    }
    const after = await room.host.ws.waitFor('participants_update', (u) => u.participants.length === before - 1 && !u.participants.some((x) => x.id === victim.pid));

    const again = await openSocket(srv.wsUrl, { auth: { code: room.code, token: victim.token } });
    assert.equal((await again.closed).code, 4001);
  });

  it('remove: errors for host, unknown id and bad payload leave the socket open', async () => {
    const room = await setupRoom(srv.base, srv.wsUrl, { joiners: 2 });
    const h = room.host.ws;
    h.send({ type: 'remove_participant', id: room.host.pid });
    h.send({ type: 'remove_participant', id: 'nobody' });
    h.send({ type: 'remove_participant' });
    const codes = [(await h.next('error')).error, (await h.next('error')).error, (await h.next('error')).error];
    assert.deepEqual(codes, ['CANNOT_REMOVE_HOST', 'UNKNOWN_PARTICIPANT', 'INVALID_INPUT']);
    assert.equal(h.ws.readyState, WebSocket.OPEN);
  });

  it('close: everyone gets session_closed then 4010, later join is 404', async () => {
    const room = await setupRoom(srv.base, srv.wsUrl, { joiners: 3 });
    room.host.ws.send({ type: 'close_session' });
    for (const m of [room.host, ...room.people]) {
      assert.deepEqual(await m.ws.next('session_closed'), { type: 'session_closed', reason: 'host' });
      assert.equal((await m.ws.closed).code, 4010);
    }
    const res = await join(srv.base, room.code, { name: 'Zed' });
    assert.equal(res.status, 404);
    const c = await openSocket(srv.wsUrl, { auth: { code: room.code, token: room.host.token } });
    assert.equal((await c.closed).code, 4004);
  });

  it('heartbeat: a socket that never pongs is terminated and shows offline', async () => {
    const room = await setupRoom(srv.base, srv.wsUrl, { joiners: 1 });
    const res = await join(srv.base, room.code, { name: 'Mute' });
    const mute = await openSocket(srv.wsUrl, {
      auth: { code: room.code, token: res.body.token }, autoPong: false,
    });
    await mute.next('welcome');
    await waitConnected(room.host.ws, res.body.participantId, true);
    const started = Date.now();
    await Promise.race([mute.closed, wait(1500).then(() => { throw new Error('not terminated'); })]);
    assert.ok(Date.now() - started < 1200);
    await waitConnected(room.host.ws, res.body.participantId, false);
    // the well-behaved sockets survive several intervals
    await wait(450);
    assert.equal(room.host.ws.ws.readyState, WebSocket.OPEN);
    assert.equal(room.people[0].ws.ws.readyState, WebSocket.OPEN);
  });

  describe('bad frames', () => {
    it('invalid JSON, unknown types and non-objects give INVALID_INPUT and stay open', async () => {
      const room = await setupRoom(srv.base, srv.wsUrl, { joiners: 2 });
      const p = room.people[0].ws;
      p.send('{not json');
      p.send({ type: 'dance' });
      p.send('[1,2]');
      p.send({ nope: true });
      p.send({ type: 'auth', code: room.code, token: room.people[0].token });
      const errs = [];
      for (let i = 0; i < 5; i++) errs.push(await p.next('error'));
      for (const e of errs) assert.equal(e.error, 'INVALID_INPUT');
      assert.equal(errs[0].re, null);
      assert.equal(errs[1].re, 'dance');
      assert.equal(p.ws.readyState, WebSocket.OPEN);
      room.host.ws.send({ type: 'start_draw' });
      await p.next('draw_result');
    });

    it('an oversized frame closes the socket', async () => {
      const room = await setupRoom(srv.base, srv.wsUrl, { joiners: 1 });
      room.people[0].ws.send(JSON.stringify({ type: 'x', pad: 'a'.repeat(5000) }));
      assert.equal((await room.people[0].ws.closed).code, 1009);
    });
  });

  it('TTL over the wire: every socket gets session_closed ttl then 4010', async () => {
    const timers = fakeTimers();
    const ttlMs = 60_000;
    const ttlStore = createStore({ ttlMs, timers, now: timers.now });
    const local = await startTestServer({ store: ttlStore });
    try {
      const room = await setupRoom(local.base, local.wsUrl, { joiners: 2 });
      timers.advance(ttlMs - 1);
      await wait(50);
      for (const m of [room.host, ...room.people]) assert.equal(m.ws.all('session_closed').length, 0);
      timers.advance(1);
      for (const m of [room.host, ...room.people]) {
        assert.deepEqual(await m.ws.next('session_closed'), { type: 'session_closed', reason: 'ttl' });
        assert.equal((await m.ws.closed).code, 4010);
      }
      assert.equal(local.app.hub.stats().sessions, 0);
    } finally {
      closeAllClients();
      await local.close();
    }
  });

  it('stats reflect live sockets and rooms', async () => {
    for (let i = 0; i < 100 && srv.app.hub.stats().sockets > 0; i++) await wait(10);
    const before = srv.app.hub.stats();
    assert.equal(before.sockets, 0);
    const room = await setupRoom(srv.base, srv.wsUrl, { joiners: 2 });
    const now = srv.app.hub.stats();
    assert.equal(now.sockets, before.sockets + 3);
    assert.equal(now.sessions, before.sessions + 1);
    room.host.ws.send({ type: 'close_session' });
    await room.host.ws.closed;
    await wait(50);
    assert.equal(srv.app.hub.stats().sessions, before.sessions);
  });
});
