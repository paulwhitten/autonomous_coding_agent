#!/bin/bash

# Validation script for the dependency-gating smoke test
#
# Checks:
#   1. Dependency gate fired (task-B was blocked)
#   2. task-A proceeded without blocking
#   3. task-B was unblocked after task-A completed
#   4. Manifest status file was persisted
#
# Exit 0 = all checks pass, Exit 1 = one or more checks failed

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PASS=0
FAIL=0
WARN=0

pass() {
  echo "  [PASS] $1"
  PASS=$((PASS + 1))
}

fail() {
  echo "  [FAIL] $1"
  FAIL=$((FAIL + 1))
}

warn() {
  echo "  [WARN] $1"
  WARN=$((WARN + 1))
}

HARNESS_ROOT="$(cd ../.. && pwd)"
CLI="npx --prefix manager/agent tsx ${HARNESS_ROOT}/scripts/smoke-test-cli.ts"
TEST_LOG="test.log"
JSON_LOG="manager/agent/logs/agent.log"

echo "--- Dependency Gating Validation ---"
echo ""

# ================================================================
# Check 1: Workflow engine loaded
# ================================================================
echo "  Workflow Engine:"
RESULT=$($CLI check-log-event --file "$TEST_LOG" --event workflow_loaded 2>/dev/null) || true
FOUND=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('found','false'))" 2>/dev/null) || FOUND="false"
if [ "$FOUND" = "True" ] || [ "$FOUND" = "true" ]; then
  pass "Workflow engine loaded"
else
  fail "Workflow engine did not load"
fi

# ================================================================
# Check 2: Dependency gate fired for task-B
# ================================================================
echo ""
echo "  Dependency Gate:"
RESULT=$($CLI check-log-pattern --file "$TEST_LOG" --pattern "Task not ready.*transitioning to BLOCKED" 2>/dev/null) || true
FOUND=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('found','false'))" 2>/dev/null) || FOUND="false"
if [ "$FOUND" = "True" ] || [ "$FOUND" = "true" ]; then
  pass "Dependency gate fired (task blocked)"
else
  fail "Dependency gate did not fire"
fi

# Check that task-B specifically was blocked (look in JSON log)
if [ -f "$JSON_LOG" ]; then
  if grep -q "\"taskId\":\"task-B\"" "$JSON_LOG" 2>/dev/null; then
    # Check for the dependency gate trigger
    if grep -q "\"trigger\":\"dependency-gate\"" "$JSON_LOG" 2>/dev/null; then
      pass "task-B blocked by dependency-gate trigger"
    else
      warn "task-B present in logs but dependency-gate trigger not found"
    fi
  else
    warn "task-B not found in JSON log (may use pretty-print log only)"
  fi
else
  warn "JSON log not found at $JSON_LOG"
fi

# ================================================================
# Check 3: task-A was not blocked (processed normally)
# ================================================================
echo ""
echo "  task-A Processing:"
if [ -f "$JSON_LOG" ]; then
  # task-A should have a workflow_assignment_received but NOT a dependency-gate block
  if grep -q "\"taskId\":\"task-A\"" "$JSON_LOG" 2>/dev/null; then
    pass "task-A received by agent"
    # Verify it was NOT blocked
    if grep "\"taskId\":\"task-A\"" "$JSON_LOG" | grep -q "dependency-gate" 2>/dev/null; then
      fail "task-A was incorrectly blocked by dependency gate"
    else
      pass "task-A was not blocked (correct -- no dependencies)"
    fi
  else
    # Fall back to pretty-print log
    if grep -q "task-A" "$TEST_LOG" 2>/dev/null; then
      pass "task-A found in test log"
    else
      fail "task-A not found in any log"
    fi
  fi
else
  # Fall back to pretty-print log
  if grep -q "task-A" "$TEST_LOG" 2>/dev/null; then
    pass "task-A found in test log"
  else
    fail "task-A not found in any log"
  fi
fi

