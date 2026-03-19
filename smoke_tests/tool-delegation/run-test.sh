#!/bin/bash

# Quick runner for tool delegation smoke test

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "═══════════════════════════════════════════════════════════"
echo "TOOL DELEGATION SMOKE TEST"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "This test verifies that send_message() and get_team_roster()"
echo "tools actually work by having an agent USE them."
echo ""
echo "Unlike other tests, this starts with EMPTY recipient mailboxes"
echo "and requires the agent to CREATE messages using tools."
echo ""

# Setup (cleans everything, copies source, installs deps)
echo "Step 1: Running setup..."
./setup.sh
echo ""

# Build agent code locally
echo "Step 2: Building agent code..."
cd manager/agent
npx tsc
if [ $? -ne 0 ]; then
  echo "Failed to build agent code"
  exit 1
fi
cd ../..
echo "Agent code ready"
echo ""

# Start agent in background
echo "Step 3: Starting manager agent..."
cd manager/agent
nohup node dist/index.js config.json > ../../test.log 2>&1 &
AGENT_PID=$!
cd ../..

# Ensure agent is killed on script exit (Ctrl-C, error, etc.)
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
echo "Waiting for agent to complete (max 5 minutes)..."
echo ""

# Monitor for completion (max 5 minutes)
MAX_WAIT=300
START_TIME=$(date +%s)
COMPLETED=false

while [ $(($(date +%s) - START_TIME)) -lt $MAX_WAIT ]; do
  if [ -f test.log ]; then
    # Count how many recipients have actual message files
    MSG_COUNT=0
    for r in test-protocol_developer test-sdk_developer test-qa_qa test-hal_developer; do
      if find "shared-mailbox/mailbox/to_${r}" -name "*.md" -type f 2>/dev/null | grep -q .; then
        MSG_COUNT=$((MSG_COUNT + 1))
      fi
    done

    if [ "$MSG_COUNT" -ge 4 ]; then
      COMPLETED=true
      break
    fi
    
    # Show progress
    SENDS=$(grep -c "TOOL INVOKED: send_message" test.log 2>/dev/null || true)
    if [ "$SENDS" -gt 0 ]; then
      echo "  send_message called $SENDS times, $MSG_COUNT/4 mailboxes have messages..."
    else
      tail -1 test.log 2>/dev/null | grep -v "^$" | head -1
    fi
  fi
  
  sleep 5
done

echo ""
if [ "$COMPLETED" = true ]; then
  echo "✅ All 4 recipients have messages"
else
  SENDS=$(grep -c "TOOL INVOKED: send_message" test.log 2>/dev/null || true)
  MSG_COUNT=0
  for r in test-protocol_developer test-sdk_developer test-qa_qa test-hal_developer; do
    if find "shared-mailbox/mailbox/to_${r}" -name "*.md" -type f 2>/dev/null | grep -q .; then
      MSG_COUNT=$((MSG_COUNT + 1))
    fi
  done
  echo "⚠️  Timeout reached ($SENDS send_message calls, $MSG_COUNT/4 mailboxes have messages)"
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
  # Force kill if still running
  if ps -p $AGENT_PID > /dev/null 2>&1; then
    kill -9 $AGENT_PID 2>/dev/null || true
  fi
  echo "✅ Agent stopped"
else
  echo "✅ Agent already stopped"
fi

echo ""
if [ $RESULT -eq 0 ]; then
  echo "🎉🎉🎉 SUCCESS - TOOLS WORK! 🎉🎉🎉"
  echo ""
  echo "What this proves:"
  echo "  ✅ Tools registered with Copilot SDK"
  echo "  ✅ Tools available in agent session"
  echo "  ✅ Copilot using tools when instructed"
  echo "  ✅ Tool implementation works correctly"
  echo ""
  echo "You can now trust that send_message() works for delegation!"
else
  echo "❌❌❌ FAILURE - TOOLS NOT WORKING ❌❌❌"
  echo ""
  echo "This means:"
  echo "  ❌ Tools not properly integrated"
  echo "  ❌ Manager delegation CAN'T work"
  echo "  ❌ Need to fix tool registration/implementation"
  echo ""
  echo "Check test.log for details:"
  echo "  tail -50 test.log"
fi

echo ""
echo "Test artifacts saved in: $SCRIPT_DIR"
echo "  - test.log (agent execution log)"
echo "  - shared-mailbox/mailbox/to_* (recipient mailboxes)"
echo ""

exit $RESULT
