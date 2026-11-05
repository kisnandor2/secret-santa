# Secret Santa

A small self-hosted web app for a remote Secret Santa draw. One container, no
database, no accounts and no email. Everything lives in memory and disappears when
the session ends or the container stops.

- The **host** creates a session and shares the code or link. By default the host
  takes part in the draw too. Tick "I do NOT participate" to only organise.
- **Participants** join with a name and a fun fact, then wait.
- The host clicks **Draw**. Everyone sees only their own match: a name plus that
  person's fun fact. Nobody, including the host, sees the full list. The host's own
  match stays hidden until they click "Reveal my match", which is handy if their
  screen is shared on a call.
- Everyone is placed in one random circle, so nobody draws themselves and no two
  people draw each other.
- A session expires 120 minutes after it was created, or when the host clicks
  "End session".

## Quick start

Requirements: Docker with the Compose plugin.

```bash
./start.sh        # build and start on port 81
./start.sh 80     # ...or on any other port, e.g. 80
```

Open `http://<server>:81/` (or your chosen port) and share that address.

```bash
docker compose logs -f     # follow logs
docker compose down        # stop (ends every session!)
```

> **Don't restart during the event.** Sessions live only in memory, so a
> restart or `docker compose down` ends every session, including finished draws.

## Deploying on a server: things to check

The app needs **no `127.0.0.1` or host configuration**. Inside the container it
listens on all interfaces, on port 3000. Compose publishes that on all host
interfaces, on port 81 by default.

1. **Port is free.** `ss -ltnp | grep -E ':(80|81) '`. Port 80 is often taken by
   nginx or Apache. If it is, keep 81 or pick another port.
2. **Firewall / security group.**
   - A cloud security group or network firewall must allow **inbound TCP** on the
     chosen port.
   - **`ufw` does not protect Docker ports.** Docker writes its own iptables rules,
     so a published port is reachable even if `ufw` says it's closed. Rely on the
     network firewall, or use `HOST_BIND` (step 4).
   - With **firewalld**, Docker uses its own `docker` zone. If other machines can't
     connect, check `firewall-cmd --get-active-zones`.
3. **Rootless Docker** can't bind ports below 1024, which includes 80 and 81. Use
   normal (rootful) Docker, set `sudo sysctl net.ipv4.ip_unprivileged_port_start=80`,
   or use a port such as 8081.
4. **Behind a reverse proxy** (nginx, Caddy, Traefik) on the same host:
   - Start with `HOST_BIND=127.0.0.1 ./start.sh 8081`, so only the proxy can reach
     the app.
   - The proxy must forward **WebSocket upgrades on `/ws`**: the `Upgrade` and
     `Connection` headers. It must also allow idle connections longer than 60 s.
     The server pings every 30 s.
   - Use the proxy for HTTPS if the server is reachable from the internet. On a
     trusted internal network, plain HTTP on 81 is fine.
5. **Test from a different machine**, not from the server itself:
   ```bash
   curl http://<server-ip>:81/healthz     # -> {"ok":true,"sessions":0}
   ```
   A machine's own firewall can drop traffic to its own LAN IP, so a test from the
   server tells you little.
6. **Health.** `docker inspect --format '{{.State.Health.Status}}' $(docker compose ps -q)`
   should show `healthy` within about 30 s.
7. **Dry run.** Use 3 browser windows (or a phone): create, join, draw, reveal,
   refresh one participant, then click **End session**. Ended sessions don't count
   toward the limit of 20 sessions at once.

### "Copy link" on plain HTTP

Browsers only allow the modern clipboard API on HTTPS or `localhost`. On
`http://<ip>:81` the app falls back to an older method. If a browser still refuses,
the link is also shown in a field under the session code: tap it and copy by hand.

## Configuration

Publishing options are read from the shell, or from a `.env` file next to
`docker-compose.yml`:

| Variable | Default | Meaning |
|---|---|---|
| `HOST_PORT` | `81` | Published port. `./start.sh <port>` sets it. |
| `HOST_BIND` | `0.0.0.0` | Host address to publish on. Use `127.0.0.1` behind a local reverse proxy. |

App settings go under `environment:` in `docker-compose.yml`:

| Variable | Default | Meaning |
|---|---|---|
| `SESSION_TTL_MIN` | `120` | Session lifetime in minutes |
| `MAX_SESSIONS` | `20` | Sessions that can exist at once |
| `MAX_PARTICIPANTS` | `50` | Per session, host included |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

The logs never contain names, fun facts, tokens or assignments.

## Development

Requires Node 24.

```bash
npm install
npm start                          # http://localhost:3000
npm test                           # unit and integration tests (~3 s)
npm run test:e2e                   # browser tests (Playwright; needs Chromium or Chrome)
docker build --target test .       # run the test suite inside Docker
```

Design and technical details are in [`plan.md`](plan.md) and
[`plan-impl.md`](plan-impl.md).
