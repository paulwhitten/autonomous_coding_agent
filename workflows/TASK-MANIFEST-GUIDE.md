---
title: Task Manifest Authoring Guide
description: How to decompose work into a task manifest for autonomous multi-agent execution with non-frontier models
author: pcw
ms.date: 2026-05-13
ms.topic: how-to
---

## Overview

A task manifest declares a set of tasks and their dependencies for autonomous
execution by a multi-agent system. The manager agent dispatches tasks from the
manifest through a state machine (ASSIGN → IMPLEMENTING → VALIDATING → MERGING
→ DONE), routing work to developer and QA agents via a filesystem mailbox.

This guide documents how to author manifests that non-frontier models (GPT-4.1,
Claude Sonnet) can execute reliably without human intervention over long periods.

## File Layout

```text
workflows/
├── dev-qa-merge.task-manifest.json        # The manifest
├── dev-qa-merge.workflow.json             # Workflow state machine definition
├── task-manifest.schema.json              # JSON Schema for validation
└── specs/
    ├── task-001.md                        # Spec for each task
    ├── task-002.md
    └── ...
```

At runtime the engine creates a sibling `.status.json` file to persist task
states across restarts:

```text
workflows/
└── dev-qa-merge.task-manifest.status.json
```

## Manifest Structure

```json
{
  "$schema": "./task-manifest.schema.json",
  "workflowId": "dev-qa-merge",
  "name": "Widget Refactor",
  "wipLimit": 1,
  "branchStrategy": "branch-per-task",
  "targetBranch": "main",
  "tasks": [
    {
      "taskId": "task-001",
      "spec": "specs/task-001.md",
      "description": "Extract shared utilities into utils module",
      "dependsOn": [],
      "blockOnFailure": true,
      "parallelizable": true
    }
  ]
}
```

### Key Fields

| Field | Purpose |
|-------|---------|
| `workflowId` | Must match a loaded `.workflow.json` definition |
| `wipLimit` | Max tasks in non-terminal states. Use 1 for sequential execution |
| `branchStrategy` | `branch-per-task` creates `dev/<taskId>` branches automatically |
| `targetBranch` | Branch that completed tasks merge into |
| `taskId` | Lowercase with hyphens. Keep short — it becomes the branch name |
| `spec` | Relative path to the task specification markdown |
| `dependsOn` | Task IDs that must reach DONE before this task dispatches |
| `blockOnFailure` | If true and a dependency fails, this task moves to BLOCKED |

## Decomposition Principles for Non-Frontier Models

Non-frontier models lack the context window and reasoning depth to handle
large, ambiguous tasks. Decomposition must compensate for these limitations.

### Right-Size Each Task

Target **1-3 files** per task with a **single clear objective**. The model
should not need to hold more than ~50KB of context (spec + file contents +
prompt) to complete the work.

Bad: "Refactor all modules in src/legacy/"
Good: "Refactor src/legacy/auth/ and src/legacy/session/ (6 files)"

Even the "good" example above can be large. For GPT-4.1, prefer splitting
further into groups of 5-10 files per task.

### Explicit Scope — No Inference Required

Every spec must state:

1. **Exact file paths** to edit (absolute paths eliminate ambiguity)
2. **Exact transformations** to apply (patterns with before/after examples)
3. **Validation commands** the agent will run
4. **What NOT to do** (critical constraints section)

The agent should never need to "figure out" what to do. If it requires
judgment, it should be a frontier-model task or decomposed further.

### Dependency Chains Over Parallelism

With `wipLimit: 1`, tasks execute sequentially regardless of `parallelizable`.
Use `dependsOn` to enforce ordering when tasks share files or when later tasks
depend on outputs of earlier ones.

Pattern for phased work:

```text
phase0 (infrastructure/setup) → no dependencies
phase1 (core shared code)     → depends on phase0
phase2 (bulk porting)         → depends on phase1
phase3 (integration)          → depends on phase2
phase4 (validation)           → depends on phase3
```

### Spec File Anatomy

```markdown
---
taskId: task-001
subject: Extract shared utilities into utils module
branch: dev/task-001
seededAt: 2026-05-12T15:34:56.000Z
sequence: 001
---

One-line summary of the task.

TASK ID: task-001

SCOPE:
- Exact files to touch
- Exact operations to perform

DELIVERABLES:
1. Numbered list of concrete outputs

ACCEPTANCE CRITERIA:
- Testable pass/fail conditions
- Commands the agent (or QA) will run

BRANCH: dev/task-001

REFERENCES (common to all tasks):
- Shared reference material (repeated in every spec for context independence)

KEY MIGRATION PATTERNS:
- before -> after (domain-specific transformation reference)

CRITICAL CONSTRAINTS:
- What NOT to do (guardrails for the model)
```

#### Design Rationale

- **Frontmatter** provides machine-readable metadata; the engine uses `taskId`
  and `branch` for routing and branch creation.
- **REFERENCES repeated in every spec** makes each task context-independent.
  The agent processes one spec at a time — it cannot look at other specs.
- **CRITICAL CONSTRAINTS** prevent common model failure modes (creating backup
  files, copying files to wrong locations, adding unnecessary scaffolding).
- **Absolute paths** eliminate path resolution errors across working directories.

## The Mailbox System

Agents communicate via a filesystem-based mailbox. Each agent has incoming
directories organized by priority:

```text
projects/<project>/mailbox/
├── to_<hostname>_<role>/
│   ├── priority/     # HIGH priority messages
│   ├── normal/       # Standard messages
│   └── background/   # LOW priority messages
│   └── archive/      # Processed messages
└── to_all/           # Broadcast messages
```

