# Autonomous Coding Agent - Architecture Research

## 1. Core Purpose

An **autonomous coding agent** built on the GitHub Copilot SDK (`@github/copilot-sdk`) that runs continuously, monitors an external git-based mailbox for task assignments, and executes them using LLM-powered tool calls. It supports multi-agent collaboration (manager, developer, QA, researcher) coordinated through a shared git repository as a message bus.

**Design philosophy:** "Validation is intentionally NOT built into the agent." Verification is a workflow concern — users define QA states/agents in their workflows as needed. The agent executes workflows; workflows define quality gates.

---

## 2. Tech Stack

| Component | Version/Detail |
|-----------|---------------|
| Language | TypeScript (ESM modules, `"type": "module"`) |
| Runtime | Node.js LTS (20+) |
| Core SDK | `@github/copilot-sdk` 0.1.29 |
| Template engine | Handlebars 4.7.8 |
| Logging | Pino 10.3.0 + pino-pretty 13.1.3 |
| Build | TypeScript 5.9.3, tsx 4.21.0 (dev runner) |
| Testing | Jest 30.2.0, ts-jest 29.4.6, memfs 4.56.10 |
| Other deps | swagger-jsdoc 6.2.8, swagger-ui-express 5.0.1 (listed but seemingly unused in agent core — may be for smoke test tasks) |

---

## 3. Configuration (`config.json`)

The agent is configured via a JSON file with these top-level sections:

### `agent` section

| Field | Type | Description |
|-------|------|-------------|
| `hostname` | string | Machine identifier (`"auto-detect"` or explicit) |
| `role` | enum | `developer`, `qa`, `manager`, `researcher` |
| `roleDefinitionsFile` | string | Path to roles.json |
| `customInstructionsFile` | string | Path to project-specific overlays |
| `workflowFile` | string | Path to `.workflow.json` for data-driven state machine |
| `checkIntervalMs` | number | Mailbox polling interval (min 20000 recommended) |
| `stuckTimeoutMs` | number | Escalation timeout when stuck |
| `sdkTimeoutMs` | number | Base timeout for Copilot SDK calls |
| `taskRetryCount` | number | Retries for failed work items (default: 3) |
| `minWorkItems` / `maxWorkItems` | number | Range for LLM task decomposition (default 5-20) |
| `decompositionPrompt` | string | Free-form guidance for decomposition |
| `backpressure` | object | Max pending work items, max recipient mailbox size |
| `timeoutStrategy` | object | Adaptive timeout with 4 tiers |
| `validation` | object | Mode: none/spot_check/milestone/always |
| `wipLimit` | number | Max concurrent manager delegations |

### `mailbox` section

| Field | Type | Description |
|-------|------|-------------|
| `repoPath` | string | Path to the external mailbox git repo |
| `gitSync` | boolean | Enable git pull/push for remote collaboration |
| `autoCommit` | boolean | Auto-commit mailbox changes |
| `commitMessage` | string | Template with `{hostname}`, `{role}`, `{timestamp}` |
| `supportBroadcast` | boolean | Enable `to_all/` messages |
| `supportAttachments` | boolean | Enable `attachments/` folder |
| `supportPriority` | boolean | Enable `priority/`, `normal/`, `background/` folders |

### `copilot` section

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | LLM model (`gpt-4.1`, `claude-sonnet-4.5`, etc.) |
| `allowedTools` | string[] or `"all"` | SDK tool access |
| `permissions` | object | `shell`, `write`, `read`, `url`, `mcp` policies |

### `workspace` section

| Field | Type | Description |
|-------|------|-------------|
| `path` | string | Root workspace directory |
| `tasksFolder` | string | Subfolder for work item management |
| `workingFolder` | string | Subfolder for generated code |
| `taskSubfolders` | object | Customizable: pending, completed, review, failed |
| `persistContext` | boolean | Save session context across restarts |

### Other sections
- **`logging`**: level, path, maxSizeMB
- **`manager`**: hostname, role, escalationPriority
- **`quota`**: enabled, preset, presetsFile, overrides, sharedQuotaUrl
- **`teamMembers`**: Array of `{ hostname, role, responsibilities }`

---

## 4. Workflow System

