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
echo "Step 4: Waiting for agent to complete (max 25 minutes)..."
echo ""

MAX_WAIT=1500
START_TIME=$(date +%s)
COMPLETED=false

while [ $(($(date +%s) - START_TIME)) -lt $MAX_WAIT ]; do
  # Check for crash
  if ! ps -p $AGENT_PID > /dev/null 2>&1; then
    echo "  WARNING: Agent process stopped"
    break
  fi

  if [ -f test.log ]; then
    # `grep -c` prints a count and exits non-zero on no match, so `head -1`
    # plus a `:-0` default keeps the value a clean single integer.
    WORK_ITEMS=$(grep -c "Work item completed" test.log 2>/dev/null | head -1)
    WORK_ITEMS=${WORK_ITEMS:-0}
    # The ad-hoc agent logs "No new messages in mailbox" on every poll once it
    # has drained the mailbox. All three assignments are seeded up front, so the
    # mailbox is never empty until every assignment has been processed and its
    # work items committed. The agent does no further work after the mailbox is
    # drained, so this idle line is a sound completion signal. Empirically the
    # first idle poll occurs only after the last assignment's commits land.
    IDLE_COUNT=$(grep -c "No new messages in mailbox" test.log 2>/dev/null | head -1)
    IDLE_COUNT=${IDLE_COUNT:-0}

    COMMIT_COUNT=0
    if [ -d "agent/workspace/project/.git" ]; then
      COMMIT_COUNT=$(cd agent/workspace/project && git log --oneline 2>/dev/null | wc -l | tr -d ' ')
    fi

    ELAPSED=$(($(date +%s) - START_TIME))
    echo "  [${ELAPSED}s] Work items: $WORK_ITEMS | Commits: $COMMIT_COUNT | Idle: $IDLE_COUNT"

    # Complete once the agent has logged two consecutive idle polls. All three
    # messages are seeded together, so a drained mailbox means every assignment
    # was read and processed; requiring two polls guards against any one-off
    # race on the very first idle line.
    if [ "$IDLE_COUNT" -ge 2 ]; then
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

# Give the agent a moment to flush logs
sleep 3

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

# Capture validate.sh's exit code without letting `set -e` abort the script.
# A non-zero result is a test FAIL, not a runner error: we still want to run
# the judge and report below.
RESULT=0
./validate.sh || RESULT=$?

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
