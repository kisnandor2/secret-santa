#!/usr/bin/env bash
# Start the Secret Santa container on port 81.
set -euo pipefail
cd "$(dirname "$0")"
docker compose up -d --build
echo "Secret Santa is running on http://localhost:81/"
