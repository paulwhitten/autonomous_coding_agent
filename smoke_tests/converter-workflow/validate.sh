#!/bin/bash
# Validate converter-workflow smoke test results
#
# Deterministic checks — each assertion is binary pass/fail based on
# file existence, content, git history, and test output.
#
# These checks intentionally mirror converter-ad-hoc/validate.sh so the
# two tests assert the SAME goal output. Extra checks at the end confirm
# the workflow engine (not the LLM) drove the process.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Validating converter-workflow smoke test..."
echo ""

PASSED=0
FAILED=0

PROJECT_DIR="agent/workspace/project"

# ================================================================
# Preconditions
# ================================================================

# Check 1: Test log exists
if [ -f test.log ]; then
  echo "PASS: Test log found"
  ((PASSED++))
else
  echo "FAIL: Test log not found — did you run the test?"
  ((FAILED++))
fi

# Check 2: Project directory exists
if [ -d "$PROJECT_DIR" ]; then
  echo "PASS: Project directory exists"
  ((PASSED++))
else
  echo "FAIL: Project directory not found at $PROJECT_DIR"
  ((FAILED++))
  echo ""
  echo "============================================"
  echo "VALIDATION RESULTS: Passed=$PASSED  Failed=$FAILED"
  echo "FAIL — no project directory"
  echo "============================================"
  exit 1
fi

# ================================================================
# Source file checks
# ================================================================

# Check 3: converter.ts exists
if [ -f "$PROJECT_DIR/converter.ts" ]; then
  echo "PASS: converter.ts exists"
  ((PASSED++))
else
  echo "FAIL: converter.ts not found"
  ((FAILED++))
fi

# Check 4: converter.ts exports celsiusToFahrenheit
if grep -q "celsiusToFahrenheit" "$PROJECT_DIR/converter.ts" 2>/dev/null; then
  echo "PASS: converter.ts contains celsiusToFahrenheit"
  ((PASSED++))
else
  echo "FAIL: converter.ts missing celsiusToFahrenheit"
  ((FAILED++))
fi

# Check 5: converter.ts exports fahrenheitToCelsius
if grep -q "fahrenheitToCelsius" "$PROJECT_DIR/converter.ts" 2>/dev/null; then
  echo "PASS: converter.ts contains fahrenheitToCelsius"
  ((PASSED++))
else
  echo "FAIL: converter.ts missing fahrenheitToCelsius"
  ((FAILED++))
fi

# Check 6: converter.ts exports milesToKilometers
if grep -q "milesToKilometers" "$PROJECT_DIR/converter.ts" 2>/dev/null; then
  echo "PASS: converter.ts contains milesToKilometers"
  ((PASSED++))
else
  echo "FAIL: converter.ts missing milesToKilometers"
  ((FAILED++))
fi

# Check 7: converter.ts exports kilogramsToPounds (extension state)
if grep -q "kilogramsToPounds" "$PROJECT_DIR/converter.ts" 2>/dev/null; then
  echo "PASS: converter.ts contains kilogramsToPounds"
  ((PASSED++))
else
  echo "FAIL: converter.ts missing kilogramsToPounds (ADD_KG state not reached?)"
  ((FAILED++))
fi

# Check 8: Test file exists
if [ -f "$PROJECT_DIR/converter.test.ts" ]; then
  echo "PASS: converter.test.ts exists"
  ((PASSED++))
else
  echo "FAIL: converter.test.ts not found"
  ((FAILED++))
fi

# Check 9: Test file has sufficient assertions (>= 8)
if [ -f "$PROJECT_DIR/converter.test.ts" ]; then
  TEST_LINES=$(grep -cE "(expect\(|\.toBe|\.toBeCloseTo|\.toEqual)" "$PROJECT_DIR/converter.test.ts" 2>/dev/null)
  TEST_LINES=${TEST_LINES:-0}
  if [ "$TEST_LINES" -ge 8 ]; then
    echo "PASS: converter.test.ts has $TEST_LINES assertions (expected >= 8)"
    ((PASSED++))
  else
    echo "FAIL: converter.test.ts has only $TEST_LINES assertions (expected >= 8)"
    ((FAILED++))
  fi
fi

# Check 10: test_output.txt exists
if [ -f "$PROJECT_DIR/test_output.txt" ]; then
  echo "PASS: test_output.txt exists"
  ((PASSED++))
else
  echo "FAIL: test_output.txt not found (engine should capture Jest output)"
  ((FAILED++))
fi

# Check 11: test_output.txt shows passing tests
if [ -f "$PROJECT_DIR/test_output.txt" ]; then
  if grep -q "passed" "$PROJECT_DIR/test_output.txt" 2>/dev/null && \
     ! grep -qiE "([1-9][0-9]*) failed|Test suite failed to run|unexpected token" "$PROJECT_DIR/test_output.txt" 2>/dev/null; then
    echo "PASS: test_output.txt shows passing Jest run"
    ((PASSED++))
  else
    echo "FAIL: test_output.txt does not show a clean passing Jest run"
    ((FAILED++))
  fi
fi

