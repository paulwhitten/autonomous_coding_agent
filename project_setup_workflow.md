---
title: a_c_a Project Setup Workflow
description: Complete guide for setting up a complex multi-task project using the autonomous coding agent framework with task manifests and spec files
author: pcw
ms.date: 2026-05-22
ms.topic: how-to
---

## Purpose

This document explains how to configure and launch a complex, multi-task project
using the autonomous coding agent (a_c_a) framework. It covers the full pipeline
from planning through agent execution.

The a_c_a framework supports any number of agents with arbitrary roles. Roles are
open-ended strings configured per-agent; built-in roles (`manager`, `developer`,
`qa`) are just pre-defined entries in `roles.json`. You can run a single agent
with any role and dispatch ad-hoc tasks via mailbox without a workflow or
manifest.

A **workflow** defines how a team of agents interacts — the team dynamic for the
flow of work. It specifies roles, state transitions, quality gates, and
behaviors that conform to a quality management system. Think of it as the
process definition independent of any particular assignment.

A **manifest** is the set of assignments for the team on a particular project.
It lists the concrete tasks, their ordering, dependencies, and the spec files
that describe each unit of work.

## Architecture overview

```text
┌─────────────────────────────────────────────────────────┐
│  Project Definition (projects/<id>.json)                │
│  ├── repoUrl (bare git repo)                           │
│  ├── workflow reference (generic, shared)               │
│  └── projectContext (instructions for all agents)      │
├─────────────────────────────────────────────────────────┤
│  Workflow (workflows/<name>.workflow.json)  [GENERIC]   │
│  ├── States (ASSIGN → IMPLEMENTING → VALIDATING → …)  │
│  ├── Roles (manager, developer, qa)                    │
│  ├── Transitions + exit commands                       │
│  └── globalContext: {{targetBranch}}, {{targetDir}}    │
├─────────────────────────────────────────────────────────┤
│  Task Manifest (projects/<id>/task-manifest.json)       │
│  ├── Task list with IDs and dependencies               │
│  ├── Spec file paths (relative to manifest directory)  │
│  ├── targetBranch, targetDir (override workflow defaults)│
│  └── WIP limit, branch strategy                        │
├─────────────────────────────────────────────────────────┤
│  Spec Files (projects/<id>/specs/<taskId>.md)           │
│  ├── YAML frontmatter (taskId, subject, branch)        │
│  ├── SCOPE (exact file paths)                          │
│  ├── TRANSFORMS (exact patterns to apply)              │
│  ├── ACCEPTANCE CRITERIA                               │
│  └── CONSTRAINTS                                       │
└─────────────────────────────────────────────────────────┘
```

> [!IMPORTANT]
> Workflows are **generic** and reusable across projects. They use template
> variables (`{{targetBranch}}`, `{{targetDir}}`) that get resolved per-project
> from the manifest. Manifests and specs are **project-specific** and live in
> the project directory.

## Step-by-step setup

### Step 1 — Create a bare git repository

The agents clone from a bare repo. This isolates them from your working tree.

```bash
mkdir -p /path/to/project/repo.git
cd /path/to/project/repo.git
git init --bare

# Clone it, create your integration branch, push
git clone file:///path/to/project/repo.git working-copy
cd working-copy
git checkout -b port/my-branch
# Add initial files, commit, push
git push origin port/my-branch
```

### Step 2 — Create the workflow file

Location: `/path/to/a_c_a/workflows/<name>.workflow.json`

The workflow defines the state machine that governs agent collaboration. Key
fields:

