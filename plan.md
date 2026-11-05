# Secret Santa — Implementation Plan

## Goal
A short-lived (one session, ~5–10 minutes of real use), self-hosted web app for a
10-person remote Secret Santa draw. No email, no accounts, no company data, no
persistent database. Deployed as a single Docker container on the colleague's
server, exposed on port 81.

Keep it simple, but it **must work on the day** — so core logic is covered by
automated tests, and there is a scripted end-to-end check to run right before
the event.

## Roles
- **Host**: creates a session, watches participants join, triggers the draw.
  **By default the host is also a participant.** They enter a name and a fun
  fact when creating the session and get drawn like anyone else. A
  checkbox **"I do NOT participate"** on the create screen opts them out
  (organizer only, no name or fun fact needed).
- **Participant**: joins a session with a session code, enters name + a fun
  fact, waits, then sees only their own assignment.

## High-level flow
1. Landing page: "I am HOST" / "I am PARTICIPANT".
2. **Host** → create screen: name + fun fact fields, plus the
   **"I do NOT participate"** checkbox (unchecked by default; ticking it hides
   and skips the name and fun fact fields) → "Create session" → server generates
   a short session code (e.g. `FROSTY-427`) and a secret host token. If the
   host participates, the server also adds them as a participant →
   host's browser stores the host token in `sessionStorage` + `localStorage` (see plan-impl.md §8.3)
   (survives tab close, not just refresh) → host is shown the code to share
   and a live waiting-room view.
3. **Participant** → enters the session code → enters name → enters a fun fact
   → joins → server generates a secret participant token → browser stores it in
   `sessionStorage` + `localStorage` → participant sees a waiting screen
   ("Waiting for the host to draw...").
4. **Waiting room** (host view): live list of joined participants + their fun
   facts, updating in real time. Shows count (e.g. "7 joined") and each
   person's connection status. A participating host appears in the list
   (marked "host") and counts toward the total. Host can **remove** a participant before the
   draw (fixes test joins / typos / duplicates such as "Bob" and "Bob K"),
   but cannot remove themselves.
5. Host clicks **Draw** (disabled below 3 participants, host included if
   participating). Server:
   - Validates and flips `state` to `"drawn"` synchronously (first request
     wins, no more joins or removals).
   - Computes the assignment (see Draw algorithm).
   - Sends each connected participant **only their own** `draw_result`.
   - Sends the host a `draw_complete`, plus the host's **own**
     `draw_result` if they participate. The server never sends the host the
     full mapping.
6. Each participant's page shows a reveal animation (gift box / card flip)
   with their assigned person's name + fun fact. Nobody, the host included,
   ever receives the full mapping.
   - **The host's result is not shown automatically.** The host's screen is
     likely being shared on the call, so the host view shows "Draw complete ✓"
     and a **"Reveal my match"** button. Only clicking it plays the gift-box
     reveal. A "Hide" button covers it again.
7. The session is deleted from memory **120 minutes after creation** or when the
   host clicks "End session", whichever comes first. Nothing is written to disk.

## Why this architecture
- Only one container, no external services, no email — matches the
  constraints (no DB, deploy once, run briefly, tear down).
- Real-time join/draw updates need a live channel → WebSocket.
- In-memory state is sufficient: the event lives within one container's
  lifetime. **Known trade-off:** if the container restarts mid-event, the
  session is lost and the host must start a new one. That's acceptable for
  a 10-minute event; don't add persistence.
- Tokens (not names) are the identity credential, so nobody can "become"
  someone else by typing their name.

