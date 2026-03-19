# WIP Limit Smoke Test

## Purpose

Verify that the manager agent's WIP (Work-In-Progress) gate correctly:
1. Tracks in-flight delegations in `SessionContext.inFlightDelegations`
2. Allows up to `wipLimit` concurrent delegations (configured as N=2)
3. Blocks further delegations when the WIP limit is reached
4. Releases WIP slots when completion messages arrive from agents
5. Expires stale delegations via watchdog timeout
6. Persists in-flight state across agent restarts

## What This Tests (vs. Other Smoke Tests)

| Aspect | basic/ | workflow/ | **wip-limit/** |
|--------|--------|-----------|----------------|
| Message reading | Yes | Yes | Yes |
| Task breakdown | Yes | Yes | Yes |
| Work item execution | Yes | Yes | Yes |
| Workflow classification | No | Yes | Yes |
| **WIP tracking** | No | No | **Yes** |
| **Concurrent delegations** | No | No | **Yes** |
| **Backpressure gate** | No | No | **Yes** |
| **Completion matching** | No | No | **Yes** |
| **Watchdog timeout** | No | No | **Yes** |

## Architecture

This test simulates a **manager agent** receiving two seed messages that it
must break down into workflow tasks and delegate to a developer agent.
With `wipLimit: 2`, the manager should delegate both tasks before blocking.

Two simulated completion messages are then injected into the manager's
mailbox to verify the WIP slots are freed.

```
Seed Messages (x2)  -->  Manager Agent (real)  -->  Developer Mailbox (checked)
                              |                          |
                              | wipLimit: 2              | Should see 2 messages
                              | Tracks in-flight         |
                              |                          |
Completion Messages (x2) --> Manager Agent              Manager in-flight: 0
```

## Files

```
wip-limit/
  README.md                 -- This file
  setup.sh                  -- Clean, copy source, install deps, seed mailbox
  run-test.sh               -- Automated: setup -> build -> start -> poll -> inject completions -> validate
  validate.sh               -- Check logs, mailbox output, WIP tracking artifacts
  workflow.json             -- Simple 2-state workflow (ASSIGN -> IMPLEMENTING -> DONE)
  manager/
    agent/
      config.template.json  -- Manager agent config with wipLimit: 2
```

## Running

### Automated (recommended)
```bash
cd smoke_tests/wip-limit
./run-test.sh
```

## Expected Duration

5-8 minutes

## Success Criteria

- Manager delegates 2 tasks (2 messages in developer mailbox)
- WIP gate activates after 2 delegations (log: "WIP limit reached")
- Completion messages match in-flight delegations (log: "Matched completion message")
- WIP slots freed after completions (log: "Cleared in-flight delegation")
- No crashes or unhandled errors
