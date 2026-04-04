#!/bin/bash

# Automated runner for the multi-agent priority mailbox smoke test
#
# Removes manual timing by polling for Task 2 output (math-utils.js)
# before injecting the HIGH priority correction.
#
# Phases:
#   1. Setup: seed 3 normal task messages in developer mailbox
#   2. Build: compile TypeScript
#   3. Run: start developer agent
#   4. Watch: poll for math-utils.js creation (Task 2 started)
#   5. Inject: place HIGH priority correction in priority/ queue
#   6. Wait: let agent finish all tasks
#   7. Validate: verify priority handling and correction applied

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

HARNESS_ROOT="$(cd ../.. && pwd)"
CLI="npx --prefix developer/agent tsx ${HARNESS_ROOT}/scripts/smoke-test-cli.ts"

PROJECT_DIR="developer/agent/workspace/project"
LOG_FILE="developer/agent/logs/agent.log"
COMPLETED_DIR="developer/agent/workspace/tasks/completed"
FAILED_DIR="developer/agent/workspace/tasks/failed"

PASS_COUNT=0
FAIL_COUNT=0
TOTAL_CHECKS=0

check() {
  local description="$1"
  local result="$2"
  TOTAL_CHECKS=$((TOTAL_CHECKS + 1))
  if [ "$result" -eq 0 ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "  PASS: $description"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "  FAIL: $description"
  fi
}

echo "================================================================"
echo "MULTI-AGENT PRIORITY MAILBOX SMOKE TEST"
echo "================================================================"
echo ""
echo "Tests that a HIGH priority correction interrupts normal work."
echo ""

# ── Step 1: Setup ──────────────────────────────────────────────────
echo "Step 1: Running setup..."
./setup.sh 2>&1 | tail -3
echo ""

# ── Step 2: Build ──────────────────────────────────────────────────
echo "Step 2: Building agent code..."
cd developer/agent
npx tsc
if [ $? -ne 0 ]; then
  echo "FATAL: TypeScript compilation failed"
  exit 1
fi
cd ../..
echo "Agent code compiled"
echo ""

# ── Step 3: Start developer agent ─────────────────────────────────
echo "Step 3: Starting developer agent..."
cd developer/agent
nohup node dist/index.js config.json > ../../test.log 2>&1 &
AGENT_PID=$!
cd ../..

cleanup() {
  if [ -n "$AGENT_PID" ] && ps -p $AGENT_PID > /dev/null 2>&1; then
    echo ""
    echo "Stopping agent (PID: $AGENT_PID)..."
    kill $AGENT_PID 2>/dev/null || true
    sleep 2
    kill -9 $AGENT_PID 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "Developer agent started (PID: $AGENT_PID)"
echo ""

# ── Step 4: Watch for Task 2 output ───────────────────────────────
echo "Step 4: Waiting for Task 2 to start (math-utils.js creation)..."
MAX_WAIT=300
START_TIME=$(date +%s)
TASK2_DETECTED=0

while [ $(($(date +%s) - START_TIME)) -lt $MAX_WAIT ]; do
  if ! ps -p $AGENT_PID > /dev/null 2>&1; then
    echo "  WARNING: Agent process stopped early"
    break
  fi

  if [ -f "$PROJECT_DIR/math-utils.js" ] || [ -f "$PROJECT_DIR/math-utils.cjs" ] || [ -f "$PROJECT_DIR/math-utils.mjs" ]; then
    ELAPSED=$(($(date +%s) - START_TIME))
    echo "  [${ELAPSED}s] math-utils.js detected -- Task 2 in progress"
    TASK2_DETECTED=1
    break
  fi

  ELAPSED=$(($(date +%s) - START_TIME))
  if [ $((ELAPSED % 15)) -eq 0 ] && [ "$ELAPSED" -gt 0 ]; then
    echo "  [${ELAPSED}s] Waiting for math-utils.js..."
  fi

  sleep 2
done

if [ "$TASK2_DETECTED" -eq 0 ]; then
  echo "WARNING: math-utils.js not created within timeout"
  echo "Continuing with injection anyway..."
fi
echo ""

# ── Step 5: Inject HIGH priority correction ────────────────────────
echo "Step 5: Injecting HIGH priority correction..."
./inject-manager-correction.sh 2>&1 | head -2
INJECT_TIME=$(date +%s)
echo ""

# ── Step 6: Wait for all tasks to complete ─────────────────────────
echo "Step 6: Waiting for agent to complete all tasks..."
MAX_WAIT=300
START_TIME=$(date +%s)
ALL_DONE=0

# We expect 3 normal messages (001, 002, 003). The priority correction gets
# merged into the existing work queue (not tracked as a separate assignment),
# so only 3 completion reports are sent. We also check for 0 pending items
# as a secondary completion signal.
while [ $(($(date +%s) - START_TIME)) -lt $MAX_WAIT ]; do
  if ! ps -p $AGENT_PID > /dev/null 2>&1; then
    echo "  Agent process stopped"
    break
  fi

  # Count completed work items and completion reports
  COMPLETED_COUNT=$(ls "$COMPLETED_DIR" 2>/dev/null | wc -l)
  FAILED_COUNT_DIR=$(ls "$FAILED_DIR" 2>/dev/null | wc -l)
  PENDING_COUNT=$(ls developer/agent/workspace/tasks/pending/ 2>/dev/null | wc -l)
  REPORTS=$(find developer/runtime_mailbox/mailbox/to_smoke-test-mgr_manager -name "*completed*" 2>/dev/null | wc -l)
  # Check for unread messages still in the developer's mailbox queues
  MAILBOX_UNREAD=$(find developer/runtime_mailbox/mailbox/to_smoke-test-dev_developer/normal \
                        developer/runtime_mailbox/mailbox/to_smoke-test-dev_developer/priority \
                   -name "*.md" -type f 2>/dev/null | wc -l)

  ELAPSED=$(($(date +%s) - START_TIME))

  # All done = 3 reports + 0 pending work items + 0 unread mailbox messages
  if [ "$REPORTS" -ge 3 ] && [ "$PENDING_COUNT" -eq 0 ] && [ "$MAILBOX_UNREAD" -eq 0 ] && [ "$COMPLETED_COUNT" -gt 0 ]; then
    echo "  [${ELAPSED}s] All completion reports sent, no pending items, mailbox empty ($COMPLETED_COUNT done, $FAILED_COUNT_DIR failed)"
    ALL_DONE=1
    break
  fi

  if [ $((ELAPSED % 15)) -eq 0 ] && [ "$ELAPSED" -gt 0 ]; then
    echo "  [${ELAPSED}s] Reports: $REPORTS/3, completed: $COMPLETED_COUNT, pending: $PENDING_COUNT, mailbox: $MAILBOX_UNREAD, failed: $FAILED_COUNT_DIR"
  fi

  sleep 5
done

# Give agent a moment to finish logging
sleep 3
echo ""

# ── Step 7: Validate results ──────────────────────────────────────
echo "Step 7: Validating results..."
echo ""

echo "── Task Completion ──"
COMPLETED_COUNT=$(ls "$COMPLETED_DIR" 2>/dev/null | wc -l)
FAILED_COUNT_DIR=$(ls "$FAILED_DIR" 2>/dev/null | wc -l)
check "All tasks completed (got: $COMPLETED_COUNT, failed: $FAILED_COUNT_DIR)" \
  "$([ "$COMPLETED_COUNT" -gt 0 ] && [ "$FAILED_COUNT_DIR" -eq 0 ] && echo 0 || echo 1)"

REPORTS=$(find developer/runtime_mailbox/mailbox/to_smoke-test-mgr_manager -name "*completed*" 2>/dev/null | wc -l)
check "All 3 completion reports sent (got: $REPORTS)" \
  "$([ "$REPORTS" -ge 3 ] && echo 0 || echo 1)"
echo ""

echo "── File Verification ──"
check "hello.js exists" \
  "$([ -f "$PROJECT_DIR/hello.js" ] && echo 0 || echo 1)"

check "math-utils.js exists" \
  "$([ -f "$PROJECT_DIR/math-utils.js" ] && echo 0 || echo 1)"

# Determine which math-utils file to validate (prefer .js, fall back to .cjs)
MATH_UTILS_FILE=""
if [ -f "$PROJECT_DIR/math-utils.js" ]; then
  MATH_UTILS_FILE="$PROJECT_DIR/math-utils.js"
elif [ -f "$PROJECT_DIR/math-utils.cjs" ]; then
  MATH_UTILS_FILE="$PROJECT_DIR/math-utils.cjs"
fi

# The correction renamed multiply -> multiplyNumbers
if [ -n "$MATH_UTILS_FILE" ]; then
  HAS_MULTIPLY_NUMBERS=$(grep -c "multiplyNumbers" "$MATH_UTILS_FILE" 2>/dev/null) || HAS_MULTIPLY_NUMBERS=0
  HAS_OLD_MULTIPLY=$(grep -c "multiply" "$MATH_UTILS_FILE" 2>/dev/null) || HAS_OLD_MULTIPLY=0
  # multiplyNumbers contains "multiply" so subtract
  ONLY_OLD=$((HAS_OLD_MULTIPLY - HAS_MULTIPLY_NUMBERS))

  check "Correction applied: multiplyNumbers exported (found: $HAS_MULTIPLY_NUMBERS)" \
    "$([ "$HAS_MULTIPLY_NUMBERS" -gt 0 ] && echo 0 || echo 1)"

  check "Old multiply name removed (residual references: $ONLY_OLD)" \
    "$([ "$ONLY_OLD" -le 0 ] && echo 0 || echo 1)"

  # Functional check
  # Node.js v24+ treats .js as ESM when no package.json exists.
  # Ensure a CommonJS package.json for the require() test.
  if command -v node > /dev/null 2>&1; then
    cd "$PROJECT_DIR"
    if [ ! -f package.json ]; then
      echo '{"type":"commonjs"}' > package.json
    fi
    REQUIRE_NAME=$(basename "$MATH_UTILS_FILE" | sed 's/\.\(js\|cjs\)$//')
    RESULT=$(node -e "const m = require('./$REQUIRE_NAME'); console.log(m.multiplyNumbers(4,5))" 2>&1) || RESULT="ERROR"
    cd - > /dev/null
    check "multiplyNumbers(4,5) returns 20 (got: $RESULT)" \
      "$([ "$RESULT" = "20" ] && echo 0 || echo 1)"
  fi
fi
echo ""

echo "── Priority Handling ──"
# Check that the correction was processed via priority path
PRIORITY_LOG=$(grep -c "HIGH priority message" "$LOG_FILE" 2>/dev/null) || PRIORITY_LOG=0
check "Agent detected HIGH priority message (log entries: $PRIORITY_LOG)" \
  "$([ "$PRIORITY_LOG" -gt 0 ] && echo 0 || echo 1)"

# Check that correction work items exist in completed
CORRECTION_ITEMS=$(ls "$COMPLETED_DIR" 2>/dev/null | grep -c "^004_\|correction\|rename\|multiplyNumbers" 2>/dev/null) || CORRECTION_ITEMS=0
check "Correction work items completed (found: $CORRECTION_ITEMS)" \
  "$([ "$CORRECTION_ITEMS" -gt 0 ] && echo 0 || echo 1)"
echo ""

echo "── README (Task 3) ──"
if [ -f "$PROJECT_DIR/README.md" ]; then
  check "README.md exists" 0
  HAS_MULTIPLY_REF=$(grep -ci "multiplyNumbers" "$PROJECT_DIR/README.md" 2>/dev/null) || HAS_MULTIPLY_REF=0
  check "README references multiplyNumbers (mentions: $HAS_MULTIPLY_REF)" \
    "$([ "$HAS_MULTIPLY_REF" -gt 0 ] && echo 0 || echo 1)"
else
  check "README.md exists" 1
fi
echo ""

# ── Summary ────────────────────────────────────────────────────────
echo "================================================================"
echo "RESULTS: $PASS_COUNT/$TOTAL_CHECKS passed, $FAIL_COUNT failed"
echo "================================================================"

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo ""
  echo "Test log tail:"
  tail -20 test.log 2>/dev/null || true
  exit 1
fi

exit 0
