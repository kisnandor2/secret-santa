// WS client with auth + reconnect/backoff — see plan-impl.md §8.5
const BASE_DELAYS = [500, 1000, 2000, 4000];
const MAX_DELAY = 5000;

export function backoffDelay(attempt, rand = Math.random) {
  const base = attempt < BASE_DELAYS.length ? BASE_DELAYS[attempt] : MAX_DELAY;
  return Math.round(base * (0.8 + rand() * 0.4));
}

export function connect({ code, token, onMessage, onTerminal, onStatus }) {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  let ws = null;
  let attempt = 0;
  let timer = null;
  let closed = false;

  function open() {
    timer = null;
    ws = new WebSocket(url);
    const mine = ws;
    mine.addEventListener('open', () => {
      mine.send(JSON.stringify({ type: 'auth', code, token }));
    });
    mine.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'welcome') {
        attempt = 0;
        onStatus?.('connected');
      }
      onMessage?.(msg);
    });
    mine.addEventListener('close', (ev) => {
      if (closed || mine !== ws) return;
      if (ev.code >= 4000 && ev.code <= 4999) {
        closed = true;
        onTerminal?.(ev.code);
        return;
      }
      onStatus?.('reconnecting');
      timer = setTimeout(open, backoffDelay(attempt++));
    });
    // 'error' is always followed by 'close'; nothing extra to do.
  }

  open();

  return {
    send(obj) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
        return true;
      }
      return false;
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      try { ws?.close(1000); } catch { /* ignore */ }
    },
  };
}
