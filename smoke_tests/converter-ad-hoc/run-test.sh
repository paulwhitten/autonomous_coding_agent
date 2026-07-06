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
# Route the agent under test to the BYOK (lesser) model. The judge is
# unaffected: byok_disable is called after the agent stops, before judging.
source "$SCRIPT_DIR/../byok-provider.sh"
byok_enable
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
    # The ad-hoc agent logs this once when it has drained the mailbox.
    IDLE_COUNT=$(grep -c "No new messages in mailbox" test.log 2>/dev/null | head -1)
    IDLE_COUNT=${IDLE_COUNT:-0}

    COMMIT_COUNT=0
    if [ -d "agent/workspace/project/.git" ]; then
      COMMIT_COUNT=$(cd agent/workspace/project && git log --oneline 2>/dev/null | wc -l | tr -d ' ')
    fi

    # The README update (assignment 3) is the final deliverable, so detect it
    # directly. Without this guard the earlier commit-count fallback declared
    # completion at 7 commits (1 setup + 3 for msg 1 + 3 for msg 2) and the
    # harness killed the agent before it ever polled for and processed the
    # third message, leaving README.md at its seeded stub.
    README_DONE=false
    if [ -f "agent/workspace/project/README.md" ] && \
       grep -qi "converter\|celsius\|fahrenheit\|miles\|kilometer" "agent/workspace/project/README.md" 2>/dev/null; then
      README_DONE=true
    fi

    ELAPSED=$(($(date +%s) - START_TIME))
    echo "  [${ELAPSED}s] Work items: $WORK_ITEMS | Commits: $COMMIT_COUNT | Idle: $IDLE_COUNT | README: $README_DONE"

    # Require a clean working tree before declaring completion. The three
    # assignment messages are seeded together, so an idle mailbox means all
    # three were read, but the run must not be called complete while changes
    # remain uncommitted (for example a modified test_output.txt or an
    # unfinished README update). A clean tree is the completion signal.
    TREE_CLEAN=false
    if [ -d "agent/workspace/project/.git" ]; then
      if [ -z "$(cd agent/workspace/project && git status --porcelain 2>/dev/null)" ]; then
        TREE_CLEAN=true
      fi
    fi

    # Complete when the agent has drained the mailbox (all three messages
    # read), documented the module (assignment 3), and left a clean tree.
    if [ "$IDLE_COUNT" -ge 1 ] && [ "$README_DONE" = true ] && [ "$TREE_CLEAN" = true ]; then
      COMPLETED=true
      break
    fi
    # Fallback: all expected commits present for the three-message task
    # (1 setup + 3 for msg 1 + 3 for msg 2 + 1 README for msg 3 = 8), with the
    # README documented and a clean tree, so no assignment was left unfinished.
    if [ "$COMMIT_COUNT" -ge 8 ] && [ "$README_DONE" = true ] && [ "$TREE_CLEAN" = true ]; then
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

# Clear BYOK provider env so the LLM judge runs on its strong default model,
# not the lesser assessed model.
byok_disable

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
