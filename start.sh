#!/usr/bin/env bash
# Build, test and start the Secret Santa container on port 81.
#
#   ./start.sh               run the test suite in Docker, then start (default)
#   ./start.sh --skip-tests  start without running the tests first
#   ./start.sh stop          stop and remove the container (all sessions are lost)
#   ./start.sh logs          follow the container logs
set -euo pipefail

cd "$(dirname "$0")"
PORT=81
HEALTH_TIMEOUT_S=60

die() { echo "error: $*" >&2; exit 1; }

command -v docker >/dev/null || die "docker is not installed"
docker compose version >/dev/null 2>&1 || die "docker compose plugin is not available"

case "${1:-}" in
  stop)
    docker compose down
    exit 0
    ;;
  logs)
    exec docker compose logs -f
    ;;
  ""|--skip-tests)
    ;;
  *)
    die "unknown argument '$1' (use --skip-tests, stop or logs)"
    ;;
esac

if [[ "${1:-}" != "--skip-tests" ]]; then
  echo "==> Running tests inside Docker"
  docker build --target test -t secret-santa:test . || die "tests failed; not starting"
  docker rmi secret-santa:test >/dev/null 2>&1 || true
fi

if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${PORT}$" \
  && ! docker compose ps --status running -q 2>/dev/null | grep -q .; then
  die "port ${PORT} is already in use by another process"
fi

echo "==> Building and starting the container"
docker compose up -d --build

echo -n "==> Waiting for the health check"
container="$(docker compose ps -q)"
for ((i = 0; i < HEALTH_TIMEOUT_S; i++)); do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null || echo unknown)"
  [[ "$status" == healthy ]] && break
  echo -n "."
  sleep 1
done
echo

if [[ "$status" != healthy ]]; then
  docker compose logs --tail 30
  die "container did not become healthy within ${HEALTH_TIMEOUT_S}s (status: ${status})"
fi

echo "==> Secret Santa is running"
echo "    Local:   http://localhost:${PORT}/"
# Real interfaces only: docker/VM bridges and veths aren't reachable by colleagues
ip -4 -o addr show scope global 2>/dev/null \
  | awk '$2 !~ /^(docker|br-|virbr|veth)/ { split($4, a, "/"); printf "    Network: http://%s:%s/   (%s)\n", a[1], port, $2 }' port="$PORT" \
  || true
echo "    Stop with: ./start.sh stop   (this ends every session)"
