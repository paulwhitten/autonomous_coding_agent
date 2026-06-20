#!/bin/bash
# Runner for converter-workflow smoke test
#
# Workflow-driven counterpart to converter-ad-hoc. Drives a single
# developer agent through a deterministic state machine that builds the
# SAME converter module. Git commits and Jest runs are performed by the
# workflow engine (onExitCommands), not the LLM.

set -eE
trap 'echo "FATAL: run-test.sh failed at line $LINENO (exit $?)" >&2' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

HARNESS_ROOT="$(cd ../.. && pwd)"
CLI="npx --prefix agent tsx ${HARNESS_ROOT}/scripts/smoke-test-cli.ts"

echo "================================================================"
echo "CONVERTER-WORKFLOW SMOKE TEST"
echo "================================================================"
echo ""
echo "This test verifies that the workflow engine can deterministically:"
echo "  1. Drive one developer agent through a multi-state machine"
echo "  2. Have the LLM write converter source and test code only"
echo "  3. Perform all git commits via onExitCommands"
echo "  4. Run Jest via onExitCommands (gating each transition)"
echo "  5. Produce the SAME artifact as converter-ad-hoc"
echo "  6. Leave a clean working tree with incremental commits"
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
# Step 4: Wait for the workflow engine to load
# ----------------------------------------------------------------
echo "Step 4: Waiting for workflow engine to initialize..."
INIT_WAIT=30
INIT_START=$(date +%s)
ENGINE_LOADED=false
while [ $(($(date +%s) - INIT_START)) -lt $INIT_WAIT ]; do
  if ! ps -p $AGENT_PID > /dev/null 2>&1; then
    echo "FATAL: Agent process died during initialization"
    tail -20 test.log 2>/dev/null
    exit 1
  fi
  RESULT=$($CLI check-log-event --file test.log --event workflow_loaded 2>/dev/null) || true
  FOUND=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('found','false'))" 2>/dev/null) || FOUND="false"
  if [ "$FOUND" = "True" ] || [ "$FOUND" = "true" ]; then
    ENGINE_LOADED=true
    break
  fi
  sleep 2
done
if [ "$ENGINE_LOADED" = true ]; then
  echo "  Workflow engine loaded"
else
  echo "  WARNING: workflow_loaded event not seen (continuing anyway)"
fi
echo ""

# ----------------------------------------------------------------
# Step 5: Monitor progress through the state machine
# ----------------------------------------------------------------
echo "Step 5: Waiting for workflow to reach terminal state (max 12 minutes)..."
echo ""

MAX_WAIT=720
START_TIME=$(date +%s)
COMPLETED=false

while [ $(($(date +%s) - START_TIME)) -lt $MAX_WAIT ]; do
  # Check for crash
  if ! ps -p $AGENT_PID > /dev/null 2>&1; then
    echo "  WARNING: Agent process stopped"
    break
  fi

  if [ -f test.log ]; then
    TRANSITIONS=$(grep -c "Workflow state transition" test.log 2>/dev/null | head -1)
    TRANSITIONS=${TRANSITIONS:-0}
    TERMINAL=$(grep -c "Workflow task reached terminal state" test.log 2>/dev/null | head -1)
    TERMINAL=${TERMINAL:-0}

    COMMIT_COUNT=0
    if [ -d "agent/workspace/project/.git" ]; then
      COMMIT_COUNT=$(cd agent/workspace/project && git log --oneline 2>/dev/null | wc -l | tr -d ' ')
    fi

    ELAPSED=$(($(date +%s) - START_TIME))
    echo "  [${ELAPSED}s] Transitions: $TRANSITIONS | Commits: $COMMIT_COUNT | Terminal: $TERMINAL"

    # Complete when the workflow reaches a terminal state
    if [ "$TERMINAL" -ge 1 ]; then
      COMPLETED=true
      break
    fi
    # Fallback: all expected commits present (1 setup + 7 work commits)
    if [ "$COMMIT_COUNT" -ge 8 ]; then
      COMPLETED=true
      break
    fi
  fi

  sleep 10
done

echo ""
if [ "$COMPLETED" = true ]; then
  echo "Workflow reached terminal state"
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
# Step 6: Validate
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
  echo "CONVERTER-WORKFLOW SMOKE TEST: PASSED"
else
  echo "CONVERTER-WORKFLOW SMOKE TEST: FAILED"
fi
echo "================================================================"
echo ""
echo "Test artifacts:"
echo "  - test.log (agent execution log)"
echo "  - agent/workspace/project/ (project with git history)"
echo ""

# Run LLM judge (non-blocking — does not affect test exit code).
# Grade against the SHARED converter task specification so the score is
# directly comparable to converter-ad-hoc.
export JUDGE_INSTRUCTIONS="$SCRIPT_DIR/judge-instructions.md"
source "$SCRIPT_DIR/../judge/run-judge.sh"
run_judge "$SCRIPT_DIR"

exit $RESULT
