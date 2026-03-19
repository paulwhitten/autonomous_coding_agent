#!/bin/bash

# Validate tool delegation smoke test results

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Validating tool delegation smoke test..."
echo ""

PASSED=0
FAILED=0

# Check 1: Test log exists
if [ -f test.log ]; then
  echo "✅ Test log found"
  ((PASSED++))
else
  echo "❌ Test log not found - did you run the test?"
  ((FAILED++))
  exit 1
fi

# Check 2: Tool calls in log
if grep -q "get_team_roster" test.log; then
  echo "✅ get_team_roster() called"
  ((PASSED++))
else
  echo "❌ get_team_roster() not called"
  ((FAILED++))
fi

if grep -qi "send_message" test.log; then
  echo "✅ send_message() called"
  ((PASSED++))
else
  echo "❌ send_message() not called"
  ((FAILED++))
fi

# Check 3: Messages created
echo ""
echo "Checking for created messages..."

RECIPIENTS=("test-protocol_developer" "test-sdk_developer" "test-qa_qa" "test-hal_developer")
MESSAGES_CREATED=0

for recipient in "${RECIPIENTS[@]}"; do
  MAILBOX_DIR="shared-mailbox/mailbox/to_${recipient}"
  MESSAGE_COUNT=$(find "$MAILBOX_DIR" -name "*.md" -type f 2>/dev/null | wc -l)
  
  if [ "$MESSAGE_COUNT" -gt 0 ]; then
    echo "✅ Message sent to $recipient ($MESSAGE_COUNT files)"
    ((MESSAGES_CREATED++))
    ((PASSED++))
  else
    echo "❌ No message sent to $recipient"
    ((FAILED++))
  fi
done

# Check 4: Message format
echo ""
echo "Checking message format..."

for recipient in "${RECIPIENTS[@]}"; do
  MAILBOX_DIR="shared-mailbox/mailbox/to_${recipient}"
  MESSAGE_FILE=$(find "$MAILBOX_DIR" -name "*.md" -type f 2>/dev/null | head -1)
  
  if [ -n "$MESSAGE_FILE" ]; then
    if grep -q "^Date:" "$MESSAGE_FILE" && \
       grep -q "^From:" "$MESSAGE_FILE" && \
       grep -q "^To:" "$MESSAGE_FILE" && \
       grep -q "^Subject:" "$MESSAGE_FILE"; then
      echo "✅ Message to $recipient has correct format"
      ((PASSED++))
    else
      echo "❌ Message to $recipient has incorrect format"
      echo "   Location: $MESSAGE_FILE"
      ((FAILED++))
    fi
  fi
done

# Check 5: Agent completed task
if grep -qi "completion" test.log || grep -qi "complete" test.log; then
  echo "✅ Agent reported completion"
  ((PASSED++))
else
  echo "⚠️  Agent may not have completed (check test.log)"
fi

# Summary
echo ""
echo "============================================"
echo "VALIDATION RESULTS"
echo "============================================"
echo "Passed: $PASSED"
echo "Failed: $FAILED"
echo "Messages created: $MESSAGES_CREATED / 4"
echo ""

if [ $FAILED -eq 0 ] && [ $MESSAGES_CREATED -eq 4 ]; then
  echo "🎉 TEST PASSED - Tools are working!"
  echo ""
  echo "Evidence:"
  echo "  - get_team_roster() successfully called"
  echo "  - send_message() successfully called"
  echo "  - 4 messages created in recipient mailboxes"
  echo "  - Messages have correct format"
  exit 0
else
  echo "❌ TEST FAILED"
  echo ""
  echo "Possible causes:"
  if [ $MESSAGES_CREATED -lt 4 ]; then
    echo "  - Tools not registered with Copilot SDK"
    echo "  - Tool implementation broken"
    echo "  - Agent not using tools (instructions unclear)"
  fi
  echo ""
  echo "Check test.log for details:"
  echo "  tail -100 test.log"
  exit 1
fi
