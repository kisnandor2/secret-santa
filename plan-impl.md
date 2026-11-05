# Secret Santa — Technical Implementation Spec

Companion to `plan.md`. `plan.md` describes *what* to build and why. This
document describes *how*: module boundaries, interfaces, wire protocol, state
machine, error model, and test harness. Where the two disagree, **this file is
authoritative** for technical detail.

---

## 0. Decisions that refine `plan.md`

| # | Decision | Reason |
|---|---|---|
| D1 | **Node 24 LTS** (`node:24-alpine`), not Node 20 | Node 20 went end-of-life in April 2026. Node 24 is the active LTS line. |
| D2 | **Express 5** | Current major version. Errors thrown in async route handlers reach the error middleware, so routes need no try/catch. |
| D3 | **ESM** (`"type": "module"`) for both server and browser | One module system. The browser uses `<script type="module">` with no bundler. |
| D4 | `draw.assign(ids, randomInt)` takes `randomInt(maxExclusive)`, not a float `random()` | No float-to-int bias, and it maps directly onto `crypto.randomInt`. |
| D5 | Session state (`store`) and socket handling (`hub`) are separate modules | `store` stays fully synchronous with no I/O, so it can be unit-tested and the draw race is safe by construction. |
| D6 | Client identity is stored in `sessionStorage` (auto-resume) **and** `localStorage` (offer to resume) | Tabs in one browser share `localStorage`, so storing it there alone would break multi-tab rehearsals. See §8.3. |
| D7 | After authenticating, the server sends `welcome { role, state, ... }` | One message for the client to start from, replacing `waiting`/`joined_ack`. |
| D8 | Timers are injected into `store`; tests use a hand-written fake timer | Independent of how `mock.timers` behaves in a given Node version, and fully deterministic. |
| D9 | Strict CSP, with no inline script or style | Defense in depth for the one real threat, XSS through names and fun facts. |
| D10 | Sessions are optionally persisted to SQLite (`node:sqlite`, built into Node 24) via a listener on `store`'s existing events, not by making `store` do I/O | Keeps `store` synchronous and I/O-free (D5) so it stays unit-testable; persistence is a separate module (`persist.js`) the store doesn't know about. |

---

## 1. Repository layout

```
secret_santa/
├── plan.md
├── plan-impl.md
├── package.json
├── package-lock.json
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── server.js                    # process entry: config, listen, signals
├── src/
│   ├── config.js                # env → frozen config object
│   ├── errors.js                # AppError + ERR catalogue
│   ├── validate.js              # input normalization/validation (pure)
│   ├── codes.js                 # session code + token + id generation
│   ├── draw.js                  # uniform single-cycle assignment (pure)
│   ├── store.js                 # session state machine (pure, sync, event-emitting)
│   ├── persist.js               # SQLite mirror of store sessions, for restart survival
│   ├── hub.js                   # WebSocket server: auth, registry, fan-out, heartbeat
│   ├── http.js                  # Express app: routes, security headers, static
│   ├── app.js                   # createApp(): wires store + http + hub onto one http.Server
│   └── log.js                   # one-line JSON logger (never logs secrets)
├── public/
│   ├── index.html
│   ├── style.css
│   ├── js/
│   │   ├── main.js              # bootstrap + view router
│   │   ├── api.js               # fetch wrappers for HTTP endpoints
│   │   ├── socket.js            # WS client with auth + reconnect/backoff
│   │   ├── identity.js          # session/local storage of {code, token, role}
│   │   ├── dom.js               # el() helper: textContent-only DOM building
│   │   ├── views.js             # render functions per view
│   │   └── reveal.js            # gift-box animation + confetti
│   └── vendor/
│       └── confetti.browser.min.js   # canvas-confetti@1.9.3, committed with license header
└── test/
    ├── helpers/
    │   ├── rng.js               # seeded randomInt (mulberry32)
    │   ├── fakeTimers.js        # deterministic setTimeout/clearTimeout/now
    │   ├── server.js            # startTestServer(): real app on port 0
    │   └── wsClient.js          # promise-based WS test client
    ├── validate.test.js
    ├── draw.test.js
    ├── store.test.js
    ├── persist.test.js
    ├── http.test.js
    ├── ws.test.js
    └── e2e/
        └── flow.test.js         # optional, Playwright
```

**Dependency rule:** `draw`, `validate`, `codes`, and `errors` are leaves.
`store` depends only on those. `hub` and `http` depend on `store`. `persist`
depends only on `store`'s public API (`on`, `exportSession`). `app`
depends on everything. Nothing in `src/` imports from `public/` or `test/`.

---

## 2. `package.json`

```json
{
  "name": "secret-santa",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "start": "node server.js",
    "test": "node --test --test-reporter=spec 'test/*.test.js'",
    "test:e2e": "node --test --test-reporter=spec 'test/e2e/*.test.js'",
    "test:all": "npm test && npm run test:e2e"
  },
  "dependencies": {
    "express": "^5.1.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "playwright": "^1.48.0"
  }
}
```

Glob patterns are quoted so that Node expands them, not the shell. That keeps
the behavior identical on every OS. `canvas-confetti` isn't a dependency: its
browser build is committed under `public/vendor/`.

---

