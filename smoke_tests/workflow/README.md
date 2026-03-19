# Workflow Engine Smoke Test

## Purpose

Verify that the workflow engine correctly:
1. Loads a workflow definition from `workflowFile` in config
2. Classifies a packed `WorkflowAssignment` message (not treated as unstructured)
3. Injects workflow prompt context into work item execution
4. Sends a completion/transition message back to the manager mailbox after work items finish
5. Falls back cleanly to legacy mode when `workflowFile` is absent

## What This Tests (vs. Other Smoke Tests)

| Aspect | basic/ | tool-delegation/ | **workflow/** |
|--------|--------|-----------------|---------------|
| Message reading | Yes | Yes | Yes |
| Task breakdown | Yes | Yes | Yes |
| Work item execution | Yes | Yes | Yes |
| Tool invocation | No | Yes | No |
| Priority mailbox | No | No | No |
| **Workflow classification** | No | No | **Yes** |
| **Workflow prompt injection** | No | No | **Yes** |
| **Mailbox transition routing** | No | No | **Yes** |
| **Fallback to legacy mode** | Implicitly | Implicitly | **Explicitly** |

## Architecture

This test simulates a **developer agent** receiving a workflow assignment from a manager.
The assignment is a packed `WorkflowAssignment` message (containing the `<!-- WORKFLOW_MSG:...:END_WORKFLOW_MSG -->` envelope) placed in the developer's normal mailbox.

The workflow uses a **minimal two-state workflow** (`IMPLEMENTING` -> `DONE`) to keep execution time short while exercising the full classification -> execution -> transition path.

```
Manager (simulated seed)  -->  Developer Agent (real)  -->  Manager Mailbox (checked by validate.sh)
     |                              |                              |
     | Packed WorkflowAssignment    | Processes work items         | Completion message
     | in normal mailbox            | with workflow context         | with embedded task state
     +------------------------------+------------------------------+
```

## Files

```
workflow/
  README.md                 -- This file
  setup.sh                  -- Clean, copy source, install deps, seed mailbox
  run-test.sh               -- Automated: setup -> build -> start -> poll -> validate -> cleanup
  validate.sh               -- Check logs, mailbox output, workflow artifacts
  test-fixes.sh             -- Deterministic tests for Fixes #1-6 (no LLM required)
  workflow.json             -- Minimal 2-state workflow with entryActions/exitActions
  developer/
    agent/
      config.template.json  -- Developer agent config with workflowFile
  start_mailbox/
    normal/
      workflow_assignment.md -- Pre-packed workflow assignment message
```

## Running

### Automated (recommended)
```bash
cd smoke_tests/workflow
./run-test.sh
```

### Deterministic tests (fast, no LLM)
```bash
cd smoke_tests/workflow
./test-fixes.sh
```

### Manual
```bash
cd smoke_tests/workflow
./setup.sh
cd developer/agent
npm start
# Wait for agent to process the message (~2-5 min)
# In another terminal:
cd smoke_tests/workflow
./validate.sh
```

## Expected Duration

- **test-fixes.sh**: ~5 seconds (deterministic, no LLM)
- **run-test.sh**: 3-5 minutes (LLM-driven)

## Success Criteria

- Workflow engine loaded (log: "Workflow engine loaded")
- Message classified as workflow (log: "Received workflow assignment")
- Workflow task activated (log: "Workflow task activated")
- Work items completed
- Entry/exit actions fire on transitions (Fix #1)
- Completion message sent to manager mailbox (log: "Sent workflow completion")
- Manager mailbox contains `.md` file with task state embedded

## Coverage Gap

The LLM-driven test (`run-test.sh`) is **happy-path only**. The workflow has
2 states (IMPLEMENTING -> DONE) with `onFailure` also pointing to DONE, so it
cannot fail or branch. It validates that the engine can load, classify, inject
a prompt, transition, and route a completion message -- but it does not exercise:

- Failure paths or rework loops
- Multi-state transitions through an agent loop
- Role handoffs between agents
- Context accumulation across states
- Required-output gating (outputs always succeed in a trivial task)

The deterministic tests in `test-fixes.sh` cover these logic paths
programmatically against the workflow engine API (no LLM), but they do not
run through the full agent loop. The `regulatory/` smoke test is the first
LLM-driven test that exercises multi-agent V-model transitions, rework loops,
and cross-role handoffs.

## Deterministic Test Coverage (test-fixes.sh)

| Fix | What it tests |
|-----|--------------|
| #1  | Entry/exit actions fire with template substitution |
| #2  | Failure fallback stays in current state (no manufactured ESCALATED) |
| #4  | Missing required outputs treated as failure |
| #5  | Envelope markers pack/strip/classify correctly |
| #6  | Multiple workflows with role-based selection |
| --  | Multi-step transition chain with rework loop |
