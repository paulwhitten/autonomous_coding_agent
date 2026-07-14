#!/bin/bash

# Runner for the V-Model Regulatory Evidence smoke test (Ad-Hoc / LLM-Driven arm)
#
# Compiles TypeScript for all 3 agents, starts them in parallel,
# then serially seeds 3 requirements as plain mailbox messages to the RA,
# monitoring the RA acceptance verdict document before seeding the next.
#
# There is NO workflow engine here. The LLM agents drive the entire
# V-model themselves: RA writes the spec and runs git, hands off to the
# Developer via send_message(); the Developer implements, tests, and
# runs git, then hands off to QA; QA verifies and merges, then hands
# back to RA; RA records an acceptance verdict. All git, tests, REQ
# annotation, handoffs, and sequencing are performed by the agents.
#
# 3 incremental requirements (serial seeding):
#   REQ-HCDP-001 (Bare CLI)         -- seeded by setup.sh
#   REQ-HCDP-002 (JSONL Validation) -- seeded after 001 is accepted
#   REQ-HCDP-003 (Ref. Integrity)   -- seeded after 002 is accepted
#
# Each requirement flows: RA -> Dev -> QA -> RA (verdict).
#
# No manager agent. Agents route handoffs directly to each other
# via send_message() using teamMembers configuration.

set -eE
trap 'echo "FATAL: run-test.sh failed at line $LINENO (exit $?)" >&2' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

HARNESS_ROOT="$(cd ../.. && pwd)"
CLI="npx --prefix developer/agent tsx ${HARNESS_ROOT}/scripts/smoke-test-cli.ts"

echo "================================================================"
echo "V-MODEL REGULATORY EVIDENCE SMOKE TEST (AD-HOC / LLM-DRIVEN ARM)"
echo "================================================================"
echo ""
echo "Agents:   RA (requirements-analyst), Developer, QA (peer routing)"
echo "Standard: HIPAA Security Rule (45 CFR 164)"
echo "Tasks:    3 incremental (REQ-HCDP-001, -002, -003)"
echo "V-Model:  RA -> Dev -> QA -> RA (LLM-driven, no workflow engine)"
echo ""

# ----------------------------------------------------------------
# Step 1: Setup
# ----------------------------------------------------------------
echo "Step 1: Running setup..."
./setup.sh
echo ""

# ----------------------------------------------------------------
# Step 2: Compile TypeScript for all 3 agents
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
# Step 3: Start all 3 agents in parallel
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
# Step 4: Wait for agents to boot
#
# There is no workflow engine to load in the ad-hoc arm.  We just
# confirm each agent process is alive and give them a brief window
# to finish booting (mailbox init, session start) before the RA
# picks up the seeded requirement message.
# ----------------------------------------------------------------
echo "Step 4: Waiting for agents to boot..."
BOOT_WAIT=30
BOOT_START=$(date +%s)
while [ $(($(date +%s) - BOOT_START)) -lt $BOOT_WAIT ]; do
  sleep 3
  ALL_ALIVE=true
  for PID in $RA_PID $DEV_PID $QA_PID; do
    if ! ps -p $PID > /dev/null 2>&1; then
      ALL_ALIVE=false
    fi
  done
  if [ "$ALL_ALIVE" = false ]; then
    echo "  WARNING: at least one agent exited during boot -- check *-test.log"
    break
  fi
done
echo "  Agents booted (RA=$RA_PID Dev=$DEV_PID QA=$QA_PID)"
echo ""

# ----------------------------------------------------------------
# Step 5: Serial requirement seeding -- monitor RA verdict, seed next
#
# Strategy: the RA records its acceptance decisions in
#   ra/agent/workspace/project/evidence/acceptance-verdict.md
# When a requirement id appears in that document, the RA has
# rendered a verdict for it and the ad-hoc V-model cycle for that
# requirement has closed.  We then seed the next requirement as a
# plain mailbox message to the RA via create-message.
#
# Requirement sequence:
#   REQ-HCDP-001 (already seeded by setup.sh)
#   REQ-HCDP-002 (seeded after REQ-HCDP-001 has a verdict)
#   REQ-HCDP-003 (seeded after REQ-HCDP-002 has a verdict)
# ----------------------------------------------------------------
echo "Step 5: Monitoring agents -- serial requirement seeding (max 120 minutes)..."
echo ""

MAX_WAIT=7200
START_TIME=$(date +%s)

# Path where the RA records acceptance verdicts (see validate.sh primary gate)
RA_VERDICT_DOC="ra/agent/workspace/project/evidence/acceptance-verdict.md"

# Helper: wait for a requirement id to receive a verdict in the RA document
wait_for_req_verdict() {
  local REQ_ID=$1
  local TIMEOUT=$2
  local WAIT_START=$(date +%s)
  echo "  Waiting for ${REQ_ID} to receive an RA verdict..."
  while [ $(($(date +%s) - WAIT_START)) -lt $TIMEOUT ]; do
    # Check RA is still alive
    if ! ps -p $RA_PID > /dev/null 2>&1; then
      echo "  WARNING: RA agent stopped while waiting for ${REQ_ID}"
      return 1
    fi
    # A verdict for this requirement exists once the id appears in the
    # verdict document alongside an ACCEPTED or REJECTED token.
    if [ -f "$RA_VERDICT_DOC" ] && \
       grep -q "${REQ_ID}" "$RA_VERDICT_DOC" 2>/dev/null && \
       grep -qiE "ACCEPTED|REJECTED" "$RA_VERDICT_DOC" 2>/dev/null; then
      local ELAPSED=$(($(date +%s) - WAIT_START))
      echo "  ${REQ_ID} received a verdict (${ELAPSED}s)"
      return 0
    fi
    sleep 10
  done
  echo "  TIMEOUT waiting for ${REQ_ID} after ${TIMEOUT}s"
  return 1
}

