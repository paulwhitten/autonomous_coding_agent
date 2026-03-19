#!/bin/bash

# Automated runner for the WIP limit smoke test
#
# Phases:
#   1. Setup: seed 2 task messages in manager mailbox
#   2. Build: compile TypeScript
#   3. Run: start manager agent, wait for it to delegate both tasks
#   4. Observe: check developer mailbox for delegated messages
#   5. Inject: place simulated completion messages in manager mailbox
#   6. Wait: let manager process completions and free WIP slots
#   7. Validate: run validation checks

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

HARNESS_ROOT="$(cd ../.. && pwd)"
CLI="npx --prefix manager/agent tsx ${HARNESS_ROOT}/scripts/smoke-test-cli.ts"

echo "================================================================"
echo "WIP LIMIT SMOKE TEST (wipLimit=2)"
echo "================================================================"
echo ""
echo "This test verifies the manager's WIP gate:"
echo "  1. Delegates up to wipLimit concurrent tasks"
echo "  2. Blocks when WIP limit reached"
echo "  3. Frees slots when completion messages arrive"
echo ""

# Step 1: Setup
echo "Step 1: Running setup..."
./setup.sh
echo ""

# Step 2: Build
echo "Step 2: Building agent code..."
cd manager/agent
npx tsc
if [ $? -ne 0 ]; then
  echo "FATAL: TypeScript compilation failed"
  exit 1
fi
cd ../..
echo "Agent code compiled"
echo ""

# Step 3: Start manager agent
echo "Step 3: Starting manager agent..."
cd manager/agent
nohup node dist/index.js config.json > ../../test.log 2>&1 &
AGENT_PID=$!
cd ../..

