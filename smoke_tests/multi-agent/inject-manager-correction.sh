#!/bin/bash
# Inject HIGH priority manager correction using the test harness CLI
#
# Uses the same message creation code the agent uses at runtime.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

HARNESS_ROOT="$(cd ../.. && pwd)"
CLI="npx --prefix developer/agent tsx ${HARNESS_ROOT}/scripts/smoke-test-cli.ts"

echo "Injecting HIGH priority manager correction..."

$CLI create-message \
  --base developer/runtime_mailbox --agent smoke-test-dev --role developer --queue priority \
  --from "smoke-test-mgr_manager" \
  --to "smoke-test-dev_developer" \
  --subject "Correction - Function Naming" \
  --body "URGENT CORRECTION: I noticed an error in Task 2 requirements. The multiply function should be named multiplyNumbers (not just multiply). Please update math-utils.js to use the correct function name before continuing with Task 3. This ensures naming consistency across the project." \
  --priority HIGH \
  --filename "correction_function_naming.md"

echo "HIGH priority message injected!"
echo ""
echo "The developer agent will:"
echo "  1. Detect HIGH priority message on next check (~5 seconds)"
echo "  2. INTERRUPT current work queue"
echo "  3. Process the correction immediately"
echo "  4. Resume normal work queue after priority handled"
