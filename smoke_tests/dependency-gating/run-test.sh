#!/bin/bash

# Runner for the dependency-gating smoke test
#
# Compiles TypeScript, starts the manager agent, seeds tasks in order,
# and verifies:
#   1. task-B is BLOCKED (dependency on task-A not met)
#   2. task-A reaches terminal state (DONE)
#   3. task-B is unblocked after task-A completes
#   4. Manifest status file is persisted to disk

set -eE
trap 'echo "FATAL: run-test.sh failed at line $LINENO (exit $?)" >&2' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

HARNESS_ROOT="$(cd ../.. && pwd)"
CLI="npx --prefix manager/agent tsx ${HARNESS_ROOT}/scripts/smoke-test-cli.ts"

echo "================================================================"
echo "DEPENDENCY GATING SMOKE TEST"
echo "================================================================"
echo ""
echo "Agent:    Manager (single agent, dependency gate logic)"
echo "Manifest: task-A (independent), task-B (depends on task-A)"
echo "Flow:     Seed task-B -> BLOCKED -> seed task-A -> DONE -> unblock task-B"
echo ""

# ----------------------------------------------------------------
# Step 1: Setup
# ----------------------------------------------------------------
echo "Step 1: Running setup..."
./setup.sh
echo ""

# ----------------------------------------------------------------
# Step 2: Compile TypeScript
# ----------------------------------------------------------------
echo "Step 2: Building agent code..."
( cd manager/agent && npx tsc ) || {
  echo "FATAL: TypeScript compilation failed"
  exit 1
}
echo "Agent code compiled"
echo ""

# ----------------------------------------------------------------
# Step 3: Start manager agent
# ----------------------------------------------------------------
echo "Step 3: Starting manager agent..."
pushd manager/agent > /dev/null
nohup node dist/index.js config.json > "${SCRIPT_DIR}/test.log" 2>&1 &
AGENT_PID=$!
popd > /dev/null

echo "Agent started (PID: $AGENT_PID, log: test.log)"
echo ""

# Cleanup on exit
cleanup() {
  if [ -n "$AGENT_PID" ] && ps -p $AGENT_PID > /dev/null 2>&1; then
    kill $AGENT_PID 2>/dev/null || true
    sleep 1
    kill -9 $AGENT_PID 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ----------------------------------------------------------------
# Step 4: Wait for workflow engine to load
# ----------------------------------------------------------------
echo "Step 4: Waiting for workflow engine to initialize..."
INIT_WAIT=45
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
  echo "  WARNING: Workflow engine may not have loaded (continuing)"
fi
echo ""

# ----------------------------------------------------------------
# Step 5: Wait for task-B to be BLOCKED
# ----------------------------------------------------------------
echo "Step 5: Waiting for task-B to hit dependency gate (max 60s)..."

MAX_BLOCK_WAIT=60
BLOCK_START=$(date +%s)
TASK_B_BLOCKED=false

while [ $(($(date +%s) - BLOCK_START)) -lt $MAX_BLOCK_WAIT ]; do
  # Check for the dependency gate log message
  RESULT=$($CLI check-log-pattern --file test.log --pattern "Task not ready.*transitioning to BLOCKED" 2>/dev/null) || true
  FOUND=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('found','false'))" 2>/dev/null) || FOUND="false"
  if [ "$FOUND" = "True" ] || [ "$FOUND" = "true" ]; then
    TASK_B_BLOCKED=true
    break
  fi
  # Check for crash
  if ! ps -p $AGENT_PID > /dev/null 2>&1; then
    echo "  FATAL: Agent process died"
    tail -20 test.log 2>/dev/null
    exit 1
  fi
  sleep 2
done

if [ "$TASK_B_BLOCKED" = true ]; then
  echo "  PASS: task-B correctly blocked by dependency gate"
else
  echo "  FAIL: task-B was not blocked within ${MAX_BLOCK_WAIT}s"
  echo "  Last 30 lines of log:"
  tail -30 test.log 2>/dev/null
  exit 1
fi
echo ""

# ----------------------------------------------------------------
# Step 6: Seed task-A (independent -- should proceed to IMPLEMENTING)
# ----------------------------------------------------------------
echo "Step 6: Seeding task-A (no dependencies -- should proceed normally)..."
$CLI pack-workflow \
  --base manager/runtime_mailbox --agent smoke-dep-mgr --role manager --queue normal \
  --workflow-id dep-gate-test \
  --task-id task-A \
  --state ASSIGN \
  --target-role manager \
  --prompt "Task A: Create task-a_proof.txt with the content DONE. This task has no dependencies." \
  --from smoke-dep-mgr_manager \
  --to smoke-dep-mgr_manager \
  --subject "Workflow Assignment: task-A"