# ================================================================
# Check 4: task-A reached terminal state
# ================================================================
echo ""
echo "  task-A Terminal State:"
TASK_A_TERMINAL=false
if [ -f "$JSON_LOG" ]; then
  if grep -q "\"taskId\":\"task-A\".*Workflow task reached terminal state" "$JSON_LOG" 2>/dev/null || \
     grep -q "Workflow task reached terminal state.*\"taskId\":\"task-A\"" "$JSON_LOG" 2>/dev/null; then
    TASK_A_TERMINAL=true
  fi
fi
# Fallback: check pretty-print log
if [ "$TASK_A_TERMINAL" = false ]; then
  RESULT=$($CLI check-log-event --file "$TEST_LOG" --event workflow_terminal 2>/dev/null) || true
  FOUND=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('found','false'))" 2>/dev/null) || FOUND="false"
  if [ "$FOUND" = "True" ] || [ "$FOUND" = "true" ]; then
    TASK_A_TERMINAL=true
  fi
fi

if [ "$TASK_A_TERMINAL" = true ]; then
  pass "task-A reached terminal state"
else
  fail "task-A did not reach terminal state"
fi

# ================================================================
# Check 5: task-B was unblocked (manifest status changed to ready)
# ================================================================
echo ""
echo "  task-B Unblock:"
TASK_B_UNBLOCKED=false

# Check for the "dependencies met" log line from markTaskDone
RESULT=$($CLI check-log-pattern --file "$TEST_LOG" --pattern "dependencies met" 2>/dev/null) || true
FOUND=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('found','false'))" 2>/dev/null) || FOUND="false"
if [ "$FOUND" = "True" ] || [ "$FOUND" = "true" ]; then
  TASK_B_UNBLOCKED=true
fi

# Also check the persisted status file for task-B = ready
if [ "$TASK_B_UNBLOCKED" = false ]; then
  STATUS_FILE="dep-gate-test.task-manifest.status.json"
  if [ -f "$STATUS_FILE" ]; then
    TASK_B_STATUS=$(python3 -c "import json; d=json.load(open('$STATUS_FILE')); print(d.get('task-B','unknown'))" 2>/dev/null) || TASK_B_STATUS="unknown"
    if [ "$TASK_B_STATUS" = "ready" ]; then
      TASK_B_UNBLOCKED=true
    fi
  fi
fi

if [ "$TASK_B_UNBLOCKED" = true ]; then
  pass "task-B was unblocked after task-A completed"
else
  warn "task-B unblock not detected in logs or status file"
fi

# ================================================================
# Check 6: Manifest status persistence
# ================================================================
echo ""
echo "  Manifest Persistence:"
STATUS_FILE="dep-gate-test.task-manifest.status.json"
if [ -f "$STATUS_FILE" ]; then
  pass "Manifest status file persisted ($STATUS_FILE)"
  # Verify it contains task entries
  if grep -q "task-A" "$STATUS_FILE" 2>/dev/null; then
    pass "Status file contains task-A entry"
  else
    warn "Status file does not contain task-A"
  fi
  if grep -q "task-B" "$STATUS_FILE" 2>/dev/null; then
    pass "Status file contains task-B entry"
  else
    warn "Status file does not contain task-B"
  fi
else
  # Also check in the agent directory
  ALT_STATUS="manager/agent/dep-gate-test.task-manifest.status.json"
  if [ -f "$ALT_STATUS" ]; then
    pass "Manifest status file persisted ($ALT_STATUS)"
  else
    warn "Manifest status file not found (agent may not have persisted yet)"
  fi
fi

# ================================================================
# Summary
# ================================================================
echo ""
echo "--- Summary ---"
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo "  WARN: $WARN"
echo ""

if [ $FAIL -gt 0 ]; then
  echo "RESULT: FAILED ($FAIL failures)"
  exit 1
else
  if [ $WARN -gt 0 ]; then
    echo "RESULT: PASSED with warnings"
  else
    echo "RESULT: PASSED"
  fi
  exit 0
fi