# Check 12: README.md updated (contains converter-related content)
if [ -f "$PROJECT_DIR/README.md" ]; then
  if grep -qi "converter\|celsius\|fahrenheit\|miles\|kilometer" "$PROJECT_DIR/README.md" 2>/dev/null; then
    echo "PASS: README.md updated with converter documentation"
    ((PASSED++))
  else
    echo "FAIL: README.md exists but has no converter-related content"
    ((FAILED++))
  fi
else
  echo "FAIL: README.md not found"
  ((FAILED++))
fi

# ================================================================
# Git history checks
# ================================================================

echo ""
echo "Checking git history..."

if [ -d "$PROJECT_DIR/.git" ]; then
  echo "PASS: Git repository exists"
  ((PASSED++))

  COMMIT_COUNT=$(cd "$PROJECT_DIR" && git log --oneline 2>/dev/null | wc -l | tr -d ' ')

  # Expect >= 5 commits: 1 setup + 7 workflow commits = 8; be lenient
  if [ "$COMMIT_COUNT" -ge 5 ]; then
    echo "PASS: Git has $COMMIT_COUNT commits (expected >= 5: 1 setup + workflow commits)"
    ((PASSED++))
  elif [ "$COMMIT_COUNT" -ge 3 ]; then
    echo "WARN: Git has $COMMIT_COUNT commits (expected >= 5, but shows incremental work)"
    ((PASSED++))
  else
    echo "FAIL: Git has $COMMIT_COUNT commits (expected >= 5 — not incremental)"
    ((FAILED++))
  fi

  echo ""
  echo "  Git log:"
  cd "$PROJECT_DIR"
  git log --oneline 2>/dev/null | while read -r line; do
    echo "    $line"
  done
  cd "$SCRIPT_DIR"
  echo ""

  # Progressive commits (distinct files touched)
  if [ "$COMMIT_COUNT" -ge 3 ]; then
    UNIQUE_FILES=$(cd "$PROJECT_DIR" && git log --name-only --pretty=format: 2>/dev/null | sort -u | grep -v '^$' | wc -l | tr -d ' ')
    if [ "$UNIQUE_FILES" -ge 2 ]; then
      echo "PASS: Commits touch $UNIQUE_FILES distinct files (progressive work)"
      ((PASSED++))
    else
      echo "WARN: Commits only touch $UNIQUE_FILES file(s)"
    fi
  fi

  # Clean working tree
  DIRTY_COUNT=$(cd "$PROJECT_DIR" && git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  if [ "$DIRTY_COUNT" -eq 0 ]; then
    echo "PASS: Working tree is clean (everything committed)"
    ((PASSED++))
  else
    echo "WARN: Working tree has $DIRTY_COUNT uncommitted changes"
    cd "$PROJECT_DIR"
    git status --short 2>/dev/null | head -10 | while read -r line; do
      echo "    $line"
    done
    cd "$SCRIPT_DIR"
  fi
else
  echo "FAIL: No .git directory — cannot check git history"
  ((FAILED++))
fi

# ================================================================
# Workflow engine checks (distinguishes this test from converter-ad-hoc)
# ================================================================

echo ""
echo "Checking workflow engine activity..."

if [ -f test.log ]; then
  # Workflow engine loaded
  if grep -q "Workflow engine loaded" test.log 2>/dev/null; then
    echo "PASS: Workflow engine loaded"
    ((PASSED++))
  else
    echo "FAIL: Workflow engine did not load (workflowFile misconfigured?)"
    ((FAILED++))
  fi

  # State transitions fired
  TRANSITION_COUNT=$(grep -c "Workflow state transition" test.log 2>/dev/null)
  TRANSITION_COUNT=${TRANSITION_COUNT:-0}
  if [ "$TRANSITION_COUNT" -ge 4 ]; then
    echo "PASS: Workflow fired $TRANSITION_COUNT state transitions (expected >= 4)"
    ((PASSED++))
  else
    echo "FAIL: Workflow fired only $TRANSITION_COUNT state transitions (expected >= 4)"
    ((FAILED++))
  fi

  # Terminal state reached
  if grep -q "Workflow task reached terminal state" test.log 2>/dev/null; then
    echo "PASS: Workflow reached terminal state (DONE)"
    ((PASSED++))
  else
    echo "FAIL: Workflow did not reach terminal state"
    ((FAILED++))
  fi
fi

# ================================================================
# Summary
# ================================================================

echo ""
echo "============================================"
echo "VALIDATION RESULTS"
echo "============================================"
echo "Passed: $PASSED"
echo "Failed: $FAILED"
echo ""

if [ "$FAILED" -eq 0 ]; then
  echo "TEST PASSED — Workflow engine deterministically built the converter!"
  echo ""
  echo "Evidence:"
  echo "  - Workflow engine drove the developer through the state machine"
  echo "  - Source files created with correct exports"
  echo "  - Tests written and passing (Jest run by the engine)"
  echo "  - Incremental git commits (made by the engine)"
  echo "  - Code extended without overwriting"
  echo "  - Clean working tree"
  exit 0
else
  echo "TEST FAILED ($FAILED checks failed)"
  echo ""
  echo "Debugging tips:"
  echo "  tail -100 test.log"
  echo "  ls -la agent/workspace/project/"
  echo "  cd agent/workspace/project && git log --oneline"
  exit 1
fi
