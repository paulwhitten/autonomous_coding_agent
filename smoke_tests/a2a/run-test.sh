#!/bin/bash
# A2A Backend Integration Smoke Test
#
# Exercises the CommunicationBackend interface end-to-end through two
# A2ABackend instances (manager + developer) exchanging messages over HTTP.
# Verifies inbox/archive persistence for the full message lifecycle.
#
# Requires @a2a-js/sdk and express to be installed.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

HARNESS_ROOT="$(cd ../.. && pwd)"

echo ""
echo "============================================================"
echo "A2A BACKEND INTEGRATION SMOKE TEST"
echo "============================================================"
echo ""

# Ensure root-level dependencies are installed
if [ ! -d "${HARNESS_ROOT}/node_modules" ]; then
  echo "Installing root-level dependencies (first run)..."
  ( cd "${HARNESS_ROOT}" && npm install --silent 2>&1 | tail -5 )
fi

echo "Running backend exchange test..."
echo ""

# Run the TypeScript test directly via tsx from the repo root
cd "${HARNESS_ROOT}"
npx tsx smoke_tests/a2a/backend-exchange.ts

EXIT_CODE=$?
exit $EXIT_CODE