### send-message Script

Send ad-hoc messages to agents:

```bash
npm run send-message -- \
  --to myhost_developer \
  --subject "Fix import in utils.ts" \
  --body "Replace deprecated 'readFileSync' call with async 'readFile'" \
  --priority NORMAL \
  --config projects/my-project/config-manager.json
```

The `--to` format is `<hostname>_<role>`. The script parses the last underscore
to split hostname from role.

### Message File Format

Messages are markdown files with a header block:

```text
From: myhost_manager
To: myhost_developer
Subject: [Workflow] IMPLEMENTING: task-001
Priority: NORMAL
Type: workflow
Date: 2026-05-13T12:18:16.920Z
---

{ JSON payload with assignment details }
```

### Filename Construction

Filenames are derived from timestamp + sanitized subject:

```text
2026-05-13-1218__workflow_implementing_sf_phase0d.md
```

The sanitized subject is truncated to 236 characters to stay under Linux's
255-byte filename limit.

## Observed Problems and Fixes

### Problem 1: Subject Line Accumulation (ENAMETOOLONG)

**Symptom**: Task was dispatched but never received by the developer.
No error in logs. Agent appeared stalled indefinitely.

**Root Cause**: Each state transition prepended `[Workflow] STATE:` to the
message subject. After 3 cycles (0a → 0b → 0c), the accumulated subject
produced a filename of 271 characters — exceeding Linux's 255-byte limit.
`fs.writeFile` threw ENAMETOOLONG, caught silently by the backend.

**Example of accumulation**:

```text
Cycle 1: [Workflow] IMPLEMENTING: task-001                          (clean)
Cycle 2: [Workflow] IMPLEMENTING: [Workflow] DONE: ... task-001     (inherited)
Cycle 3: [Workflow] IMPLEMENTING: [Workflow] DONE: ... [Workflow] ... task-001
Cycle 4: (271 chars — ENAMETOOLONG)
```

**Fix**: Two changes applied:

1. Truncate sanitized filename to 236 chars in `mailbox.ts`
2. Use bare `taskId` as subject base in peer-routing instead of
   `this.context.currentTask?.subject` (which accumulated prefixes)

### Problem 2: Silent Send Failure

**Symptom**: Same as above — message never delivered, no error logged.

**Root Cause**: `git-mailbox-backend.ts` caught the ENAMETOOLONG error and
returned `{success: false}` without logging. The calling code in `agent.ts`
never checked `routeResult.success`.

**Fix**:

1. Added error logging in the catch block of `git-mailbox-backend.ts`
2. Added `routeResult.success` check in the peer-routing code with early
   return and error log

### Problem 3: Stale currentTask Context During Dispatch

**Symptom**: Subjects referenced wrong task IDs in filenames (all showed
`task-001` regardless of actual task).

**Root Cause**: `handleWorkflowTransition()` built the outbound subject from
`this.context.currentTask?.subject`, but when called from `dispatchReadyTasks`,
`currentTask` still held the previous DONE message's context — not the task
being dispatched.

**Fix**: Use the bare `taskId` from the workflow engine (authoritative) rather
than the stale session context field.

### Problem 4: Unnecessary LLM Call on Mechanical Routing

**Symptom**: 6-second delay on every mechanical ASSIGN → IMPLEMENTING transition.

**Root Cause**: `extractStateSummary()` runs unconditionally on all state
transitions, including the manager's ASSIGN state where no real work occurred.
It calls the LLM to "summarize what you did" — for a state that did nothing.

**Impact**: Performance only. Not a correctness issue. The routing decision is
fully deterministic (state machine lookup from workflow YAML). The LLM is never
consulted for routing.

**Status**: Known issue. Could skip summary extraction when the state was
processed via the mechanical fast-path (empty prompt).

### Problem 5: WIP Slot Not Released on Send Failure

**Symptom**: After the task failed to send, the manager recorded a WIP
delegation. The WIP slot was never released because the developer never sent
DONE. The WIP watchdog eventually freed it (~45 minutes later), but no
re-dispatch occurred because the task was already marked "dispatched".

**Lesson**: The `routeResult.success` check (Fix #2) now prevents WIP recording
when the send fails. Combined with keeping the task in "ready" state on failure,
the next dispatch cycle will retry.

## Operational Tips

### Status File

The `.status.json` file persists task states across agent restarts. To reset a
stuck task:

```bash
# Edit the status file directly
vim workflows/dev-qa-merge.task-manifest.status.json
# Change "dispatched" back to "ready"
```

### Monitoring

```bash
# Watch manager dispatch activity
tail -f projects/<project>/logs/manager.log | grep -i "dispatch\|phase"

# Check developer progress
tail -f projects/<project>/logs/developer.log | grep -i "work item\|completed"

# Inspect mailbox state
ls projects/<project>/mailbox/to_<hostname>_<role>/normal/
ls projects/<project>/mailbox/to_<hostname>_<role>/archive/
```

### Killing and Restarting Agents

```bash
# Find agent PIDs
ps aux | grep "node.*dist/cli" | grep -v grep

# Kill all agents
kill <manager_pid> <developer_pid> <qa_pid>

# Restart via the Web UI (port 5173) or CLI
```

### Pre-Flight Checklist

Before starting a long autonomous run:

1. Verify specs are self-contained (each spec has all context it needs)
2. Validate manifest schema: check `$schema` reference resolves
3. Confirm branch strategy: bare repo has `targetBranch` available
4. Test one task manually: dispatch task-001 alone, verify full cycle
5. Check WIP limit: start with 1 until the pipeline is proven stable
6. Verify mailbox paths: all agents point to the same mailbox root
