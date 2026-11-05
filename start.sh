#!/usr/bin/env bash
# Start the Secret Santa container.
#   ./start.sh       -> port 81
#   ./start.sh 80    -> port 80 (any port works)
set -euo pipefail
cd "$(dirname "$0")"

PORT="${1:-81}"
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1 && PORT <= 65535 )) || { echo "usage: $0 [port]" >&2; exit 1; }

HOST_PORT="$PORT" docker compose up -d --build
echo "Secret Santa is running on http://localhost:${PORT}/"
