// Promise-based WS test client and HTTP shortcuts — see plan-impl.md §11.1
export async function openSocket(wsUrl, { auth } = {}) { throw new Error('not implemented'); }
// returns { messages, send(obj), next(type, { timeout }), none(type, { within }), closed, close() }
export const createSession = (base, body) => { throw new Error('not implemented'); };
export const join = (base, code, body) => { throw new Error('not implemented'); };
export async function setupRoom(base, wsUrl, { hostParticipates = true, joiners = 4 } = {}) { throw new Error('not implemented'); }
// returns { code, host: { token, pid, ws }, people: [{ name, token, pid, ws }] }
