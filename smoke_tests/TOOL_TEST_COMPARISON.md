# Smoke Test Comparison

## What Each Test Actually Tests

### Existing Tests (Don't Test Tools)

| Test | What It Tests | What It Doesn't Test |
|------|---------------|----------------------|
| **basic/** | Agent reads messages, Agent processes tasks, Agent archives messages | Can't test tools (no other agents), Messages pre-created by setup script |
| **intermediate/** | Agent reads messages, Multi-step workflows, Task sequencing | Can't test tools (no other agents), Messages pre-created by setup script |
| **multi-agent/** | Agent reads priority messages, Priority queue ordering, Message processing | Doesn't call send_message(), All messages pre-created, Tests reading, not sending |
| **longrunning/** | Timeout handling, Background processes, Dependency tracking | Can't test tools (no other agents), Messages pre-created by setup script |

**Key Problem:** All existing tests pre-populate mailbox directories with .md files. They never test if an agent can USE send_message() to CREATE messages.

### New Test: tool-delegation/

| Test | What It Tests |
|------|---------------|
| **tool-delegation/** | **get_team_roster()** - Can agent list team?, **send_message()** - Can agent send messages?, **Tool registration** - Are tools in Copilot session?, **File creation** - Do messages appear in mailbox?, **Tool selection** - Will Copilot choose to use tools? |

**How It's Different:**
- **Starts with EMPTY recipient mailboxes** (not pre-populated)
- **Requires agent to call send_message()** to create messages
- **Validates 4 message files appear** in recipient mailboxes
- **First test that proves tools work** end-to-end

## Why This Matters

We discovered the manager agent wasn't delegating. Possible causes:

1. **Tools not registered?** - Maybe createMailboxTools() not called
2. **Tools broken?** - Maybe send_message() implementation fails
3. **Instructions unclear?** - Maybe Copilot doesn't know to use tools
4. **SDK integration wrong?** - Maybe tools not passed to session

**None of the existing tests would detect these problems!**

The tool-delegation test will definitively answer: **Do the tools actually work?**

## Running the Tool Delegation Test

```bash
cd smoke_tests/tool-delegation
./setup.sh
cd manager/agent
nohup npm start > ../../test.log 2>&1 &

# In another terminal:
cd smoke_tests/tool-delegation
tail -f test.log

# Watch for tool calls:
grep -i "get_team_roster\|send_message" test.log

# Check if messages created:
ls -la shared-mailbox/mailbox/to_test-protocol_developer/
ls -la shared-mailbox/mailbox/to_test-sdk_developer/
ls -la shared-mailbox/mailbox/to_test-qa_qa/
ls -la shared-mailbox/mailbox/to_test-hal_developer/

# Validate results:
./validate.sh
```

## Expected Output

**If tools work:**
```
Test log found
get_team_roster() called
send_message() called
Message sent to test-protocol_developer (1 files)
Message sent to test-sdk_developer (1 files)
Message sent to test-qa_qa (1 files)
Message sent to test-hal_developer (1 files)
Message to test-protocol_developer has correct format
Message to test-sdk_developer has correct format
Message to test-qa_qa has correct format
Message to test-hal_developer has correct format
Agent reported completion

Passed: 13
Failed: 0
Messages created: 4 / 4

TEST PASSED - Tools are working!
```

**If tools DON'T work:**
```
get_team_roster() not called
send_message() not called
No message sent to test-protocol_developer
No message sent to test-sdk_developer
No message sent to test-qa_qa
No message sent to test-hal_developer

Passed: 1
Failed: 8
Messages created: 0 / 4

TEST FAILED - Tools not working
```

## What This Proves

**If test passes:**
- Tools ARE registered with Copilot SDK
- Tools ARE available in agent session
- Copilot WILL use tools when instructed
- Tool implementation WORKS (creates files)
- Message format is CORRECT

**If test fails:**
- Something fundamentally wrong with tool integration
- Need to check: tool registration, SDK session creation, tool implementation

This is the **smoking gun test** for delegation issues.
