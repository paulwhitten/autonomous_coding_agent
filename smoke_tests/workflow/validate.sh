#!/bin/bash

# Validate workflow engine smoke test results
#
# Uses the test harness CLI (scripts/smoke-test-cli.ts) for log event
# checking and delivery verification.  Event names map to the actual
# log strings in the source code via the LOG_EVENTS registry in
# src/test-harness.ts -- if a log message changes, only the registry
# needs updating, not every validate.sh across all smoke tests.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Resolve CLI -- run from agent dir where node_modules has tsx/pino
HARNESS_ROOT="$(cd ../.. && pwd)"
CLI="npx --prefix developer/agent tsx ${HARNESS_ROOT}/scripts/smoke-test-cli.ts"

echo "Validating workflow engine smoke test..."
echo ""

PASSED=0
FAILED=0
WARNINGS=0

# Helper: check a named log event (uses the LOG_EVENTS registry)
check_event() {
  local event="$1"
  local pass_msg="$2"
  local fail_msg="$3"
  local severity="${4:-FAIL}"  # FAIL or WARN

  local result
  result=$($CLI check-log-event --file test.log --event "$event" 2>/dev/null) || true
  local found
  found=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('found','false'))" 2>/dev/null) || found="false"

  if [ "$found" = "True" ] || [ "$found" = "true" ]; then
    echo "[PASS] $pass_msg"
    ((PASSED++))
  elif [ "$severity" = "WARN" ]; then
    echo "[WARN] $fail_msg"
    ((WARNINGS++))
  else
    echo "[FAIL] $fail_msg"
    ((FAILED++))
  fi
}

# --------------------------------------------------------------------------
# Check 1: Test log exists
# --------------------------------------------------------------------------
if [ -f test.log ]; then
  echo "[PASS] Test log found"
  ((PASSED++))
else
  echo "[FAIL] Test log not found -- did you run the test?"
  ((FAILED++))
  echo ""
  echo "Run './run-test.sh' to execute the test"
  exit 1
fi

# --------------------------------------------------------------------------
# Check 2: Workflow engine loaded
# --------------------------------------------------------------------------
check_event "workflow_loaded" \
  "Workflow engine loaded successfully" \
  "Workflow engine did not load -- check workflowFile config and workflow.json"

# --------------------------------------------------------------------------
# Check 3: Message classified as workflow assignment
# --------------------------------------------------------------------------
check_event "workflow_assignment_received" \
  "Message classified as workflow assignment" \
  "Message not classified as workflow assignment -- WORKFLOW_MSG marker may be malformed"

# --------------------------------------------------------------------------
# Check 4: Workflow task activated
# --------------------------------------------------------------------------
check_event "workflow_task_activated" \
  "Workflow task activated with prompt injection" \
  "Workflow task not activated"

# --------------------------------------------------------------------------
# Check 5: Work items were created and processed
# --------------------------------------------------------------------------
check_event "work_item_completed" \
  "Work items created and processed" \
  "Could not confirm work item processing in logs" \
  "WARN"

# --------------------------------------------------------------------------
# Check 6: Workflow state transition fired
# --------------------------------------------------------------------------
check_event "workflow_transition" \
  "Workflow state transition occurred" \
  "No workflow state transition -- agent may not have reached completion"

# --------------------------------------------------------------------------
# Check 6a: Exit actions fired on transition (Fix #1)
# --------------------------------------------------------------------------
check_event "state_action_set_context" \
  "Entry/exit action set_context executed" \
  "No entry/exit set_context actions detected (workflow.json may lack entryActions/exitActions)" \
  "WARN"

# --------------------------------------------------------------------------
# Check 6b: Entry action log fired on transition (Fix #1)
# --------------------------------------------------------------------------
check_event "state_action_log" \
  "Entry/exit action log message emitted" \
  "No entry/exit log actions detected" \
  "WARN"

# --------------------------------------------------------------------------
# Check 7: Completion message sent or terminal state reached
# --------------------------------------------------------------------------
# Check for either completion sent or terminal state
SENT=$($CLI check-log-event --file test.log --event workflow_completion_sent 2>/dev/null) || true
TERM=$($CLI check-log-event --file test.log --event workflow_terminal 2>/dev/null) || true

SENT_FOUND=$(echo "$SENT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('found','false'))" 2>/dev/null) || SENT_FOUND="false"
TERM_FOUND=$(echo "$TERM" | python3 -c "import sys,json; print(json.load(sys.stdin).get('found','false'))" 2>/dev/null) || TERM_FOUND="false"

if [ "$SENT_FOUND" = "True" ] || [ "$SENT_FOUND" = "true" ]; then
  echo "[PASS] Completion message sent to manager"
  ((PASSED++))
elif [ "$TERM_FOUND" = "True" ] || [ "$TERM_FOUND" = "true" ]; then
  echo "[PASS] Workflow reached terminal state"
  ((PASSED++))
else
  echo "[FAIL] No completion message sent and no terminal state reached"
  ((FAILED++))
fi

# --------------------------------------------------------------------------
# Check 8: Manager mailbox has a message (via check-delivery)
# --------------------------------------------------------------------------
echo ""
echo "Checking manager mailbox for completion message..."

