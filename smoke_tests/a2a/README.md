# A2A Backend Integration Smoke Test

Tests the A2A communication backend by exercising the `CommunicationBackend`
interface through two `A2ABackend` instances that communicate over HTTP.

## What It Tests

| Area | Verification |
|------|-------------|
| Backend factory | `createBackend()` returns an `A2ABackend` instance |
| Initialization | HTTP server starts, inbox/archive dirs created |
| Message send | `sendMessage()` delivers over HTTP to recipient |
| Message receive | `receiveMessages()` returns sent messages; inbox file persisted |
| Acknowledge | `acknowledgeMessage()` moves file inbox -> archive |
| Escalation | `escalate()` delivers to manager backend |
| Completion | `sendCompletionReport()` delivers to manager |
| Discovery | `getTeamRoster()` returns enriched agent cards |
| Sync | `syncFromRemote()` / `syncToRemote()` succeed |
| Shutdown | `shutdown()` stops HTTP server cleanly |

## Running

```bash
./run-test.sh
```

Requires `@a2a-js/sdk` and `express` to be installed.

**Expected duration:** Less than 10 seconds (no Copilot CLI needed).

## Structure

```text
smoke_tests/a2a/
  README.md              This file
  run-test.sh            Entry point -- setup + run + validate
  backend-exchange.ts    TypeScript integration test script
```

## Related

`smoke_tests/mailbox-backend/` -- equivalent test for the `GitMailboxBackend`.
