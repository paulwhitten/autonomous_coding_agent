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
  --body "URGENT CORRECTION: The multiply function in math-utils.js must be renamed to multiplyNumbers for naming consistency. Do NOT split into .cjs/.mjs files -- keep the single math-utils.js file. Requirements: 1. Open math-utils.js and rename the function from multiply to multiplyNumbers. 2. Update module.exports to export multiplyNumbers instead of multiply. 3. Verify: node -e 'const m = require(\"./math-utils\"); console.log(m.multiplyNumbers(4,5))' prints 20. Acceptance Criteria: math-utils.js still exists as a single CommonJS file; exports add and multiplyNumbers (not multiply); multiplyNumbers(4,5) returns 20. Apply this fix before continuing with Task 3 (README)." \
  --priority HIGH \
  --filename "correction_function_naming.md"

echo "HIGH priority message injected!"
echo ""
echo "The developer agent will:"
echo "  1. Detect HIGH priority message on next check (~5 seconds)"
echo "  2. INTERRUPT current work queue"
echo "  3. Process the correction immediately"
echo "  4. Resume normal work queue after priority handled"
