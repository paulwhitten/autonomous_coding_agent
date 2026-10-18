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
| Jest runs | LLM runs `jest` | Engine runs `jest` via `onExitCommands` (gates the `TEST` transition) |
| LLM responsibility | Everything | **Only writes `converter.ts` / `converter.test.ts` / `README.md`** |
| Determinism | Low (LLM-driven) | High (engine-driven) |
| Goal artifact | Identical | Identical |

Both tests are graded by the same LLM-as-Judge against the **same task
specification** (`judge-instructions.md`, whose Expected Deliverables section is
identical between the two tests), so their scores are directly comparable.

## What it builds

A `converter.ts` module exporting four functions plus a `converter.test.ts`
suite (11+ assertions), captured Jest output in `test_output.txt`, and a
documented `README.md`. The engine commits each kind of change separately
(implementation, tests, test output, docs) with the commit message supplied
in the assignment, then runs a safety-net commit and clean-tree check at
`FINALIZE`.

## The workflow

`workflow.json` defines a generic, deliverable-agnostic single-developer state
machine (`IMPLEMENT -> TEST -> VERIFY -> DOCUMENT -> FINALIZE -> DONE`). Every
state has `role: developer`, so a rework transition routes back to the same
agent (this requires a non-empty `teamMembers` roster, configured in
`agent/config.template.json`). The same process drives every assignment; the
WHAT comes from each assignment's `taskPrompt`, and the files and commit
messages for each state come from the assignment context (`implPaths`,
`testPaths`, `docPaths`, `implCommitMessage`, `testCommitMessage`,
`verifyCommitMessage`, `docsCommitMessage`). The three deliverables (build
the module, add `kilogramsToPounds`, update the `README`) are three separate
assignments (`converter-01/02/03`), seeded serially, each run through the full
machine.

```text
IMPLEMENT ─▶ TEST ─▶ VERIFY ─▶ DOCUMENT ─▶ FINALIZE ─▶ DONE
```

### State diagram

The diagram shows the `onSuccess` path plus the `onFailure` routes. The three
LLM states self-loop to retry (bounded by `maxRetries: 1`) and escalate when
that budget is exhausted. `VERIFY` is an engine-only Jest gate that routes
back to `IMPLEMENT` for rework on failure, bounded by `IMPLEMENT`'s
`maxCycleVisits: 3`. `FINALIZE` escalates if it cannot leave a clean tree.

```mermaid
stateDiagram-v2
    direction LR
    [*] --> IMPLEMENT

    IMPLEMENT --> TEST: onSuccess (source committed)
    TEST --> VERIFY: onSuccess (tests committed)
    VERIFY --> DOCUMENT: jest passes
    DOCUMENT --> FINALIZE: onSuccess (docs committed)
    FINALIZE --> DONE: clean-tree gate passes
    DONE --> [*]

    IMPLEMENT --> IMPLEMENT: onFailure (retry, maxRetries 1)
    TEST --> TEST: onFailure (retry, maxRetries 1)
    DOCUMENT --> DOCUMENT: onFailure (retry, maxRetries 1)
    VERIFY --> IMPLEMENT: jest fails (rework, maxCycleVisits 3)
    FINALIZE --> ESCALATED: onFailure
    IMPLEMENT --> ESCALATED: retries or cycle visits exhausted
    ESCALATED --> [*]

    note right of VERIFY
        Engine only (empty prompt, no LLM turn)
        npx jest --passWithNoTests > test_output.txt
        Jest exit code decides the transition
    end note
    note right of FINALIZE
        Engine only (empty prompt, no LLM turn)
        safety-net commit, then finalize-clean-tree.sh
    end note
```

| State | LLM writes | Engine does (deterministic) |
| --- | --- | --- |
| `IMPLEMENT` | only the production source (`implPaths`) | on exit: commits `implPaths` with `implCommitMessage`, discards other changes |
| `TEST` | only the test files (`testPaths`) | on exit: commits `testPaths` with `testCommitMessage`, discards other changes |
| `VERIFY` | none (empty prompt) | on entry: runs `npx jest --passWithNoTests` into `test_output.txt`; a failing suite routes to `IMPLEMENT` with the Jest output as `{{rejectionReason}}`. On exit: commits `test_output.txt` with `verifyCommitMessage` |
| `DOCUMENT` | only the documentation (`docPaths`) | on exit: commits `docPaths` with `docsCommitMessage` |
| `FINALIZE` | none (empty prompt) | `git add -A` safety-net commit, then `finalize-clean-tree.sh` (clean untracked noise, gate on a clean tree) |
| `DONE` | none | terminal |
| `ESCALATED` | none | terminal: `FINALIZE` failed, a state exhausted its retries, or the rework loop exceeded `maxCycleVisits` |

The LLM prompts explicitly tell the LLM **not** to run git or jest; the
engine owns those steps. Each command with `failOnError: true` gates the
transition: if a commit or the test suite fails, the workflow does not
advance. When a state's entry commands fail (as `VERIFY` does on a failing
suite), the state fails immediately and its exit commands do not run.

## How to run

```bash
./run-test.sh
```

This will:

1. `setup.sh` — copy the agent source, seed a Jest + TypeScript project skeleton
   into `agent/workspace/project`, `git init`, `npm ci`, and seed the first
   `WorkflowAssignment` (`converter-01`) at the `IMPLEMENT` state. `run-test.sh`
   seeds `converter-02` and `converter-03` serially as each prior assignment
   reaches a terminal state.
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
- ≥4 commits (1 setup + per-state commits for 3 assignments), clean working tree

## Files

| File | Purpose |
| --- | --- |
| `workflow.json` | The deterministic state machine |
| `agent/config.template.json` | Agent config (workflow file + `teamMembers` roster) |
| `scripts/finalize-clean-tree.sh` | Deterministic hygiene finalize called from `FINALIZE` (copied to `agent/workspace/` by `setup.sh`) |
| `setup.sh` | Provisions the agent, project skeleton, and seed message |
| `run-test.sh` | Orchestrates setup → run → validate → judge |
| `validate.sh` | Deterministic pass/fail checks |
| `judge-instructions.md` | Shared task spec used by the LLM judge |
