#!/bin/bash

# Validation script for the V-Model Regulatory Evidence smoke test
#
# Checks all 3 agent workspaces (RA, Developer, QA) for expected
# evidence artifacts, requirement traceability annotations, and V-model
# completeness.
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

check_file() {
  local DESC="$1"
  local FILE="$2"
  if [ -f "$FILE" ]; then
    if [ -s "$FILE" ]; then
      pass "$DESC"
    else
      fail "$DESC (file exists but is empty)"
    fi
  else
    fail "$DESC (not found: $FILE)"
  fi
}

check_dir_has_files() {
  local DESC="$1"
  local DIR="$2"
  local PATTERN="$3"
  if [ -d "$DIR" ]; then
    COUNT=$(find "$DIR" -name "$PATTERN" -type f 2>/dev/null | wc -l)
    if [ "$COUNT" -gt 0 ]; then
      pass "$DESC ($COUNT files)"
    else
      fail "$DESC (directory exists but no $PATTERN files)"
    fi
  else
    fail "$DESC (directory not found: $DIR)"
  fi
}

check_grep() {
  local DESC="$1"
  local PATTERN="$2"
  local FILE="$3"
  if [ -f "$FILE" ]; then
    if grep -q "$PATTERN" "$FILE" 2>/dev/null; then
      pass "$DESC"
    else
      fail "$DESC (pattern not found in $FILE)"
    fi
  else
    fail "$DESC (file not found: $FILE)"
  fi
}

check_grep_dir() {
  local DESC="$1"
  local PATTERN="$2"
  local DIR="$3"
  local EXT="$4"
  if [ -d "$DIR" ]; then
    MATCHES=$(grep -rl "$PATTERN" "$DIR" --include="*${EXT}" 2>/dev/null | wc -l)
    if [ "$MATCHES" -gt 0 ]; then
      pass "$DESC ($MATCHES files)"
    else
      fail "$DESC (no files matching pattern in $DIR)"
    fi
  else
    fail "$DESC (directory not found: $DIR)"
  fi
}

# ================================================================
# RA Workspace
# ================================================================
echo "--- RA Agent Workspace ---"
RA_WS="ra/agent/workspace"

echo ""
echo "  Requirements Documents:"
check_file "Requirements specification" "$RA_WS/project/docs/requirements-specification.md"
check_file "Acceptance criteria checklist" "$RA_WS/project/docs/acceptance-criteria-checklist.md"

echo ""
echo "  Requirement IDs in specification:"
if [ -f "$RA_WS/project/docs/requirements-specification.md" ]; then
  check_grep "REQ-HCDP-001 in requirements spec" "REQ-HCDP-001" "$RA_WS/project/docs/requirements-specification.md"
  check_grep "REQ-HCDP-002 in requirements spec" "REQ-HCDP-002" "$RA_WS/project/docs/requirements-specification.md"
  check_grep "REQ-HCDP-003 in requirements spec" "REQ-HCDP-003" "$RA_WS/project/docs/requirements-specification.md"
fi

echo ""
echo "  Acceptance Verdict (V-model closure):"
# Check multiple possible locations for acceptance evidence
ACCEPTANCE_DOC=""
for CANDIDATE in \
  "$RA_WS/project/evidence/acceptance-verdict.md" \
  "$RA_WS/project/docs/acceptance-verdict.md" \
  "$RA_WS/evidence/acceptance-verdict.md"; do
  if [ -f "$CANDIDATE" ]; then
    ACCEPTANCE_DOC="$CANDIDATE"
    break
  fi
done

# RA_VERDICT is the primary test gate -- set here, evaluated in summary
RA_VERDICT="MISSING"

