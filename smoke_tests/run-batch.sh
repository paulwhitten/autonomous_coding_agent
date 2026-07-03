#!/bin/bash
# Batch runner for the converter smoke tests.
#
# Runs one smoke test (converter-ad-hoc or converter-workflow) N times and
# archives the logs from every run into a timestamped folder for later
# diagnosis. Each run is independent: run-test.sh calls setup.sh, which wipes
# the previous run's artifacts (test.log, agent/logs, workspace), so this
# script copies the logs out immediately after each run completes, before the
# next run can overwrite them.
#
# Usage:
#   ./run-batch.sh <test-name> <N>
#
#   <test-name>  converter-ad-hoc | converter-workflow
#   <N>          number of runs (positive integer)
#
# Examples:
#   ./run-batch.sh converter-ad-hoc 10
#   ./run-batch.sh converter-workflow 10
#
# Archive layout:
#   <test-name>/log_archive/batch-<UTC-timestamp>/
#     summary.csv          one row per run (result, commits, judge score, ...)
#     summary.txt          human-readable aggregate
#     run_01/
#       console.log        full stdout+stderr of run-test.sh
#       test.log           agent execution log
#       agent.log          structured (pino) agent log
#       judge.json         LLM-as-Judge report for this run (if produced)
#       result.txt         PASS/FAIL, exit code, commit count, duration
#     run_02/ ...

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ----------------------------------------------------------------
# Arguments
# ----------------------------------------------------------------
usage() {
  echo "Usage: $0 <converter-ad-hoc|converter-workflow> <N>" >&2
  echo "  <N> must be a positive integer." >&2
  exit 2
}

[ $# -eq 2 ] || usage
TEST_NAME="$1"
N="$2"

case "$TEST_NAME" in
  converter-ad-hoc|converter-workflow) ;;
  *)
    echo "ERROR: unknown test '$TEST_NAME'." >&2
    usage
    ;;
esac

if ! [[ "$N" =~ ^[0-9]+$ ]] || [ "$N" -lt 1 ]; then
  echo "ERROR: N must be a positive integer (got '$N')." >&2
  usage
fi

TEST_DIR="${SCRIPT_DIR}/${TEST_NAME}"
RUNNER="${TEST_DIR}/run-test.sh"

if [ ! -x "$RUNNER" ] && [ ! -f "$RUNNER" ]; then
  echo "ERROR: runner not found at $RUNNER" >&2
  exit 1
fi

# ----------------------------------------------------------------
# Archive location
# ----------------------------------------------------------------
BATCH_TS="$(date -u +%Y%m%d-%H%M%S)"
BATCH_DIR="${TEST_DIR}/log_archive/batch-${BATCH_TS}"
mkdir -p "$BATCH_DIR"

SUMMARY_CSV="${BATCH_DIR}/summary.csv"
SUMMARY_TXT="${BATCH_DIR}/summary.txt"
echo "run,result,exit_code,commits,validate_passed,validate_failed,judge_overall,judge_grade,tasks_completed,tasks_failed,duration_sec,started_at_utc" > "$SUMMARY_CSV"

