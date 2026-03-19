#!/bin/bash
# Runner for basic-scm smoke test

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "═══════════════════════════════════════════════════════════"
echo "BASIC-SCM SMOKE TEST"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "This test verifies that the agent can:"
echo "  1. Use an existing git repository in the project folder"
echo "  2. Create files progressively"
echo "  3. Make incremental commits for each work item"
echo "  4. Leave a clean working tree"
echo ""

# Setup
echo "Step 1: Running setup..."
./setup.sh
echo ""

# Build
echo "Step 2: Building agent code..."
cd agent
npx tsc
if [ $? -ne 0 ]; then
  echo "❌ Failed to build agent code"
  exit 1
fi
cd ..
echo "✅ Agent code ready"
echo ""

# Start agent
echo "Step 3: Starting agent..."
cd agent
nohup node dist/index.js config.json > ../test.log 2>&1 &
AGENT_PID=$!
cd ..

cleanup() {
  if [ -n "$AGENT_PID" ] && ps -p $AGENT_PID > /dev/null 2>&1; then
    kill $AGENT_PID 2>/dev/null || true
    sleep 1
    kill -9 $AGENT_PID 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "✅ Agent started (PID: $AGENT_PID)"
echo ""
echo "Waiting for agent to complete (max 10 minutes)..."
echo ""

# Monitor for completion (max 10 minutes — git operations can be slow)
MAX_WAIT=600
START_TIME=$(date +%s)
COMPLETED=false

while [ $(($(date +%s) - START_TIME)) -lt $MAX_WAIT ]; do
  if [ -f test.log ]; then
    # Check if all work items from message 001 are done
    if grep -q "Message 001 completed" test.log 2>/dev/null; then
      COMPLETED=true
      break
    fi

    # Check if agent is idle (no new messages, already processed)
    if grep -q "No new messages in mailbox" test.log 2>/dev/null; then
      COMPLETED_ITEMS=$(grep -c "Work item completed" test.log 2>/dev/null || echo "0")
      if [ "$COMPLETED_ITEMS" -ge 3 ]; then
        COMPLETED=true
        break
      fi
    fi

    # Show progress
    COMPLETED_ITEMS=$(grep -c "Work item completed" test.log 2>/dev/null || echo "0")
    COMMIT_COUNT=0
    if [ -d "agent/workspace/project/.git" ]; then
      COMMIT_COUNT=$(cd agent/workspace/project && git log --oneline 2>/dev/null | wc -l | tr -d ' ')
    fi
    echo "  Work items completed: $COMPLETED_ITEMS | Git commits: $COMMIT_COUNT"
  fi

  sleep 10
done

echo ""
if [ "$COMPLETED" = true ]; then
  echo "✅ Agent finished processing"
else
  echo "⚠️  Timeout reached — validating what was completed"
fi

echo ""
echo "════════════════════════════════════════════════════════════"
echo "VALIDATION"
echo "════════════════════════════════════════════════════════════"
echo ""

# Run validation
./validate.sh
RESULT=$?

echo ""
echo "════════════════════════════════════════════════════════════"

# Cleanup
echo ""
echo "Cleaning up..."
if ps -p $AGENT_PID > /dev/null 2>&1; then
  kill $AGENT_PID 2>/dev/null || true
  sleep 2
  if ps -p $AGENT_PID > /dev/null 2>&1; then
    kill -9 $AGENT_PID 2>/dev/null || true
  fi
  echo "✅ Agent stopped"
else
  echo "✅ Agent already stopped"
fi

echo ""
if [ $RESULT -eq 0 ]; then
  echo "🎉🎉🎉 SUCCESS — INCREMENTAL GIT WORKFLOW WORKS! 🎉🎉🎉"
  echo ""
  echo "What this proves:"
  echo "  ✅ Agent can run git commands via terminal"
  echo "  ✅ Agent commits work incrementally (not all-at-once)"
  echo "  ✅ Each work item produces a separate commit"
  echo "  ✅ Agent maintains a clean working tree"
else
  echo "❌❌❌ FAILURE — GIT WORKFLOW NOT WORKING ❌❌❌"
  echo ""
  echo "Check test.log for details:"
  echo "  tail -100 test.log"
fi

echo ""
echo "Test artifacts saved in: $SCRIPT_DIR"
echo "  - test.log (agent execution log)"
echo "  - agent/workspace/project/ (project with git history)"
echo ""

exit $RESULT