## Tech stack
- **Backend**: Node.js 24 LTS + Express 5 (HTTP) + `ws` (WebSocket). No build step.
- **Frontend**: Plain HTML/CSS/JS served as static files by Express. One page
  that switches views by state. `canvas-confetti` is **vendored** into
  `public/vendor/` (don't load it from a CDN — the server may not have
  internet access, and the event shouldn't depend on a third party).
- **Storage**: In-memory only.
- **Tests**: Node's built-in `node:test` + `node:assert`, with no test
  framework dependency. Integration tests use Node's global `fetch` and the
  `ws` client. Optional browser smoke test with Playwright (dev dependency only).
- **Packaging**: Single `Dockerfile`; `docker-compose.yml` mapping `81:3000`.

## Code structure (designed for testability)
Logic is split so that most of it can be tested without sockets or timers:

```
secret_santa/
├── plan.md
├── Dockerfile
├── docker-compose.yml
├── .dockerignore              (node_modules, test/, .git)
├── package.json               (scripts: start, test, test:e2e)
├── server.js                  (entry point: createApp() + listen on PORT, SIGTERM handling)
├── src/
│   ├── app.js                 (createApp({ store }) → { httpServer }; Express routes + ws wiring)
│   ├── store.js               (createStore({ now, random, ttlMs, setTimeout }) — pure session logic)
│   ├── draw.js                (assign(ids, random) — Sattolo's algorithm)
│   └── codes.js               (session code + token generation)
├── public/
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   └── vendor/confetti.browser.min.js
└── test/
    ├── draw.test.js
    ├── store.test.js
    ├── api.test.js            (HTTP + WebSocket integration, real server on port 0)
    └── e2e.test.js            (optional, Playwright)
```

Key rule: `store.js` has **no** I/O. It takes injected `now`, `random`, and
timer functions, and returns plain data and events. `app.js` translates
those into HTTP responses and WS messages. Tests can then use a seeded RNG and
`node:test`'s `mock.timers` for TTL behaviour.

## Data model (in-memory)
```js
Session {
  code: "FROSTY-427",
  hostToken: "<random 128-bit hex>",
  createdAt: timestamp,
  state: "waiting" | "drawn",       // closed sessions are simply deleted
  hostParticipantId: id | null,     // null when host ticked "I do NOT participate"
  participants: Map<id, {
    id: "uuid",
    token: "<random 128-bit hex>",  // secret, held by that participant's browser
    name: "Alice",
    funFact: "Once met a penguin",
    sockets: Set<WebSocket>,        // a person may have >1 tab open; connected = size > 0
    assignedTo: id | null
  }>,
  hostSockets: Set<WebSocket>,
  expiryTimer
}
```
`Map<code, Session>` holds all sessions. Tokens come from `crypto.randomBytes`
and codes from `crypto.randomInt`, never `Math.random`. Compare tokens with
`crypto.timingSafeEqual` (cheap to do, so no reason not to).

## Input validation
- `name`: trimmed, 1–40 chars. Uniqueness is checked **case-insensitively
  after trimming and collapsing whitespace** ("alice " == "Alice").
- `funFact`: trimmed, 0–200 chars.
- Session code: normalized to upper case, so participants can type `frosty-427`.
- JSON body size limit: `express.json({ limit: '2kb' })`.
- **XSS:** the frontend renders all user text with `textContent`, never
  `innerHTML`. Names and fun facts are shown to other people, so this is the
  one security issue that actually matters here.
- Max 50 participants per session and max 20 live sessions, as a cheap guard
  against accidental or abusive floods.

## API / WebSocket contract
HTTP:
| Method & path | Body | Success | Errors |
|---|---|---|---|
| `POST /api/sessions` | `{ participate: true, name, funFact }` or `{ participate: false }` | `201 { code, hostToken }` | `400` invalid input (name required when participating), `503` session limit |
| `POST /api/sessions/:code/join` | `{ name, funFact }` | `201 { participantId, token }` | `400` invalid input, `404` no session, `409` name taken / already drawn / full |
| `GET /healthz` | – | `200 ok` | – |

All errors return `{ error: "<code>", message: "<human text>" }` so the
frontend can show something sensible.

WebSocket at `/ws`. The client sends credentials as the **first message**
(not in the URL, which can end up in proxy logs):
`{ type: "auth", code, token }`. The server works out the role from the
token. If auth is invalid or missing within 5 s, the server closes the socket
with code `4001`.

Server → Host:
- `participants_update { participants: [{ id, name, funFact, connected, isHost }], state }`
  (sent on auth, join, remove, connect, and disconnect)
- `draw_complete`
- `draw_result { assignedName, assignedFunFact }`: only if the host
  participates. It's sent on draw and on any later host auth. The client keeps
  it hidden behind "Reveal my match".

The host uses **one token** (the host token). If the host participates,
that token also identifies their participant record, so there's no second
token to manage.
- `error { error, message }`

Server → Participant:
- `welcome { role, state, participantId, name }` (sent first on every auth; see plan-impl.md §8.2)
- `draw_result { assignedName, assignedFunFact }` (sent on draw, **and** on
  any later auth, so refresh/reconnect re-serves the same result)
- `removed` (host removed them; client clears its token)

Server → All in session:
- `session_closed` (followed by socket close)

Client → Server (host token required, otherwise `error { error: "forbidden" }`):
- `start_draw`: rejected unless state is "waiting" and there are at least 3 participants
- `remove_participant { id }`: only while state is "waiting"
- `close_session`

Liveness: server pings every 30 s and terminates sockets that miss a pong, so
the `connected` indicator is reliable.

## Draw algorithm
Use **Sattolo's algorithm**, a Fisher–Yates variant that produces a uniformly
random single cycle. Each participant gives to `order[i+1]`, wrapping around.
Compared with reject-and-retry derangement:
- It never assigns anyone to themselves.
- It never creates mutual pairs (A→B and B→A) for n ≥ 3, which makes the game
  more fun.
- It's a single pass with no retry loop, deterministic for a given RNG, and
  easy to test.

```js
function assign(ids, randomInt) {       // randomInt(max) → 0..max-1
  const a = [...ids];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i);             // j < i  (Sattolo; Fisher–Yates uses i+1)
    [a[i], a[j]] = [a[j], a[i]];
  }
  return new Map(a.map((id, i) => [id, a[(i + 1) % a.length]]));
}
```
No exclusion-list feature in v1.

## UI / animation notes
- Landing: two big buttons, Host / Participant, festive CSS-only theme.
- Host create screen: name, fun fact, and an "I do NOT participate" checkbox
  that hides the name and fun fact fields when ticked.
- Participant waiting room: pulsing "waiting for host..." over a CSS snow background.
- Host waiting room: names + fun facts as cards with an entrance animation,
  connection dot, a remove "×" button per card, a count, and the Draw button.
  The Draw button asks "Draw for N people? No one else can join after this."
- Reveal: wrapped gift box → tap → flip/unwrap → name + fun fact → confetti.
- Host after the draw: "Draw complete ✓" plus "Reveal my match" (if
  participating). The reveal never auto-plays on the host screen.
- Dark, warm palette; mobile-friendly; honors `prefers-reduced-motion`.
- The frontend auto-reconnects the WebSocket with backoff and shows a small
  "reconnecting…" banner while disconnected.

## Testing plan

`npm test` runs `node --test test/`. It must pass before every deploy.

### Unit: `draw.test.js`
- For n = 3..20, over many random seeds: the result is a permutation (every
  id gives exactly once and receives exactly once), with no fixed points.
- The result is a single cycle: following `assignedTo` from anyone visits all
  n people.
- There are no mutual pairs for n ≥ 3.
- With a fixed seeded RNG, the output is deterministic.
- Rough uniformity check for n = 4: across ~6000 runs, each of the 6 possible
  cycles appears within a loose tolerance. This catches the classic
  Sattolo/Fisher–Yates off-by-one.

### Unit: `store.test.js`
- Create a session: the code has the expected format, and the token is unique.
- Code collision: with an injected RNG that repeats a code, the second session
  gets a different code.
- Join: works, and an upper/lower-case code still resolves.
- Duplicate name (`"Alice"` vs `" alice "`) is rejected.
- Invalid name/funFact lengths are rejected.
- Join after the draw is rejected. Join to an unknown session gives "not found".
- Draw with fewer than 3 participants is rejected. Draw with a participant
  token is rejected.
- A second draw is rejected, and the assignments stay unchanged.
- Removing a participant before the draw works. Removing after the draw is rejected.
- Close deletes the session, and later lookups give "not found".
- TTL: with `mock.timers`, advancing 119 min keeps the session, and advancing
  to 120 min deletes it, even after a draw.
- Participant and session limits are enforced.
- Host participates by default: creating with `participate: true` adds the
  host as a participant, `isHost: true`.
- Opt-out: creating with `participate: false` gives 0 participants, and the
  host is not in the draw.
- `participate: true` without a name is rejected.
- A participant can't join with the host's name, case-insensitively.
- The host's own record can't be removed.
- Minimum count: a participating host + 2 joiners can draw. A non-participating
  host + 2 joiners cannot.

### Integration: `api.test.js`
Start the real app on port 0 in `before()` and close it in `after()`. A small
helper opens an authenticated WS and collects the messages it receives.
- `GET /healthz` returns 200. Static `index.html` is served.
- HTTP status codes and error bodies match the table above.
- A WS with a bad token is closed with `4001`, and so is a WS that never sends auth.
- The host receives `participants_update` when a participant joins,
  connects, and disconnects.
- `start_draw` sent from a participant socket returns `forbidden`.
- **Full happy path:** host + 5 participants join, the host draws, and each
  participant gets exactly one `draw_result`. The results together form a
  valid single-cycle assignment, and nobody gets themselves.
- **Host participates (default):** host + 4 participants, then draw. The host
  socket receives `draw_complete` and exactly one `draw_result`, for the host
  only. All 5 assignments form one valid loop that includes the host.
- **Host opts out:** host + 5 participants, then draw. The host receives
  `draw_complete` and **no** `draw_result`, and nobody is assigned the host.
- **Privacy:** across every message received by the host and by each
  participant, no message contains another participant's assignment.
  The host never receives more than its own single `draw_result`.
- **Race:** two `start_draw` messages sent at once lead to exactly one draw,
  and each participant receives exactly one result.
- **Reconnect after draw:** close a participant socket, re-auth with the same
  token, and get the *same* `draw_result`.
- **Offline at draw time:** a participant who joined but had no socket open
  during the draw receives their result when they connect later.
- **Host reconnect:** a new socket with the host token gets the current
  participant list and can still draw. After the draw, a reconnecting
  participating host gets the same `draw_result` again.
- **Two tabs:** the same participant on two sockets shows as one person,
  stays `connected` while one tab is still open, and both tabs get the result.
- `close_session` → every socket receives `session_closed` and is closed, and
  later joins return 404.
- `remove_participant` → that person's sockets get `removed`, and the host
  list updates.
- An XSS-shaped name (`<img src=x onerror=alert(1)>`) is stored and returned
  verbatim as data. Escaping is the frontend's job, covered below.

### Optional E2E: `e2e.test.js` (Playwright, `npm run test:e2e`)
A single smoke test using one browser context for the host and three for
participants: create, join, draw, and check that each participant page shows
a name that isn't their own. On the host page, the match is not visible
until "Reveal my match" is clicked. It also checks that the XSS-shaped name renders
as literal text and no `<img>` element appears. Skip it if installing
Playwright is a hassle; the integration tests cover the logic.

### Pre-event checklist (manual, ~5 min, on the actual server)
1. `docker compose up -d --build`, then `curl http://<server>:81/healthz`.
2. Open the URL from **another machine** on the same network (catches
   firewall/port 81 issues), plus one phone.
3. Do a dry run with 3 browser windows: join, draw, reveal, refresh one
   participant (they should see the same result), then end the session.
4. Leave the container running, and start a fresh session for the real event.

## Deployment
1. `Dockerfile`: `node:24-alpine`, `WORKDIR /app`, copy `package*.json`,
   `npm ci --omit=dev`, copy the app, `USER node`, `EXPOSE 3000`,
   `HEALTHCHECK` hitting `/healthz`, `CMD ["node", "server.js"]`.
2. `docker-compose.yml`: `ports: ["81:3000"]`, `restart: unless-stopped`
   (a crash-restart loses state anyway, but it beats a dead page mid-event).
3. `server.js` handles `SIGTERM`: it closes sockets and the server, so
   `docker compose down` is instant.
4. No TLS at :81. Fine on a trusted internal network. If the server is
   reachable from the internet, put it behind the colleague's existing HTTPS
   reverse proxy, which must allow WebSocket upgrades on `/ws`.

## Edge cases (all have tests above)
- Duplicate name, compared case- and whitespace-insensitively → clear error.
- Host closes the tab or refreshes → the stored token reconnects
  them as host.
- Double-click on Draw or racing requests → the state flips synchronously,
  so the first one wins.
- Fewer than 3 participants → Draw is disabled client-side and rejected server-side.
- Participant refreshes before the draw → same slot, no duplicate.
- Participant refreshes or connects after the draw → same assignment re-served.
- Participant is offline at draw time → they get their result on next connect.
- Unwanted or duplicate join → the host removes it before the draw.
- Session code collision → regenerated.
- Host participates (default) → in the draw, counts toward the minimum, can't
  be removed, and their result is hidden until they click "Reveal my match".
- Host ticks "I do NOT participate" → organizer only, never assigned.
- Container restart → session lost (accepted). Clients see "session not
  found" and are sent back to the landing page.

## Implementation order
1. `draw.js` + its tests.
2. `store.js` + its tests (TDD, using the injected clock and RNG).
3. `app.js` HTTP routes + API tests.
4. WebSocket protocol + integration tests (happy path, privacy, race, reconnect).
5. Frontend views, wired to the protocol, with `textContent` everywhere.
6. Animations and polish.
7. Dockerfile/compose, then the pre-event checklist on the real server.

## Out of scope (v1)
Wishlists, exclusion rules, email notifications, persistent history,
authentication beyond tokens, persistence across container restarts.
