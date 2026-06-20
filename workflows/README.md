# Workflows

Workflow definitions are data-driven state machines stored as `.workflow.json` files. Each file defines a directed graph of states with role assignments, prompt templates, tool permissions, and transition rules.

## Schema

All workflow files are validated against [`workflow.schema.json`](workflow.schema.json). Add this to the top of any new workflow file for editor support (autocomplete, inline validation):

```json
{
  "$schema": "./workflow.schema.json",
  ...
}
```

## Files

| File | Description |
|------|-------------|
| `workflow.schema.json` | JSON Schema for workflow definitions |
| `hello-world.workflow.json` | Minimal learning workflow (manager assigns, developer completes) |
| `dev-qa-merge.workflow.json` | Standard dev/QA/merge pipeline (project default) |
| `regulatory.workflow.json` | Linear regulated pipeline with static analysis, coverage, code review, traceability |
| `v-model-regulatory.workflow.json` | V-model regulated pipeline (requirements through acceptance testing) |

### dev-qa-merge State Diagram

The dev-qa-merge workflow is the default project workflow. The diagram below
shows the state machine: Manager assigns, Developer implements on a feature
branch, QA validates (with a rework loop if needed), and a mechanical merge
lands the code on main.

![dev-qa-merge state diagram](../diagrams/dev_qa_merge.svg)

## Exit Evaluation

States can define an `exitEvaluation` field to replace regex-based fail
detection with a structured LLM question. After work items complete, the
engine sends a constrained prompt (e.g., "Did all tests pass? true/false")
and maps the parsed response to `success` or `failure` for transition routing.

