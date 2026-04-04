# Multi-Agent Priority Mailbox Smoke Test

Tests priority mailbox functionality: a HIGH priority correction interrupts normal work.

## Purpose

Validates that:

1. Priority mailboxes work correctly (priority/ > normal/ > background/)
2. A HIGH priority correction is processed before remaining normal tasks
3. The correction is applied to previously created code
4. Normal work continues after the correction is handled

## Test Scenario

```text
Timeline:
1. Setup seeds 3 normal tasks in developer mailbox
2. Developer processes Task 1 (hello.js)
3. Developer starts Task 2 (math-utils.js with add + multiply)
4. run-test.sh detects math-utils.js creation, injects HIGH priority correction
5. Developer processes correction (rename multiply -> multiplyNumbers)
6. Developer continues with Task 3 (README referencing multiplyNumbers)
```

## Expected Duration

~5-8 minutes (automated)

## Running the Test

Fully automated with `run-test.sh`:

```bash
cd smoke_tests/multi-agent
./run-test.sh
```

The script handles setup, agent startup, timed injection, completion
waiting, and validation. It exits 0 on success, 1 on failure.

### Manual mode (optional)

For debugging, the individual scripts still work:

```bash
./setup.sh
cd developer/agent && npm start &
# In another terminal, after math-utils.js appears:
./inject-manager-correction.sh
```

## Success Criteria

- All 4 messages processed (3 normal + 1 priority correction)
- `hello.js` exists and runs
- `math-utils.js` exports `add` and `multiplyNumbers` (not `multiply`)
- `multiplyNumbers(4, 5)` returns `20`
- Agent log shows HIGH priority message detection
- `README.md` references `multiplyNumbers` (not the pre-correction name)
- Zero failed work items
