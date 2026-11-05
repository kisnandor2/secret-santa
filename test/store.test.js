import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { fakeTimers } from './helpers/fakeTimers.js';
import { seededRandomInt } from './helpers/rng.js';

const TTL = 120 * 60_000;
const person = (name, funFact = '') => ({ name, nameKey: name.toLowerCase(), funFact });

const counter = (prefix) => { let n = 0; return () => `${prefix}${++n}`; };
const codeSeq = () => { let n = 0; return () => `W${n++}-${100 + n}`; };

let timers;
let events;
let listenerErrors;

const make = (opts = {}) => {
  const store = createStore({
    ttlMs: TTL,
    maxSessions: 20,
    maxParticipants: 50,
    randomInt: seededRandomInt(42),
    genCode: codeSeq(),
    genToken: counter('tok'),
    genId: counter('id'),
    timers,
    now: timers.now,
    onListenerError: (e) => listenerErrors.push(e),
    ...opts,
  });
  store.on((e) => events.push(e));
  return store;
};

const throwsCode = (fn, errCode) => assert.throws(fn, (e) => e.code === errCode, `expected ${errCode}`);

// host participating + joiners named by list; returns { c, hostToken, hostPid, joined }
const room = (store, { participate = true, names = [] } = {}) => {
  const created = store.createSession(participate
    ? { participate: true, ...person('Host', 'hf') } : { participate: false });
  const joined = names.map((n) => ({ name: n, ...store.join(created.code, person(n, `fact ${n}`)) }));
  return { c: created.code, hostToken: created.hostToken, hostPid: created.participantId, joined };
};

const snapshot = (store, c) => store.hostView(c).participants.map((p) => [p.id, store.resultFor(c, p.id)]);

