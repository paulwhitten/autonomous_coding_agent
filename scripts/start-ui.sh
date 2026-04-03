#!/usr/bin/env bash
# Start the Web UI — launches both the API server and the Vite dev server.
# Usage: ./scripts/start-ui.sh
#
# Environment variables:
#   API_PORT  — API server port (default: 3001)
#   API_KEY   — Optional API key for authentication

set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ROOT="$(pwd)"

echo "=== Autonomous Coding Agent — Web UI ==="
echo ""
echo "  API server:  http://localhost:${API_PORT:-3001}"
echo "  Web UI:      http://localhost:5173"
echo "  Swagger:     http://localhost:${API_PORT:-3001}/api-docs"
echo ""

# Install web dependencies if needed
if [ ! -d web/node_modules ]; then
  echo "[setup] Installing web dependencies..."
  (cd web && npm install)
fi

cleanup() {
  echo ""
  echo "[shutdown] Stopping servers..."
  kill "$API_PID" "$WEB_PID" 2>/dev/null || true
  wait "$API_PID" "$WEB_PID" 2>/dev/null || true
  echo "[shutdown] Done."
}
trap cleanup EXIT INT TERM

# Start API server
echo "[start] Starting API server..."
npx tsx src/api/index.ts &
API_PID=$!

# Start Vite dev server
echo "[start] Starting Web UI dev server..."
(cd web && npx vite --host) &
WEB_PID=$!

echo "[ready] Both servers running. Press Ctrl+C to stop."
wait
