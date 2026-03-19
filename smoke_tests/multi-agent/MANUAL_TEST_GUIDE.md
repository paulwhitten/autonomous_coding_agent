# Manual Priority Mailbox Test Guide

## Setup Complete

The test environment is set up with:
- Priority mailbox folders (priority/, normal/, background/)
- 3 NORMAL tasks queued for developer
- 1 HIGH priority correction ready to inject
- Developer agent configuration (supportPriority: true)

## How to Run the Test

Since the agent can't run effectively in background mode, this test requires manual observation:

### Option A: Watch Priority Interruption (Recommended)

**Terminal 1:**
```bash
cd smoke_tests/multi-agent/developer/agent
npm start
```

Watch the agent:
1. Process Task 1 (hello world) - should complete quickly
2. Start on Task 2 (math function)

**Terminal 2:**
While agent is working on Task 2:
```bash
cd smoke_tests/multi-agent
./inject-manager-correction.sh
```

**Expected Behavior:**
- Agent detects HIGH priority message on next check (~5 seconds)
- Agent INTERRUPTS current work
- Agent processes correction IMMEDIATELY
- Agent returns to normal queue after priority handled

### Option B: Pre-inject Priority Message

```bash
cd smoke_tests/multi-agent
./inject-manager-correction.sh
cd developer/agent
npm start
```

**Expected Behavior:**
- Agent checks priority mailbox FIRST (before normal queue)
- Agent processes HIGH priority correction immediately
- Agent then processes normal tasks in order

## What to Verify

### Priority Mailbox Check
```bash
# Watch agent logs for:
# "Checking priority mailbox..."
# "Found 1 HIGH priority message(s)"
```

### Work Item Sequence
```bash
# Check workspace/tasks/pending/ for sequence IDs:
ls -la developer/agent/workspace/tasks/pending/

# Expected: 001_001, 001_002, 001_003 (from messages)
# With message tracking in session_context.json
```

### Message Tracking
```bash
# Check session context has persistent tracking:
cat developer/agent/workspace/session_context.json

# Should show:
# - nextMessageSequence: increments with each message
# - messageTracking: maps sequences to mailbox files
```

### Atomic Writes
```bash
# After agent runs, check for backup file:
ls -la developer/agent/workspace/session_context.json*

# Should see:
# - session_context.json (main file)
# - session_context.json.backup (atomic write backup)
```

## Success Criteria

- Priority folder checked BEFORE normal folder
- HIGH priority messages processed immediately
- Normal tasks wait for priority completion
- Message sequences persist across restarts
- Atomic writes create backup files
- No sequence ID collisions

## Current Status

**Setup:** Complete
**Priority Structure:** Working
**Atomic Writes:** Implemented
**Message Tracking:** Implemented

**Not Yet Implemented:**
- Priority workspace folders (tasks/priority/pending vs tasks/normal/pending)
- Message editing on corrections
- Work item invalidation
- Message stays in mailbox until complete