cleanup() {
  if [ -n "$AGENT_PID" ] && ps -p $AGENT_PID > /dev/null 2>&1; then
    kill $AGENT_PID 2>/dev/null || true
    sleep 1
    kill -9 $AGENT_PID 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "Manager agent started (PID: $AGENT_PID)"
echo ""

# Step 4: Wait for manager to process messages and delegate
echo "Step 4: Waiting for manager to delegate tasks (max 5 minutes)..."
MAX_WAIT=300
START_TIME=$(date +%s)
DELEGATED_COUNT=0

while [ $(($(date +%s) - START_TIME)) -lt $MAX_WAIT ]; do
  # Check if agent is still running
  if ! ps -p $AGENT_PID > /dev/null 2>&1; then
    echo "  WARNING: Agent process stopped early"
    break
  fi

  # Count messages in developer mailbox (delegated tasks)
  DEV_NORMAL=$($CLI check-delivery --base manager/runtime_mailbox --agent smoke-wip-dev --role developer --queue normal 2>/dev/null) || true
  DEV_COUNT=$(echo "$DEV_NORMAL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('count',0))" 2>/dev/null) || DEV_COUNT=0

  ELAPSED=$(($(date +%s) - START_TIME))

  if [ "$DEV_COUNT" -ge 2 ]; then
    DELEGATED_COUNT=$DEV_COUNT
    echo "  [${ELAPSED}s] Developer mailbox has $DEV_COUNT messages -- both tasks delegated"
    break
  elif [ "$DEV_COUNT" -ge 1 ]; then
    echo "  [${ELAPSED}s] Developer mailbox has $DEV_COUNT message(s) -- waiting for second delegation..."
  else
    echo "  [${ELAPSED}s] Developer mailbox empty -- waiting for manager to delegate..."
  fi

  sleep 10
done

if [ "$DELEGATED_COUNT" -lt 1 ]; then
  echo ""
  echo "WARNING: Manager did not delegate any tasks within timeout"
  echo "Checking logs for errors..."
  tail -30 test.log 2>/dev/null || true
fi

echo ""

# Step 5: Check for WIP gate activation
echo "Step 5: Checking WIP gate behavior..."

# Check if WIP limit was reached (logged when gate blocks)
WIP_LOG=$(grep -c "WIP limit reached" test.log 2>/dev/null) || WIP_LOG=0
INFLIGHT_LOG=$(grep -c "Recorded in-flight delegation" test.log 2>/dev/null) || INFLIGHT_LOG=0

echo "  In-flight delegations recorded: $INFLIGHT_LOG"
echo "  WIP limit reached events: $WIP_LOG"
echo ""

# Step 6: Inject simulated completion messages
echo "Step 6: Injecting completion messages into manager mailbox..."

# Create completion message 1
$CLI create-message \
  --base manager/runtime_mailbox --agent smoke-wip-mgr --role manager --queue normal \
  --from "smoke-wip-dev_developer" \
  --to "smoke-wip-mgr_manager" \
  --subject "[Workflow Complete] Task 1: Create constants module" \
  --body "Phase completed successfully.

Assignment completed.

**Summary:**
- Total work items: 1
- Completed: 1
- Status: All items completed

**Work completed:**
Created crates/protocol-core/src/constants.rs with protocol constants.
cargo build and cargo test pass." \
  --filename "completion_task1.md"

echo "  Injected completion for Task 1"

# Create completion message 2
$CLI create-message \
  --base manager/runtime_mailbox --agent smoke-wip-mgr --role manager --queue normal \
  --from "smoke-wip-dev_developer" \
  --to "smoke-wip-mgr_manager" \
  --subject "[Workflow Complete] Task 2: Create error types" \
  --body "Phase completed successfully.

Assignment completed.

**Summary:**
- Total work items: 1
- Completed: 1
- Status: All items completed

**Work completed:**
Created crates/protocol-core/src/error.rs with ProtocolError enum.
cargo build and cargo test pass." \
  --filename "completion_task2.md"

echo "  Injected completion for Task 2"
echo ""

# Step 7: Wait for manager to process completions
echo "Step 7: Waiting for manager to process completions (max 2 minutes)..."
COMP_WAIT=120
COMP_START=$(date +%s)

while [ $(($(date +%s) - COMP_START)) -lt $COMP_WAIT ]; do
  if ! ps -p $AGENT_PID > /dev/null 2>&1; then
    echo "  Agent process stopped"
    break
  fi

  CLEARED=$(grep -c "Cleared in-flight delegation" test.log 2>/dev/null) || CLEARED=0
  ELAPSED=$(($(date +%s) - COMP_START))

  if [ "$CLEARED" -ge 2 ]; then
    echo "  [${ELAPSED}s] Both WIP slots cleared"
    break
  elif [ "$CLEARED" -ge 1 ]; then
    echo "  [${ELAPSED}s] $CLEARED WIP slot(s) cleared -- waiting for second..."
  else
    echo "  [${ELAPSED}s] Waiting for completion processing..."
  fi

  sleep 10
done

# Give agent time to flush logs
sleep 3

echo ""

# Step 8: Validate
echo "================================================================"
echo "VALIDATION"
echo "================================================================"
echo ""

./validate.sh
RESULT=$?

# Step 9: Cleanup
echo ""
echo "Cleaning up..."
if ps -p $AGENT_PID > /dev/null 2>&1; then
  kill $AGENT_PID 2>/dev/null || true
  sleep 2
  if ps -p $AGENT_PID > /dev/null 2>&1; then
    kill -9 $AGENT_PID 2>/dev/null || true
  fi
  echo "Agent stopped"
else
  echo "Agent already stopped"
fi

# Final report
echo ""
echo "================================================================"
if [ $RESULT -eq 0 ]; then
  echo "SUCCESS -- WIP LIMIT GATE IS WORKING"
  echo ""
  echo "What this proves:"
  echo "  - wipLimit config controls concurrent delegations"
  echo "  - In-flight delegations tracked in session context"
  echo "  - WIP gate blocks when limit reached"
  echo "  - Completion messages free WIP slots"
  echo "  - Watchdog timeout prevents deadlocks"
else
  echo "FAILURE -- WIP LIMIT GATE NEEDS INVESTIGATION"
  echo ""
  echo "Check test.log for details:"
  echo "  tail -100 $SCRIPT_DIR/test.log"
fi
echo "================================================================"
echo ""
echo "Test artifacts: $SCRIPT_DIR"
echo "  - test.log"
echo "  - manager/runtime_mailbox/"
echo "  - manager/agent/workspace/"
echo ""

exit $RESULT
