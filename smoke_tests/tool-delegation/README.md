# Tool Delegation Smoke Test

**Purpose:** Verify that mailbox tools (send_message, get_team_roster, etc.) actually work

**Critical Test:** Unlike other smoke tests that pre-populate mailbox messages, this test requires the agent to USE the send_message() tool to create messages.

## What This Tests

1. **get_team_roster()** - Agent can list team members
2. **send_message()** - Agent can send messages to other agents
3. **Mailbox file creation** - Messages appear in recipient mailbox
4. **Tool integration** - Tools properly integrated with Copilot SDK session

## Test Scenario

**Manager Agent receives task:**
```
"Use get_team_roster() to list your team.
Then send_message() to each team member with a simple hello."
```

**Success Criteria:**
- Manager calls get_team_roster() - Returns list of agents
- Manager calls send_message() 4 times (one per team member)
- 4 message files appear in recipient mailboxes:
  - `/shared-mailbox/mailbox/to_test-protocol_developer/*.md`
  - `/shared-mailbox/mailbox/to_test-sdk_developer/*.md`
  - `/shared-mailbox/mailbox/to_test-qa_qa/*.md`
  - `/shared-mailbox/mailbox/to_test-hal_developer/*.md`

**Failure Would Mean:**
- Tools not registered properly with SDK
- Tools not available in session
- Tool implementation broken
- Copilot not choosing to use tools

## Setup

```bash
cd smoke_tests/tool-delegation
./setup.sh
```

This creates:
- manager/agent/ - Manager agent config
- shared-mailbox/ - Shared mailbox for all agents
- team.json - Team roster (5 agents)

## Running the Test

```bash
cd manager/agent
nohup npm start > ../../test.log 2>&1 &
```

Monitor progress:
```bash
tail -f ../../test.log
```

Check for tool usage in logs:
```bash
grep -i "get_team_roster\|send_message" ../../test.log
```

Check if messages created:
```bash
ls -la ../../shared-mailbox/mailbox/to_test-protocol_developer/
ls -la ../../shared-mailbox/mailbox/to_test-sdk_developer/
ls -la ../../shared-mailbox/mailbox/to_test-qa_qa/
ls -la ../../shared-mailbox/mailbox/to_test-hal_developer/
```

## Expected Timeline

- **0:00** - Agent starts, reads initialization message
- **0:10-0:30** - Agent calls get_team_roster()
- **0:30-1:30** - Agent calls send_message() 4 times
- **1:30** - Agent sends completion report
- **1:30** - 4 message files exist in recipient mailboxes

Total: ~1-2 minutes

## Stop the Test

```bash
ps aux | grep "node dist/index.js" | grep manager
kill <PID>
```

## Validation Script

```bash
./validate.sh
```

Checks:
1. 4 message files created (one per team member)
2. Each message has correct format (Date, From, To, Subject)
3. Test log shows tool calls (get_team_roster, send_message)
4. Agent marked task as complete

## Why This Test Matters

The existing smoke tests pre-create messages in mailbox directories. They test:
- Agent can read messages
- Agent can process tasks
- Agent can archive messages

But they DON'T test:
- Can agent USE send_message()?
- Are tools registered in Copilot session?
- Will Copilot choose to use tools?
- Do tools actually create files?

**This is the first test that actually validates tool functionality.**

## Common Failure Modes

### Agent doesn't use tools
**Symptom:** No tool calls in logs, no messages created
**Cause:** 
- Tools not registered in session
- Instructions not clear about tool usage
- Copilot not choosing to use tools

**Fix:** Check instructions explicitly require tool usage

### Tools fail silently
**Symptom:** Tool called but no messages appear
**Cause:**
- Tool implementation broken
- File permissions issue
- Path resolution wrong

**Fix:** Check tool implementation in src/tools/mailbox-tools.ts

### Wrong message format
**Symptom:** Messages created but malformed
**Cause:** Tool not following message template

**Fix:** Update tool handler to match expected format