## 3. Configuration (`src/config.js`)

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP listen port inside the container |
| `SESSION_TTL_MIN` | `120` | Session lifetime from creation |
| `MAX_SESSIONS` | `20` | Concurrent live sessions |
| `MAX_PARTICIPANTS` | `50` | Per session, including a participating host |
| `HEARTBEAT_MS` | `30000` | WS ping interval |
| `AUTH_TIMEOUT_MS` | `5000` | Time allowed for the first `auth` message |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `DB_PATH` | unset | SQLite file for session persistence. Unset disables persistence: sessions live in memory only, as before. |

`loadConfig(env = process.env)` parses the values, checks they're positive
integers, and returns `Object.freeze({...})`. An invalid value fails fast at
startup with a clear message. Tests pass explicit overrides to `createApp()`
and never touch `process.env`.

---

## 4. Error model (`src/errors.js`)

```js
export class AppError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}

export const ERR = Object.freeze({
  INVALID_INPUT:      { status: 400, message: 'Invalid input.' },
  FORBIDDEN:          { status: 403, message: 'Only the host can do that.' },
  NOT_FOUND:          { status: 404, message: 'Session not found. Check the code.' },
  NAME_TAKEN:         { status: 409, message: 'That name is already taken in this session.' },
  ALREADY_DRAWN:      { status: 409, message: 'The draw has already happened.' },
  SESSION_FULL:       { status: 409, message: 'This session is full.' },
  TOO_FEW:            { status: 409, message: 'At least 3 participants are needed to draw.' },
  CANNOT_REMOVE_HOST: { status: 409, message: 'The host cannot be removed.' },
  UNKNOWN_PARTICIPANT:{ status: 404, message: 'No such participant.' },
  SESSION_LIMIT:      { status: 503, message: 'Too many active sessions. Try again later.' },
});

export const fail = (key, message) => { throw new AppError(key, message ?? ERR[key].message, ERR[key].status); };
```

- HTTP: the error middleware maps an `AppError` to `res.status(e.status).json({ error: e.code, message: e.message })`.
  The body-parser errors `entity.parse.failed` and `entity.too.large` become `400 INVALID_INPUT`.
  Anything else becomes `500 { error: "INTERNAL" }` and is logged with its stack trace.
- WS: an `AppError` thrown while handling a client message becomes
  `{ type: "error", re: <client msg type>, error: e.code, message }`. The socket stays open.

---

## 5. Pure modules

### 5.1 `src/validate.js`

```js
normalizeCode(raw)            // → "FROSTY-427"  | fail INVALID_INPUT
parseName(raw)                // → { name, nameKey } | fail INVALID_INPUT
parseFunFact(raw)             // → string (may be "") | fail INVALID_INPUT
parseCreateBody(body)         // → { participate: true, name, nameKey, funFact } | { participate: false }
parseJoinBody(body)           // → { name, nameKey, funFact }
```

Rules:
- `typeof raw === 'string'` is required. Anything else is `INVALID_INPUT`.
- `clean(s) = s.normalize('NFC').replace(/\s+/g, ' ').trim()`.
- Reject any C0/C1 control character remaining after `clean`: `/[\u0000-\u001F\u007F-\u009F]/`.
- Length is counted in code points (`[...s].length`): name 1–40, funFact 0–200.
- `nameKey = name.toLocaleLowerCase('und')`, used only for uniqueness checks.
- Code: `raw.trim().toUpperCase()` must match `/^[A-Z]{3,10}-\d{3}$/`.
- `participate` defaults to `true` when absent. An explicit `false` ignores
  `name` and `funFact` even if they're present.

### 5.2 `src/codes.js`

```js
export function createCodeGen(randomInt = crypto.randomInt) {
  return () => `${WORDS[randomInt(WORDS.length)]}-${100 + randomInt(900)}`;
}
export const newToken = () => crypto.randomBytes(16).toString('base64url'); // 128-bit
export const newId    = () => crypto.randomUUID();
export function tokenEquals(a, b) {               // constant-time for equal lengths
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const A = Buffer.from(a), B = Buffer.from(b);
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
```

`WORDS` is a fixed list of 32 festive words, each 3–10 letters long (e.g.
FROSTY, JINGLE, TINSEL, COCOA, SLEIGH…). That gives 32 × 900 = 28,800 codes. The
store retries on collision up to 10 times, then throws `SESSION_LIMIT`.
Session codes aren't secrets: the tokens are. A guessed code only lets
someone *join*, which the host can see and undo with remove.

### 5.3 `src/draw.js`

```js
/**
 * Seat everyone in a uniformly random circle (Fisher–Yates), then each person
 * gives to the next one. Every n-cycle comes from exactly n rotations of the
 * seating, so all (n-1)! cycles are equally likely.
 * @param {readonly string[]} ids  length >= 2
 * @param {(maxExclusive:number)=>number} randomInt
 * @returns {Map<string,string>} giver id → receiver id
 */
export function assign(ids, randomInt) {
  if (ids.length < 2) throw new RangeError('need at least 2 ids');
  const a = [...ids];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);             // 0 <= j <= i
    [a[i], a[j]] = [a[j], a[i]];
  }
  return new Map(a.map((id, k) => [id, a[(k + 1) % a.length]]));
}
```

Properties guaranteed for n ≥ 3 (and tested):
- it's a bijection
- it has no fixed points
- it's one n-cycle
- it has no 2-cycles
- every cycle is equally likely, each with probability 1/(n−1)!

---

## 6. `src/store.js` — session state machine

### 6.1 Factory

