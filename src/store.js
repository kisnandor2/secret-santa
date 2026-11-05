// Session state machine — see plan-impl.md §6
import crypto from 'node:crypto';
import { fail } from './errors.js';
import { assign } from './draw.js';
import { createCodeGen, newToken, newId, tokenEquals } from './codes.js';

const CODE_ATTEMPTS = 10;

export function createStore({
  ttlMs = 120 * 60_000,
  maxSessions = 20,
  maxParticipants = 50,
  randomInt = crypto.randomInt,
  genCode = createCodeGen(randomInt),
  genToken = newToken,
  genId = newId,
  timers = { setTimeout, clearTimeout },
  now = Date.now,
  onListenerError = (err) => console.error('store listener error:', err),
} = {}) {
  const sessions = new Map(); // code -> Session
  const listeners = new Set();

  function emit(event) {
    for (const listener of [...listeners]) {
      try { listener(event); } catch (err) { onListenerError(err); }
    }
  }

  function getSession(code) {
    const s = sessions.get(code);
    if (!s) fail('NOT_FOUND');
    return s;
  }

  function requireHost(s, token) {
    if (!tokenEquals(token, s.hostToken)) fail('FORBIDDEN');
  }

  function addParticipant(s, { name, nameKey, funFact }, isHost, token) {
    const id = genId();
    s.participants.set(id, { id, token, name, nameKey, funFact, isHost, assignedTo: null });
    return id;
  }

  function expire(code) {
    if (!sessions.delete(code)) return;
    emit({ type: 'closed', code, reason: 'ttl' });
  }

  function createSession(parsed) {
    if (sessions.size >= maxSessions) fail('SESSION_LIMIT');
    let code = null;
    for (let i = 0; i < CODE_ATTEMPTS; i++) {
      const candidate = genCode();
      if (!sessions.has(candidate)) { code = candidate; break; }
    }
    if (code === null) fail('SESSION_LIMIT');

    const hostToken = genToken();
    const s = {
      code, hostToken, hostParticipantId: null, createdAt: now(),
      state: 'waiting', participants: new Map(), timer: null,
    };
    // A participating host's participant token is the hostToken.
    if (parsed.participate) s.hostParticipantId = addParticipant(s, parsed, true, hostToken);
    s.timer = timers.setTimeout(() => expire(code), ttlMs);
    s.timer?.unref?.();
    sessions.set(code, s);
    return { code, hostToken, participantId: s.hostParticipantId };
  }

  function join(code, parsed) {
    const s = getSession(code);
    if (s.state !== 'waiting') fail('ALREADY_DRAWN');
    if (s.participants.size >= maxParticipants) fail('SESSION_FULL');
    for (const p of s.participants.values()) {
      if (p.nameKey === parsed.nameKey) fail('NAME_TAKEN');
    }
    const token = genToken();
    const participantId = addParticipant(s, parsed, false, token);
    emit({ type: 'participants_changed', code });
    return { participantId, token };
  }

  function authenticate(code, token) {
    const s = getSession(code);
    if (tokenEquals(token, s.hostToken)) return { role: 'host', participantId: s.hostParticipantId };
    for (const p of s.participants.values()) {
      if (tokenEquals(token, p.token)) return { role: 'participant', participantId: p.id };
    }
    return null;
  }

  function removeParticipant(code, token, id) {
    const s = getSession(code);
    requireHost(s, token);
    if (s.state !== 'waiting') fail('ALREADY_DRAWN');
    if (!s.participants.has(id)) fail('UNKNOWN_PARTICIPANT');
    if (id === s.hostParticipantId) fail('CANNOT_REMOVE_HOST');
    s.participants.delete(id);
    emit({ type: 'removed', code, participantId: id });
    emit({ type: 'participants_changed', code });
  }

  function draw(code, token) {
    const s = getSession(code);
    requireHost(s, token);
    if (s.state !== 'waiting') fail('ALREADY_DRAWN');
    if (s.participants.size < 3) fail('TOO_FEW');
    // RACE SAFETY: no await or callback may sit between the 'waiting' check above
    // and this assignment. Node runs one handler at a time, so a second draw
    // request is serialized behind this one and rejected with ALREADY_DRAWN.
    s.state = 'drawn';
    const pairs = assign([...s.participants.keys()], randomInt);
    for (const [giver, receiver] of pairs) s.participants.get(giver).assignedTo = receiver;
    emit({ type: 'drawn', code });
  }

  function close(code, token) {
    const s = getSession(code);
    requireHost(s, token);
    timers.clearTimeout(s.timer);
    sessions.delete(code);
    emit({ type: 'closed', code, reason: 'host' });
  }

  function hostView(code) {
    const s = getSession(code);
    return {
      state: s.state,
      participants: [...s.participants.values()].map(({ id, name, funFact, isHost }) => (
        { id, name, funFact, isHost })),
    };
  }

  function resultFor(code, participantId) {
    const s = getSession(code);
    if (s.state !== 'drawn') return null;
    const target = s.participants.get(s.participants.get(participantId)?.assignedTo);
    return target ? { assignedName: target.name, assignedFunFact: target.funFact } : null;
  }

  function participantName(code, participantId) {
    return sessions.get(code)?.participants.get(participantId)?.name ?? null;
  }

  function on(listener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  function dispose() {
    for (const s of sessions.values()) timers.clearTimeout(s.timer);
    sessions.clear();
  }

  return {
    createSession, join, authenticate, removeParticipant, draw, close,
    hostView, resultFor, participantName, on, size: () => sessions.size, dispose,
  };
}