# Width for zero-padded run directories (run_01, run_002, ...)
PAD_WIDTH=${#N}
[ "$PAD_WIDTH" -lt 2 ] && PAD_WIDTH=2

# ----------------------------------------------------------------
# Helper: extract a field from the judge JSON using python3.
#   $1 = json file, $2 = dotted path (e.g. overall.score)
# Prints the value or empty string on any failure.
# ----------------------------------------------------------------
json_field() {
  local file="$1" path="$2"
  [ -f "$file" ] || { echo ""; return; }
  python3 - "$file" "$path" <<'PY' 2>/dev/null || echo ""
import json, sys
try:
    with open(sys.argv[1]) as fh:
        data = json.load(fh)
    cur = data
    for key in sys.argv[2].split("."):
        cur = cur[key]
    print(cur)
except Exception:
    print("")
PY
}

echo "================================================================"
echo "BATCH: ${TEST_NAME} x ${N}"
echo "Archive: ${BATCH_DIR}"
echo "================================================================"
echo ""

PASS_COUNT=0
FAIL_COUNT=0
JUDGE_SUM=0
JUDGE_N=0

for i in $(seq 1 "$N"); do
  RUN_ID="$(printf "run_%0${PAD_WIDTH}d" "$i")"
  RUN_DIR="${BATCH_DIR}/${RUN_ID}"
  mkdir -p "$RUN_DIR"

  STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  START_EPOCH=$(date +%s)

  echo "----------------------------------------------------------------"
  echo "[$i/$N] ${RUN_ID}  (started ${STARTED_AT})"
  echo "----------------------------------------------------------------"

  # Run the test. run-test.sh is cwd-independent (it cd's to its own dir) and
  # writes test.log next to itself. Capture combined output; PIPESTATUS[0]
  # preserves the runner's exit code through the tee pipe.
  "$RUNNER" 2>&1 | tee "${RUN_DIR}/console.log"
  EXIT_CODE=${PIPESTATUS[0]}

  END_EPOCH=$(date +%s)
  DURATION=$((END_EPOCH - START_EPOCH))

  # Archive logs immediately, before the next run's setup wipes them.
  [ -f "${TEST_DIR}/test.log" ] && cp "${TEST_DIR}/test.log" "${RUN_DIR}/test.log"
  [ -f "${TEST_DIR}/agent/logs/agent.log" ] && cp "${TEST_DIR}/agent/logs/agent.log" "${RUN_DIR}/agent.log"

  # Grab the judge report produced by this run (newest in judge/).
  JUDGE_SRC="$(ls -t "${TEST_DIR}/judge/"*.json 2>/dev/null | head -1)"
  if [ -n "$JUDGE_SRC" ] && [ -f "$JUDGE_SRC" ]; then
    cp "$JUDGE_SRC" "${RUN_DIR}/judge.json"
  fi

  # Commit count in the project repo (read now, before next setup wipes it).
  COMMITS=0
  if [ -d "${TEST_DIR}/agent/workspace/project/.git" ]; then
    COMMITS=$(git -C "${TEST_DIR}/agent/workspace/project" log --oneline 2>/dev/null | wc -l | tr -d ' ')
  fi

  # Result from the runner exit code (validate.sh result).
  if [ "$EXIT_CODE" -eq 0 ]; then
    RESULT="PASS"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    RESULT="FAIL"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi

  # Deterministic validate.sh outcome: the engine-checked, non-LLM signal.
  # validate.sh prints "Passed: N" / "Failed: N"; capture the final counts from
  # the run's console log so the deterministic verdict sits beside the judge's.
  VAL_PASSED="$(grep -E '^Passed: [0-9]+' "${RUN_DIR}/console.log" 2>/dev/null | tail -1 | grep -oE '[0-9]+' | head -1)"
  VAL_FAILED="$(grep -E '^Failed: [0-9]+' "${RUN_DIR}/console.log" 2>/dev/null | tail -1 | grep -oE '[0-9]+' | head -1)"
  VAL_PASSED="${VAL_PASSED:-n/a}"
  VAL_FAILED="${VAL_FAILED:-n/a}"

  # Judge fields (best-effort; empty if no report or parse failure).
  JUDGE_OVERALL="$(json_field "${RUN_DIR}/judge.json" overall.score)"
  JUDGE_GRADE="$(json_field "${RUN_DIR}/judge.json" overall.grade)"
  TASKS_DONE="$(json_field "${RUN_DIR}/judge.json" task_summary.completed)"
  TASKS_FAILED="$(json_field "${RUN_DIR}/judge.json" task_summary.failed)"

  if [[ "$JUDGE_OVERALL" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
    JUDGE_SUM=$(python3 -c "print($JUDGE_SUM + $JUDGE_OVERALL)")
    JUDGE_N=$((JUDGE_N + 1))
  fi

  # Per-run result file.
  {
    echo "run:        ${RUN_ID}"
    echo "test:       ${TEST_NAME}"
    echo "result:     ${RESULT}"
    echo "exit_code:  ${EXIT_CODE}"
    echo "commits:    ${COMMITS}"
    echo "validate:   passed=${VAL_PASSED} failed=${VAL_FAILED} (deterministic)"
    echo "judge:      ${JUDGE_OVERALL:-n/a} (${JUDGE_GRADE:-n/a})"
    echo "tasks:      completed=${TASKS_DONE:-n/a} failed=${TASKS_FAILED:-n/a}"
    echo "duration:   ${DURATION}s"
    echo "started_at: ${STARTED_AT}"
  } > "${RUN_DIR}/result.txt"

  echo "${i},${RESULT},${EXIT_CODE},${COMMITS},${VAL_PASSED},${VAL_FAILED},${JUDGE_OVERALL},${JUDGE_GRADE},${TASKS_DONE},${TASKS_FAILED},${DURATION},${STARTED_AT}" >> "$SUMMARY_CSV"

  echo ""
  echo "[$i/$N] ${RESULT} | validate=${VAL_PASSED}P/${VAL_FAILED}F | commits=${COMMITS} | judge=${JUDGE_OVERALL:-n/a} | ${DURATION}s | archived -> ${RUN_DIR}"
  echo ""

  # Brief pause to let ports and child processes settle before the next run.
  if [ "$i" -lt "$N" ]; then
    sleep 3
  fi
done

# ----------------------------------------------------------------
# Aggregate summary
# ----------------------------------------------------------------
JUDGE_MEAN="n/a"
if [ "$JUDGE_N" -gt 0 ]; then
  JUDGE_MEAN=$(python3 -c "print(round($JUDGE_SUM / $JUDGE_N, 2))")
fi

{
  echo "Batch summary"
  echo "============="
  echo "Test:          ${TEST_NAME}"
  echo "Runs:          ${N}"
  echo "Passed:        ${PASS_COUNT}"
  echo "Failed:        ${FAIL_COUNT}"
  echo "Judge mean:    ${JUDGE_MEAN} (over ${JUDGE_N} scored run(s))"
  echo "Archive:       ${BATCH_DIR}"
  echo "CSV:           ${SUMMARY_CSV}"
} | tee "$SUMMARY_TXT"

echo ""
echo "================================================================"
echo "BATCH COMPLETE: ${PASS_COUNT}/${N} passed"
echo "================================================================"

# Exit non-zero if any run failed, so CI / callers can detect it.
[ "$FAIL_COUNT" -eq 0 ]