# Helper: seed a requirement into the RA mailbox as a plain ad-hoc message
seed_req() {
  local REQ_ID=$1
  local BODY=$2
  local SUBJECT=$3
  local FILENAME=$4
  echo ""
  echo "  --- Seeding ${REQ_ID} ---"
  $CLI create-message \
    --base runtime_mailbox --agent smoke-regah-ra --role requirements-analyst --queue normal \
    --from smoke-regah-ra_requirements-analyst \
    --to smoke-regah-ra_requirements-analyst \
    --subject "${SUBJECT}" \
    --body "${BODY}" \
    --filename "${FILENAME}"
  echo "  Seeded ${REQ_ID} into RA mailbox"
}

# --- Requirement 1: REQ-HCDP-001 (already seeded by setup.sh) ---
REMAINING=$((MAX_WAIT - ($(date +%s) - START_TIME)))
if wait_for_req_verdict "REQ-HCDP-001" "$REMAINING"; then
  # --- Requirement 2: REQ-HCDP-002 ---
  seed_req "REQ-HCDP-002" \
    "You are the Requirements Analyst and the orchestrator of an ad-hoc V-model. There is NO workflow engine. You must drive the whole cycle yourself by running git commands and handing off to teammates via send_message(). Follow the Ad-Hoc V-Model Protocol in your instructions.

REQUIREMENT REQ-HCDP-002: Extend the hcdp-validate CLI (already in the repo from REQ-HCDP-001). The CLI shall accept a filename argument, read a JSONL file (one JSON object per line) of medical records, and validate that each record's recordType field is one of patient, procedure, or diagnosis. It shall exit non-zero and log line numbers on failure.

Your steps for this requirement:
1. In workspace/project, git fetch origin, checkout main, and git reset --hard origin/main so you start from the latest shared state.
2. Update docs/requirements-specification.md with a section headed '## REQ-HCDP-002:' including Requirement Identifier, Title, Purpose, Scope, Out of Scope, and Traceability subsections.
3. Update docs/acceptance-criteria-checklist.md with objectively verifiable acceptance criteria for REQ-HCDP-002.
4. Run: git add -A, git commit -m 'requirements: REQ-HCDP-002 spec and checklist', git push origin main. You run git yourself -- nothing runs it for you.
5. Hand off to the Developer: send_message(toHostname='smoke-regah-dev', toRole='developer', subject='IMPLEMENT: REQ-HCDP-002 JSONL Validation', content includes the requirement text and the instruction to implement, test, push to origin main, and then hand off to QA).

Requirement traceability shall be maintained in the acceptance verdict, traceability matrix, and verification reports -- not in source code comments." \
    "V-Model REQUIREMENTS: REQ-HCDP-002 JSONL Validation" \
    "002_req_hcdp_002.md"

  REMAINING=$((MAX_WAIT - ($(date +%s) - START_TIME)))
  if wait_for_req_verdict "REQ-HCDP-002" "$REMAINING"; then
    # --- Requirement 3: REQ-HCDP-003 ---
    seed_req "REQ-HCDP-003" \
      "You are the Requirements Analyst and the orchestrator of an ad-hoc V-model. There is NO workflow engine. You must drive the whole cycle yourself by running git commands and handing off to teammates via send_message(). Follow the Ad-Hoc V-Model Protocol in your instructions.

REQUIREMENT REQ-HCDP-003: Extend the hcdp-validate CLI (already in the repo). Add referential integrity checking: every procedure and diagnosis record must have a patientId field matching an actual patient record's id in the same file. The CLI shall exit non-zero and log line numbers for orphaned references.

Your steps for this requirement:
1. In workspace/project, git fetch origin, checkout main, and git reset --hard origin/main so you start from the latest shared state.
2. Update docs/requirements-specification.md with a section headed '## REQ-HCDP-003:' including Requirement Identifier, Title, Purpose, Scope, Out of Scope, and Traceability subsections.
3. Update docs/acceptance-criteria-checklist.md with objectively verifiable acceptance criteria for REQ-HCDP-003.
4. Run: git add -A, git commit -m 'requirements: REQ-HCDP-003 spec and checklist', git push origin main. You run git yourself -- nothing runs it for you.
5. Hand off to the Developer: send_message(toHostname='smoke-regah-dev', toRole='developer', subject='IMPLEMENT: REQ-HCDP-003 Referential Integrity', content includes the requirement text and the instruction to implement, test, push to origin main, and then hand off to QA).

Requirement traceability shall be maintained in the acceptance verdict, traceability matrix, and verification reports -- not in source code comments." \
      "V-Model REQUIREMENTS: REQ-HCDP-003 Referential Integrity" \
      "003_req_hcdp_003.md"

    REMAINING=$((MAX_WAIT - ($(date +%s) - START_TIME)))
    wait_for_req_verdict "REQ-HCDP-003" "$REMAINING" || true
  fi
fi

echo ""
ELAPSED=$(($(date +%s) - START_TIME))
echo "Requirement seeding phase completed in ${ELAPSED}s"

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
  echo "  - RA never recorded an acceptance verdict (ad-hoc handoff stalled)"
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

# Run LLM judge per role (non-blocking — does not affect test exit code)
source "$SCRIPT_DIR/../judge/run-judge.sh"
run_judge "$SCRIPT_DIR" developer qa

exit $RESULT