if [ -n "$ACCEPTANCE_DOC" ]; then
  pass "Acceptance verdict document found"
  check_grep "Verdict contains REQ-HCDP-001" "REQ-HCDP-001" "$ACCEPTANCE_DOC"
  check_grep "Verdict contains REQ-HCDP-002" "REQ-HCDP-002" "$ACCEPTANCE_DOC"
  check_grep "Verdict contains REQ-HCDP-003" "REQ-HCDP-003" "$ACCEPTANCE_DOC"

  # Parse the RA verdict.
  # The acceptance-verdict may be a table with per-requirement rows.
  # Check the LAST row / LAST verdict entry to determine overall status.
  # Also look for an explicit overall summary line.
  LAST_LINE_VERDICT=$(tail -5 "$ACCEPTANCE_DOC" | grep -oiE 'ACCEPTED|REJECTED|PASS|FAIL' | tail -1)
  OVERALL_SUMMARY=$(grep -iE '^(overall|final|summary).*verdict' "$ACCEPTANCE_DOC" 2>/dev/null | grep -oiE 'ACCEPTED|REJECTED|PASS|FAIL' | tail -1)

  # Prefer explicit overall summary, fall back to counting per-req verdicts
  if [ -n "$OVERALL_SUMMARY" ]; then
    VERDICT_KEY=$(echo "$OVERALL_SUMMARY" | tr '[:lower:]' '[:upper:]')
  elif [ -n "$LAST_LINE_VERDICT" ]; then
    VERDICT_KEY=$(echo "$LAST_LINE_VERDICT" | tr '[:lower:]' '[:upper:]')
  else
    # Count accepted vs rejected rows.
    # NOTE: grep -c prints "0" to stdout AND exits code 1 when no matches.
    # Using "|| true" (not "|| echo 0") avoids capturing a second "0" that
    # would produce "0\n0" and break integer comparisons.
    ACCEPT_COUNT=$(grep -ciE 'ACCEPTED|verdict.*pass|status.*pass' "$ACCEPTANCE_DOC" 2>/dev/null || true)
    REJECT_COUNT=$(grep -ciE 'REJECTED|verdict.*fail|status.*fail' "$ACCEPTANCE_DOC" 2>/dev/null || true)
    # Sanitize: strip whitespace/newlines, default to 0
    ACCEPT_COUNT=$(echo "$ACCEPT_COUNT" | tr -d '[:space:]')
    REJECT_COUNT=$(echo "$REJECT_COUNT" | tr -d '[:space:]')
    ACCEPT_COUNT=${ACCEPT_COUNT:-0}
    REJECT_COUNT=${REJECT_COUNT:-0}
    if [ "$REJECT_COUNT" -gt 0 ] && [ "$ACCEPT_COUNT" -eq 0 ]; then
      VERDICT_KEY="REJECTED"
    elif [ "$ACCEPT_COUNT" -gt 0 ] && [ "$REJECT_COUNT" -eq 0 ]; then
      VERDICT_KEY="ACCEPTED"
    elif [ "$ACCEPT_COUNT" -gt "$REJECT_COUNT" ]; then
      VERDICT_KEY="ACCEPTED"
    elif [ "$REJECT_COUNT" -gt 0 ]; then
      VERDICT_KEY="REJECTED"
    else
      VERDICT_KEY="INCONCLUSIVE"
    fi
  fi

  case "$VERDICT_KEY" in
    ACCEPTED|PASS)
      RA_VERDICT="ACCEPTED"
      if [ -n "$ACCEPT_COUNT" ] && [ "$ACCEPT_COUNT" -gt 0 ] 2>/dev/null; then
        pass "RA verdict: ACCEPTED ($ACCEPT_COUNT of $((ACCEPT_COUNT + REJECT_COUNT)) requirements accepted)"
      else
        pass "RA verdict: ACCEPTED (from last entry in verdict document)"
      fi
      ;;
    REJECTED|FAIL)
      RA_VERDICT="REJECTED"
      if [ -n "$REJECT_COUNT" ] && [ "$REJECT_COUNT" -gt 0 ] 2>/dev/null; then
        fail "RA verdict: REJECTED ($REJECT_COUNT of $((ACCEPT_COUNT + REJECT_COUNT)) requirements rejected)"
      else
        fail "RA verdict: REJECTED (from last entry in verdict document)"
      fi
      ;;
    *)
      RA_VERDICT="INCONCLUSIVE"
      warn "RA verdict document exists but no clear accept/reject language found"
      ;;
  esac
else
  fail "Acceptance verdict not found (RA did not reach ACCEPTANCE state)"
fi

