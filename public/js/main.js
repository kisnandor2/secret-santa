// Bootstrap + view router — see plan-impl.md §8.3 / §8.4
import * as api from './api.js';
import * as identity from './identity.js';
import { connect } from './socket.js';
import * as views from './views.js';

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
const statusEl = document.getElementById('conn-status');

const MESSAGES = {
  4001: 'Your session link is invalid.',
  4004: 'Session ended or not found.',
  4010: 'Session ended.',
  4011: 'The host removed you from this session.',
};

const s = {
  screen: 'landing',       // landing | hostCreate | join (only while there is no identity)
  joinCode: '',
  id: null,                // { code, token, role, name } once created/joined/resumed
  conn: null,              // socket handle
  welcomed: false,
  role: null,              // from welcome
  code: null,
  name: null,
  participantId: null,
  serverState: 'waiting',
  participants: [],
  result: null,            // own draw_result (participant or participating host)
  drawComplete: false,
  drawPending: false,
  revealedByHost: false,   // local only
  animateHostReveal: false,
  boxOpened: false,        // local only
  connected: false,
  ended: null,             // message string when in the ended view
  endedResult: null,       // archived result shown alongside `ended`, if one was found
};
const seenIds = new Set();
const confirmer = views.createConfirm();
document.body.append(confirmer.dialog);

// ---- toast / status ------------------------------------------------------
let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; toastEl.textContent = ''; }, 6000);
}
function setStatus(status) {
  s.connected = status === 'connected';
  statusEl.hidden = status !== 'reconnecting';
  statusEl.textContent = status === 'reconnecting' ? 'Reconnecting…' : '';
}

// ---- state helpers ---------------------------------------------------------
function resetSessionState() {
  if (s.conn) { s.conn.close(); s.conn = null; }
  Object.assign(s, {
    id: null, welcomed: false, role: null, code: null, name: null, participantId: null,
    serverState: 'waiting', participants: [], result: null, drawComplete: false,
    drawPending: false, revealedByHost: false, animateHostReveal: false, boxOpened: false,
    connected: false, endedResult: null,
  });
  seenIds.clear();
  setStatus('connected');
  statusEl.hidden = true;
}

function startConnection(ident) {
  resetSessionState();
  s.id = ident;
  s.role = ident.role;
  s.code = ident.code;
  s.name = ident.name ?? null;
  s.screen = 'landing';
  s.conn = connect({
    code: ident.code,
    token: ident.token,
    onMessage: onMessage,
    onTerminal: onTerminal,
    onStatus: (st) => { setStatus(st); render(); },
  });
  render();
}

function endWith(message, { toLanding = false } = {}) {
  identity.clear();
  resetSessionState();
  try { history.replaceState(null, '', '/'); } catch { /* ignore */ }
  if (toLanding) {
    s.ended = null;
    s.screen = 'landing';
    toast(message);
  } else if (!s.ended) {
    s.ended = message;
  }
  render();
}

function onTerminal(code) {
  const msg = MESSAGES[code] || 'Disconnected from the session.';
  if (s.ended) { render(); return; } // a more specific message arrived first
  endWith(msg, { toLanding: code === 4001 || code === 4004 });
}

// ---- §8.2 server messages (any order) -------------------------------------
function onMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      s.welcomed = true;
      s.role = msg.role;
      s.code = msg.code || s.code;
      s.participantId = msg.participantId ?? null;
      s.name = msg.name ?? s.name;
      s.serverState = msg.state;
      s.drawPending = false; // a start_draw sent on a previous socket may never have arrived
      break;
    case 'participants_update':
      s.participants = Array.isArray(msg.participants) ? msg.participants : [];
      s.serverState = msg.state;
      if (msg.state === 'drawn') s.drawPending = false;
      break;
    case 'draw_complete':
      s.serverState = 'drawn';
      s.drawComplete = true;
      s.drawPending = false;
      break;
    case 'draw_result':
      // Host: stored only; shown after "Reveal my match". Participant: closed box appears.
      s.result = { assignedName: msg.assignedName, assignedFunFact: msg.assignedFunFact };
      s.serverState = 'drawn';
      s.drawPending = false;
      break;
    case 'removed':
      endWith(MESSAGES[4011]);
      return;
    case 'session_closed': {
      if (s.ended) return; // a more specific message arrived first
      const code = s.code;
      const token = s.id?.token;
      const message = msg.reason === 'ttl' ? 'This session has expired.' : 'The host ended the session.';
      // Set synchronously: the WS 'close' (4010) that follows this message is a
      // no-op once s.ended is set (see onTerminal's guard), so it can't race us.
      s.ended = message;
      resetSessionState();
      try { history.replaceState(null, '', '/'); } catch { /* ignore */ }
      render();
      api.getArchivedResult(code, token).then((result) => {
        if (result) s.endedResult = result;
        else identity.clear(); // nothing to look up later; forget this identity, as before
        render();
      });
      return;
    }
    case 'error':
      s.drawPending = false;
      toast(msg.message || 'Something went wrong.');
      break;
    default:
      return; // unknown types are ignored
  }
  render();
}

// ---- actions ---------------------------------------------------------------
function afterAuth({ code, token, role, name }) {
  const ident = { code, token, role, name };
  identity.save(ident);
  try { history.replaceState(null, '', '/?s=' + encodeURIComponent(code)); } catch { /* ignore */ }
  startConnection(ident);
}