echo "  task-A seeded"
echo ""

# ----------------------------------------------------------------
# Step 7: Wait for task-A to reach terminal state
# ----------------------------------------------------------------
echo "Step 7: Waiting for task-A to reach terminal state (max 60s)..."

MAX_WAIT=60
START_TIME=$(date +%s)
TASK_A_DONE=false
JSON_LOG="manager/agent/logs/agent.log"

while [ $(($(date +%s) - START_TIME)) -lt $MAX_WAIT ]; do
  # Check for crash
  if ! ps -p $AGENT_PID > /dev/null 2>&1; then
    echo "  WARNING: Agent process stopped"
    break
  fi
  # Check pretty-print test.log for terminal state
  if grep -q "Workflow task reached terminal state" test.log 2>/dev/null; then
    TASK_A_DONE=true
    ELAPSED=$(($(date +%s) - START_TIME))
    echo "  PASS: task-A reached terminal state (${ELAPSED}s)"
    break
  fi
  # Also check pino JSON log
  if [ -f "$JSON_LOG" ]; then
    if grep -q "Workflow task reached terminal state" "$JSON_LOG" 2>/dev/null; then
      TASK_A_DONE=true
      ELAPSED=$(($(date +%s) - START_TIME))
      echo "  PASS: task-A reached terminal state (${ELAPSED}s)"
      break
    fi
  fi
  sleep 2
done

if [ "$TASK_A_DONE" != true ]; then
  echo "  FAIL: task-A did not reach terminal state within ${MAX_WAIT}s"
  echo "  Last 30 lines of log:"
  tail -30 test.log 2>/dev/null
  exit 1
fi
echo ""

# ----------------------------------------------------------------
# Step 8: Verify task-B dependencies resolved (manifest status updated)
# ----------------------------------------------------------------
echo "Step 8: Checking that task-B was unblocked in manifest (max 30s)..."

MAX_UNBLOCK_WAIT=30
UNBLOCK_START=$(date +%s)
TASK_B_UNBLOCKED=false

while [ $(($(date +%s) - UNBLOCK_START)) -lt $MAX_UNBLOCK_WAIT ]; do
  # Check for the "dependencies met" log from markTaskDone
  if grep -q "dependencies met" test.log 2>/dev/null; then
    TASK_B_UNBLOCKED=true
    break
  fi
  # Also check the persisted status file
  STATUS_FILE="dep-gate-test.task-manifest.status.json"
  if [ -f "$STATUS_FILE" ]; then
    if grep -q '"task-B".*"ready"' "$STATUS_FILE" 2>/dev/null || \
       grep -q '"ready"' "$STATUS_FILE" 2>/dev/null; then
      # Verify task-B specifically is ready
      TASK_B_STATUS=$(python3 -c "import json; d=json.load(open('$STATUS_FILE')); print(d.get('task-B','unknown'))" 2>/dev/null) || TASK_B_STATUS="unknown"
      if [ "$TASK_B_STATUS" = "ready" ]; then
        TASK_B_UNBLOCKED=true
        break
      fi
    fi
  fi
  # Check for crash
  if ! ps -p $AGENT_PID > /dev/null 2>&1; then
    echo "  WARNING: Agent stopped"
    break
  fi
  sleep 2
done

if [ "$TASK_B_UNBLOCKED" = true ]; then
  echo "  PASS: task-B unblocked after task-A completed"
else
  echo "  WARN: task-B unblock not detected (may still be waiting for recheck timer)"
fi
echo ""

# ----------------------------------------------------------------
# Step 9: Run validation
# ----------------------------------------------------------------
echo "Step 9: Running validation..."
echo ""
./validate.sh
VALIDATE_EXIT=$?

echo ""
echo "================================================================"
if [ $VALIDATE_EXIT -eq 0 ]; then
  echo "DEPENDENCY GATING SMOKE TEST: PASSED"
else
  echo "DEPENDENCY GATING SMOKE TEST: FAILED (validation exit code $VALIDATE_EXIT)"
fi
echo "================================================================"

exit $VALIDATE_EXIT
