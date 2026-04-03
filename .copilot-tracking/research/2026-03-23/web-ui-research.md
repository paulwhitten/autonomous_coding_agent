<!-- markdownlint-disable-file -->

# Web UI for Autonomous Coding Agent — Research Document

## Scope

Design a user-friendly web UI that abstracts away JSON configuration complexity and provides a visual interface for configuring agents, designing workflows, managing teams, and submitting/monitoring work.

## Current State Analysis

### Tech Stack

- **Runtime**: Node.js + TypeScript (ES modules)
- **AI SDK**: `@github/copilot-sdk` 0.1.29
- **Templating**: Handlebars
- **Logging**: Pino + pino-pretty
- **Swagger deps**: `swagger-jsdoc` + `swagger-ui-express` are installed but **unused** — indicates API layer was already planned
- **Testing**: Jest 30
- **Docker**: Docker Compose setup exists for containerized deployment

### Configuration Surface (What the UI Must Expose)

| Config Area | File | Key Fields | Complexity |
|---|---|---|---|
| Agent identity | `config.json → agent` | hostname, role, timing (3 timeouts), retry count, work item decomposition range, decomposition prompt, timeout strategy (6 params), validation mode (4 modes + params), backpressure (4 params), WIP limit | High |
| Mailbox | `config.json → mailbox` | repoPath, gitSync, autoCommit, commitMessage template, broadcast/attachments/priority toggles | Medium |
| Copilot SDK | `config.json → copilot` | model selection, allowedTools, permissions (shell/write/read/url/mcp modes) | Medium |
| Workspace | `config.json → workspace` | path, folder names (4 customizable subfolders), persistContext | Low |
| Logging | `config.json → logging` | level, path, maxSizeMB | Low |
| Manager | `config.json → manager` | hostname, role, escalation priority | Low |
| Quota | `config.json → quota` | enabled, preset name, overrides, shared URL | Medium |
| Team members | `config.json → teamMembers` | Array of {hostname, role, responsibilities} | Medium |
| Role definitions | `roles.json` | Per-role: responsibilities, tasks, escalation triggers, rework workflow, QA constraints | High |
| Custom instructions | `custom_instructions.json` | Git workflow (per-role steps + rules), coding standards (per-section), build commands, project context | High |
| Quota presets | `quota-presets.json` | Strategy presets (conservative/aggressive/adaptive) with limits, fallback, priority rules | Medium |
| Team roster | `team.json` | Team metadata, agents (id, hostname, role, capabilities, timezone), role groupings | Medium |

### Workflow Schema (Visual Designer Target)

Workflows are **deterministic state machines** defined in `.workflow.json`:

- **Top level**: id, name, description, version, initialState, terminalStates[], globalContext{}, variables[]
- **States**: keyed by name, each with:
  - role (which agent type handles it)
  - prompt (Handlebars template with `{{variable}}` substitution)
  - allowedTools[] (advisory) and restrictedTools[] (enforced deny-list)
  - requiredOutputs[] (context keys that must be present for success)
  - transitions: { onSuccess, onFailure } — deterministic, not LLM decisions
  - maxRetries, timeoutMs
  - onEntryCommands[] and onExitCommands[] (shell commands with template variables)
  - entryActions[] and exitActions[] (engine-level actions)
  - tasks[] (required work items for decomposition)
  - decompositionPrompt (free-form guidance)
  - exitEvaluation (structured LLM evaluation for routing)
  - permissions overrides (state-level SDK permission gating)

Existing workflows: `dev-qa-merge`, `hello-world`, `regulatory`, `v-model-regulatory`

### Interaction Patterns (Current)

1. **Agent startup**: `npm start config.json` — reads config, initializes workspace, starts polling loop
2. **Work submission**: Write a message file to a mailbox directory (`to_<agentId>/normal/`)
3. **Message format**: Header block (From/To/Subject/Priority/MessageType) + body
4. **Status monitoring**: Read log files, check workspace task folders (pending/completed/review/failed)
5. **Workflow monitoring**: No real-time visibility into state transitions

### Existing API Surface

**None.** There is no HTTP server, REST API, or WebSocket endpoint. The swagger dependencies are installed but unused. All interaction is file-based.

## Evaluated Approaches

### Option A: Express API + React (Vite) SPA — SELECTED

**Architecture**: Express REST API (`src/api/`) serving alongside or independently from agent processes, with a React SPA frontend (`web/`).

**Pros**:
- Swagger deps (`swagger-jsdoc`, `swagger-ui-express`) are already installed — this was likely the planned direction
- Express is lightweight, well-understood, fits the existing Node/TS stack
- React + Vite gives fast dev experience and rich component ecosystem
- Can run as a standalone "admin/dashboard" process separate from agents
- Incrementally buildable — start with config editor, add workflow designer later
- JSON Schema already exists for workflows — drives form validation automatically
- Real-time updates via WebSocket (agent status, work item progress)

**Cons**:
- Two build processes (API + frontend)
- Need to decide on state management (agent processes are separate from API server)

**Key Libraries**:
- **React Flow** (`@xyflow/react`) for visual workflow state machine designer
- **React Hook Form** + **Zod** for form-based config editing with validation
- **TanStack Query** for server state management
- **Tailwind CSS** + **shadcn/ui** for rapid, consistent UI
- **Socket.io** for real-time agent status and log streaming

