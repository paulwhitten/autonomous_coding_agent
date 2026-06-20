# Dependency Gating Smoke Test

End-to-end verification that the workflow engine dependency gate correctly blocks, persists, and unblocks tasks based on their manifest dependencies.

## What It Tests

1. **Dependency gate fires** -- A task whose `dependsOn` prerequisites are not met transitions to BLOCKED instead of proceeding to IMPLEMENTING.
2. **Independent tasks proceed** -- A task with no dependencies passes the gate and executes normally.
3. **Auto-unblock on completion** -- When a dependency completes (markTaskDone), downstream blocked tasks are automatically re-evaluated and unblocked.
4. **Manifest status persistence** -- The `.status.json` file is written to disk after state changes.

## Architecture

```text
┌─────────────────────────────────────────────────────────┐
│  Manager Agent (smoke-dep-mgr)                          │
│                                                         │
│  Workflow: ASSIGN → IMPLEMENTING → DONE                 │
│                  └→ BLOCKED (dependency gate)           │
│                                                         │
│  Manifest: task-A (no deps), task-B (depends on task-A) │
└─────────────────────────────────────────────────────────┘
```

## Test Sequence

1. `setup.sh` seeds task-B into the manager mailbox (has dependency on task-A)
2. Agent starts, picks up task-B, dependency gate fires → BLOCKED
3. `run-test.sh` seeds task-A (no dependencies) → proceeds through IMPLEMENTING → DONE
4. markTaskDone("task-A") triggers auto-unblock of task-B
5. `validate.sh` checks logs and status file for expected behavior

## Running

```bash
cd smoke_tests/dependency-gating
./run-test.sh
```

The runner calls `setup.sh` and `validate.sh` automatically.

## Files

| File | Purpose |
|------|---------|
| `setup.sh` | Cleans artifacts, copies source, installs deps, seeds task-B |
| `run-test.sh` | Compiles, starts agent, monitors gate behavior, seeds task-A |
| `validate.sh` | Checks logs and status file for expected outcomes |
| `dep-gate-test.workflow.json` | Minimal workflow with ASSIGN, BLOCKED, IMPLEMENTING, DONE states |
| `dep-gate-test.task-manifest.json` | Two-task manifest with dependency graph |
| `manager/agent/config.template.json` | Agent configuration referencing workflow and manifest |