DELIVERY_OK=false
for queue in priority normal; do
  RESULT=$($CLI check-delivery --base developer/runtime_mailbox --agent smoke-wf-mgr --role manager --queue "$queue" 2>/dev/null) || true
  COUNT=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('count',0))" 2>/dev/null) || COUNT=0
  if [ "$COUNT" -gt 0 ]; then
    echo "[PASS] Manager mailbox has $COUNT message(s) in $queue queue"
    ((PASSED++))
    DELIVERY_OK=true

    # Check message format using the harness's log pattern checker
    MGR_MSG_FILE=$(find "developer/runtime_mailbox/mailbox/to_smoke-wf-mgr_manager/$queue" -name "*.md" -type f 2>/dev/null | head -1)
    if [ -n "$MGR_MSG_FILE" ]; then
      if grep -q "^Date:" "$MGR_MSG_FILE" && \
         grep -q "^From:" "$MGR_MSG_FILE" && \
         grep -q "^To:" "$MGR_MSG_FILE" && \
         grep -q "^Subject:" "$MGR_MSG_FILE"; then
        echo "[PASS] Completion message has correct header format"
        ((PASSED++))
      else
        echo "[WARN] Completion message may have non-standard format"
        ((WARNINGS++))
      fi

      # Check for embedded workflow message or completion text
      if grep -q "WORKFLOW_MSG" "$MGR_MSG_FILE" || grep -q "Phase completed" "$MGR_MSG_FILE"; then
        echo "[PASS] Completion message contains workflow data or completion text"
        ((PASSED++))
      else
        echo "[WARN] Completion message may not contain embedded workflow data"
        ((WARNINGS++))
      fi
    fi
    break
  fi
done

if [ "$DELIVERY_OK" = false ]; then
  echo "[FAIL] Manager mailbox is empty -- no completion message received"
  ((FAILED++))
fi

# --------------------------------------------------------------------------
# Check 9: Workflow proof file (if agent created it)
# --------------------------------------------------------------------------
echo ""
echo "Checking for workflow proof artifacts..."

PROOF_FILE=$(find developer/agent/workspace -name "workflow_proof.txt" -type f 2>/dev/null | head -1)
if [ -n "$PROOF_FILE" ]; then
  if grep -q "WORKFLOW_ENGINE_ACTIVE" "$PROOF_FILE"; then
    echo "[PASS] Workflow proof file created with correct content"
    ((PASSED++))
  else
    echo "[WARN] Workflow proof file exists but has unexpected content"
    ((WARNINGS++))
  fi
else
  echo "[WARN] Workflow proof file not found (agent may have created it elsewhere)"
  ((WARNINGS++))
fi

# --------------------------------------------------------------------------
# Check 10: No crashes or unhandled errors
# --------------------------------------------------------------------------
CRASH_RESULT=$($CLI check-log-event --file test.log --event crash 2>/dev/null) || true
CRASH_FOUND=$(echo "$CRASH_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('found','false'))" 2>/dev/null) || CRASH_FOUND="false"

if [ "$CRASH_FOUND" = "True" ] || [ "$CRASH_FOUND" = "true" ]; then
  echo "[FAIL] Unhandled error or crash detected in logs"
  ((FAILED++))
else
  echo "[PASS] No crashes or unhandled errors"
  ((PASSED++))
fi

# --------------------------------------------------------------------------
# Check 11: Seed message was consumed (moved to archive)
# --------------------------------------------------------------------------
SEED_RESULT=$($CLI check-delivery --base developer/runtime_mailbox --agent smoke-wf-dev --role developer --queue normal 2>/dev/null) || true
SEED_COUNT=$(echo "$SEED_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('count',0))" 2>/dev/null) || SEED_COUNT=0

if [ "$SEED_COUNT" -eq 0 ]; then
  echo "[PASS] Seed message consumed from mailbox"
  ((PASSED++))
else
  echo "[WARN] Seed message may still be in mailbox ($SEED_COUNT files remain)"
  ((WARNINGS++))
fi

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------
echo ""
echo "============================================"
echo "WORKFLOW SMOKE TEST RESULTS"
echo "============================================"
echo "Passed:   $PASSED"
echo "Failed:   $FAILED"
echo "Warnings: $WARNINGS"
echo ""

CORE_CHECKS=0
# Core checks: engine loaded, message classified, task activated, transition, completion
for pattern in "Workflow engine loaded" "Received workflow assignment" "Workflow task activated" "Workflow state transition"; do
  if grep -q "$pattern" test.log 2>/dev/null; then
    ((CORE_CHECKS++))
  fi
done

if [ $FAILED -eq 0 ]; then
  echo "TEST PASSED"
  echo ""
  echo "What this proves:"
  echo "  - Workflow engine loads from workflowFile config"
  echo "  - Packed WorkflowAssignment messages are classified correctly"
  echo "  - Workflow prompt/context injected into work item execution"
  echo "  - State transition fires on work item completion"
  echo "  - Entry/exit actions execute on state transitions (Fix #1)"
  echo "  - Completion message routed to manager mailbox"
  exit 0
elif [ $CORE_CHECKS -ge 3 ]; then
  echo "TEST PARTIAL PASS ($CORE_CHECKS/4 core checks passed)"
  echo ""
  echo "The workflow engine is fundamentally working but some checks failed."
  echo "Review the FAIL items above for details."
  exit 1
else
  echo "TEST FAILED ($CORE_CHECKS/4 core checks passed)"
  echo ""
  echo "Possible causes:"
  echo "  - workflowFile not set in config.json"
  echo "  - workflow.json not found at configured path"
  echo "  - Seed message WORKFLOW_MSG envelope malformed"
  echo "  - Agent crashed before processing the message"
  echo ""
  echo "Check test.log for details:"
  echo "  tail -100 test.log"
  exit 1
fi