### Option B: Next.js Full-Stack

**Architecture**: Next.js app with API routes and server components.

**Pros**: Single build, SSR, modern React patterns
**Cons**: Heavier framework, less control over API layer, overkill for an admin panel, adds a framework opinion the project doesn't need

### Option C: Embedded Server in Agent Process

**Architecture**: Add Express routes directly inside `AutonomousAgent` class.

**Pros**: Direct access to live agent state
**Cons**: Couples UI lifecycle to agent lifecycle, can't monitor multiple agents from one UI, crashes in agent affect UI

### Selected Approach: Option A

Express API server that reads/writes the same file-based config and mailbox system, paired with a React SPA. The API server runs independently and can manage multiple agent configurations.

## Proposed UI Sections

### 1. Dashboard
- Agent status cards (running/idle/stuck/escalated)
- Work item pipeline view (pending → working → completed/failed)
- Quota usage meters
- Recent activity feed (from log files)

### 2. Configuration Builder (Wizard)
- Step-by-step guided setup instead of raw JSON
- Agent identity (hostname, role picker, model selector)
- Timing & retry (sliders with sensible defaults, tooltips explaining each timeout)
- Mailbox setup (repo path picker, toggle switches for features)
- Permissions matrix (visual grid for shell/write/read/url/mcp)
- Quota strategy (preset picker with visual comparison)
- Advanced (backpressure, timeout strategy, validation mode)
- Preview: show generated JSON before saving

### 3. Workflow Designer
- Visual canvas with **React Flow** — drag states, connect transitions
- State editor panel (role, prompt template, tools, entry/exit commands)
- Transition wiring (success/failure edges with visual differentiation)
- Template variable reference panel
- Validation against workflow.schema.json in real-time
- Import existing workflows, export to .workflow.json

### 4. Team Management
- Team roster CRUD (add/remove agents, assign roles, capabilities)
- Role overview with agent counts
- Visual team topology

### 5. Work Submission
- Message composer (To agent picker, subject, priority, message type)
- Template library for common task types
- Workflow assignment builder (structured payload for workflow tasks)

### 6. Monitoring
- Real-time log viewer (WebSocket-streamed, filterable by level/component)
- Work item lifecycle tracker
- Workflow instance state diagram (highlight current state)
- Mailbox browser (view pending/archive messages)

## Architecture Diagram

```
┌─────────────────────────────────────────┐
│              React SPA (Vite)           │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌───────┐  │
│  │Config│ │Workflow│ │ Team │ │Monitor│  │
│  │Wizard│ │Designer│ │Mgmt  │ │Dashboard││
│  └──┬───┘ └──┬────┘ └──┬───┘ └──┬────┘  │
│     └────────┴─────────┴────────┘       │
│              HTTP + WebSocket           │
└──────────────────┬──────────────────────┘
                   │
┌──────────────────┴──────────────────────┐
│          Express API Server             │
│  ┌──────────┐ ┌──────────┐ ┌─────────┐ │
│  │Config API│ │Workflow  │ │Mailbox  │ │
│  │  CRUD    │ │  CRUD    │ │  R/W    │ │
│  └──┬───────┘ └────┬─────┘ └────┬────┘ │
│  ┌──┴───┐ ┌────────┴─────┐ ┌───┴────┐  │
│  │Schema│ │  Validation  │ │  Git   │  │
│  │Valid. │ │  Engine      │ │  Sync  │  │
│  └──────┘ └──────────────┘ └────────┘  │
│           Swagger UI at /api-docs       │
└──────────────────┬──────────────────────┘
                   │ File System
    ┌──────────────┼──────────────┐
    │              │              │
┌───┴───┐   ┌─────┴────┐  ┌─────┴─────┐
│config/│   │workflows/│  │ mailbox/  │
│ .json │   │  .json   │  │ repo      │
└───────┘   └──────────┘  └───────────┘
```

## Implementation Phases

1. **API Foundation**: Express server with config CRUD, Swagger docs, WebSocket setup
2. **Config UI**: React app with configuration wizard/form builder
3. **Workflow Designer**: React Flow-based state machine visual editor
4. **Team & Mailbox**: Team CRUD, message composer, mailbox browser
5. **Dashboard & Monitoring**: Real-time agent status, log streaming, work item tracking

## Dependencies (New)

### API Server
- `express` (already have `swagger-ui-express`)
- `cors`
- `socket.io`
- `ajv` (JSON Schema validation — validates configs + workflows against schemas)
- `chokidar` (file watching for real-time updates)

### Frontend (`web/` directory)
- `react`, `react-dom`
- `@xyflow/react` (workflow designer)
- `react-hook-form` + `@hookform/resolvers` + `zod`
- `@tanstack/react-query`
- `tailwindcss` + `@tailwindcss/vite`
- `shadcn/ui` components
- `socket.io-client`
- `lucide-react` (icons)

## Success Criteria

- Non-technical users can configure and launch agents without editing JSON
- Workflows can be designed visually and exported as valid .workflow.json
- Work can be submitted to agents through the browser
- Agent status and work progress are visible in real-time
- All generated JSON validates against existing schemas
