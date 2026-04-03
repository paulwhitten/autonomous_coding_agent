#!/bin/bash
# Mailbox Backend Integration Smoke Test
#
# Exercises the CommunicationBackend interface end-to-end through two
# GitMailboxBackend instances (manager + developer) exchanging messages.
#
# No Copilot CLI or network services needed.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

HARNESS_ROOT="$(cd ../.. && pwd)"

echo ""
echo "============================================================"
echo "MAILBOX BACKEND INTEGRATION SMOKE TEST"
echo "============================================================"
echo ""

# Ensure root-level dependencies are installed
if [ ! -d "${HARNESS_ROOT}/node_modules" ]; then
  echo "Installing root-level dependencies (first run)..."
  ( cd "${HARNESS_ROOT}" && npm install --silent 2>&1 | tail -5 )
fi

echo "Running backend exchange test..."
echo ""

cd "${HARNESS_ROOT}"
npx tsx smoke_tests/mailbox-backend/backend-exchange.ts

EXIT_CODE=$?
exit $EXIT_CODE
