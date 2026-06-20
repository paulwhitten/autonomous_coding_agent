# converter-workflow smoke test

A deterministic, **workflow-driven** smoke test that builds a small TypeScript
unit converter module. It is the engine-driven counterpart to
[`converter-ad-hoc`](../converter-ad-hoc/README.md) and is designed for **A/B
comparison**: both tests produce the *same* artifact, but this one removes the
LLM from every process decision.

## The A/B comparison

| Aspect | `converter-ad-hoc` | `converter-workflow` (this test) |
| --- | --- | --- |
| Driver | LLM decides the steps | Workflow state machine decides the steps |
| Git commits | LLM runs `git` | Engine runs `git` via `onExitCommands` |
| Jest runs | LLM runs `jest` | Engine runs `jest` via `onExitCommands` (gates each transition) |
| LLM responsibility | Everything | **Only writes `converter.ts` / `converter.test.ts` / `README.md`** |
| Determinism | Low (LLM-driven) | High (engine-driven) |
| Goal artifact | Identical | Identical |

Both tests are graded by the same LLM-as-Judge against the **same task
specification** (`judge-instructions.md`, whose Expected Deliverables section is
identical between the two tests), so their scores are directly comparable.

## What it builds

A `converter.ts` module exporting four functions plus a `converter.test.ts`
suite (≥11 tests), captured Jest output in `test_output.txt`, and a documented
`README.md` — all committed incrementally.

## The workflow

`workflow.json` defines a single-developer state machine. Every state has
`role: developer`, so transitions self-loop back to the same agent (this
requires a non-empty `teamMembers` roster, configured in
`agent/config.template.json`).

```text
CREATE_MODULE ─▶ WRITE_TESTS ─▶ ADD_KG ─▶ ADD_KG_TESTS ─▶ UPDATE_README ─▶ DONE
```

| State | LLM writes | Engine does on exit (deterministic) |
| --- | --- | --- |
| `CREATE_MODULE` | `converter.ts` (3 functions) | `test -f` gate → commit |
| `WRITE_TESTS` | `converter.test.ts` (≥8 tests) | `test -f` gate → `npx jest` gate+capture → 2 commits |
| `ADD_KG` | adds `kilogramsToPounds` | grep gates (new + originals present) → commit |
| `ADD_KG_TESTS` | adds ≥3 tests (≥11 total) | `npx jest` gate+recapture → 2 commits |
| `UPDATE_README` | `README.md` usage docs (all four functions) | commit (if changed) |
| `DONE` | — | terminal |

The per-state prompts explicitly tell the LLM **not** to run git or jest — the
engine owns those steps. Each `onExitCommands` entry with `failOnError: true`
gates the transition: if a required file is missing or a test fails, the
workflow does not advance.

## How to run

```bash
./run-test.sh
```

This will:

1. `setup.sh` — copy the agent source, seed a Jest + TypeScript project skeleton
   into `agent/workspace/project`, `git init`, `npm ci`, and seed **one**
   `WorkflowAssignment` at the `CREATE_MODULE` state.
2. Compile the agent (`tsc`) and start it.
3. Monitor the log until the workflow reaches its terminal state.
4. Run `validate.sh` (deterministic checks).
5. Run the LLM judge against `judge-instructions.md` (non-blocking).

## Validation

`validate.sh` mirrors the converter-ad-hoc checks (same goal output) and adds
workflow-specific assertions:

- Workflow engine loaded
- ≥4 state transitions fired
- Terminal state (`DONE`) reached
- `test_output.txt` shows a clean passing Jest run
- ≥5 incremental commits, clean working tree

## Files

| File | Purpose |
| --- | --- |
| `workflow.json` | The deterministic state machine |
| `agent/config.template.json` | Agent config (workflow file + `teamMembers` roster) |
| `setup.sh` | Provisions the agent, project skeleton, and seed message |
| `run-test.sh` | Orchestrates setup → run → validate → judge |
| `validate.sh` | Deterministic pass/fail checks |
| `judge-instructions.md` | Shared task spec used by the LLM judge |