Workflows are **data-driven state machines** stored as `.workflow.json` files. Each defines a directed graph of states with role assignments, prompt templates, tool permissions, and deterministic transition rules.

### Schema Core Structure

```
workflow.json
├── id, name, version, description
├── initialState
├── terminalStates
├── globalContext (shared template variables)
└── states
    └── STATE_NAME
        ├── name, role, description
        ├── prompt ({{variable}} substitution)
        ├── allowedTools (advisory, not whitelist)
        ├── restrictedTools (enforced deny-list)
        ├── requiredOutputs
        ├── transitions: { onSuccess, onFailure }
        ├── maxRetries, timeoutMs
        ├── onEntryCommands (deterministic shell)
        ├── onExitCommands (deterministic shell)
        ├── exitEvaluation (LLM yes/no gate)
        ├── tasks (required decomposition items)
        ├── decompositionPrompt
        └── permissions (SDK overrides per state)
```

### Key Design Principle: Mechanization

All shipped workflows follow: **move every deterministic operation out of
the prompt and into mechanical entry/exit commands.** The LLM spends tokens
only on work requiring intelligence. Git operations, builds, tests, and
linting are executed mechanically by `onEntryCommands`/`onExitCommands`.

### Shipped Workflows

| File | Description |
|------|-------------|
| `hello-world.workflow.json` | Minimal: ASSIGN → DO_WORK → DONE |
| `dev-qa-merge.workflow.json` | Standard pipeline: ASSIGN → IMPLEMENTING → VALIDATING → MERGING → DONE (with REWORK loop) |
| `regulatory.workflow.json` | Linear regulated pipeline with static analysis, coverage, code review, traceability |
| `v-model-regulatory.workflow.json` | V-model: requirements through acceptance testing |

### Exit Evaluation

States define structured LLM-answered questions (boolean or enum) to
replace unreliable regex-based pass/fail detection. The engine parses the
response and maps it to success/failure for transition routing.

---

## 5. Multi-Agent Collaboration (Mailbox System)

### Architecture

Agents communicate via a **shared git repository** acting as a message bus:

```
mailbox-repo/
├── mailbox/
│   ├── to_hostname_role/
│   │   ├── priority/      (HIGH priority messages)
│   │   ├── normal/         (routine assignments)
│   │   ├── background/     (low priority)
│   │   └── archive/        (processed messages)
│   └── to_all/             (broadcast messages)
└── attachments/            (shared files)
```

### Message Format

Messages are Markdown files with headers:
```
Date: 2026-01-30T21:45:00Z
From: i9_manager
To: mbp16_developer
Subject: Implement user authentication
Priority: HIGH
MessageType: workflow

[Body content — free text or JSON payload]
```

### Message Types

- `workflow` — Structured `WorkflowAssignment` JSON payload
- `oob` — Out-of-band message (urgent interrupts)
- `status` — Informational (logged but not decomposed)
- `unstructured` — Free-text (legacy/human messages)

### Priority System

Messages are checked in order: `priority/` → `normal/` → `background/`

### Git Sync

On each mailbox check: `git pull` → read messages → process → archive → `git add/commit/push`

### Backpressure

Configurable limits on pending work items and recipient mailbox depth to
prevent overloading agents.

### WIP Limit (Manager)

Manager can set `wipLimit` to cap concurrent in-flight delegations.

---

## 6. User Interaction (CLI Commands & Scripts)

### npm scripts

| Command | Description |
|---------|-------------|
| `npm start` | Build TypeScript and run agent |
| `npm run start:dev` | Run via tsx (no build step) |
| `npm run dev` | Watch mode with hot reload |
| `npm run check-mailbox` | One-shot mailbox check |
| `npm run generate-instructions` | Regenerate copilot-instructions.md |
| `npm run quota-status` | Display quota usage |
| `npm run workflow:diagram` | Generate Mermaid diagrams from workflows |
| `npm run build` | TypeScript compilation |
| `npm run test` | Run Jest tests |
| `npm run test:watch` | Jest in watch mode |
| `npm run test:coverage` | Jest with coverage |

### Utility Scripts

