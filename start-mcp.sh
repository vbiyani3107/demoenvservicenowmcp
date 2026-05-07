#!/usr/bin/env bash
# Run the MCP stdio server from this repo. Configure secrets via .env (never commit .env).
set -euo pipefail
cd "$(dirname "$0")"
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
exec node src/stdio-server.js
