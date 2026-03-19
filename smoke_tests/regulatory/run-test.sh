#!/bin/bash

# Runner for the V-Model Regulatory Evidence smoke test
#
# Compiles TypeScript for all 3 agents, starts them in parallel,
# then serially executes 3 workflow tasks by monitoring the RA log
# for terminal state completion before seeding the next task.
#
# 3 incremental workflow tasks (serial execution):
#   vmodel-001: REQ-HCDP-001 (Bare CLI)        -- seeded by setup.sh
#   vmodel-002: REQ-HCDP-002 (JSONL Validation) -- seeded after 001 DONE
#   vmodel-003: REQ-HCDP-003 (Ref. Integrity)   -- seeded after 002 DONE
#
# Each task flows: RA (REQUIREMENTS_DEFINITION) -> Dev (IMPLEMENTING)
#   -> QA (VERIFICATION) -> RA (ACCEPTANCE) -> DONE
#
# No manager agent. Agents route workflow assignments directly
# to each other via teamMembers configuration.

set -eE
trap 'echo "FATAL: run-test.sh failed at line $LINENO (exit $?)" >&2' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

HARNESS_ROOT="$(cd ../.. && pwd)"
CLI="npx --prefix developer/agent tsx ${HARNESS_ROOT}/scripts/smoke-test-cli.ts"

echo "================================================================"
echo "V-MODEL REGULATORY EVIDENCE SMOKE TEST"
echo "================================================================"
echo ""
echo "Agents:   RA (requirements-analyst), Developer, QA (peer routing)"
echo "Standard: HIPAA Security Rule (45 CFR 164)"
echo "Tasks:    3 incremental (REQ-HCDP-001, -002, -003)"
echo "V-Model:  RA -> Dev -> QA -> RA -> DONE (per task)"
echo ""

# ----------------------------------------------------------------
# Step 1: Setup
# ----------------------------------------------------------------
echo "Step 1: Running setup..."
./setup.sh
echo ""

# ----------------------------------------------------------------
# Step 2: Compile TypeScript for all 4 agents
# ----------------------------------------------------------------
echo "Step 2: Building agent code for all 3 agents..."
for AGENT_DIR in ra developer qa; do
  echo "  Compiling ${AGENT_DIR}..."
  ( cd ${AGENT_DIR}/agent && npx tsc ) || {
    echo "FATAL: TypeScript compilation failed for ${AGENT_DIR}"
    exit 1
  }
done
echo "All agents compiled"
echo ""

# ----------------------------------------------------------------
# Step 3: Start all 4 agents in parallel
# ----------------------------------------------------------------
echo "Step 3: Starting all 3 agents..."

# Agents resolve config paths (workspace, mailbox, roles.json) relative to
# process.cwd(), so each must launch from its own agent/ directory.
# pushd/popd isolates cwd changes; $! captures PID in the current shell.

pushd ra/agent > /dev/null
nohup node dist/index.js config.json > "${SCRIPT_DIR}/ra-test.log" 2>&1 &
RA_PID=$!
popd > /dev/null

pushd developer/agent > /dev/null
nohup node dist/index.js config.json > "${SCRIPT_DIR}/developer-test.log" 2>&1 &
DEV_PID=$!
popd > /dev/null

pushd qa/agent > /dev/null
nohup node dist/index.js config.json > "${SCRIPT_DIR}/qa-test.log" 2>&1 &
QA_PID=$!
popd > /dev/null

echo "  RA agent:        PID $RA_PID  (log: ra-test.log)"
echo "  Developer agent: PID $DEV_PID (log: developer-test.log)"
echo "  QA agent:        PID $QA_PID  (log: qa-test.log)"
echo ""