| Script | Description |
|--------|-------------|
| `scripts/validate-config.ts` | Validates config.json structure, types, field values, and file references |
| `scripts/quota-status.ts` | Displays formatted quota usage report from workspace/quota_state.json |
| `scripts/check-mailbox.ts` | Quick manual mailbox check without starting the agent loop |
| `scripts/generate-instructions.ts` | Generates `.github/copilot-instructions.md` from roles.json + custom_instructions.json |
| `scripts/workflow-to-mermaid.ts` | Converts workflow JSON to Mermaid state diagrams |
| `scripts/validate-workflow.ts` | Validates workflow JSON files against schema |
| `scripts/test-workflow.ts` | Tests workflow state machine logic without infrastructure |
| `scripts/smoke-test-cli.ts` | CLI for smoke tests |
| `scripts/test-verification.ts` | Test verification utilities |
| `scripts/render-diagrams.sh` | Render Mermaid diagrams to SVG |
| `scripts/export-to-external-dist.sh` | Export to external distribution |

### Starting the Agent

```bash
# Standard start
npm start

# With custom config
npm start my-config.json

# Development mode
npm run dev
```

### Monitoring

```bash
tail -f logs/agent.log           # Real-time logs
cat workspace/session_context.json  # Agent state
cat workspace/quota_state.json      # Quota state
npm run quota-status                # Formatted quota report
```

---

## 7. Role System

### Defined Roles (roles.json)

| Role | Description |
|------|-------------|
| **Developer** | Implements, tests, documents code. Works on feature branches, pushes, sends completion reports. Max 2 rework cycles before escalation. |
| **QA** | Read-only validation. Runs build/test/lint on feature branches. Approves (merge to main) or rejects (rework). Never modifies source files. |
| **Manager** | Coordination only. Never writes code or runs builds. Delegates via `send_message()`. Tracks in-flight delegations. Sequential task pipeline. |
| **Researcher** | Literature review, SOTA analysis, methodology guidance. Depth over speed. |

### Instruction Generation Pipeline

```
roles.json (generic role identity)
  + custom_instructions.json (project-specific overlays)
  → generate-instructions.ts
  → .github/copilot-instructions.md (Copilot reads this)
```

Auto-regenerated on startup and when config files change (hot reload via ConfigWatcher).

### custom_instructions.json

Adds project-specific content:
- `gitWorkflow` — branch/merge rules per role
- `codingStandards` — language, pre-commit checklist, sections
- `buildSystem` — build/test/lint/format commands
- `projectContext` — domain-specific context lines
- `additionalSections` — arbitrary extra sections

---

## 8. Key Interfaces and Types (types.ts)

### Core Types

- **`AgentConfig`** — Full configuration structure (agent, mailbox, copilot, workspace, logging, manager, quota, teamMembers)
- **`MailboxMessage`** — Parsed message with filename, filepath, date, from, to, subject, priority, messageType, content, payload
- **`MessageType`** — `'workflow' | 'oob' | 'status' | 'unstructured'`
- **`SessionContext`** — Agent runtime state: agentId, currentTask, status, nextMessageSequence, messageTracking, reworkTracking, inFlightDelegations
- **`TaskAssignment`** — Parsed task with messageId, subject, description, acceptanceCriteria, dueDate, priority
- **`AgentStatus`** — Runtime status: running, currentTask, uptime, tasksCompleted, lastActivity
- **`TeamAgent`** — Team member: id, hostname, role, capabilities, timezone
- **`TeamRoster`** — Full team: team metadata, agents array, roles map

### Session Status Values

`'idle' | 'working' | 'stuck' | 'escalated' | 'breaking_down_task'`

---

## 9. Agent Lifecycle

### Initialization (`initialize()`)
1. Create workspace and log directories
2. Generate `.github/copilot-instructions.md` from role definitions
3. Initialize mailbox (create folder structure)
4. Initialize workspace manager (pending/completed/review/failed)
5. Initialize quota manager and timeout manager
6. Perform initial git sync
7. Load previous session context (if `persistContext: true`)
8. Start config file watcher for hot reload
9. Load workflow definition (if `workflowFile` configured)

