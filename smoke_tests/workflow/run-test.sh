#!/bin/bash

# Automated runner for the workflow engine smoke test
#
# Uses the test harness CLI for message seeding (via setup.sh),
# completion polling, and validation (via validate.sh).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Resolve CLI -- available after setup.sh installs deps
HARNESS_ROOT="$(cd ../.. && pwd)"
CLI="npx --prefix developer/agent tsx ${HARNESS_ROOT}/scripts/smoke-test-cli.ts"

echo "================================================================"
echo "WORKFLOW ENGINE SMOKE TEST"
echo "================================================================"
echo ""
echo "This test verifies that the workflow engine correctly:"
echo "  1. Loads a workflow definition from config"
echo "  2. Classifies a packed WorkflowAssignment message"
echo "  3. Injects workflow prompt context into work items"
echo "  4. Fires state transition on completion"
echo "  5. Routes completion message to manager mailbox"
echo ""

# Step 1: Setup (seeds messages via harness CLI)
echo "Step 1: Running setup..."
./setup.sh
echo ""

# Step 2: Build TypeScript
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

# Step 3: Start agent in background
echo "Step 3: Starting developer agent..."
cd developer/agent
nohup node dist/index.js config.json > ../../test.log 2>&1 &
AGENT_PID=$!
cd ../..

# Ensure agent is killed on script exit
cleanup() {
  if [ -n "$AGENT_PID" ] && ps -p $AGENT_PID > /dev/null 2>&1; then
    kill $AGENT_PID 2>/dev/null || true
    sleep 1
    kill -9 $AGENT_PID 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "Agent started (PID: $AGENT_PID)"
echo ""

# Step 4: Wait for workflow engine to load
echo "Waiting for workflow engine to initialize..."
INIT_WAIT=30
INIT_START=$(date +%s)
ENGINE_LOADED=false

while [ $(($(date +%s) - INIT_START)) -lt $INIT_WAIT ]; do
  RESULT=$($CLI check-log-event --file test.log --event workflow_loaded 2>/dev/null) || true
  FOUND=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('found','false'))" 2>/dev/null) || FOUND="false"
  if [ "$FOUND" = "True" ] || [ "$FOUND" = "true" ]; then
    ENGINE_LOADED=true
    break
  fi
  # Check for crash
  if ! ps -p $AGENT_PID > /dev/null 2>&1; then
    echo "FATAL: Agent process died during initialization"
    echo "Last 20 lines of log:"
    tail -20 test.log 2>/dev/null
    exit 1
  fi
  sleep 2
done

if [ "$ENGINE_LOADED" = true ]; then
  echo "  Workflow engine loaded"
else
  echo "  WARNING: Workflow engine may not have loaded (continuing anyway)"
fi
echo ""

# Step 5: Poll for completion (max 5 minutes)
echo "Waiting for workflow processing (max 5 minutes)..."
echo ""

MAX_WAIT=300
START_TIME=$(date +%s)
COMPLETED=false