```json
{
  "id": "my-workflow",
  "name": "Human-readable name",
  "description": "What this workflow does",
  "version": "1.0.0",
  "initialState": "ASSIGN",
  "terminalStates": ["DONE", "ESCALATED"],
  "globalContext": {
    "targetBranch": "port/default-branch",
    "targetDir": "safety/DefaultModule/"
  },
  "states": {
    "ASSIGN": {
      "id": "ASSIGN",
      "name": "Task Assignment",
      "role": "manager",
      "isInitial": true,
      "transitions": [{ "to": "IMPLEMENTING", "trigger": "task_assigned" }]
    },
    "IMPLEMENTING": {
      "id": "IMPLEMENTING",
      "name": "Implementation",
      "role": "developer",
      "exitCommands": ["git add -A {{targetDir}}", "git commit -m ..."],
      "transitions": [{ "to": "VALIDATING", "trigger": "implementation_complete" }]
    },
    "VALIDATING": {
      "id": "VALIDATING",
      "name": "Validation",
      "role": "qa",
      "transitions": [
        { "to": "MERGING", "trigger": "validation_passed" },
        { "to": "IMPLEMENTING", "trigger": "validation_failed" }
      ]
    },
    "MERGING": {
      "id": "MERGING",
      "name": "Merge to target",
      "role": "qa",
      "exitCommands": ["git checkout {{targetBranch}}", "git merge --no-ff ..."],
      "isTerminal": false,
      "transitions": [{ "to": "DONE", "trigger": "merge_complete" }]
    },
    "DONE": { "id": "DONE", "isTerminal": true }
  },
  "settings": { "timeoutMs": 900000 }
}
```

The `globalContext` provides default values for template variables. These
defaults are overridden at runtime by `targetBranch` and `targetDir` from
the manifest, making the workflow reusable across projects.

Important workflow settings:

| Setting | Guidance |
|---------|----------|
| `timeoutMs` | At least 900000 (15 min) for complex tasks. 450s caused rushing. |
| `exitCommands` | Scope `git add` to `{{targetDir}}` to prevent scratch files. |
| `globalContext` | Default values for template variables. Overridden by manifest. |
| `{{targetBranch}}` | Template resolved from manifest's `targetBranch` field. |
| `{{targetDir}}` | Template resolved from manifest's `targetDir` field. |

Important per-role config settings:

| Setting | Guidance |
|---------|----------|
| `workflowFile` | Path to the shared workflow (relative to config file). |
| `manifestFile` | Path to the project's task manifest (relative to config file). |

### Step 3 — Create the task manifest

Location: `/path/to/a_c_a/projects/<id>/task-manifest.json`

The manifest defines all tasks, their ordering, and dependencies. It lives in
the project directory alongside its spec files.

```json
{
  "workflowId": "dev-qa-merge-python3",
  "name": "My Project Tasks",
  "wipLimit": 1,
  "branchStrategy": "branch-per-task",
  "targetBranch": "port/my-branch",
  "targetDir": "safety/MyModule/",
  "tasks": [
    {
      "taskId": "phase1a",
      "spec": "specs/phase1a.md",
      "description": "Short human-readable description",
      "dependsOn": [],
      "blockOnFailure": false,
      "parallelizable": true
    },
    {
      "taskId": "phase1b",
      "spec": "specs/phase1b.md",
      "description": "Another task",
      "dependsOn": ["phase1a"],
      "blockOnFailure": false,
      "parallelizable": true
    }
  ]
}
```

Key manifest fields:

| Field | Purpose |
|-------|---------|
| `workflowId` | Must match the `id` field in the workflow JSON. |
| `taskId` | Unique identifier. Must match the spec filename (without `.md`). |
| `spec` | Relative path from the manifest directory to the spec file. |
| `targetBranch` | Integration branch (overrides workflow globalContext default). |
| `targetDir` | Scoped directory for git operations (overrides workflow default). |
| `dependsOn` | Array of taskIds that must complete before this task starts. |
| `wipLimit` | Max concurrent tasks. Use 1 for sequential execution. |
| `branchStrategy` | `branch-per-task` creates `dev/<taskId>` branches. |

### Step 4 — Create spec files

Location: `/path/to/a_c_a/projects/<id>/specs/<taskId>.md`

Each spec file is the **complete instruction set** the developer agent receives.
The manager reads it and sends its content as the task assignment message. This
is the most critical artifact — if a spec is vague, the agent will fail.

#### Spec file template

