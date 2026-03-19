# Multi-Agent Priority Mailbox Smoke Test

Tests priority mailbox functionality with manager and developer agents interacting.

## Purpose

Validates that:
1. Priority mailboxes work correctly (priority/ > normal/ > background/)
2. Manager responses (HIGH priority) are processed immediately
3. Developer can send escalations that get quick responses
4. Normal work continues in appropriate order

## Test Scenario

```
Timeline:
1. Manager sends 3 normal tasks to developer
2. Developer starts Task 1, encounters issue
3. Developer sends HIGH priority help request to manager
4. Manager receives help request, responds with HIGH priority guidance
5. Developer receives manager guidance immediately (skips Tasks 2-3)
6. Developer applies fix and continues
7. Developer processes remaining tasks in order
```

## Expected Duration

~3-5 minutes

## Running the Test

```bash
cd smoke_tests/multi-agent
./setup.sh
cd developer/agent
nohup npm start > ../../test.log 2>&1 &
```

**Note:** `npm start` automatically:
1. Compiles TypeScript (`npm run build`)
2. Runs the compiled JavaScript (`node dist/index.js`)

In another terminal, inject the HIGH priority correction:
```bash
cd smoke_tests/multi-agent
./inject-manager-correction.sh
tail -f test.log
```

**To stop:**
```bash
# Find PID: ps aux | grep "node dist/index.js"
# Kill: kill <PID>
```

The test automatically demonstrates:
- Developer processing normal queue tasks
- Developer encountering an issue and escalating
- Manager response arriving in priority queue  
- Developer immediately handling priority message
- Developer continuing with remaining normal tasks

## Success Criteria

- Developer receives priority messages before normal messages
- Manager responses arrive in priority/ folder
- Developer processes priority queue first
- Normal tasks wait while priority items handled