while [ $(($(date +%s) - START_TIME)) -lt $MAX_WAIT ]; do
  # Check if agent is still running
  if ! ps -p $AGENT_PID > /dev/null 2>&1; then
    echo "  Agent process stopped"
    break
  fi

  # Check for completion: manager mailbox has messages
  DELIVERY=$($CLI check-delivery --base developer/runtime_mailbox --agent smoke-wf-mgr --role manager --queue normal 2>/dev/null) || true
  DELIVERY_P=$($CLI check-delivery --base developer/runtime_mailbox --agent smoke-wf-mgr --role manager --queue priority 2>/dev/null) || true
  MGR_NORMAL=$(echo "$DELIVERY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('count',0))" 2>/dev/null) || MGR_NORMAL=0
  MGR_PRIORITY=$(echo "$DELIVERY_P" | python3 -c "import sys,json; print(json.load(sys.stdin).get('count',0))" 2>/dev/null) || MGR_PRIORITY=0
  MGR_TOTAL=$((MGR_NORMAL + MGR_PRIORITY))

  if [ "$MGR_TOTAL" -gt 0 ]; then
    COMPLETED=true
    echo "  Completion message detected in manager mailbox"
    break
  fi

  # Also check for terminal state log
  TERM=$($CLI check-log-event --file test.log --event workflow_terminal 2>/dev/null) || true
  TERM_FOUND=$(echo "$TERM" | python3 -c "import sys,json; print(json.load(sys.stdin).get('found','false'))" 2>/dev/null) || TERM_FOUND="false"
  if [ "$TERM_FOUND" = "True" ] || [ "$TERM_FOUND" = "true" ]; then
    COMPLETED=true
    echo "  Workflow reached terminal state"
    break
  fi

  # Show progress using harness event checks
  ELAPSED=$(($(date +%s) - START_TIME))
  RECV=$($CLI check-log-event --file test.log --event workflow_assignment_received 2>/dev/null) || true
  RECV_FOUND=$(echo "$RECV" | python3 -c "import sys,json; print(json.load(sys.stdin).get('found','false'))" 2>/dev/null) || RECV_FOUND="false"

  if [ "$RECV_FOUND" = "True" ] || [ "$RECV_FOUND" = "true" ]; then
    ACT=$($CLI check-log-event --file test.log --event workflow_task_activated 2>/dev/null) || true
    ACT_FOUND=$(echo "$ACT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('found','false'))" 2>/dev/null) || ACT_FOUND="false"
    if [ "$ACT_FOUND" = "True" ] || [ "$ACT_FOUND" = "true" ]; then
      WI=$($CLI check-log-event --file test.log --event work_item_completed 2>/dev/null) || true
      WI_COUNT=$(echo "$WI" | python3 -c "import sys,json; print(json.load(sys.stdin).get('count',0))" 2>/dev/null) || WI_COUNT=0
      echo "  [${ELAPSED}s] Workflow active, work items completed: $WI_COUNT"
    else
      echo "  [${ELAPSED}s] Workflow assignment received, activating..."
    fi
  else
    echo "  [${ELAPSED}s] Waiting for agent to pick up mailbox message..."
  fi

  sleep 10
done

echo ""

if [ "$COMPLETED" = true ]; then
  echo "Workflow processing completed"
else
  ELAPSED=$(($(date +%s) - START_TIME))
  echo "Timeout reached after ${ELAPSED}s"
  echo "The agent may still be processing -- running validation anyway"
fi

# Give the agent a moment to flush logs
sleep 3

# Step 6: Validate
echo ""
echo "================================================================"
echo "VALIDATION"
echo "================================================================"
echo ""

./validate.sh
RESULT=$?

# Step 7: Cleanup
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
  echo "SUCCESS -- WORKFLOW ENGINE IS WORKING"
  echo ""
  echo "What this proves:"
  echo "  - workflowFile config loads workflow definition"
  echo "  - Packed WorkflowAssignment messages classified correctly"
  echo "  - Workflow prompt context injected into work items"
  echo "  - State machine transition fires on completion"
  echo "  - Completion message routed via mailbox"
  echo ""
  echo "The workflow engine is safe to use in production agents."
else
  echo "FAILURE -- WORKFLOW ENGINE NEEDS INVESTIGATION"
  echo ""
  echo "Check test.log for details:"
  echo "  tail -100 $SCRIPT_DIR/test.log"
  echo ""
  echo "Common issues:"
  echo "  - workflow.json schema mismatch"
  echo "  - WORKFLOW_MSG envelope malformed in seed message"
  echo "  - Agent timeout before completing work items"
fi
echo "================================================================"
echo ""
echo "Test artifacts: $SCRIPT_DIR"
echo "  - test.log"
echo "  - developer/runtime_mailbox/mailbox/to_smoke-wf-mgr_manager/"
echo "  - developer/agent/workspace/"
echo ""

exit $RESULT
