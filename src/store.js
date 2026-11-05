// Session state machine — see plan-impl.md §6
export function createStore({
  ttlMs,
  maxSessions,
  maxParticipants,
  randomInt,
  genCode,
  genToken,
  genId,
  timers,
  now,
} = {}) {
  throw new Error('not implemented');
}
