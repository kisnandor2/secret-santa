// WebSocket server: auth, registry, fan-out, heartbeat — see plan-impl.md §7
import { WebSocketServer, WebSocket } from 'ws';
import { AppError, fail } from './errors.js';
import { normalizeCode } from './validate.js';

// AUTH_TIMEOUT is deliberately outside 4000–4999 so the client retries instead of discarding its token.
const CLOSE = Object.freeze({ AUTH_TIMEOUT: 1008, AUTH: 4001, NOT_FOUND: 4004, SESSION_CLOSED: 4010, REMOVED: 4011 });

export function createHub({ store, heartbeatMs, authTimeoutMs, log }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, clientTracking: true });
  // code -> { hosts: Set<WebSocket>, members: Map<participantId, Set<WebSocket>> }
  const rooms = new Map();

  const isOpen = (ws) => ws.readyState === WebSocket.OPEN;

  function send(ws, frame) {
    if (!isOpen(ws)) return;
    try { ws.send(JSON.stringify(frame)); } catch (err) { log.warn('ws_send_failed', { err }); }
  }

  // Tell the socket it is finished; anything it sends afterwards is ignored.
  function endSocket(ws, code, reason) {
    ws.ctx.terminal = true;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      try { ws.close(code, reason); } catch (err) { log.warn('ws_close_failed', { err }); }
    }
  }

  const connected = (code, pid) => (rooms.get(code)?.members.get(pid)?.size ?? 0) > 0;

  function participantsUpdate(code) {
    const view = store.hostView(code);
    return {
      type: 'participants_update',
      state: view.state,
      participants: view.participants.map((p) => ({ ...p, connected: connected(code, p.id) })),
    };
  }

  function broadcastToHosts(code) {
    const room = rooms.get(code);
    if (!room || room.hosts.size === 0) return;
    let frame;
    try { frame = participantsUpdate(code); } catch { return; } // session already gone
    for (const ws of room.hosts) send(ws, frame);
  }

  function register(ws) {
    const { code, role, participantId } = ws.ctx;
    let room = rooms.get(code);
    if (!room) rooms.set(code, room = { hosts: new Set(), members: new Map() });
    if (role === 'host') room.hosts.add(ws);
    if (participantId) {
      if (!room.members.has(participantId)) room.members.set(participantId, new Set());
      room.members.get(participantId).add(ws);
    }
  }

  function unregister(ws) {
    const { code, participantId } = ws.ctx;
    const room = rooms.get(code);
    if (!room) return;
    room.hosts.delete(ws);
    const set = room.members.get(participantId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) room.members.delete(participantId);
    }
    if (room.hosts.size === 0 && room.members.size === 0) rooms.delete(code);
  }

  function sendResult(ws, code, pid) {
    const result = store.resultFor(code, pid);
    if (result) send(ws, { type: 'draw_result', assignedName: result.assignedName, assignedFunFact: result.assignedFunFact });
  }

  function welcome(ws) {
    const { code, role, participantId } = ws.ctx;
    const view = store.hostView(code);
    send(ws, { type: 'welcome', role, code, state: view.state, participantId, name: participantId ? store.participantName(code, participantId) : null });
    if (role === 'host') {
      send(ws, participantsUpdate(code));
      if (view.state === 'drawn') {
        send(ws, { type: 'draw_complete' });
        if (participantId) sendResult(ws, code, participantId);
      }
    } else if (view.state === 'drawn') {
      sendResult(ws, code, participantId);
    }
  }

  function authenticate(ws, msg) {
    let code;
    try {
      if (msg?.type !== 'auth') return endSocket(ws, CLOSE.AUTH, 'auth required');
      code = normalizeCode(msg.code);
    } catch { return endSocket(ws, CLOSE.NOT_FOUND, 'session not found'); }
    let who;
    try { who = store.authenticate(code, msg.token); } catch { return endSocket(ws, CLOSE.NOT_FOUND, 'session not found'); }
    if (!who) return endSocket(ws, CLOSE.AUTH, 'auth failed');

    clearTimeout(ws.ctx.authTimer);
    Object.assign(ws.ctx, { code, token: msg.token, role: who.role, participantId: who.participantId, authed: true });
    register(ws);
    welcome(ws);
    broadcastToHosts(code);
    log.debug('ws_auth_ok', { code, role: who.role });
  }

  function handle(ws, msg) {
    const { code, token } = ws.ctx;
    switch (msg.type) {
      case 'start_draw': return store.draw(code, token);
      case 'close_session': return store.close(code, token);
      case 'remove_participant':
        if (typeof msg.id !== 'string') fail('INVALID_INPUT', 'Participant id must be text.');
        return store.removeParticipant(code, token, msg.id);
      default: return fail('INVALID_INPUT', 'Unknown message type.');
    }
  }

  function onMessage(ws, data, isBinary) {
    if (ws.ctx.terminal) return;
    let msg = null;
    if (!isBinary) { try { msg = JSON.parse(data.toString('utf8')); } catch { /* handled below */ } }
    const valid = msg !== null && typeof msg === 'object' && !Array.isArray(msg) && typeof msg.type === 'string';

    if (!ws.ctx.authed) return authenticate(ws, valid ? msg : null);
    if (!valid) {
      return send(ws, { type: 'error', re: null, error: 'INVALID_INPUT', message: 'Messages must be JSON objects with a type.' });
    }
    try {
      handle(ws, msg);
    } catch (err) {
      if (!(err instanceof AppError)) {
        log.error('ws_handler_error', { err });
        return send(ws, { type: 'error', re: msg.type, error: 'INTERNAL', message: 'Something went wrong.' });
      }
      send(ws, { type: 'error', re: msg.type, error: err.code, message: err.message });
    }
  }

  function onClose(ws) {
    clearTimeout(ws.ctx.authTimer);
    if (!ws.ctx.authed) return;
    unregister(ws);
    if (!ws.ctx.terminal) broadcastToHosts(ws.ctx.code);
  }

  wss.on('connection', (ws) => {
    ws.ctx = { code: null, token: null, role: null, participantId: null, alive: true, authed: false, terminal: false, authTimer: null };
    ws.ctx.authTimer = setTimeout(() => endSocket(ws, CLOSE.AUTH_TIMEOUT, 'auth timeout'), authTimeoutMs);
    ws.on('pong', () => { ws.ctx.alive = true; });
    ws.on('message', (data, isBinary) => onMessage(ws, data, isBinary));
    ws.on('close', () => onClose(ws));
    ws.on('error', (err) => log.debug('ws_error', { err }));
  });

  const unsubscribe = store.on((event) => {
    const room = rooms.get(event.code);
    switch (event.type) {
      case 'participants_changed':
        return broadcastToHosts(event.code);

      case 'removed': {
        const sockets = room?.members.get(event.participantId);
        if (!sockets) return;
        const targets = [...sockets];
        for (const ws of targets) {
          send(ws, { type: 'removed' });
          endSocket(ws, CLOSE.REMOVED, 'removed');
          unregister(ws);
        }
        log.info('participant_removed_ws', { code: event.code, closed: targets.length });
        return;
      }

      case 'drawn': {
        if (!room) return;
        for (const [pid, sockets] of room.members) {
          for (const ws of sockets) sendResult(ws, event.code, pid);
        }
        const update = participantsUpdate(event.code);
        for (const ws of room.hosts) {
          send(ws, { type: 'draw_complete' });
          send(ws, update);
        }
        log.info('draw_broadcast', { code: event.code, members: room.members.size, hosts: room.hosts.size });
        return;
      }

      case 'closed': {
        if (!room) return;
        const all = new Set(room.hosts);
        for (const set of room.members.values()) for (const ws of set) all.add(ws);
        rooms.delete(event.code);
        for (const ws of all) {
          send(ws, { type: 'session_closed', reason: event.reason });
          endSocket(ws, CLOSE.SESSION_CLOSED, 'session closed');
        }
        log.info('session_closed_ws', { code: event.code, reason: event.reason, sockets: all.size });
        return;
      }

      default:
    }
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.ctx.alive) { ws.terminate(); continue; }
      ws.ctx.alive = false;
      try { ws.ping(); } catch { ws.terminate(); }
    }
  }, heartbeatMs);
  heartbeat.unref();

  return {
    handleUpgrade(req, socket, head) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    },
    closeAll(code = 1001, reason = 'server shutting down') {
      clearInterval(heartbeat);
      unsubscribe();
      for (const ws of wss.clients) {
        clearTimeout(ws.ctx?.authTimer);
        try { ws.close(code, reason); } catch { ws.terminate(); }
      }
      // Don't wait forever for peers that never complete the close handshake.
      const killer = setTimeout(() => { for (const ws of wss.clients) ws.terminate(); }, 1000);
      killer.unref();
    },
    stats: () => ({ sockets: wss.clients.size, sessions: rooms.size }),
  };
}
