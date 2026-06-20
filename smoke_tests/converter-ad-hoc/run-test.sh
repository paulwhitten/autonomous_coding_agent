#!/bin/bash
# Runner for ad-hoc smoke test
#
# Tests a single agent processing plain ad-hoc messages (no workflow
# engine, no state machine) to build a TypeScript converter module
# with incremental git commits.

set -eE
trap 'echo "FATAL: run-test.sh failed at line $LINENO (exit $?)" >&2' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

HARNESS_ROOT="$(cd ../.. && pwd)"

echo "================================================================"
echo "AD-HOC SMOKE TEST"
echo "================================================================"
echo ""
echo "This test verifies that the agent can:"
echo "  1. Process ad-hoc messages without a workflow engine"
echo "  2. Create TypeScript source and test files"
echo "  3. Run tests and capture output"
echo "  4. Make incremental git commits per step"
echo "  5. Extend existing code without overwriting it"
echo "  6. Leave a clean working tree"
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
( cd agent && npx tsc ) || {
  echo "FATAL: TypeScript compilation failed"
  exit 1
}
echo "Agent code compiled"
echo ""

# ----------------------------------------------------------------
# Step 3: Start agent
# ----------------------------------------------------------------
echo "Step 3: Starting agent..."
pushd agent > /dev/null
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
# Step 4: Monitor progress
# ----------------------------------------------------------------
echo "Step 4: Waiting for agent to complete (max 10 minutes)..."
echo ""

MAX_WAIT=600
START_TIME=$(date +%s)
COMPLETED=false

while [ $(($(date +%s) - START_TIME)) -lt $MAX_WAIT ]; do
  # Check for crash
  if ! ps -p $AGENT_PID > /dev/null 2>&1; then
    echo "  WARNING: Agent process stopped"
    break
  fi

  if [ -f test.log ]; then
    # Check if the agent has processed both messages and gone idle
    MSG_COMPLETE=$(grep -c "Message.*completed\|processed message\|ad-hoc message handled" test.log 2>/dev/null || echo "0")
    WORK_ITEMS=$(grep -c "Work item completed" test.log 2>/dev/null || echo "0")
    IDLE_COUNT=$(grep -c "No new messages in mailbox" test.log 2>/dev/null || echo "0")

    # Show progress
    COMMIT_COUNT=0
    if [ -d "agent/workspace/project/.git" ]; then
      COMMIT_COUNT=$(cd agent/workspace/project && git log --oneline 2>/dev/null | wc -l | tr -d ' ')
    fi
    ELAPSED=$(($(date +%s) - START_TIME))
    echo "  [${ELAPSED}s] Work items: $WORK_ITEMS | Commits: $COMMIT_COUNT | Idle checks: $IDLE_COUNT"

    # Consider complete if agent has done meaningful work and is now idle
    if [ "$IDLE_COUNT" -ge 2 ] && [ "$WORK_ITEMS" -ge 2 ]; then
      COMPLETED=true
      break
    fi

    # Also consider complete if we see enough git commits
    if [ "$COMMIT_COUNT" -ge 7 ] && [ "$IDLE_COUNT" -ge 1 ]; then
      COMPLETED=true
      break
    fi

    # Fallback: if agent processed messages and has been idle for a while
    if [ "$IDLE_COUNT" -ge 4 ] && [ "$COMMIT_COUNT" -ge 3 ]; then
      COMPLETED=true
      break
    fi
  fi

  sleep 10
done

echo ""
if [ "$COMPLETED" = true ]; then
  echo "Agent finished processing"
else
  echo "Timeout reached — validating what was completed"
fi

# Stop agent
if ps -p $AGENT_PID > /dev/null 2>&1; then
  kill $AGENT_PID 2>/dev/null || true
  sleep 2
  kill -9 $AGENT_PID 2>/dev/null || true
  echo "Agent stopped"
fi

echo ""

# ----------------------------------------------------------------
# Step 5: Validate
# ----------------------------------------------------------------
echo "================================================================"
echo "VALIDATION"
echo "================================================================"
echo ""

./validate.sh
RESULT=$?

echo ""
echo "================================================================"
if [ $RESULT -eq 0 ]; then
  echo "AD-HOC SMOKE TEST: PASSED"
else
  echo "AD-HOC SMOKE TEST: FAILED"
fi
echo "================================================================"
echo ""
echo "Test artifacts:"
echo "  - test.log (agent execution log)"
echo "  - agent/workspace/project/ (project with git history)"
echo ""

# Run LLM judge (non-blocking — does not affect test exit code)
# Grade against the ad-hoc task specification rather than the generic
# role-based copilot-instructions.md the agent runtime generates.
export JUDGE_INSTRUCTIONS="$SCRIPT_DIR/judge-instructions.md"
source "$SCRIPT_DIR/../judge/run-judge.sh"
run_judge "$SCRIPT_DIR"

exit $RESULT