# Cleanup on exit
cleanup() {
  for PID in $RA_PID $DEV_PID $QA_PID; do
    if [ -n "$PID" ] && ps -p $PID > /dev/null 2>&1; then
      kill $PID 2>/dev/null || true
    fi
  done
  sleep 1
  for PID in $RA_PID $DEV_PID $QA_PID; do
    if [ -n "$PID" ] && ps -p $PID > /dev/null 2>&1; then
      kill -9 $PID 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT

# ----------------------------------------------------------------
# Step 4: Wait for workflow engines to load
# ----------------------------------------------------------------
echo "Step 4: Waiting for workflow engines to initialize..."
INIT_WAIT=45
INIT_START=$(date +%s)

for AGENT_LABEL_LOG in "RA:ra-test.log" "Developer:developer-test.log" "QA:qa-test.log"; do
  LABEL="${AGENT_LABEL_LOG%%:*}"
  LOGFILE="${AGENT_LABEL_LOG##*:}"
  ENGINE_LOADED=false
  while [ $(($(date +%s) - INIT_START)) -lt $INIT_WAIT ]; do
    RESULT=$($CLI check-log-event --file "$LOGFILE" --event workflow_loaded 2>/dev/null) || true
    FOUND=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('found','false'))" 2>/dev/null) || FOUND="false"
    if [ "$FOUND" = "True" ] || [ "$FOUND" = "true" ]; then
      ENGINE_LOADED=true
      break
    fi
    sleep 2
  done
  if [ "$ENGINE_LOADED" = true ]; then
    echo "  ${LABEL}: workflow engine loaded"
  else
    echo "  ${LABEL}: WARNING -- workflow engine may not have loaded (continuing)"
  fi
done
echo ""

# ----------------------------------------------------------------
# Step 5: Serial task execution -- monitor RA log, seed next task
#
# Strategy: grep the RA pino log for the JSON field
#   "msg":"Workflow task reached terminal state"
# combined with the expected taskId. When found, seed the next
# task into the RA mailbox via CLI.
#
# Task sequence:
#   vmodel-001 (already seeded by setup.sh)
#   vmodel-002 (seeded after vmodel-001 reaches DONE)
#   vmodel-003 (seeded after vmodel-002 reaches DONE)
# ----------------------------------------------------------------
echo "Step 5: Monitoring agents -- serial task execution (max 120 minutes)..."
echo ""

MAX_WAIT=7200
START_TIME=$(date +%s)

# Helper: wait for a taskId to appear in the RA log as terminal
wait_for_task_done() {
  local TASK_ID=$1
  local TIMEOUT=$2
  local WAIT_START=$(date +%s)
  # Use the JSON file log (pino ndjson) -- ra-test.log is pretty-printed
  # and does not have taskId on the same line as the message text.
  local JSON_LOG="ra/agent/logs/agent.log"
  echo "  Waiting for ${TASK_ID} to reach terminal state..."
  while [ $(($(date +%s) - WAIT_START)) -lt $TIMEOUT ]; do
    # Check RA is still alive
    if ! ps -p $RA_PID > /dev/null 2>&1; then
      echo "  WARNING: RA agent stopped while waiting for ${TASK_ID}"
      return 1
    fi
    # Grep pino JSON log for terminal state message with this taskId
    if grep -q "\"taskId\":\"${TASK_ID}\".*Workflow task reached terminal state" "$JSON_LOG" 2>/dev/null || \
       grep -q "Workflow task reached terminal state.*\"taskId\":\"${TASK_ID}\"" "$JSON_LOG" 2>/dev/null; then
      local ELAPSED=$(($(date +%s) - WAIT_START))
      echo "  ${TASK_ID} reached DONE (${ELAPSED}s)"
      return 0
    fi
    sleep 10
  done
  echo "  TIMEOUT waiting for ${TASK_ID} after ${TIMEOUT}s"
  return 1
}

# Helper: seed a workflow task into the RA mailbox
seed_task() {
  local TASK_ID=$1
  local PROMPT=$2
  local SUBJECT=$3
  echo ""
  echo "  --- Seeding ${TASK_ID} ---"
  $CLI pack-workflow \
    --base runtime_mailbox --agent smoke-reg-ra --role requirements-analyst --queue normal \
    --workflow-id v-model-evidence \
    --task-id "${TASK_ID}" \
    --state REQUIREMENTS_DEFINITION \
    --target-role requirements-analyst \
    --prompt "${PROMPT}" \
    --from smoke-reg-ra_requirements-analyst \
    --to smoke-reg-ra_requirements-analyst \
    --subject "${SUBJECT}"
  echo "  Seeded ${TASK_ID} into RA mailbox"
}