# ================================================================
# Developer Workspace
# ================================================================
echo ""
echo "--- Developer Agent Workspace ---"
DEV_WS="developer/agent/workspace"

echo ""
echo "  Source Files:"
check_dir_has_files "Source files in src/" "$DEV_WS/project/src" "*.ts"

echo ""
echo "  Test Files:"
check_dir_has_files "Test files in tests/" "$DEV_WS/project/tests" "*.test.ts"

echo ""
echo "  Evidence:"
check_file "Developer traceability document" "$DEV_WS/project/evidence/developer-traceability.md"

echo ""
echo "  Requirement Traceability in Developer Evidence:"
check_grep "REQ-HCDP-001 in developer traceability" "REQ-HCDP-001" "$DEV_WS/project/evidence/developer-traceability.md"
check_grep "REQ-HCDP-002 in developer traceability" "REQ-HCDP-002" "$DEV_WS/project/evidence/developer-traceability.md"

# ================================================================
# QA Workspace
# ================================================================
echo ""
echo "--- QA Agent Workspace ---"
QA_WS="qa/agent/workspace"

echo ""
echo "  Evidence Documents:"
# Check multiple paths for traceability matrix
for QA_BASE in "$QA_WS/project" "$QA_WS"; do
  TRACE_MATRIX=""
  for CANDIDATE in \
    "$QA_BASE/evidence/traceability-matrix.md" \
    "$QA_BASE/evidence/traceability_matrix.md"; do
    if [ -f "$CANDIDATE" ]; then
      TRACE_MATRIX="$CANDIDATE"
      break
    fi
  done
  [ -n "$TRACE_MATRIX" ] && break
done

if [ -n "$TRACE_MATRIX" ]; then
  pass "Traceability matrix found"
  check_grep "Matrix contains REQ-HCDP-001" "REQ-HCDP-001" "$TRACE_MATRIX"
  check_grep "Matrix contains REQ-HCDP-002" "REQ-HCDP-002" "$TRACE_MATRIX"
  check_grep "Matrix contains REQ-HCDP-003" "REQ-HCDP-003" "$TRACE_MATRIX"
else
  fail "Traceability matrix not found"
fi

# Verification report
VERIF_REPORT=""
for QA_BASE in "$QA_WS/project" "$QA_WS"; do
  for CANDIDATE in \
    "$QA_BASE/evidence/verification-report.md" \
    "$QA_BASE/evidence/verification_report.md"; do
    if [ -f "$CANDIDATE" ]; then
      VERIF_REPORT="$CANDIDATE"
      break
    fi
  done
  [ -n "$VERIF_REPORT" ] && break
done

if [ -n "$VERIF_REPORT" ]; then
  pass "Verification report found"
else
  fail "Verification report not found"
fi

# Requirement coverage
REQ_COVERAGE=""
for QA_BASE in "$QA_WS/project" "$QA_WS"; do
  for CANDIDATE in \
    "$QA_BASE/evidence/requirement-coverage.md" \
    "$QA_BASE/evidence/requirement_coverage.md"; do
    if [ -f "$CANDIDATE" ]; then
      REQ_COVERAGE="$CANDIDATE"
      break
    fi
  done
  [ -n "$REQ_COVERAGE" ] && break
done

if [ -n "$REQ_COVERAGE" ]; then
  pass "Requirement coverage document found"
else
  warn "Requirement coverage document not found"
fi

echo ""
echo "  Integration Tests (QA-authored):"
# Look for integration tests in QA workspace
INTEG_DIR=""
for QA_BASE in "$QA_WS/project" "$QA_WS"; do
  if [ -d "$QA_BASE/tests/integration" ]; then
    INTEG_DIR="$QA_BASE/tests/integration"
    break
  fi
done

if [ -n "$INTEG_DIR" ]; then
  INTEG_COUNT=$(find "$INTEG_DIR" -name "*.test.ts" -o -name "*.test.js" 2>/dev/null | wc -l)
  if [ "$INTEG_COUNT" -gt 0 ]; then
    pass "Integration test files found ($INTEG_COUNT files)"
    # Check cross-requirement references
    check_grep_dir "Integration test references REQ-HCDP" "REQ-HCDP" "$INTEG_DIR" ".ts"
  else
    fail "Integration test directory exists but no test files"
  fi
