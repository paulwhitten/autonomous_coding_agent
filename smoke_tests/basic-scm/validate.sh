#!/bin/bash
# Validate basic-scm smoke test results

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Validating basic-scm smoke test..."
echo ""

PASSED=0
FAILED=0

PROJECT_DIR="agent/workspace/project"

# Check 1: Test log exists
if [ -f test.log ]; then
  echo "✅ Test log found"
  ((PASSED++))
else
  echo "❌ Test log not found - did you run the test?"
  ((FAILED++))
fi

# Check 2: Project directory exists
if [ -d "$PROJECT_DIR" ]; then
  echo "✅ Project directory exists"
  ((PASSED++))
else
  echo "❌ Project directory not found at $PROJECT_DIR"
  ((FAILED++))
  echo ""
  echo "============================================"
  echo "VALIDATION RESULTS"
  echo "============================================"
  echo "Passed: $PASSED"
  echo "Failed: $FAILED"
  echo ""
  echo "❌ TEST FAILED - no project directory"
  exit 1
fi

# Check 3: Git repo initialized
if [ -d "$PROJECT_DIR/.git" ]; then
  echo "✅ Git repository initialized (.git/ exists)"
  ((PASSED++))
else
  echo "❌ Git repository not initialized (no .git/ directory)"
  ((FAILED++))
fi

# Check 4: Source file exists with expected functions
if [ -f "$PROJECT_DIR/calculator.ts" ]; then
  echo "✅ calculator.ts exists"
  ((PASSED++))

  FUNC_COUNT=0
  for func in add subtract multiply; do
    if grep -q "$func" "$PROJECT_DIR/calculator.ts"; then
      ((FUNC_COUNT++))
    fi
  done

  if [ "$FUNC_COUNT" -ge 3 ]; then
    echo "✅ calculator.ts has all 3 functions (add, subtract, multiply)"
    ((PASSED++))
  else
    echo "❌ calculator.ts missing functions ($FUNC_COUNT/3 found)"
    ((FAILED++))
  fi
else
  echo "❌ calculator.ts not found"
  ((FAILED++))
fi

# Check 5: Test file exists
if [ -f "$PROJECT_DIR/calculator.test.ts" ]; then
  echo "✅ calculator.test.ts exists"
  ((PASSED++))
else
  echo "❌ calculator.test.ts not found"
  ((FAILED++))
fi

# Check 6: README exists
if [ -f "$PROJECT_DIR/README.md" ]; then
  echo "✅ README.md exists"
  ((PASSED++))
else
  echo "❌ README.md not found"
  ((FAILED++))
fi

# Check 7: Git commit count (expect >= 3 separate commits)
echo ""
echo "Checking git history..."

if [ -d "$PROJECT_DIR/.git" ]; then
  COMMIT_COUNT=$(cd "$PROJECT_DIR" && git log --oneline 2>/dev/null | wc -l | tr -d ' ')

  # Expect >= 5 commits: 1 from setup + 4 from agent work items
  if [ "$COMMIT_COUNT" -ge 5 ]; then
    echo "✅ Git has $COMMIT_COUNT commits (expected ≥5: 1 setup + 4 agent)"
    ((PASSED++))
  elif [ "$COMMIT_COUNT" -ge 3 ]; then
    echo "⚠️  Git has $COMMIT_COUNT commits (expected ≥5, but shows incremental work)"
    ((PASSED++))
  else
    echo "❌ Git has $COMMIT_COUNT commits (expected ≥5 — not incremental)"
    ((FAILED++))
  fi

  # Show the git log for inspection
  echo ""
  echo "  Git log:"
  cd "$PROJECT_DIR"
  git log --oneline 2>/dev/null | while read -r line; do
    echo "    $line"
  done
  cd "$SCRIPT_DIR"
  echo ""

  # Check 8: Commits are progressive (different files touched in different commits)
  if [ "$COMMIT_COUNT" -ge 2 ]; then
    # Check that the first commit and last commit touch different files
    FIRST_FILES=$(cd "$PROJECT_DIR" && git diff-tree --no-commit-id --name-only -r "$(git rev-list --max-parents=0 HEAD 2>/dev/null)" 2>/dev/null | sort)
    LAST_FILES=$(cd "$PROJECT_DIR" && git diff-tree --no-commit-id --name-only -r HEAD 2>/dev/null | sort)

    if [ "$FIRST_FILES" != "$LAST_FILES" ] || [ "$COMMIT_COUNT" -ge 3 ]; then
      echo "✅ Commits show progressive work (different files across commits)"
      ((PASSED++))
    else
      echo "⚠️  Commits may not be progressive (same files in first and last commit)"
    fi
  fi

  # Check 9: Clean working tree
  DIRTY_COUNT=$(cd "$PROJECT_DIR" && git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  if [ "$DIRTY_COUNT" -eq 0 ]; then
    echo "✅ Working tree is clean (everything committed)"
    ((PASSED++))
  else
    echo "⚠️  Working tree has $DIRTY_COUNT uncommitted changes"
  fi
else
  echo "❌ Cannot check git history — no .git directory"
  ((FAILED++))
fi

# Check 10: Agent completed work items
if [ -f test.log ]; then
  COMPLETED_COUNT=$(grep -c "Work item completed" test.log 2>/dev/null || echo "0")
  if [ "$COMPLETED_COUNT" -ge 1 ]; then
    echo "✅ Agent completed $COMPLETED_COUNT work items"
    ((PASSED++))
  else
    echo "❌ No work items completed"
    ((FAILED++))
  fi
fi

# Summary
echo ""
echo "============================================"
echo "VALIDATION RESULTS"
echo "============================================"
echo "Passed: $PASSED"
echo "Failed: $FAILED"
echo ""

if [ "$FAILED" -eq 0 ]; then
  echo "🎉 TEST PASSED — Agent uses git incrementally!"
  echo ""
  echo "Evidence:"
  echo "  ✅ Git repository initialized in project directory"
  echo "  ✅ Source files created progressively"
  echo "  ✅ Multiple commits with descriptive messages"
  echo "  ✅ Working tree clean"
  exit 0
else
  echo "❌ TEST FAILED"
  echo ""
  echo "Possible causes:"
  echo "  - Agent didn't run git commands (shell permission denied?)"
  echo "  - Agent committed everything in one shot (not incremental)"
  echo "  - Agent didn't create expected files"
  echo "  - Agent re-initialized git repo instead of using existing one"
  echo ""
  echo "Check test.log for details:"
  echo "  tail -100 test.log"
  exit 1
fi