# --- Task 1: vmodel-001 (already seeded by setup.sh) ---
REMAINING=$((MAX_WAIT - ($(date +%s) - START_TIME)))
if wait_for_task_done "vmodel-001" "$REMAINING"; then
  # --- Task 2: vmodel-002 ---
  seed_task "vmodel-002" \
    "REQ-HCDP-002: Extend the hcdp-validate CLI (already in the repo from a prior task). Add the ability to accept a filename argument, read a JSONL file (one JSON object per line) of medical records, and validate that each record's recordType field is one of patient, procedure, or diagnosis. Exit non-zero and log line numbers on failure. Update the requirements spec and checklist. Requirement traceability shall be maintained in the acceptance verdict, traceability matrix, and verification reports -- not in source code comments. Push to origin and report completion." \
    "V-Model: REQUIREMENTS_DEFINITION -- REQ-HCDP-002 JSONL Validation"

  REMAINING=$((MAX_WAIT - ($(date +%s) - START_TIME)))
  if wait_for_task_done "vmodel-002" "$REMAINING"; then
    # --- Task 3: vmodel-003 ---
    seed_task "vmodel-003" \
      "REQ-HCDP-003: Extend the hcdp-validate CLI (already in the repo). Add referential integrity checking: every procedure and diagnosis record must have a patientId field matching an actual patient record's id in the same file. Exit non-zero and log line numbers for orphaned references. Update the requirements spec and checklist. Requirement traceability shall be maintained in the acceptance verdict, traceability matrix, and verification reports -- not in source code comments. Push to origin and report completion." \
      "V-Model: REQUIREMENTS_DEFINITION -- REQ-HCDP-003 Referential Integrity"

    REMAINING=$((MAX_WAIT - ($(date +%s) - START_TIME)))
    wait_for_task_done "vmodel-003" "$REMAINING" || true
  fi
fi

echo ""
ELAPSED=$(($(date +%s) - START_TIME))
echo "Task execution phase completed in ${ELAPSED}s"

# Give agents a moment to flush logs
sleep 3

# ----------------------------------------------------------------
# Step 6: Validate
# ----------------------------------------------------------------
echo ""
echo "================================================================"
echo "VALIDATION"
echo "================================================================"
echo ""

./validate.sh
RESULT=$?

# ----------------------------------------------------------------
# Step 7: Cleanup
# ----------------------------------------------------------------
echo ""
echo "Cleaning up..."
for PID in $RA_PID $DEV_PID $QA_PID; do
  if [ -n "$PID" ] && ps -p $PID > /dev/null 2>&1; then
    kill $PID 2>/dev/null || true
  fi
done
sleep 2
for PID in $RA_PID $DEV_PID $QA_PID; do
  if [ -n "$PID" ] && ps -p $PID > /dev/null 2>&1; then
    kill -9 $PID 2>/dev/null || true
  fi
done
echo "Agents stopped"

# ----------------------------------------------------------------
# Step 8: Summary
# ----------------------------------------------------------------
echo ""
echo "================================================================"
if [ $RESULT -eq 0 ]; then
  echo "SUCCESS -- RA ACCEPTED THE DELIVERY"
  echo ""
  echo "What this proves:"
  echo "  - V-model cycle completed for at least one requirement"
  echo "  - 3 incremental tasks tested: REQ-HCDP-001, -002, -003"
  echo "  - RA examined the verification report and traceability matrix"
  echo "  - RA issued an explicit ACCEPT verdict closing the V"
  echo "  - HIPAA Security Rule traceability from REQ through source to test to evidence"
  echo "  - 3 agents (RA + Developer + QA) coordinated via peer routing"
else
  echo "FAILURE -- RA DID NOT ACCEPT THE DELIVERY"
  echo ""
  echo "The V-model test gate is the RA acceptance verdict."
  echo "Check the RA workspace for evidence/acceptance-verdict.md"
  echo ""
  echo "Logs for investigation:"
  echo "  tail -100 $SCRIPT_DIR/ra-test.log"
  echo "  tail -100 $SCRIPT_DIR/developer-test.log"
  echo "  tail -100 $SCRIPT_DIR/qa-test.log"
  echo ""
  echo "Common issues:"
  echo "  - RA never reached ACCEPTANCE state (workflow stalled)"
  echo "  - RA rejected due to missing traceability or coverage gaps"
  echo "  - Workspace isolation prevented RA from seeing QA/Dev artifacts"
fi
echo "================================================================"
echo ""
echo "Test artifacts: $SCRIPT_DIR"
echo "  Logs:      ra-test.log, developer-test.log, qa-test.log"
echo "  Mailbox:   runtime_mailbox/"
echo "  RA work:   ra/agent/workspace/"
echo "  Dev work:  developer/agent/workspace/"
echo "  QA work:   qa/agent/workspace/"
echo "  QA work:   qa/agent/workspace/"
echo ""

exit $RESULT