### Main Loop (`start()`)
1. Create/resume Copilot SDK session
2. Enter continuous loop:
   a. Check rate-limit backoff (sleep if active)
   b. Check priority mailbox first (urgent messages)
   c. Check WIP limit (manager only — wait if at capacity)
   d. Check for pending work items (resume incomplete tasks)
   e. Check normal mailbox for new messages
   f. Decompose new messages into work items
   g. Execute work items sequentially via WorkItemExecutor
   h. Track completion, send reports, archive messages
   i. Save session context
   j. Sleep with jitter until next check interval

### Work Item Execution Flow
1. LLM decomposes task into sequential work items (5-20 by default)
2. Work items saved to `workspace/tasks/pending/`
3. WorkItemExecutor sends each to Copilot SDK with:
   - Prompt from `buildWorkItemPrompt()` or workflow state prompt
   - Tool set (mailbox tools + SDK built-in tools)
   - Permission handler for SDK operations
4. SDK creates/resumes a CopilotSession
5. LLM executes using available tools (terminal, file ops, git, etc.)
6. On completion: move to `completed/` (or `review/` for spot checks)
7. On failure: retry up to `taskRetryCount` times, then move to `failed/`

### Shutdown (`stop()`)
Graceful shutdown on SIGINT/SIGTERM. Saves context, cleans up sessions.

---

## 10. Docker Setup

### Architecture
- Host runs Copilot CLI in server mode (port 3000)
- Container(s) run the agent code, connecting to host CLI via `COPILOT_CLI_URL`
- Based on `node:20-slim`
- Optional language toolchains: Python, Rust, Go, Java (build args)

### Volumes
- `workspace/` — persistent agent workspace
- `mailbox/` — shared mailbox repo
- `logs/` — agent logs
- `config.json` — read-only config mount

### Docker Compose
- Single service with `restart: unless-stopped`
- Commented examples for multi-agent setup (developer + QA containers)
- `host.docker.internal` for Mac/Windows, host networking for Linux

---

## 11. API / Server Capabilities

**The agent does NOT expose an HTTP API or server.** It is a CLI-only autonomous
process. The `swagger-jsdoc` and `swagger-ui-express` dependencies in
package.json appear to be vestigial or intended for smoke test tasks (the
intermediate smoke test has the agent build an Express API with Swagger docs),
not used by the agent itself.

The agent's only external interface is:
- The git-based mailbox protocol (file-based message passing)
- Log files for monitoring
- `session_context.json` and `quota_state.json` for state inspection

---

## 12. Architecture Diagram

From `diagrams/architecture.mmd`:

```
CLI (Copilot SDK) ←→ Agent Loop → External Mailbox
                                → Workspace Manager → Work Item Executor → CLI
```

The agent loop cycle:
1. Check priority mailbox
2. Process pending work items
3. Check normal mailbox
4. Sleep until next interval

---

## References

- [README.md](README.md) — Main documentation
- [QUICKSTART.md](QUICKSTART.md) — 5-minute setup guide
- [ROLES.md](ROLES.md) — Role-based configuration system
- [workflows/README.md](workflows/README.md) — Workflow authoring guide
- [workflows/workflow.schema.json](workflows/workflow.schema.json) — Full JSON Schema
- [config.example.json](config.example.json) — Configuration reference
- [custom_instructions.example.json](custom_instructions.example.json) — Overlay example
- [docker/README.md](docker/README.md) — Docker deployment guide
- [smoke_tests/](smoke_tests/) — Working examples

## Discovered Topics

- **Config hot-reload**: ConfigWatcher monitors config.json and applies safe field changes at runtime without restart
- **Fail pattern detector**: `fail-pattern-detector.ts` scans LLM output for failure indicators
- **Exit evaluation**: Structured LLM-answered yes/no gates replace unreliable regex matching
- **Permission handler**: Granular SDK permissions (shell allowlist, write/read/url/mcp)
- **Tool health monitor**: Detects PTY/infrastructure failures
- **Quota management**: Preset-based quota tracking with model fallback
- **Team roster**: `team.json` in mailbox repo for agent discovery
- **Backpressure system**: Prevents overloading agents with too many pending items
- **Timeout strategy**: 4-tier adaptive timeout handling

## Clarifying Questions

None — all research topics fully covered through source code and documentation.
