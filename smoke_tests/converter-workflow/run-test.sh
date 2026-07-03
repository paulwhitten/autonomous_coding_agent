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
# Step 5: Serial task execution -- monitor the agent log, seed next task
#
# The three deliverables are three SEPARATE workflow assignments, seeded
# ONE AT A TIME to avoid mailbox interleave on the single developer agent.
# setup.sh already seeded converter-01. We wait for each assignment to
# reach a terminal state (DONE or ESCALATED), then seed the next.
# Serial seeding guarantees only one task is ever in the mailbox, so a
# DEVELOP rework self-loop cannot clobber a later assignment's
# not-yet-committed work.
#
# Task sequence:
#   converter-01 (seeded by setup.sh)         -- create module + tests
#   converter-02 (seeded after 01 terminal)   -- add kilogramsToPounds
#   converter-03 (seeded after 02 terminal)   -- update README
# ----------------------------------------------------------------
echo "Step 5: Serial task execution (max 48 minutes)..."
echo ""

MAX_WAIT=2900
START_TIME=$(date +%s)

# Helper: wait for a taskId to reach a terminal state in the agent log.
# Uses the pino ndjson file log (agent/logs/agent.log) -- test.log is
# pretty-printed and does not carry taskId on the message line.
wait_for_task_done() {
  local TASK_ID=$1
  local TIMEOUT=$2
  local WAIT_START=$(date +%s)
  local JSON_LOG="agent/logs/agent.log"
  echo "  Waiting for ${TASK_ID} to reach terminal state..."
  while [ $(($(date +%s) - WAIT_START)) -lt $TIMEOUT ]; do
    if ! ps -p $AGENT_PID > /dev/null 2>&1; then
      echo "  WARNING: Agent stopped while waiting for ${TASK_ID}"
      return 1
    fi
    if grep -q "\"taskId\":\"${TASK_ID}\".*Workflow task reached terminal state" "$JSON_LOG" 2>/dev/null || \
       grep -q "Workflow task reached terminal state.*\"taskId\":\"${TASK_ID}\"" "$JSON_LOG" 2>/dev/null; then
      local ELAPSED=$(($(date +%s) - WAIT_START))
      echo "  ${TASK_ID} reached terminal state (${ELAPSED}s)"
      return 0
    fi
    local COMMIT_COUNT=0
    if [ -d "agent/workspace/project/.git" ]; then
      COMMIT_COUNT=$(cd agent/workspace/project && git log --oneline 2>/dev/null | wc -l | tr -d ' ')
    fi
    local TE=$(($(date +%s) - START_TIME))
    echo "  [${TE}s] waiting on ${TASK_ID} | commits: ${COMMIT_COUNT}"
    sleep 10
  done
  echo "  TIMEOUT waiting for ${TASK_ID} after ${TIMEOUT}s"
  return 1
}

# Helper: seed a workflow assignment into the developer mailbox at DEVELOP.
# The taskPrompt carries the deliverable spec (the WHAT); the generic
# workflow carries the process (the HOW).
seed_task() {
  local TASK_ID=$1
  local PROMPT=$2
  local SUBJECT=$3
  local FILENAME=$4
  local COMMIT_MSG=$5
  echo ""
  echo "  --- Seeding ${TASK_ID} ---"
  $CLI pack-workflow \
    --base runtime_mailbox --agent converter-wf-dev --role developer --queue normal \
    --workflow-id converter-workflow \
    --task-id "${TASK_ID}" \
    --state DEVELOP \
    --target-role developer \
    --prompt "${PROMPT}" \
    --context "{\"commitMessage\":\"${COMMIT_MSG}\"}" \
    --from converter-wf-dev_developer \
    --to converter-wf-dev_developer \
    --subject "${SUBJECT}" \
    --filename "${FILENAME}"
  echo "  Seeded ${TASK_ID} into developer mailbox"
}

COMPLETED=false

# --- Assignment 1: converter-01 (already seeded by setup.sh) ---
REMAINING=$((MAX_WAIT - ($(date +%s) - START_TIME)))
if wait_for_task_done "converter-01" "$REMAINING"; then
  # --- Assignment 2: converter-02 ---
  seed_task "converter-02" \
    "@assignments/02-add-kilograms.md" \
    "Workflow Assignment converter-02: add kilogramsToPounds" \
    "002_converter_02.md" \
    "feat: add kilogramsToPounds converter"

  REMAINING=$((MAX_WAIT - ($(date +%s) - START_TIME)))
  if wait_for_task_done "converter-02" "$REMAINING"; then
    # --- Assignment 3: converter-03 ---
    seed_task "converter-03" \
      "@assignments/03-update-readme.md" \
      "Workflow Assignment converter-03: update README" \
      "003_converter_03.md" \
      "docs: update README with converter usage"

    REMAINING=$((MAX_WAIT - ($(date +%s) - START_TIME)))
    if wait_for_task_done "converter-03" "$REMAINING"; then
      COMPLETED=true
    fi
  fi
fi

echo ""
if [ "$COMPLETED" = true ]; then
  echo "All three assignments reached terminal state"
else
  echo "Timeout or early stop -- validating what was completed"
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
# Step 6: Validate
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