```js
export function createStore({
  ttlMs,                       // 120 * 60_000
  maxSessions,                 // 20
  maxParticipants,             // 50
  randomInt = crypto.randomInt,
  genCode   = createCodeGen(randomInt),
  genToken  = newToken,
  genId     = newId,
  timers    = { setTimeout, clearTimeout },
  now       = Date.now,
}) → Store
```

### 6.2 Internal shape

```js
/** @typedef {{ id, token, name, nameKey, funFact, isHost: boolean, assignedTo: string|null }} Participant */
/** @typedef {{
 *   code, hostToken, hostParticipantId: string|null, createdAt: number,
 *   state: 'waiting'|'drawn',
 *   participants: Map<string, Participant>,   // insertion order = join order
 *   timer
 * }} Session */
const sessions = new Map();   // code → Session
```

A participating host's `Participant.token` **is** `hostToken`, so the host
only ever uses one token.

### 6.3 Public API

All methods are **synchronous**. Mutating methods emit events *after* the state
change is complete.

| Method | Auth | Allowed in | Effect / return | Errors |
|---|---|---|---|---|
| `createSession(parsedCreate)` | – | – | Creates the session and adds the host as a participant if they participate. Arms the TTL timer. → `{ code, hostToken, participantId \| null }` | `SESSION_LIMIT` |
| `join(code, parsedJoin)` | – | `waiting` | Adds a participant → `{ participantId, token }`. Emits `participants_changed`. | `NOT_FOUND`, `ALREADY_DRAWN`, `NAME_TAKEN`, `SESSION_FULL` |
| `authenticate(code, token)` | token | any | → `{ role: 'host'\|'participant', participantId \| null }` or `null` | `NOT_FOUND` |
| `removeParticipant(code, token, id)` | host | `waiting` | Deletes the participant. Emits `removed`, then `participants_changed`. | `FORBIDDEN`, `ALREADY_DRAWN`, `UNKNOWN_PARTICIPANT`, `CANNOT_REMOVE_HOST` |
| `draw(code, token)` | host | `waiting` | Sets `state = 'drawn'` **first**, then sets `assignedTo` on everyone. Emits `drawn`. | `FORBIDDEN`, `ALREADY_DRAWN`, `TOO_FEW` |
| `close(code, token)` | host | any | Clears the timer and deletes the session. Emits `closed { reason: 'host' }`. | `FORBIDDEN`, `NOT_FOUND` |
| `hostView(code)` | (caller) | any | → `{ state, participants: [{ id, name, funFact, isHost }] }` (no tokens, no assignments) | `NOT_FOUND` |
| `resultFor(code, participantId)` | (caller) | `drawn` | → `{ assignedName, assignedFunFact }` or `null` | `NOT_FOUND` |
| `participantName(code, participantId)` | (caller) | any | → string or `null` | |
| `on(listener)` | – | – | Subscribes. → `unsubscribe()` | |
| `size()` | – | – | Number of live sessions (for tests and `/healthz`) | |
| `dispose()` | – | – | Clears all timers and sessions (for tests and shutdown) | |
| `exportSession(code)` | – | any | → full session snapshot (tokens, `assignedTo` included) for `persist.js`, or `null` | |
| `restoreSessions(list)` | – | – | Rehydrates sessions from snapshots at startup, arming a timer for the *remaining* TTL. → `{ restored: string[], expired: string[] }`; a session whose TTL elapsed while the process was down is skipped, not extended | |

`hostView`, `resultFor` and `participantName` don't check authorization
themselves. Only `hub` calls them, and only for a socket that has already
authenticated with the right role (§7.3).

Check order inside `join` matters, so that errors are deterministic:
`NOT_FOUND → ALREADY_DRAWN → SESSION_FULL → NAME_TAKEN`.

Check order inside `draw`:
`NOT_FOUND → FORBIDDEN → ALREADY_DRAWN → TOO_FEW`.

**Race safety:** `draw` contains no `await` and no callback between checking
`state === 'waiting'` and setting `state = 'drawn'`. Node runs one message
handler at a time, so two `start_draw` messages are serialized, and the second
is rejected with `ALREADY_DRAWN`. Keep this invariant. A comment in the code
must say so.

### 6.4 State machine

```
            createSession
                 │
                 ▼
          ┌────────────┐  join / removeParticipant
          │  waiting   │◄──────────────┐
          └─────┬──────┘───────────────┘
                │ draw (host, n ≥ 3)
                ▼
          ┌────────────┐  authenticate / resultFor only
          │   drawn    │
          └─────┬──────┘
                │
 close(host) or TTL from either state
                ▼
           (deleted — emits closed)
```

### 6.5 Events

```js
{ type: 'created', code }
{ type: 'participants_changed', code }
{ type: 'removed',  code, participantId }
{ type: 'drawn',    code }
{ type: 'closed',   code, reason: 'host' | 'ttl' }
```

Events carry only identifiers. The hub pulls whatever view it needs. A
listener that throws is caught and logged, so it can't break the store.

### 6.6 TTL

`createSession` arms `timers.setTimeout(() => expire(code), ttlMs)` and calls
`.unref?.()` on the handle so the timer never keeps the process alive. `expire`
deletes the session and emits `closed { reason: 'ttl' }`. `close` and
`dispose` call `clearTimeout`.

### 6.7 `src/persist.js` — surviving a restart (optional)

