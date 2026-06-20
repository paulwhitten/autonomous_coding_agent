# Ad-Hoc Smoke Test

Single-agent test that exercises ad-hoc (no workflow) message processing with deterministic validation.

## What It Tests

1. **No workflow engine** -- the agent config has no `workflowFile`; every mailbox message is processed as a standalone ad-hoc request.
2. **Deterministic code generation** -- the agent creates a TypeScript converter module with four exported functions (`celsiusToFahrenheit`, `fahrenheitToCelsius`, `milesToKilometers`, `kilogramsToPounds`).
3. **Test authoring and execution** -- the agent writes Jest tests (11+ assertions) and captures passing output to `test_output.txt`.
4. **Incremental git commits** -- each logical step produces a separate commit (expect 5+ after the initial setup commit).
5. **Code extension without overwrite** -- a second message adds a fourth function without destroying the first three.
6. **Clean working tree** -- everything is committed when the agent finishes.

## Architecture

```text
                 ┌────────────────────────────────────────┐
  mailbox ──────>│  Ad-Hoc Agent (adhoc-test-agent)       │
  (2 messages)   │                                        │
                 │  No workflow.  No state machine.        │
                 │  Processes each message as standalone.  │
                 │                                        │
                 │  Project dir: workspace/project/        │
                 │  (pre-initialized git repo)             │
                 └────────────────────────────────────────┘
```

## Messages

| # | Subject | What the agent does |
|---|---------|---------------------|
| 1 | Create unit converter module | Create `converter.ts` with 3 functions, write 8+ tests, run Jest -- 3 commits |
| 2 | Add kilogramsToPounds converter | Extend `converter.ts` with a 4th function, add 3+ tests, re-run Jest, update README to document all four functions -- 4 commits |

## Running

```bash
cd smoke_tests/ad-hoc
./run-test.sh
```

The runner calls `setup.sh` and `validate.sh` automatically, then runs the
LLM-as-Judge to characterize the result (non-blocking — it does not affect the
test's pass/fail exit code).

## LLM Judge

After the deterministic checks, the runner invokes the shared
[judge](../judge/README.md) to qualitatively characterize the agent's work.

Unlike the deterministic `validate.sh` (binary pass/fail), the judge scores the
run on a weighted rubric (task completion, code correctness, test coverage,
commit hygiene, etc.) and writes a timestamped report to `judge/`.

The judge grades against [`judge-instructions.md`](judge-instructions.md) — the
ad-hoc task specification — rather than the generic role-based
`copilot-instructions.md` the agent runtime generates. The runner passes this
via the `JUDGE_INSTRUCTIONS` environment variable.

## Validation Checks

| # | Check | Criteria |
|---|-------|----------|
| 1 | Test log exists | `test.log` present |
| 2 | Project dir exists | `agent/workspace/project/` |
| 3-6 | Source functions | `converter.ts` exports all four functions |
| 7 | Test file | `converter.test.ts` exists |
| 8 | Assertion count | >= 8 assertions in test file |
| 9 | Test output captured | `test_output.txt` exists |
| 10 | README updated | Contains converter documentation |
| 11 | Git repo | `.git/` directory present |
| 12 | Commit count | >= 5 commits (1 setup + agent work) |
| 13 | Progressive commits | Multiple distinct files touched |
| 14 | Clean working tree | `git status --porcelain` is empty |
| 15 | Work items completed | Agent log shows completed items |

## Comparison with basic-scm

| Aspect | basic-scm | ad-hoc |
|--------|-----------|--------|
| Workflow engine | None | None |
| Messages | 1 | 2 (second extends first) |
| Task type | Calculator module | Unit converter module |
| Code extension test | No | Yes (message 2 must not overwrite message 1 work) |
| Functions validated | 3 | 4 |
| Test assertions | 6+ | 8+ (11+ with message 2) |
| Test output capture | No | Yes (`test_output.txt`) |

## Files

| File | Purpose |
|------|---------|
| `setup.sh` | Clean artifacts, copy source, init git, install deps, seed 2 messages |
| `run-test.sh` | Build, start agent, monitor, validate |
| `validate.sh` | 15 deterministic pass/fail checks |
| `judge-instructions.md` | Task spec the LLM judge grades against |
| `agent/config.template.json` | Agent config -- no workflowFile |
