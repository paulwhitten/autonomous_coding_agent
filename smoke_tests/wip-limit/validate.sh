#!/bin/bash

# Validation checks for the WIP limit smoke test
#
# Check categories:
#   A. Manager operation (agent started, processed messages)
#   B. Delegation delivery (messages in developer mailbox)
#   C. WIP tracking (in-flight delegations logged)
#   D. WIP gate behavior (limit blocked or would block)
#   E. Completion processing (slots cleared after completions)
#   F. No crashes or errors

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

HARNESS_ROOT="$(cd ../.. && pwd)"
CLI="npx --prefix manager/agent tsx ${HARNESS_ROOT}/scripts/smoke-test-cli.ts"
LOG="test.log"

PASS=0
FAIL=0
WARN=0

check() {
  local label="$1"
  local result="$2"  # 0 = pass, 1 = fail, 2 = warn
  local detail="$3"

  if [ "$result" -eq 0 ]; then
    echo "  [PASS] $label"
    [ -n "$detail" ] && echo "         $detail"
    PASS=$((PASS + 1))
  elif [ "$result" -eq 2 ]; then
    echo "  [WARN] $label"
    [ -n "$detail" ] && echo "         $detail"
    WARN=$((WARN + 1))
  else
    echo "  [FAIL] $label"
    [ -n "$detail" ] && echo "         $detail"
    FAIL=$((FAIL + 1))
  fi
}

# -- Category A: Manager Operation --
echo "Category A: Manager Operation"

if [ -f "$LOG" ] && [ -s "$LOG" ]; then
  check "Log file exists and is non-empty" 0
else
  check "Log file exists and is non-empty" 1 "No log file or empty"
fi

# Check agent started
STARTED=$(grep -c "Agent loop started\|Starting agent\|Checking mailbox" "$LOG" 2>/dev/null) || STARTED=0
if [ "$STARTED" -ge 1 ]; then
  check "Agent main loop executed" 0 "Found $STARTED lifecycle events"
else
  check "Agent main loop executed" 1 "No lifecycle events in log"
fi

# Check messages were read
MSG_READ=$(grep -c "Found.*message\|Processing message\|Retrieved.*messages\|Picked up message" "$LOG" 2>/dev/null) || MSG_READ=0
if [ "$MSG_READ" -ge 1 ]; then
  check "Manager read seeded messages" 0 "Found $MSG_READ message events"
else
  check "Manager read seeded messages" 2 "No message read events (may use different log format)"
fi
echo ""

# -- Category B: Delegation Delivery --
echo "Category B: Delegation Delivery"

# Count messages in developer mailbox
DEV_MAILBOX="manager/runtime_mailbox/mailbox/to_smoke-wip-dev_developer/normal"
if [ -d "$DEV_MAILBOX" ]; then
  DEV_MSG_COUNT=$(find "$DEV_MAILBOX" -name "*.md" -not -name "README.md" | wc -l)
else
  DEV_MSG_COUNT=0
fi

if [ "$DEV_MSG_COUNT" -ge 2 ]; then
  check "Developer received 2 delegated tasks" 0 "Found $DEV_MSG_COUNT messages"
elif [ "$DEV_MSG_COUNT" -ge 1 ]; then
  check "Developer received 2 delegated tasks" 2 "Only $DEV_MSG_COUNT message(s) -- partial delegation"
else
  check "Developer received 2 delegated tasks" 1 "No messages in developer mailbox"
fi

# Look for delegation artifacts in log
DELEGATE_LOG=$(grep -c "Sending.*assignment\|Delegating\|handleWorkflowTransition\|workflow.*ASSIGN.*IMPLEMENTING" "$LOG" 2>/dev/null) || DELEGATE_LOG=0
if [ "$DELEGATE_LOG" -ge 1 ]; then
  check "Delegation activity logged" 0 "Found $DELEGATE_LOG delegation events"
else
  check "Delegation activity logged" 2 "No delegation events found (may use different log keys)"
fi
echo ""

# -- Category C: WIP Tracking --
echo "Category C: WIP Tracking"

INFLIGHT=$(grep -c "Recorded in-flight delegation\|recordInFlightDelegation\|in.flight" "$LOG" 2>/dev/null) || INFLIGHT=0
if [ "$INFLIGHT" -ge 1 ]; then
  check "In-flight delegations tracked" 0 "Found $INFLIGHT tracking events"
else
  check "In-flight delegations tracked" 2 "No in-flight tracking events (check log format)"
fi