```js
export function createPersistence({ dbPath, store, log }) → {
  loadAll(),            // → snapshot[] for store.restoreSessions()
  removeSession(code),  // used by app.js to drop a session that expired while down
  close(),              // unsubscribes from store and closes the DB handle
}
```

Only created when `config.DB_PATH` is set (§3); otherwise sessions are
memory-only, exactly as before this feature existed. It's a plain listener on
`store.on(...)`, so `store` itself stays synchronous and I/O-free (D5, D10):

| Store event | Action |
|---|---|
| `created`, `participants_changed`, `removed`, `drawn` | `store.exportSession(code)`, then upsert that session's row and fully replace its participant rows, inside one transaction |
| `closed` | Delete the session's row and participant rows |

Uses `node:sqlite` (`DatabaseSync`, built into Node 24, no new dependency),
with two tables, `sessions` and `participants` (one row per participant, with
a `seq` column to preserve join order). Writes are synchronous and
transactional (`BEGIN`/`COMMIT`/`ROLLBACK`), so a session's row is never left
half-written. A write that fails is logged (`persist_failed`) and the
in-memory store is unaffected — persistence is a mirror, never a dependency
of correctness while the process is up.

**Startup (`app.js`):** if `config.DB_PATH` is set, `createPersistence(...)`
is constructed right after `store`, then `store.restoreSessions(persistence.loadAll())`
runs before `listen()`. Sessions reported as `expired` (TTL elapsed while the
process was down) are removed from the DB via `persistence.removeSession`.
`app.close()` calls `persistence.close()`.

Since the DB holds tokens in plaintext, `DB_PATH` must point at a volume no
one else can read; see §12.

---

## 7. `src/hub.js` — WebSocket layer

### 7.1 Factory

```js
export function createHub({ store, heartbeatMs, authTimeoutMs, log }) → {
  handleUpgrade(req, socket, head),   // called by app.js for path === '/ws'
  closeAll(code = 1001, reason = 'server shutting down'),
  stats() → { sockets, sessions },
}
```

It uses `new WebSocketServer({ noServer: true, maxPayload: 4096, clientTracking: true })`.
`app.js` sends upgrades for any path other than `/ws` to `socket.destroy()`.

### 7.2 Registry

```js
// code → { hosts: Set<WebSocket>, members: Map<participantId, Set<WebSocket>> }
const rooms = new Map();
```

Each socket holds `ws.ctx = { code, token, role, participantId, alive: true }`
after it authenticates. A participating host's socket is added to `hosts`
**and** to `members[hostParticipantId]`. That makes `connected` correct for
the host's own card and lets the same fan-out code deliver the host's result.

`connected(code, pid) = rooms.get(code)?.members.get(pid)?.size > 0`

### 7.3 Socket lifecycle

1. **Connection opens.** Start `authTimer = setTimeout(() => ws.close(1008, 'auth timeout'), authTimeoutMs)`.
2. **First message must be** `{ type: 'auth', code, token }`. Otherwise the server closes with `4001`.
   - `normalizeCode` fails or the session doesn't exist → close `4004`.
   - `store.authenticate` returns `null` → close `4001`.
   - Success: clear `authTimer`, set `ws.ctx`, register the socket, send the
     welcome sequence (§7.5), and broadcast `participants_update` to hosts,
     since `connected` changed.
3. **Later messages** are parsed as JSON. Invalid JSON or an unknown `type`
   gets an `error INVALID_INPUT` reply. Each message is sent to its handler,
   and any `AppError` becomes an `error` message.
4. **Socket closes.** Remove it from the registry and, if the session still
   exists, broadcast `participants_update` to hosts.
5. **Heartbeat.** Every `heartbeatMs`, any socket whose `alive` flag is still
   false is terminated. Every other socket has `alive` set to false and is
   sent `ws.ping()`, and its `pong` sets `alive` back to true. Browsers answer
   pings automatically, so the client needs no code for this.

### 7.4 Store event → wire fan-out

| Store event | Action |
|---|---|
| `participants_changed` | `participants_update` to every socket in `hosts` |
| `removed { participantId }` | That participant's sockets: send `removed`, then close `4011`. Drop them from the registry. |
| `drawn` | Every socket in `members[pid]`: `draw_result` (`resultFor(pid)`). Every host socket: `draw_complete`, then `participants_update` (state = drawn). A host socket gets its `draw_result` through the `members` fan-out, never through a host-only path. |
| `closed { reason }` | Every socket in the room: `session_closed { reason }`, then close `4010`. Delete the room. |

Send order on `drawn` for a participating host's socket: `draw_result`, then
`draw_complete`, then `participants_update`. The client must handle any order
(§8.4).

### 7.5 Welcome sequence (on successful auth)

- **Host:** `welcome`, then `participants_update`. If the state is `drawn`:
  `draw_complete`, plus `draw_result` if `participantId` isn't null.
- **Participant:** `welcome`. If the state is `drawn`: `draw_result`.

This one sequence handles first connect, refresh, reconnect, and being
offline at draw time.

### 7.6 Close codes

| Code | Meaning | Client behavior |
|---|---|---|
| `1000/1001/1006…` | normal / network / server restart | Reconnect with backoff |
| `1008` | Auth timed out (e.g. phone suspended mid-connect) | Reconnect with backoff, keep identity |
| `4001` | Auth failed | Forget identity, go to landing ("Your session link is invalid") |
| `4004` | Session not found | Forget identity, go to landing ("Session ended or not found") |
| `4010` | Session closed (by host or TTL) | Forget identity, show "Session ended" |
| `4011` | Removed by host | Forget identity, show "The host removed you from this session" |