else
  warn "Integration tests directory not found (tests/integration/)"
fi

# ================================================================
# Cross-Agent Traceability (V-Model Chain)
# ================================================================
echo ""
echo "--- V-Model Cross-Agent Traceability ---"
echo ""

# Check that all 3 requirement IDs appear across at least 2 agent workspaces
for REQ_ID in REQ-HCDP-001 REQ-HCDP-002 REQ-HCDP-003; do
  AGENTS_WITH_REQ=0
  for AGENT_WS in "$RA_WS" "$DEV_WS" "$QA_WS"; do
    if [ -d "$AGENT_WS" ]; then
      FOUND=$(grep -rl "$REQ_ID" "$AGENT_WS" --include="*.md" --include="*.ts" --include="*.js" 2>/dev/null | head -1)
      if [ -n "$FOUND" ]; then
        AGENTS_WITH_REQ=$((AGENTS_WITH_REQ + 1))
      fi
    fi
  done
  if [ "$AGENTS_WITH_REQ" -ge 2 ]; then
    pass "$REQ_ID traced across $AGENTS_WITH_REQ agent workspaces"
  elif [ "$AGENTS_WITH_REQ" -eq 1 ]; then
    warn "$REQ_ID found in only $AGENTS_WITH_REQ agent workspace"
  else
    fail "$REQ_ID not found in any agent workspace"
  fi
done

# ================================================================
# Log Evidence (Workflow Engine Activity)
# ================================================================
echo ""
echo "--- Workflow Engine Logs ---"
echo ""

# RA, Developer, QA use workflow engine -- no manager agent in peer routing mode
for AGENT_LABEL_LOG in "RA:ra-test.log" "Developer:developer-test.log" "QA:qa-test.log"; do
  LABEL="${AGENT_LABEL_LOG%%:*}"
  LOGFILE="${AGENT_LABEL_LOG##*:}"
  if [ -f "$LOGFILE" ] && [ -s "$LOGFILE" ]; then
    pass "$LABEL agent log file present"
    # Check for workflow assignment received (match pino human-readable log output)
    if grep -qi "Loaded workflow\|Received workflow assignment\|Workflow engine loaded\|Workflow task activated\|Workflow context injected\|Workflow output extraction" "$LOGFILE" 2>/dev/null; then
      pass "$LABEL log shows workflow activity"
    else
      warn "$LABEL log present but no workflow events detected"
    fi
  else
    fail "$LABEL agent log not found or empty"
  fi
done

# ================================================================
# Summary
# ================================================================
echo ""
echo "================================================================"
echo "VALIDATION SUMMARY"
echo "================================================================"
echo ""
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo "  WARN: $WARN"
echo ""

TOTAL=$((PASS + FAIL))
if [ "$TOTAL" -gt 0 ]; then
  PCT=$((PASS * 100 / TOTAL))
  echo "  Score: ${PCT}% ($PASS / $TOTAL)"
else
  echo "  Score: N/A (no checks executed)"
fi
echo ""

# The RA acceptance verdict is the primary test gate.
# The whole point of the V-model is that RA closes the loop by examining
# the QA verification report and traceability matrix and issuing a verdict.
echo "  RA Verdict: $RA_VERDICT"
echo ""

if [ "$RA_VERDICT" = "ACCEPTED" ]; then
  echo "  Result: PASS -- RA accepted the delivery"
  echo "================================================================"
  exit 0
elif [ "$RA_VERDICT" = "REJECTED" ]; then
  echo "  Result: FAIL -- RA rejected the delivery"
  echo "================================================================"
  exit 1
elif [ "$RA_VERDICT" = "INCONCLUSIVE" ]; then
  echo "  Result: FAIL -- RA verdict document exists but lacks clear accept/reject"
  echo "================================================================"
  exit 1
else
  echo "  Result: FAIL -- RA never produced an acceptance verdict"
  echo "  (workflow did not reach ACCEPTANCE state)"
  echo "================================================================"
  exit 1
fi