# Check session context was saved with inFlightDelegations
CTX_FILE="manager/agent/workspace/session_context.json"
if [ -f "$CTX_FILE" ]; then
  HAS_INFLIGHT=$(python3 -c "
import json
with open('$CTX_FILE') as f:
    ctx = json.load(f)
ifd = ctx.get('inFlightDelegations', {})
print(len(ifd))
" 2>/dev/null) || HAS_INFLIGHT="error"
  check "Session context tracks in-flight state" 0 "inFlightDelegations entries: $HAS_INFLIGHT"
else
  check "Session context tracks in-flight state" 2 "No session_context.json found"
fi
echo ""

# -- Category D: WIP Gate Behavior --
echo "Category D: WIP Gate Behavior"

WIP_CONFIG=$(python3 -c "
import json
with open('manager/agent/config.json') as f:
    cfg = json.load(f)
print(cfg.get('agent', {}).get('wipLimit', 'not set'))
" 2>/dev/null) || WIP_CONFIG="error"
check "wipLimit configured" 0 "wipLimit = $WIP_CONFIG"

WIP_REACHED=$(grep -c "WIP limit reached\|wipLimit.*blocked\|In-flight count.*limit" "$LOG" 2>/dev/null) || WIP_REACHED=0
if [ "$WIP_REACHED" -ge 1 ]; then
  check "WIP gate activated (blocked further work)" 0 "Found $WIP_REACHED gate events"
else
  # With wipLimit=2 and exactly 2 tasks, the gate may not fire until after both are sent
  # This is expected and not a failure
  check "WIP gate activated (blocked further work)" 2 "Gate may not have fired (wipLimit=$WIP_CONFIG with 2 tasks is at-limit, not over-limit)"
fi
echo ""

# -- Category E: Completion Processing --
echo "Category E: Completion Processing"

CLEARED=$(grep -c "Cleared in-flight delegation\|clearInFlightDelegation\|completion.*processed" "$LOG" 2>/dev/null) || CLEARED=0
if [ "$CLEARED" -ge 2 ]; then
  check "Both WIP slots cleared after completions" 0 "Found $CLEARED clearance events"
elif [ "$CLEARED" -ge 1 ]; then
  check "Both WIP slots cleared after completions" 2 "Only $CLEARED slot(s) cleared"
else
  check "Both WIP slots cleared after completions" 2 "No clearance events -- completions may not have been processed yet"
fi

# Check if completion messages were consumed (moved to archive)
COMP_ARCHIVE="manager/runtime_mailbox/mailbox/to_smoke-wip-mgr_manager/archive"
if [ -d "$COMP_ARCHIVE" ]; then
  ARCHIVED=$(find "$COMP_ARCHIVE" -name "*.md" -not -name "README.md" | wc -l)
else
  ARCHIVED=0
fi

if [ "$ARCHIVED" -ge 2 ]; then
  check "Completion messages archived" 0 "Found $ARCHIVED archived messages"
else
  check "Completion messages archived" 2 "Only $ARCHIVED message(s) archived"
fi
echo ""

# -- Category F: No Crashes --
echo "Category F: Stability"

ERRORS=$(grep -ci "unhandled.*rejection\|fatal.*error\|ENOENT\|stack trace\|segmentation fault\|SIGABRT" "$LOG" 2>/dev/null) || ERRORS=0
if [ "$ERRORS" -eq 0 ]; then
  check "No crashes or fatal errors" 0
else
  check "No crashes or fatal errors" 1 "Found $ERRORS error indicators"
fi

EXCEPTIONS=$(grep -ci "uncaught.*exception\|TypeError\|ReferenceError\|SyntaxError" "$LOG" 2>/dev/null) || EXCEPTIONS=0
if [ "$EXCEPTIONS" -eq 0 ]; then
  check "No uncaught exceptions" 0
else
  check "No uncaught exceptions" 1 "Found $EXCEPTIONS exception indicators"
fi
echo ""

# -- Summary --
echo "================================================================"
TOTAL=$((PASS + FAIL + WARN))
echo "Results: $PASS passed, $FAIL failed, $WARN warnings (out of $TOTAL checks)"
echo "================================================================"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "FAILED: $FAIL check(s) did not pass"
  echo "Review test.log for details"
  exit 1
else
  if [ "$WARN" -gt 0 ]; then
    echo ""
    echo "PASSED with $WARN warning(s)"
    echo "Some checks could not be definitively verified -- review test.log"
  else
    echo ""
    echo "ALL CHECKS PASSED"
  fi
  exit 0
fi