The client treats any close code from 4000 to 4999 as **terminal** and does
not reconnect.

---

## 8. Wire protocol

All frames are UTF-8 JSON objects with a string `type` field.

### 8.1 HTTP

| Method | Path | Request | Response |
|---|---|---|---|
| `POST` | `/api/sessions` | `{ participate?: boolean = true, name?: string, funFact?: string }` | `201 { code, hostToken, participantId: string \| null }` |
| `POST` | `/api/sessions/:code/join` | `{ name: string, funFact?: string }` | `201 { code, participantId, token }` (`code` comes back normalized) |
| `GET`  | `/healthz` | – | `200 { ok: true, sessions: n }` |
| `GET`  | `/*` | – | Static files from `public/`. Unknown non-API paths serve `index.html`. |

Every `/api/*` response sets `Cache-Control: no-store`. Unknown `/api/*` paths
return `404 { error: "NOT_FOUND" }`.

### 8.2 WebSocket messages

Client → server:

```ts
{ type: 'auth', code: string, token: string }          // must be first
{ type: 'start_draw' }                                  // host
{ type: 'remove_participant', id: string }              // host
{ type: 'close_session' }                               // host
```

Server → client:

```ts
{ type: 'welcome', role: 'host'|'participant', code: string,
  state: 'waiting'|'drawn', participantId: string|null, name: string|null }

{ type: 'participants_update', state: 'waiting'|'drawn',
  participants: { id: string, name: string, funFact: string,
                  isHost: boolean, connected: boolean }[] }           // hosts only

{ type: 'draw_complete' }                                             // hosts only
{ type: 'draw_result', assignedName: string, assignedFunFact: string } // own result only
{ type: 'removed' }
{ type: 'session_closed', reason: 'host'|'ttl' }
{ type: 'error', re: string|null, error: string, message: string }
```

**Invariant (asserted in tests):** no server frame ever contains a `token`
other than in the HTTP response to its owner. No frame ever contains an
`assignedTo` field. A socket only ever receives the `draw_result` for its own
`participantId`.

### 8.3 Client identity storage (`public/js/identity.js`)

The value stored is `{ code, token, role, name }`.

- On create or join, write it to **both** `sessionStorage['santa.id']` and
  `localStorage['santa.id']`. Update the URL to `/?s=<CODE>` with `history.replaceState`.
- On load:
  1. If `sessionStorage` has an identity, resume it automatically by
     connecting the WS. This is the refresh case.
  2. Otherwise, if `localStorage` has one, the landing page shows a banner
     **"Continue as Alice (FROSTY-427)? [Continue] [Start fresh]"**. This
     covers a closed tab without hijacking a second tab during a rehearsal.
  3. If the URL has `?s=CODE` and there's no identity, open the join form
     with the code filled in. The host's screen shows this link and a
     "Copy link" button.
- Any terminal close code (4xxx) clears both storages.

All storage access is wrapped in try/catch. If storage isn't available, the
app still works, just without resuming.

### 8.4 Client view state machine (`public/js/main.js`)

```
landing ──Host──► hostCreate ──POST ok──► hostRoom(waiting) ──draw_complete──► hostRoom(drawn)
   │                                                                     └─ "Reveal my match" ─► revealed (local only)
   └─Participant─► join ──POST ok──► waiting ──draw_result──► reveal(box closed) ──tap──► reveal(opened)
any ──terminal close──► ended(message)
```

- The view is derived from `(role, server state, local flags)`. Apart from
  `revealedByHost` and `boxOpened`, the client never assumes state the server
  hasn't confirmed.
- On the host, `draw_result` is stored in memory and **never** displayed until
  the user clicks "Reveal my match". After a refresh it's hidden again.
- On a participant, `draw_result` switches to the closed gift box. A tap opens it.
- The Draw button is enabled when `participants.length >= 3 && state === 'waiting'`.
  It opens a native `<dialog>` that asks "Draw for N people? No one else can
  join after this." On confirm it sends `start_draw` and disables the button
  until a response arrives.

### 8.5 WS client (`public/js/socket.js`)