```markdown
---
taskId: phase1a
subject: Short description of what this task does
branch: dev/phase1a
---

Short description of what this task does

TASK ID: phase1a

SCOPE:
  1. path/to/file1.py — what needs changing
  2. path/to/file2.py — what needs changing

TRANSFORMS:
  - `old_pattern` → `new_pattern` (where it occurs)
  - `another_old` → `another_new`

DELIVERABLES:
1. All listed files updated with the specified transforms
2. All files pass validation command

ACCEPTANCE CRITERIA:
  - Validation command passes on all files
  - No remaining instances of old patterns
  - No unrelated changes introduced

BRANCH: dev/phase1a

KEY MIGRATION PATTERNS:
- Pattern 1 explanation
- Pattern 2 explanation

REFERENCES:
- Path to reference documents
- Path to mapping tables

CRITICAL CONSTRAINTS:
- Do NOT create backup files or scripts
- Commit ONLY the listed files
- Do NOT change logic — only port syntax
```

### Step 5 — Create the project via UI

Open the a_c_a web UI and use the project creation wizard:

1. **Project Setup** — name, description, repo URL, language, tech stack,
   project context
2. **Workflow** — select your workflow from the dropdown
3. **Review Team** — verify generated configs (manager, developer, qa)
4. **Launch** — start agents

Alternatively, create the project JSON directly:

```bash
# projects/<project-id>.json
{
  "id": "my-project",
  "name": "My Project",
  "repoUrl": "file:///path/to/repo.git",
  "language": "Python",
  "workflow": "my-workflow.workflow.json",
  "projectContext": ["Instruction line 1", "Instruction line 2"],
  "buildSystem": { "buildCommand": "python -m py_compile" }
}
```

Then apply to generate configs:

```bash
curl -X POST http://localhost:3001/api/projects/my-project/apply
```

### Step 6 — Launch agents

Via UI "Launch all agents" button, or via API:

```bash
curl -X POST http://localhost:3001/api/processes/batch \
  -H "Content-Type: application/json" \
  -d '{"configFiles": ["projects/my-project/config-manager.json", "projects/my-project/config-developer.json", "projects/my-project/config-qa.json"]}'
```

The manager will start polling the manifest, read spec files, and dispatch tasks
to the developer.

## Task decomposition guidance for lesser LLMs (GPT-4.1 and similar)

This section is critical. Models like GPT-4.1 have limited context window
utilization and frequently miss patterns when given too much scope.

### Maximum file count per task

| Model tier | Max files per task | Rationale |
|---|---|---|
| Claude Opus/Sonnet | 5–8 files | Strong context retention |
| GPT-4.1, GPT-4o | 2–4 files | Misses patterns beyond ~4 files |
| GPT-4.1-mini | 1–2 files | Very limited attention span |

**Hard rule:** Never exceed 4 files per task for GPT-4.1. A prior migration
attempt assigned 19 files to one task and failed 6 times consecutively.

### Decomposition principles

1. **Group by pattern similarity** — files that need the same transforms go
   together. Do not mix "print statement fixes" with "import migration" in one
   task.

2. **One transform type per phase** — Phase 1 does syntax, Phase 2 does
   imports, Phase 3 does annotations. Never mix phases in one task.

3. **Include validation in every task** — The last acceptance criterion must be
   a concrete validation command (`py_compile`, `pylint`, `grep` for remaining
   patterns).

4. **Specify exact locations** — Do not say "fix all print statements." Say
   "fix print statements in `file.py` (lines 42, 87, 133)." Line numbers help
   the agent locate patterns without scanning the entire file.

5. **Provide before/after examples** — For complex transforms, show:

   ```text
   BEFORE: import ratools.cip.channel as channel
   AFTER:  import cip.channel_factory as channel

   BEFORE: ch = channel.create(ip)
   AFTER:  ch = channel.create_channel(ip)
   ```

6. **Explicit negative constraints** — State what the agent must NOT do:
   - Do NOT refactor logic
   - Do NOT create helper scripts
   - Do NOT add files to the commit that aren't listed
   - Do NOT delete imports, only modify or annotate

7. **Dependency chains prevent cascading failures** — If Task B depends on
   Task A's output, declare `"dependsOn": ["taskA"]` in the manifest. The
   manager will not dispatch B until A completes.

### Sizing heuristics