See the main [README](../README.md#exit-evaluation-exitevaluation) for full
documentation and examples. The schema is defined in
[`workflow.schema.json`](workflow.schema.json) under `$defs/ExitEvaluation`.

## Mechanization Design Principle

LLMs are unreliable at deterministic tasks. When an LLM is asked to run
`git add`, `git commit`, `git push`, or execute build/test/lint commands,
it can forget a step, get the command wrong, or misreport the result. These
are not tasks that require judgment -- they are mechanical operations with
known-correct sequences. Every time we ask the LLM to do one of these, we
introduce an unnecessary opportunity for failure.

The shipped workflows apply a consistent principle: **move every
deterministic operation out of the prompt and into mechanical entry/exit
commands.** The LLM should spend its token budget only on work that
requires intelligence -- writing code, analyzing requirements, reviewing
quality. Everything else should be a deterministic command sequence that
runs regardless of what the LLM does or forgets.

### Patterns Applied

All shipped workflow files use these four patterns:

| Pattern | What It Replaces | Why |
|---------|-----------------|-----|
| `onEntryCommands` | Git fetch/checkout/reset in prompts | Guarantees the working tree is in the correct state before the LLM begins. The LLM cannot forget to sync. |
| `onExitCommands` | Git add/commit/push in prompts, build/test/lint in prompts | Guarantees work is committed and pushed after the LLM finishes. Quality gates (`failOnError: true`) block the transition if build/test/lint fail. The LLM cannot skip or misreport these. |
| `exitEvaluation` | Regex-based pass/fail detection of LLM output | Asks a direct yes/no question instead of parsing unstructured text. Eliminates false positives from verdict tables that mention both "PASS" and "FAIL". |
| `captureAs` on `onEntryCommands` | LLM manually recording SHAs in output | Records the exact commit SHA being verified, mechanically and reliably, for downstream traceability. |

### What This Means for Workflow Authors

When writing or adapting a workflow:

1. **Never put git state-management commands in the prompt.** Use
   `onEntryCommands` for checkout/sync and `onExitCommands` for
   add/commit/push. The prompt should say "You are ALREADY on branch X"
   and "Do NOT run git commands."

2. **Never rely on the LLM to run build/test/lint.** Add them as
   `onExitCommands` with `failOnError: true`. The prompt can mention
   them as context ("quality gates run automatically") but should not
   ask the LLM to execute them.

3. **Use `exitEvaluation` for every non-trivial transition decision.**
   Ask a direct boolean question. Do not parse the LLM's free-text output
   for keywords.

4. **Use `captureAs` to record SHAs.** Any command like
   `git rev-parse HEAD` that produces a value needed downstream should
   use `captureAs` to store it reliably.

5. **Make merge states fully mechanical.** If the only operations are
   git merge, push, and branch cleanup, use empty `prompt` and empty
   `allowedTools`. The entry/exit commands do all the work.

## Architectural Rationale: Declarative Workflows as Symbolic Knowledge

This system uses declarative JSON state machines rather than procedural agent
orchestration frameworks (LangGraph, CrewAI, AutoGen). This section explains
the reasoning and the symbolic AI principles that inform the design.

### The separation of knowledge and control

The foundational principle is **separation of knowledge and control**, first
articulated by Newell and Simon in their work on the General Problem Solver
(1963) and later formalized in production rule system architectures.

The architecture has three components:

| Component | Symbolic AI term | Implementation |
|-----------|-----------------|----------------|
| Knowledge base | Rule base / declarative knowledge | `.workflow.json` files + task manifests |
| Working memory | Current state of the world | Task state, context variables, mailbox messages |
| Inference engine | Domain-independent processor | `workflow-engine.ts` + `agent.ts` main loop |

The generic agent loop does not encode domain behavior. It reads the current
state from the workflow definition, renders the prompt template, restricts
tools, executes entry/exit commands, evaluates the transition condition, and
routes the assignment. All behavior differences come from the JSON
configuration, not from code changes.

### Why not procedural orchestration (LangGraph, CrewAI, etc.)

Procedural orchestration frameworks embed agent behavior in code. Each node
in a LangGraph graph is a Python function that contains the prompt, tool
binding, and routing logic. This conflates knowledge and control:

| Requirement | Declarative workflow JSON | Procedural graph code |
|---|---|---|
| Per-state prompt templates | `"prompt": "Review {{branch}}"` | Embedded in node function body |
| Per-state tool restrictions | `"allowedTools": ["terminal"]` | Bound at model level, not per-node |
| Entry/exit shell commands | `"onExitCommands": [{"cmd": "git push"}]` | Written imperatively in each node |
| Multi-agent role routing | `"role": "developer"` dispatches to physical agent | Custom routing code per edge |
| Hot-reload without restart | Edit JSON, re-read at next state | Recompile and redeploy |
| Non-programmer modification | Edit a JSON file | Edit Python/TypeScript code |

The declarative approach means a workflow author (who may not be a software
engineer) can define new workflows, add states, change transition logic, and
modify prompts without touching the inference engine code.

### Production rule systems

The workflow engine is structurally a **production rule system** — a class of
symbolic AI architecture originating in the 1970s with systems like OPS5,
CLIPS, and R1/XCON.

A production rule has the form:

```text
IF <condition> THEN <action>
```

In this system, each workflow state is a production rule:

```text
IF state = IMPLEMENTING AND result = success
THEN execute exitCommands, transition to VALIDATING, route to qa role
```

The engine pattern-matches against the current state and fires the
corresponding rule. This is the **recognize-act cycle** that all production
systems share.

Key properties inherited from production systems:

- **Modularity** — rules (states) are independent; adding a state does not
  require modifying others
- **Monotonic growth** — new capabilities are added by adding rules, not by
  restructuring existing ones
- **Transparency** — the rule that fired and why is always visible in the
  transition log
- **Domain independence** — the same engine runs any workflow definition

### Related architectures

The system also draws from:

- **Blackboard architecture** (Erman et al., 1980) — multiple specialist
  agents (developer, QA, manager) communicate through a shared workspace
  (the mailbox). Each agent operates independently and contributes to a
  common solution without direct coupling.

- **Behavior trees** (Isla, 2005; game AI) — the success/failure branching
  at each state mirrors behavior tree tick evaluation. `onSuccess` and
  `onFailure` transitions are selector/sequence nodes expressed declaratively.

- **Table-driven methods** (McConnell, *Code Complete*, 1993) — replace
  complex conditional logic with data tables. The workflow JSON is a state
  transition table that eliminates switch statements from the agent code.

### References

1. Newell, A. & Simon, H.A. (1963). GPS: A Program that Simulates Human
   Thought. In *Computers and Thought*, eds. Feigenbaum & Feldman.
   — Establishes separation of knowledge and control.

2. Forgy, C.L. (1982). Rete: A Fast Algorithm for the Many Pattern/Many
   Object Pattern Match Problem. *Artificial Intelligence*, 19(1), 17–37.
   — Production rule system matching algorithm (OPS5).

3. Buchanan, B.G. & Shortliffe, E.H. (1984). *Rule-Based Expert Systems:
   The MYCIN Experiments*. Addison-Wesley.
   — Canonical example of knowledge/control separation in expert systems.

4. Erman, L.D., Hayes-Roth, F., Lesser, V.R., & Reddy, D.R. (1980). The
   Hearsay-II Speech-Understanding System. *Computing Surveys*, 12(2).
   — Blackboard architecture for multi-agent cooperation.

5. Isla, D. (2005). Handling Complexity in the Halo 2 AI. *GDC 2005*.
   — Behavior trees for reactive agent control.

6. McConnell, S. (1993). *Code Complete*. Microsoft Press. Chapter 18:
   Table-Driven Methods.
   — Data tables as a replacement for complex conditional logic.

7. Jackson, P. (1998). *Introduction to Expert Systems*, 3rd ed.
   Addison-Wesley. Chapters 5–7.
   — Comprehensive treatment of production systems, forward/backward
   chaining, and the recognize-act cycle.

### Practical consequences

This architecture yields specific operational benefits:

1. **Testability** — the engine is tested with unit tests against synthetic
   workflow definitions. No LLM calls needed to verify state machine logic.
2. **Auditability** — every transition is logged with the rule that fired,
   the inputs, and the outputs. The trace is a complete execution record.
3. **Evolvability** — adding BLOCKED, ESCALATED, or any new state is a JSON
   edit. The engine code remains unchanged.
4. **Multi-tenancy** — different projects can use different workflow
   definitions with the same agent binary.
5. **Resilience** — the engine is deterministic. Given the same state and
   inputs, it always produces the same transition. LLM non-determinism is
   confined to within-state execution, not to the control flow.

## Customizing for Your Language

The shipped workflow files default to **Rust** (`cargo build`, `cargo test`,
`cargo clippy`). Before using any workflow, update the `globalContext` fields
`buildCommand`, `testCommand`, and `lintCommand` to match your project's
toolchain.

### Required Fields

| Field | Purpose | Examples |
|-------|---------|----------|
| `buildCommand` | Compile / build the project | `cargo build`, `npm run build`, `go build ./...`, `dotnet build` |
| `testCommand` | Run the test suite | `cargo test`, `npm test`, `pytest`, `go test ./...`, `dotnet test` |
| `lintCommand` | Run the linter | `cargo clippy -- -D warnings`, `npm run lint`, `ruff check .`, `golangci-lint run` |

These values are substituted into prompt templates and `onExitCommands` via
`{{buildCommand}}`, `{{testCommand}}`, and `{{lintCommand}}`. If they are
wrong for your language, every mechanical quality gate in the workflow will
fail.

### Example: Changing to TypeScript / Node.js

```json
"globalContext": {
  "projectPath": "workspace/project",
  "buildCommand": "npm run build",
  "testCommand": "npm test",
  "lintCommand": "npm run lint"
}
```

### Example: Changing to Python

```json
"globalContext": {
  "projectPath": "workspace/project",
  "buildCommand": "python -m py_compile $(find . -name '*.py')",
  "testCommand": "pytest",
  "lintCommand": "ruff check ."
}
```

### Language-Specific Prompt Content

Some workflow prompts contain language-specific guidance beyond the three
command fields. For example, the `VALIDATING` prompt in
`dev-qa-merge.workflow.json` references `cargo fmt --check`, `///` doc
comments, `//!` module comments, and `Display/Error` trait implementations.
When adapting a workflow to a different language, review every state's
`prompt` field and replace language-specific references with equivalents
for your toolchain.

## Development Tools

### Config Validation

Validate your `config.json` before running the agent:

```bash
# Validate default config.json
npx tsx scripts/validate-config.ts

# Validate custom config
npx tsx scripts/validate-config.ts path/to/custom-config.json
```

Checks:
- Required sections (agent, mailbox, copilot, workspace, logging, manager)
- Field types match TypeScript interfaces
- Enum values (role, validation mode, log level, priority, permissions)
- Numeric ranges (intervals, timeouts)
- File path references exist (roles file, workflow file, mailbox path)
- Permission policies are valid

### Workflow Validation

Validate workflow JSON files before using them:

```bash
# Validate single workflow
npx tsx scripts/validate-workflow.ts workflows/my-workflow.workflow.json

# Validate all workflows
npx tsx scripts/validate-workflow.ts workflows/*.workflow.json
```

Checks:
- Required fields (id, name, description, roles, initialState, states, terminalStates)
- State references (initialState, terminalStates, transitions point to existing states)
- Unreachable states detection
- Tool group resolution
- Type validation

### Workflow Structure Testing

Test workflow state machine logic without full infrastructure:

```bash
# Basic test
npx tsx scripts/test-workflow.ts workflows/my-workflow.workflow.json --task "Task description"

# With options
npx tsx scripts/test-workflow.ts workflows/my-workflow.workflow.json \
  --task "Task description" \
  --workspace ./test-ws \
  --context key=value \
  --skip-cleanup \
  --verbose
```

Tests:
- State connectivity
- Transition paths
- No infinite loops
- Terminal state reachability

**Note:** This is a structural test only - it doesn't execute LLM completions.

### Generating State Diagrams

Generate Mermaid state diagrams from workflow files to visually validate them.

**All workflows:**

```bash
cd autonomous_copilot_agent
npm run workflow:diagram
```

**Specific file:**

```bash
npx tsx scripts/workflow-to-mermaid.ts workflows/dev-qa-merge.workflow.json
```

**Save to file:**

```bash
npm run workflow:diagram > workflows/STATE_DIAGRAMS.md
```

Output includes a state table, role legend, and a Mermaid `stateDiagram-v2` block for each workflow. Paste the Mermaid blocks into any Mermaid renderer (GitHub markdown, VS Code preview, mermaid.live) to view the diagrams.