- `connect({ code, token, onMessage, onTerminal, onStatus })`.
- URL: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`.
- It sends `auth` on `open`.
- Backoff on non-terminal close: 500 ms, 1 s, 2 s, 4 s, then every 5 s,
  with ±20% jitter. The counter resets after a successful `welcome`.
- `onStatus('connected'|'reconnecting')` controls the "reconnecting…" banner.

### 8.6 DOM safety (`public/js/dom.js`)

```js
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) node.append(c instanceof Node ? c : document.createTextNode(String(c ?? '')));
  return node;
}
```

**Rule:** `innerHTML`, `outerHTML`, `insertAdjacentHTML`, and `document.write`
aren't used anywhere in `public/js/`. A unit test greps for them and fails if
it finds one (§11.4).

---

## 9. `src/http.js` — Express app

```js
export function createHttpApp({ store, publicDir, log }) → express.Application
```

Middleware order:
1. `app.disable('x-powered-by')`.
2. Security headers on every response:
   ```
   Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self';
     img-src 'self' data:; connect-src 'self' ws: wss:; worker-src 'self' blob:;
     frame-ancestors 'none'; base-uri 'none'; form-action 'self'
   X-Content-Type-Options: nosniff
   Referrer-Policy: no-referrer
   ```
   `worker-src blob:` is there because canvas-confetti may render in a worker
   created from a blob URL.
3. `GET /healthz`.
4. Router `/api`: `express.json({ limit: '2kb', strict: true })`, then
   `no-store`, then the routes, then `404`.
5. `express.static(publicDir, { index: 'index.html', etag: true, maxAge: 0 })`.
6. SPA fallback: a `GET` for anything else returns `index.html`.
7. Error middleware (§4).

The route handlers are thin:

```js
api.post('/sessions', (req, res) => {
  const out = store.createSession(parseCreateBody(req.body));
  log.info('session_created', { code: out.code, hostParticipates: out.participantId !== null });
  res.status(201).json(out);
});
api.post('/sessions/:code/join', (req, res) => {
  const code = normalizeCode(req.params.code);
  const out = store.join(code, parseJoinBody(req.body));
  log.info('participant_joined', { code });
  res.status(201).json({ code, ...out });
});
```

---

## 10. `src/app.js` and `server.js`

```js
// src/app.js
export function createApp(overrides = {}) {
  const config = { ...loadConfig(), ...overrides };
  const log    = overrides.log ?? createLogger(config.LOG_LEVEL);
  const store  = overrides.store ?? createStore({ ttlMs: config.SESSION_TTL_MIN * 60_000, ... });
  const app    = createHttpApp({ store, publicDir, log });
  const server = http.createServer(app);
  const hub    = createHub({ store, heartbeatMs: config.HEARTBEAT_MS, authTimeoutMs: config.AUTH_TIMEOUT_MS, log });
  server.on('upgrade', (req, sock, head) => {   // must never throw: it would crash the process
    let pathname = null;
    try { pathname = new URL(req.url, 'http://x').pathname; } catch {}
    pathname === '/ws' ? hub.handleUpgrade(req, sock, head) : sock.destroy();
  });
  return {
    server, store, hub,
    listen: (port = config.PORT) => new Promise(r => server.listen(port, () => r(server.address().port))),
    close:  async () => { hub.closeAll(); store.dispose(); await new Promise(r => server.close(r)); },
  };
}
```

`server.js` creates the app with `createApp()` and calls `listen()`. On
`SIGTERM` or `SIGINT` it calls `close()`, with a 3 s hard `process.exit(0)`
fallback. On `uncaughtException` it logs the error and exits with status 1,
and Docker's restart policy brings the container back.

### 10.1 Logging (`src/log.js`)

Logs are one JSON line per event on stdout:
`{"t":"2026-12-12T10:00:00.000Z","lvl":"info","ev":"draw_done","code":"FROSTY-427","n":10}`.

**Never logged:** tokens, names, fun facts, assignments, or request bodies.
Logged: event name, session code, counts, error codes, and close codes. That
gives enough to debug the event without leaking who drew whom to anyone who
can read `docker logs`.

---

## 11. Test architecture

`npm test` runs on Node's built-in test runner with no extra dependencies.
The suite has to finish in under 5 s.

### 11.1 Helpers

```js
// test/helpers/rng.js — deterministic randomInt for reproducible draws
export function seededRandomInt(seed) {
  let s = seed >>> 0;
  const next = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
  return (max) => Math.floor(next() * max);
}

// test/helpers/fakeTimers.js
export function fakeTimers() → { setTimeout, clearTimeout, now, advance(ms), pending() }

// test/helpers/server.js
export async function startTestServer(overrides) → { base, wsUrl, app, close }
  // createApp({ PORT: 0, HEARTBEAT_MS: 200, AUTH_TIMEOUT_MS: 200, log: silentLog, ...overrides })

// test/helpers/wsClient.js
export async function openSocket(wsUrl, { auth } = {}) → {
  messages,                        // every parsed frame received, in order
  send(obj),
  next(type, { timeout = 1000 }),  // resolves with the next unseen frame of that type
  none(type, { within = 150 }),    // asserts no frame of that type arrives
  closed,                          // Promise<{ code, reason }>
  close(),
}
// http shortcuts
export const createSession = (base, body) => post(`${base}/api/sessions`, body);
export const join = (base, code, body) => post(`${base}/api/sessions/${code}/join`, body);
export async function setupRoom(base, wsUrl, { hostParticipates = true, joiners = 4 }) →
  { code, host: { token, pid, ws }, people: [{ name, token, pid, ws }] }