| Complexity | Files | Lines changed | Example |
|---|---|---|---|
| Trivial | 4 | < 10 per file | Single import rename in doc files |
| Simple | 3 | 10–30 per file | print→print() across a file |
| Medium | 2–3 | 30–80 per file | Multiple import migrations + API renames |
| Complex | 1–2 | 80+ per file | Heavy refactoring with many patterns |

### Common failure modes with GPT-4.1

| Failure | Cause | Mitigation |
|---|---|---|
| Missed patterns at end of file | Context window saturation | Provide line numbers |
| Created scratch files at repo root | Agent "helpfulness" instinct | Scoped `git add` + `.gitignore` |
| Partial completion then commit | Timeout too short | Set `timeoutMs` ≥ 900000 |
| Changed test logic | Ambiguous spec | Add "Do NOT change test logic" constraint |
| Blanket pylint disables | Agent trying to "fix" lint | Add "Do NOT add pylint disables" |
| Applied wrong pattern to wrong file | Too many files in scope | Reduce to 2–3 files per task |

### Validation work items

Every task decomposition the manager creates should include a final validation
work item. Example:

```text
Work Item 3 (validation):
- Run: python3 -W error -m py_compile safety/SafetyTask/obj/act_objs.py
- Run: python3 -W error -m py_compile safety/SafetyTask/obj/identity.py
- Run: python3 -W error -m py_compile safety/SafetyTask/obj/task.py
- Run: grep -n "print " safety/SafetyTask/obj/*.py | grep -v "print("
- Expected: all compile, grep returns empty
```

## File locations reference

| Artifact | Location |
|---|---|
| Project JSON | `a_c_a/projects/<id>.json` |
| Per-role configs | `a_c_a/projects/<id>/config-{manager,developer,qa}.json` |
| Workflow | `a_c_a/workflows/<name>.workflow.json` (generic, shared) |
| Task manifest | `a_c_a/projects/<id>/task-manifest.json` |
| Spec files | `a_c_a/projects/<id>/specs/<taskId>.md` |
| Agent logs | `a_c_a/projects/<id>/logs/{role}.log` |
| Shared mailbox | `a_c_a/projects/<id>/mailbox/` |
| Custom instructions | `a_c_a/projects/<id>/custom_instructions.json` |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Manager logs "failed to read spec file" | Spec files missing or wrong path | Create specs at `projects/<id>/specs/<taskId>.md` |
| No tasks dispatched | Dependencies not met | Check `dependsOn` — earlier tasks must complete first |
| Developer idle | No messages in mailbox | Check manager log for dispatch errors |
| Wrong workflow in configs | UI didn't re-apply | Click "Launch" (which re-applies) or `curl -X POST .../apply` |
| Agent creates junk files | Spec lacks constraints | Add CRITICAL CONSTRAINTS section to spec |
| Workflow not in UI dropdown | File not named `*.workflow.json` | Rename to match pattern |

## Checklist before launching agents

- [ ] Bare repo exists and integration branch is pushed
- [ ] Workflow JSON is valid (`python3 -m json.tool < workflow.json`)
- [ ] Task manifest JSON is valid and references correct spec paths
- [ ] All spec files exist at the paths referenced in the manifest
- [ ] Each spec has SCOPE, TRANSFORMS, ACCEPTANCE CRITERIA, CONSTRAINTS
- [ ] No spec assigns more than 4 files (for GPT-4.1)
- [ ] `.gitignore` in the repo blocks scratch files (*.bak, *.sh, *.tmp)
- [ ] Project JSON has correct `workflow` and `repoUrl` fields
- [ ] Per-role configs point to correct workflow file (check after apply)
- [ ] Per-role configs have `manifestFile` pointing to the project's task manifest
- [ ] Integration branch has no uncommitted changes

## TODO

- [ ] Rename `projects/` to `teams/` — a "team" better describes the grouping
  of agents, configs, manifests, and specs. A project implies a codebase;
  a team implies collaborating agents that can work across multiple codebases
  or assignments. This rename would affect config paths, the web UI, and the
  `project_setup_workflow.md` doc itself.
