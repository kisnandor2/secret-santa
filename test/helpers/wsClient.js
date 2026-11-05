// Promise-based WS test client and HTTP shortcuts — see plan-impl.md §11.1
import { WebSocket } from 'ws';

const open = new Set();

export async function openSocket(wsUrl, { auth, autoPong = true } = {}) {
  const ws = new WebSocket(wsUrl, { autoPong });
  const messages = [];
  const byType = new Map(); // type -> { frames: [], cursor: 0, waiters: [] }
  const slot = (type) => {
    if (!byType.has(type)) byType.set(type, { frames: [], cursor: 0, waiters: [] });
    return byType.get(type);
  };

  const closed = new Promise((resolve) => {
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });

  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    messages.push(frame);
    const s = slot(frame.type);
    s.frames.push(frame);
    while (s.waiters.length && s.cursor < s.frames.length) s.waiters.shift()(s.frames[s.cursor++]);
  });

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.on('error', () => {});

  const client = {
    ws,
    messages,
    closed,
    send: (obj) => ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)),
    // Resolves with the next frame of this type that hasn't been consumed yet, including ones that arrived earlier.
    next(type, { timeout = 1000 } = {}) {
      const s = slot(type);
      if (s.cursor < s.frames.length) return Promise.resolve(s.frames[s.cursor++]);
      return new Promise((resolve, reject) => {
        const waiter = (frame) => { clearTimeout(timer); resolve(frame); };
        const timer = setTimeout(() => {
          s.waiters.splice(s.waiters.indexOf(waiter), 1);
          reject(new Error(`timed out waiting for '${type}'`));
        }, timeout);
        s.waiters.push(waiter);
      });
    },
    // Rejects if an unconsumed frame of this type is present or arrives within the window.
    async none(type, { within = 150 } = {}) {
      await new Promise((r) => setTimeout(r, within));
      const s = slot(type);
      if (s.cursor < s.frames.length) throw new Error(`unexpected '${type}' frame: ${JSON.stringify(s.frames[s.cursor])}`);
    },
    all: (type) => messages.filter((m) => m.type === type),
    // Resolves once a frame of this type matching pred has been seen (consumed or not).
    async waitFor(type, pred, { timeout = 1000 } = {}) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const hit = client.all(type).find(pred);
        if (hit) return hit;
        if (Date.now() > deadline) throw new Error(`timed out waiting for matching '${type}'`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    close: () => { ws.close(); return closed; },
  };

  open.add(client);
  closed.then(() => open.delete(client));
  if (auth) client.send({ type: 'auth', ...auth });
  return client;
}

export function closeAllClients() {
  for (const c of open) c.ws.terminate();
  open.clear();
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
}

export const createSession = (base, body) => post(`${base}/api/sessions`, body);
export const join = (base, code, body) => post(`${base}/api/sessions/${code}/join`, body);

export async function setupRoom(base, wsUrl, { hostParticipates = true, joiners = 4 } = {}) {
  const created = await createSession(base, hostParticipates ? { name: 'Host', funFact: 'hosts' } : { participate: false });
  const { code, hostToken, participantId } = created.body;
  const host = { name: hostParticipates ? 'Host' : null, token: hostToken, pid: participantId };
  host.ws = await openSocket(wsUrl, { auth: { code, token: hostToken } });
  await host.ws.next('welcome');

  const people = [];
  for (let i = 1; i <= joiners; i++) {
    const name = `P${i}`;
    const res = await join(base, code, { name, funFact: `fact ${i}` });
    const p = { name, token: res.body.token, pid: res.body.participantId };
    p.ws = await openSocket(wsUrl, { auth: { code, token: p.token } });
    await p.ws.next('welcome');
    people.push(p);
  }
  return { code, host, people };
}