async function onCreate(body) {
  const r = await api.createSession(body);
  afterAuth({ code: r.code, token: r.hostToken, role: 'host', name: body.participate === false ? null : String(body.name).trim() });
}
async function onJoin(code, body) {
  const r = await api.joinSession(code, body);
  afterAuth({ code: r.code, token: r.token, role: 'participant', name: String(body.name).trim() });
}

const shareLink = () => location.origin + '/?s=' + s.code;

// Pre-Clipboard-API copy, used on plain-http LAN addresses (not a secure context).
// The textarea must be focused and editable, and selected with setSelectionRange:
// otherwise iOS/Android select nothing, copy nothing, and still report success.
function legacyCopy(text) {
  const prevFocus = document.activeElement;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.className = 'offscreen';
  ta.setAttribute('aria-hidden', 'true');
  document.body.append(ta);
  let ok = false;
  try {
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, text.length);
    ok = document.execCommand('copy');
  } catch { /* ok stays false */ }
  ta.remove();
  prevFocus?.focus?.({ preventScroll: true });
  return ok;
}

async function copyLink() {
  const link = shareLink();
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(link);
      toast('Link copied.');
      return;
    } catch { /* fall through */ }
  }
  if (legacyCopy(link)) { toast('Link copied.'); return; }
  toast('Couldn\'t copy automatically. Select the link above and copy it.');
}

async function onDraw() {
  const n = s.participants.length;
  const ok = await confirmer.ask(`Draw for ${n} people?`, 'No one else can join after this.', 'Draw');
  if (!ok || s.serverState !== 'waiting' || s.drawPending) return;
  if (s.participants.length !== n) {
    toast('The participant list changed. Check it and press Draw again.');
    return;
  }
  if (s.conn && s.conn.send({ type: 'start_draw' })) {
    s.drawPending = true;
    render();
  } else {
    toast('Not connected. Try again in a moment.');
  }
}
async function onEnd() {
  const ok = await confirmer.ask('End this session?', 'Everyone will be disconnected and the draw is lost.', 'End session');
  if (ok && !(s.conn && s.conn.send({ type: 'close_session' }))) toast('Not connected. Try again in a moment.');
}
function onRemove(id) {
  if (!(s.conn && s.conn.send({ type: 'remove_participant', id }))) toast('Not connected. Try again in a moment.');
}
function backToStart() {
  s.ended = null;
  s.endedResult = null;
  s.screen = 'landing';
  s.joinCode = '';
  try { history.replaceState(null, '', '/'); } catch { /* ignore */ }
  render();
}

// ---- render ----------------------------------------------------------------
function currentView() {
  if (s.ended) {
    return s.endedResult
      ? views.renderArchivedResult({
        message: s.ended, result: s.endedResult, boxOpened: s.boxOpened,
        onOpened: () => { s.boxOpened = true; }, onBack: backToStart,
      })
      : views.renderEnded({ message: s.ended, onBack: backToStart });
  }

  if (s.id) {
    if (!s.welcomed) return views.renderConnecting();
    if (s.role === 'host') {
      const node = views.renderHostRoom({
        code: s.code,
        link: shareLink(),
        participants: s.participants,
        drawn: s.serverState === 'drawn' || s.drawComplete,
        drawPending: s.drawPending,
        connected: s.connected,
        participates: s.participantId !== null,
        hostResult: s.result,
        revealedByHost: s.revealedByHost,
        animateHostReveal: s.animateHostReveal,
        seenIds,
        onCopy: copyLink,
        onDraw,
        onEnd,
        onRemove,
        onRevealHost: () => { s.revealedByHost = true; s.animateHostReveal = true; render(); },
        onHideHost: () => { s.revealedByHost = false; s.animateHostReveal = false; render(); },
      });
      s.animateHostReveal = false;
      for (const p of s.participants) seenIds.add(p.id);
      return node;
    }
    if (s.result) {
      return views.renderReveal({ result: s.result, boxOpened: s.boxOpened, onOpened: () => { s.boxOpened = true; } });
    }
    return views.renderWaiting({ name: s.name, code: s.code });
  }

  if (s.screen === 'hostCreate') {
    return views.renderHostCreate({ onCreate, onBack: backToStart });
  }
  if (s.screen === 'join') {
    return views.renderJoin({ code: s.joinCode, onJoin, onBack: backToStart });
  }
  return views.renderLanding({
    remembered: identity.loadRemembered(),
    onHost: () => { s.screen = 'hostCreate'; render(); },
    onParticipant: () => { s.screen = 'join'; render(); },
    onContinue: async () => {
      const r = identity.loadRemembered();
      if (!r) { render(); return; }
      // The session may have closed since this identity was last used; check
      // the archive before trying to open a live connection to it.
      const result = await api.getArchivedResult(r.code, r.token);
      if (result) {
        s.ended = 'The draw is done! Here\'s your match.';
        s.endedResult = result;
        render();
        return;
      }
      identity.save(r); // copy into sessionStorage for this tab
      try { history.replaceState(null, '', '/?s=' + encodeURIComponent(r.code)); } catch { /* ignore */ }
      startConnection(r);
    },
    onFresh: () => { identity.clear(); render(); },
  });
}

function render() {
  const view = currentView();
  app.replaceChildren(view);
}

// ---- bootstrap (§8.3) ------------------------------------------------------
(function boot() {
  let urlCode = '';
  try { urlCode = (new URLSearchParams(location.search).get('s') || '').trim().slice(0, 14); } catch { /* ignore */ }

  const sess = identity.loadSession();
  if (sess) { startConnection(sess); return; }

  if (urlCode) {
    s.joinCode = urlCode; // prefilled if they pick Participant
    if (!identity.loadRemembered()) s.screen = 'join';
  }
  render();
})();