```

Each test file starts its own server in `before` and closes it in `after`,
and each test creates its own session. That keeps tests isolated without
restarting the server.

### 11.2 Unit test matrix

**`validate.test.js`**
- Names: trim and collapse whitespace, the 1/40 length boundaries (40 accepted,
  41 rejected), and length counted in code points (emoji count as 1).
  Control characters and non-strings are rejected.
- Codes: `frosty-427` → `FROSTY-427`. `FROSTY427`, `F-1` and `""` are rejected.
- Create body: `{}` means participate with a missing name, so it's rejected.
  `{ participate: false }` is OK. `{ participate: 'no' }` is rejected.

**`draw.test.js`**
- For n = 2..30, with 200 seeds each: bijective, no fixed points, a single
  n-cycle, and (for n ≥ 3) no 2-cycles.
- The same seed gives the same output.
- Uniformity for n = 4 with `seededRandomInt(42)`, 6000 runs: each of the 6
  possible cycles appears 1000 ± 200 times. That's about 7 standard
  deviations, so it doesn't flake, yet it catches biased shuffles. An earlier
  version of this spec ran Sattolo's algorithm and then linked neighbours. That
  version never produced one of the 6 cycles and produced another twice as
  often, and this test caught it.
- n < 2 throws `RangeError`.

**`store.test.js`** (`fakeTimers` + `seededRandomInt`)
- Create, with the host participating: one participant, `isHost: true`, whose
  token equals `hostToken`.
- Create with the host opting out: 0 participants and `hostParticipantId === null`.
- Code collision: `genCode` returns `A-100, A-100, B-200`, so the second
  session gets `B-200`. A generator that always collides throws
  `SESSION_LIMIT` after 10 attempts.
- `join` error precedence, one case per code in the §6.3 order.
- `NAME_TAKEN` for `" ALICE "` against host `"Alice"`.
- `authenticate`: host token → host role. Participant token → participant
  role. Wrong token → `null`. A token from session A used in session B → `null`.
- `removeParticipant`: works and emits `removed` and then
  `participants_changed`. Removing the host gives `CANNOT_REMOVE_HOST`.
  Removing with a participant token gives `FORBIDDEN`. Removing after the
  draw gives `ALREADY_DRAWN`.
- `draw` thresholds: host participating + 2 joiners → OK. Host opted out + 2
  joiners → `TOO_FEW`. Host opted out + 3 joiners → OK.
- `draw` twice → `ALREADY_DRAWN`, with the assignments unchanged (compared
  as a deep snapshot).
- `draw` with an opted-out host: the host never appears as a giver or a receiver.
- `resultFor` returns the right name and fun fact for every participant.
- `hostView` never contains `token`, `nameKey`, or `assignedTo`.
- TTL: `advance(ttl - 1)` → the session still exists. `advance(1)` → it's
  gone, and `closed { reason: 'ttl' }` was emitted. This works in both states.
- `close` clears the timer: `pending()` is 0 afterwards.
- `dispose` leaves `size()` at 0 and `pending()` at 0.
- A listener that throws doesn't stop other listeners from running.

### 11.2.1 `persist.test.js`

Uses a real SQLite file in a temp directory (`fs.mkdtempSync`), never
`:memory:`, since the point is surviving a process restart.

- `created`/`participants_changed`/`removed`/`drawn` each mirror the full
  session (including tokens and `assignedTo`) into SQLite; `closed` deletes it.
- TTL expiry (via `fakeTimers`) also deletes the session from SQLite.
- A second `createStore` + `createPersistence` pointed at the same file
  restores a session via `restoreSessions(persistence.loadAll())`, with
  `authenticate`, `resultFor`, and `hostView` all matching the pre-restart
  store.
- Full app-level restart: `startTestServer({ DB_PATH })`, create/join/draw
  over real HTTP/WS, `app.close()` (simulating a crash — no `closed` event),
  then a second `startTestServer({ DB_PATH })` against the same file. A
  participant's and the host's `draw_result` after reconnecting match what
  they got before the restart.

### 11.3 Integration tests

**`http.test.js`**
- `/healthz` returns 200. `/` returns HTML with a `Content-Security-Policy` header.
- A create/join round-trip returns the documented status codes and bodies.
- Every error code reachable over HTTP returns `{ error, message }` with the
  right status.
- Malformed JSON and a body over 2 kB both return 400 `INVALID_INPUT`.
- `/api/*` responses carry `Cache-Control: no-store`. Unknown `/api/x`
  returns 404 JSON.
- An XSS-shaped name round-trips unchanged as JSON data.

**`ws.test.js`**
- **Auth:**
  - no auth within `AUTH_TIMEOUT_MS` → closed with 1008 (retryable)
  - bad token → 4001
  - unknown code → 4004
  - first message not `auth` → 4001
  - a request to `/other` fails to upgrade
- **Presence:** the host receives `participants_update` when a participant
  connects (`connected: true`) and after they close (`connected: false`).
- **Authz:** `start_draw`, `remove_participant`, and `close_session` sent
  from a participant socket each get `error FORBIDDEN`.
- **Happy path, host participating:** host + 4 joiners connected, `start_draw`.
  - Each joiner receives exactly one `draw_result`.
  - The host receives exactly one `draw_result` plus `draw_complete`.
  - Collecting the 5 results as (own name → assignedName) gives a single
    5-cycle with no one assigned to themselves.
- **Happy path, host opted out:** host + 5 joiners.
  - The host receives `draw_complete` and `none('draw_result')`.
  - No result names the host.
- **Privacy sweep** after both happy paths, over every frame seen by every
  socket:
  - no `token` field
  - no `assignedTo` field
  - each socket sees at most one distinct `draw_result`, matching
    `store.resultFor(itsPid)`
- **Race:**
  - Two host sockets each send `start_draw` in the same tick, and one socket
    sends it twice back-to-back.
  - The draw happens exactly once: every member gets exactly one
    `draw_result`, and the losing requests get `error ALREADY_DRAWN`.
- **Reconnect after draw:** close a participant's socket, open a new one with
  the same token, and get `welcome { state: 'drawn' }` with a `draw_result`
  identical to the first.
- **Offline at draw time:** a participant who joined over HTTP but had no
  open socket gets their result on their first connect after the draw.
- **Host reconnect:**
  - Before the draw, a new host socket gets `participants_update` and can draw.
  - After the draw, a participating host gets `draw_complete` and the same
    `draw_result`.
- **Two tabs:**
  - The same token on 2 sockets shows as one participant entry.
  - Closing one socket leaves `connected: true`. Closing both gives `false`.
  - Both sockets receive the result.
- **Remove:**
  - The removed person's sockets get `removed` and then close with 4011.
  - The host list shrinks.
  - That person's token is then rejected with 4001.
- **Close:**
  - Every socket gets `session_closed { reason: 'host' }` and closes with 4010.
  - A later HTTP join returns 404.
- **TTL over the wire:** start the server with an injected `fakeTimers`
  store, then `advance(ttl)`. Every socket gets
  `session_closed { reason: 'ttl' }` and closes with 4010.
- **Heartbeat:** with `HEARTBEAT_MS = 200`, a socket that has automatic pong
  disabled (the `ws` client lets you override the `pong` behavior) is
  terminated within 2 intervals, and the host sees `connected: false`.
- **Bad frames:** invalid JSON and unknown `type` each give
  `error INVALID_INPUT`, and the socket stays open.

### 11.4 Static guard test (inside `validate.test.js` or its own file)
- Read every file in `public/js/*.js` and assert that none contains
  `innerHTML`, `outerHTML`, `insertAdjacentHTML`, or `document.write`.
- Assert that `public/index.html` contains no inline `<script>` without `src`
  and no `style=` attribute, since the CSP would block them anyway.

### 11.5 E2E (`test/e2e/flow.test.js`, Playwright, optional)

Run with `npx playwright install chromium` once, then `npm run test:e2e`.
- Start the server on port 0 and launch Chromium headless.
- Use 4 **separate browser contexts**, so each has its own storage: the host
  (participating) and three participants, one of them named
  `<img src=x onerror=window.__xss=1>`.
- The host creates a session, and the participants join through
  `/?s=<CODE>`. The host's list shows 4 cards, and the XSS name appears as
  literal text in the DOM (`textContent` matches, and there's no `img`
  element in the list).
- The host clicks Draw and confirms.
  - Each participant page shows the closed box. After a tap, it shows a name
    that isn't the participant's own.
  - On the host page, the match isn't visible until "Reveal my match" is
    clicked, then it is.
- Reload one participant page. The same name is shown, with no new draw.
- In every context, `window.__xss` is undefined.

### 11.6 Docker test stage

```dockerfile
FROM node:24-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./

FROM base AS test
RUN npm ci
COPY . .
RUN npm test

FROM base AS runtime
ENV NODE_ENV=production
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY src ./src
COPY public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "server.js"]
```

On the target server, `docker build --target test .` proves the code works on
that machine's Docker before `docker compose up`. The default build target is
`runtime`, the last stage.

---

## 12. Deployment files

**`docker-compose.yml`**
```yaml
services:
  santa:
    build: .
    image: secret-santa:local
    ports: ["81:3000"]
    restart: unless-stopped
    init: true                  # proper PID 1 signal forwarding / zombie reaping
    read_only: true             # app only writes to the /data volume below
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    environment:
      SESSION_TTL_MIN: "120"
      DB_PATH: "/data/sessions.db"
    volumes:
      - santa-data:/data

volumes:
  santa-data:
```

The Dockerfile creates `/data`, `chown`s it to the `node` user (the one the
container runs as, under `read_only: true`), and declares it a `VOLUME` so it
survives `docker compose restart`/`up` even without the named volume above.
`DB_PATH` holds session tokens in plaintext (D10) — acceptable here since
this is a single-purpose, short-lived app taken down after the event, but
that's a real tradeoff, not a non-issue, if this code is ever reused for
something with a real threat model. Don't back up or publish the volume.

**`.dockerignore`**: `node_modules`, `.git`, `test/e2e`, `*.md`, `.env*`.

If the app sits behind a reverse proxy, the proxy must forward
`Upgrade`/`Connection` headers on `/ws` and allow idle connections for more
than 60 s (heartbeats every 30 s keep them alive).

---

## 13. Build order and definition of done

| Step | Deliverable | Done when |
|---|---|---|
| 1 | `package.json`, `errors.js`, `validate.js` + tests | `npm test` is green |
| 2 | `draw.js` + tests | All properties pass, including the uniformity check |
| 3 | `codes.js`, `store.js` + tests | The §11.2 store matrix is green |
| 4 | `http.js`, `app.js`, `server.js` + `http.test.js` | `curl` create/join works locally |
| 5 | `hub.js` + `ws.test.js` | The §11.3 WS matrix is green, including privacy and race |
| 6 | Frontend: `dom`, `identity`, `api`, `socket`, `views`, `main` | Manual flow works in 4 browser profiles, and the static guard test is green |
| 7 | `reveal.js`, CSS, animations, `prefers-reduced-motion` | Works on a phone-sized viewport |
| 8 | Playwright E2E | `npm run test:all` is green |
| 9 | Dockerfile + compose | `docker build --target test .` passes, and `/healthz` is OK through port 81 |
| 10 | `persist.js` + `DB_PATH` wiring + `persist.test.js` | §11.2.1 is green, and a session survives `docker compose restart` with the `/data` volume mounted |
| 11 | Pre-event checklist (`plan.md`) on the real server | Dry run done from a second machine and a phone |

**Definition of done for v1:** steps 1–9 are green, and no log line contains a
name, token, or assignment (spot-check `docker logs` after the dry run).