describe('store', () => {
  beforeEach(() => {
    timers = fakeTimers();
    events = [];
    listenerErrors = [];
  });

  it('create with participating host', () => {
    const store = make();
    const out = store.createSession({ participate: true, ...person('Alice', 'likes tea') });
    assert.ok(out.participantId);
    const view = store.hostView(out.code);
    assert.equal(view.state, 'waiting');
    assert.deepEqual(view.participants, [
      { id: out.participantId, name: 'Alice', funFact: 'likes tea', isHost: true },
    ]);
    assert.deepEqual(store.authenticate(out.code, out.hostToken), { role: 'host', participantId: out.participantId });
    assert.equal(store.size(), 1);
    assert.equal(timers.pending(), 1);
  });

  it('host participant token equals hostToken', () => {
    const store = make();
    const out = store.createSession({ participate: true, ...person('Alice') });
    // the only token the host uses authenticates as the host participant
    assert.equal(store.authenticate(out.code, out.hostToken).participantId, out.participantId);
  });

  it('create with opted-out host', () => {
    const store = make();
    const out = store.createSession({ participate: false });
    assert.equal(out.participantId, null);
    assert.equal(store.hostView(out.code).participants.length, 0);
    assert.deepEqual(store.authenticate(out.code, out.hostToken), { role: 'host', participantId: null });
  });

  it('code collision retries', () => {
    const codes = ['A-100', 'A-100', 'B-200'];
    const store = make({ genCode: () => codes.shift() });
    const a = store.createSession({ participate: false });
    const b = store.createSession({ participate: false });
    assert.equal(a.code, 'A-100');
    assert.equal(b.code, 'B-200');
    assert.equal(store.size(), 2);
  });

  it('always-colliding generator throws SESSION_LIMIT after 10 attempts', () => {
    let calls = 0;
    const store = make({ genCode: () => { calls++; return 'A-100'; } });
    store.createSession({ participate: false });
    calls = 0;
    throwsCode(() => store.createSession({ participate: false }), 'SESSION_LIMIT');
    assert.equal(calls, 10);
    assert.equal(store.size(), 1);
  });

  it('maxSessions enforced as SESSION_LIMIT', () => {
    const store = make({ maxSessions: 2 });
    store.createSession({ participate: false });
    const second = store.createSession({ participate: false });
    throwsCode(() => store.createSession({ participate: false }), 'SESSION_LIMIT');
    store.close(second.code, second.hostToken);
    store.createSession({ participate: false });
    assert.equal(store.size(), 2);
  });

  it('join adds a participant and emits participants_changed', () => {
    const store = make();
    const r = room(store);
    const out = store.join(r.c, person('Bob', 'bf'));
    assert.ok(out.participantId && out.token);
    assert.notEqual(out.token, r.hostToken);
    assert.deepEqual(events, [{ type: 'participants_changed', code: r.c }]);
    assert.equal(store.participantName(r.c, out.participantId), 'Bob');
    assert.deepEqual(store.authenticate(r.c, out.token), { role: 'participant', participantId: out.participantId });
  });

  it('join error precedence', () => {
    const store = make({ maxParticipants: 3 });
    // NOT_FOUND first
    throwsCode(() => store.join('NOPE-123', person('Bob')), 'NOT_FOUND');

    // ALREADY_DRAWN beats SESSION_FULL and NAME_TAKEN
    const r = room(store, { names: ['Bob', 'Cy'] });
    store.draw(r.c, r.hostToken);
    throwsCode(() => store.join(r.c, person('Bob')), 'ALREADY_DRAWN');

    // SESSION_FULL beats NAME_TAKEN
    const r2 = room(store, { names: ['Bob', 'Cy'] });
    throwsCode(() => store.join(r2.c, person('Bob')), 'SESSION_FULL');

    // NAME_TAKEN when there is room
    const r3 = room(store, { names: ['Bob'] });
    throwsCode(() => store.join(r3.c, person('Bob')), 'NAME_TAKEN');
  });

  it('SESSION_FULL counts a participating host and respects maxParticipants', () => {
    const store = make({ maxParticipants: 2 });
    const r = room(store, { names: ['Bob'] });
    throwsCode(() => store.join(r.c, person('Cy')), 'SESSION_FULL');
    assert.equal(store.hostView(r.c).participants.length, 2);
  });

  it('NAME_TAKEN for padded ALICE vs Alice', () => {
    const store = make();
    const out = store.createSession({ participate: true, ...person('Alice') });
    // validate.js would produce name 'ALICE', nameKey 'alice'
    throwsCode(() => store.join(out.code, { name: 'ALICE', nameKey: 'alice', funFact: '' }), 'NAME_TAKEN');
  });

  it('authenticate roles, wrong token, cross-session token', () => {
    const store = make();
    const a = room(store, { names: ['Bob'] });
    const b = room(store, { names: ['Cy'] });
    assert.equal(store.authenticate(a.c, a.hostToken).role, 'host');
    assert.deepEqual(store.authenticate(a.c, a.joined[0].token),
      { role: 'participant', participantId: a.joined[0].participantId });
    assert.equal(store.authenticate(a.c, 'wrong'), null);
    assert.equal(store.authenticate(a.c, undefined), null);
    assert.equal(store.authenticate(b.c, a.hostToken), null);
    assert.equal(store.authenticate(b.c, a.joined[0].token), null);
    throwsCode(() => store.authenticate('NOPE-123', a.hostToken), 'NOT_FOUND');
  });

  it('removeParticipant works and emits removed then participants_changed', () => {
    const store = make();
    const r = room(store, { names: ['Bob', 'Cy'] });
    events.length = 0;
    const bob = r.joined[0];
    store.removeParticipant(r.c, r.hostToken, bob.participantId);
    assert.deepEqual(events, [
      { type: 'removed', code: r.c, participantId: bob.participantId },
      { type: 'participants_changed', code: r.c },
    ]);
    assert.deepEqual(store.hostView(r.c).participants.map((p) => p.name), ['Host', 'Cy']);
    assert.equal(store.authenticate(r.c, bob.token), null);
    assert.equal(store.participantName(r.c, bob.participantId), null);
    // name is free again
    store.join(r.c, person('Bob'));
  });

  it('removeParticipant errors', () => {
    const store = make();
    const r = room(store, { names: ['Bob', 'Cy'] });
    throwsCode(() => store.removeParticipant('NOPE-123', r.hostToken, 'x'), 'NOT_FOUND');
    throwsCode(() => store.removeParticipant(r.c, r.hostToken, 'nope'), 'UNKNOWN_PARTICIPANT');
    events.length = 0;
    throwsCode(() => store.removeParticipant(r.c, r.hostToken, r.hostPid), 'CANNOT_REMOVE_HOST');
    assert.deepEqual(events, []);
  });

  it('removing host gives CANNOT_REMOVE_HOST', () => {
    const store = make();
    const r = room(store, { names: ['Bob'] });
    throwsCode(() => store.removeParticipant(r.c, r.hostToken, r.hostPid), 'CANNOT_REMOVE_HOST');
    assert.equal(store.hostView(r.c).participants.length, 2);
  });

  it('remove with participant token gives FORBIDDEN', () => {
    const store = make();
    const r = room(store, { names: ['Bob', 'Cy'] });
    throwsCode(() => store.removeParticipant(r.c, r.joined[0].token, r.joined[1].participantId), 'FORBIDDEN');
    throwsCode(() => store.removeParticipant(r.c, 'garbage', r.joined[1].participantId), 'FORBIDDEN');
    assert.equal(store.hostView(r.c).participants.length, 3);
  });

  it('remove after draw gives ALREADY_DRAWN', () => {
    const store = make();
    const r = room(store, { names: ['Bob', 'Cy'] });
    store.draw(r.c, r.hostToken);
    throwsCode(() => store.removeParticipant(r.c, r.hostToken, r.joined[0].participantId), 'ALREADY_DRAWN');
    assert.equal(store.hostView(r.c).participants.length, 3);
  });

  it('draw thresholds', () => {
    const store = make();
    const ok = room(store, { names: ['Bob', 'Cy'] });
    store.draw(ok.c, ok.hostToken);
    assert.equal(store.hostView(ok.c).state, 'drawn');

    const few = room(store, { participate: false, names: ['Bob', 'Cy'] });
    throwsCode(() => store.draw(few.c, few.hostToken), 'TOO_FEW');
    assert.equal(store.hostView(few.c).state, 'waiting');

    const enough = room(store, { participate: false, names: ['Bob', 'Cy', 'Di'] });
    store.draw(enough.c, enough.hostToken);
    assert.equal(store.hostView(enough.c).state, 'drawn');
  });

  it('draw check order: NOT_FOUND, FORBIDDEN, ALREADY_DRAWN, TOO_FEW', () => {
    const store = make();
    throwsCode(() => store.draw('NOPE-123', 'x'), 'NOT_FOUND');
    const few = room(store, { names: ['Bob'] });
    // participant token on an undersized session: FORBIDDEN beats TOO_FEW
    throwsCode(() => store.draw(few.c, few.joined[0].token), 'FORBIDDEN');
    throwsCode(() => store.draw(few.c, few.hostToken), 'TOO_FEW');
    const full = room(store, { names: ['Bob', 'Cy'] });
    store.draw(full.c, full.hostToken);
    // participant token after draw: FORBIDDEN beats ALREADY_DRAWN
    throwsCode(() => store.draw(full.c, full.joined[0].token), 'FORBIDDEN');
  });

  it('draw emits drawn after the state is set', () => {
    const store = make();
    const r = room(store, { names: ['Bob', 'Cy'] });
    events.length = 0;
    let stateAtEmit;
    let resultAtEmit;
    store.on((e) => {
      if (e.type !== 'drawn') return;
      stateAtEmit = store.hostView(r.c).state;
      resultAtEmit = store.resultFor(r.c, r.hostPid);
    });
    store.draw(r.c, r.hostToken);
    assert.deepEqual(events, [{ type: 'drawn', code: r.c }]);
    assert.equal(stateAtEmit, 'drawn');
    assert.ok(resultAtEmit);
  });

  it('draw twice gives ALREADY_DRAWN, assignments unchanged', () => {
    const store = make();
    const r = room(store, { names: ['Bob', 'Cy', 'Di'] });
    store.draw(r.c, r.hostToken);
    const before = snapshot(store, r.c);
    events.length = 0;
    throwsCode(() => store.draw(r.c, r.hostToken), 'ALREADY_DRAWN');
    assert.deepEqual(snapshot(store, r.c), before);
    assert.deepEqual(events, []);
  });

  it('opted-out host never appears as giver or receiver', () => {
    const store = make();
    const r = room(store, { participate: false, names: ['Bob', 'Cy', 'Di', 'Ed'] });
    store.draw(r.c, r.hostToken);
    const names = new Set(['Bob', 'Cy', 'Di', 'Ed']);
    assert.equal(store.hostView(r.c).participants.some((p) => p.isHost), false);
    for (const j of r.joined) {
      const res = store.resultFor(r.c, j.participantId);
      assert.ok(names.has(res.assignedName));
      assert.notEqual(res.assignedName, j.name);
    }
    assert.equal(store.resultFor(r.c, 'host'), null);
  });

  it('resultFor correct for every participant', () => {
    const store = make();
    const r = room(store, { names: ['Bob', 'Cy', 'Di', 'Ed'] });
    const funFacts = new Map([['Host', 'hf'], ...r.joined.map((j) => [j.name, `fact ${j.name}`])]);
    store.draw(r.c, r.hostToken);
    const view = store.hostView(r.c).participants;
    const received = new Set();
    for (const p of view) {
      const res = store.resultFor(r.c, p.id);
      assert.notEqual(res.assignedName, p.name);
      assert.equal(res.assignedFunFact, funFacts.get(res.assignedName));
      received.add(res.assignedName);
    }
    // a single cycle is a bijection: everyone is received exactly once
    assert.equal(received.size, view.length);
  });

  it('resultFor and participantName return null for pending or unknown participants', () => {
    const store = make();
    const r = room(store, { names: ['Bob', 'Cy'] });
    assert.equal(store.resultFor(r.c, r.hostPid), null); // not drawn yet
    store.draw(r.c, r.hostToken);
    assert.equal(store.resultFor(r.c, 'nobody'), null);
    assert.equal(store.participantName(r.c, 'nobody'), null);
    assert.equal(store.participantName('NOPE-123', r.hostPid), null);
    throwsCode(() => store.resultFor('NOPE-123', r.hostPid), 'NOT_FOUND');
    assert.equal(store.participantName(r.c, r.hostPid), 'Host');
  });

  it('resultFor is null for a participant removed before draw', () => {
    const store = make();
    const r = room(store, { names: ['Bob', 'Cy', 'Di'] });
    store.removeParticipant(r.c, r.hostToken, r.joined[0].participantId);
    store.draw(r.c, r.hostToken);
    assert.equal(store.resultFor(r.c, r.joined[0].participantId), null);
  });

  it('hostView has no token, nameKey or assignedTo', () => {
    const store = make();
    const r = room(store, { names: ['Bob', 'Cy'] });
    for (const phase of ['waiting', 'drawn']) {
      const view = store.hostView(r.c);
      assert.equal(view.state, phase);
      const json = JSON.stringify(view);
      for (const key of ['token', 'nameKey', 'assignedTo']) assert.ok(!json.includes(key), key);
      for (const p of view.participants) {
        assert.deepEqual(Object.keys(p).sort(), ['funFact', 'id', 'isHost', 'name']);
      }
      if (phase === 'waiting') store.draw(r.c, r.hostToken);
    }
    throwsCode(() => store.hostView('NOPE-123'), 'NOT_FOUND');
  });

  it('TTL expiry while waiting', () => {
    const store = make();
    const r = room(store, { names: ['Bob'] });
    events.length = 0;
    timers.advance(TTL - 1);
    assert.equal(store.size(), 1);
    assert.deepEqual(events, []);
    timers.advance(1);
    assert.equal(store.size(), 0);
    assert.deepEqual(events, [{ type: 'closed', code: r.c, reason: 'ttl' }]);
    assert.equal(timers.pending(), 0);
  });

  it('TTL expiry after draw', () => {
    const store = make();
    const r = room(store, { names: ['Bob', 'Cy'] });
    store.draw(r.c, r.hostToken);
    events.length = 0;
    timers.advance(TTL - 1);
    assert.equal(store.size(), 1);
    timers.advance(1);
    assert.equal(store.size(), 0);
    assert.deepEqual(events, [{ type: 'closed', code: r.c, reason: 'ttl' }]);
  });

  it('TTL is measured from creation, not from activity', () => {
    const store = make();
    const r = room(store);
    timers.advance(TTL - 10);
    store.join(r.c, person('Bob'));
    timers.advance(10);
    assert.equal(store.size(), 0);
  });

  it('TTL expiry removes the session so later calls fail NOT_FOUND', () => {
    const store = make();
    const r = room(store, { names: ['Bob'] });
    timers.advance(TTL);
    throwsCode(() => store.join(r.c, person('Cy')), 'NOT_FOUND');
    throwsCode(() => store.authenticate(r.c, r.hostToken), 'NOT_FOUND');
    throwsCode(() => store.hostView(r.c), 'NOT_FOUND');
    throwsCode(() => store.draw(r.c, r.hostToken), 'NOT_FOUND');
    throwsCode(() => store.removeParticipant(r.c, r.hostToken, r.hostPid), 'NOT_FOUND');
    throwsCode(() => store.close(r.c, r.hostToken), 'NOT_FOUND');
    throwsCode(() => store.resultFor(r.c, r.hostPid), 'NOT_FOUND');
  });

  it('close removes the session, emits closed(host) and clears the timer', () => {
    const store = make();
    const r = room(store, { names: ['Bob'] });
    assert.equal(timers.pending(), 1);
    events.length = 0;
    store.close(r.c, r.hostToken);
    assert.equal(timers.pending(), 0);
    assert.equal(store.size(), 0);
    assert.deepEqual(events, [{ type: 'closed', code: r.c, reason: 'host' }]);
    throwsCode(() => store.join(r.c, person('Cy')), 'NOT_FOUND');
    throwsCode(() => store.hostView(r.c), 'NOT_FOUND');
    throwsCode(() => store.close(r.c, r.hostToken), 'NOT_FOUND');
  });

  it('close works after draw and requires the host token', () => {
    const store = make();
    const r = room(store, { names: ['Bob', 'Cy'] });
    throwsCode(() => store.close('NOPE-123', r.hostToken), 'NOT_FOUND');
    throwsCode(() => store.close(r.c, r.joined[0].token), 'FORBIDDEN');
    assert.equal(store.size(), 1);
    store.draw(r.c, r.hostToken);
    store.close(r.c, r.hostToken);
    assert.equal(store.size(), 0);
  });

  it('dispose clears sessions and timers', () => {
    const store = make();
    room(store);
    room(store, { participate: false });
    assert.equal(timers.pending(), 2);
    store.dispose();
    assert.equal(store.size(), 0);
    assert.equal(timers.pending(), 0);
    timers.advance(TTL * 2);
    assert.deepEqual(events, []);
  });

  it('throwing listener does not stop others and does not break the store', () => {
    const store = make();
    const seen = [];
    store.on(() => { throw new Error('boom'); });
    store.on((e) => seen.push(e.type));
    const r = room(store);
    store.join(r.c, person('Bob'));
    assert.deepEqual(seen, ['participants_changed']);
    assert.equal(listenerErrors.length, 1);
    assert.equal(listenerErrors[0].message, 'boom');
    assert.equal(store.hostView(r.c).participants.length, 2);
  });

  it('unsubscribe stops delivery', () => {
    const store = make();
    const seen = [];
    const off = store.on((e) => seen.push(e));
    const r = room(store);
    off();
    store.join(r.c, person('Bob'));
    assert.deepEqual(seen, []);
  });

  it('uses the real timers and defaults when not injected', () => {
    const store = createStore({ onListenerError() {} });
    const out = store.createSession({ participate: false });
    assert.match(out.code, /^[A-Z]{3,10}-\d{3}$/);
    assert.equal(store.size(), 1);
    store.dispose();
    assert.equal(store.size(), 0);
  });
});

describe('fakeTimers', () => {
  it('fires due timers in time order and tracks now and pending', () => {
    const t = fakeTimers();
    const fired = [];
    t.setTimeout(() => fired.push('b'), 20);
    const a = t.setTimeout(() => fired.push('a'), 10);
    t.setTimeout(() => fired.push('c'), 30);
    assert.equal(a.unref(), a);
    assert.equal(t.pending(), 3);
    t.advance(25);
    assert.deepEqual(fired, ['a', 'b']);
    assert.equal(t.now(), 25);
    assert.equal(t.pending(), 1);
    t.advance(5);
    assert.deepEqual(fired, ['a', 'b', 'c']);
  });

  it('clearTimeout disarms and nested timers fire within the same advance', () => {
    const t = fakeTimers();
    const fired = [];
    const h = t.setTimeout(() => fired.push('x'), 5);
    t.clearTimeout(h);
    t.setTimeout(() => t.setTimeout(() => fired.push('nested'), 5), 5);
    t.advance(10);
    assert.deepEqual(fired, ['nested']);
    assert.equal(t.pending(), 0);
  });
});
