<!-- markdownlint-disable-file -->

# Web UI Implementation Plan

## Overview

Build a web-based UI for the autonomous coding agent project with Express API + React SPA.

## Objectives

- Replace manual JSON editing with guided forms
- Visual workflow designer for state machines
- Team management and work submission UI
- Real-time agent monitoring dashboard

## Context

- Research: `.copilot-tracking/research/2026-03-23/web-ui-research.md`
- Existing swagger deps in package.json (unused)
- TypeScript + ES modules project
- File-based config and mailbox system

## Implementation Phases

### Phase 1: API Foundation <!-- parallelizable: false -->

- [x] Install API dependencies (express, cors, socket.io, ajv, chokidar, @types/express, @types/cors)
- [x] Create `src/api/server.ts` — Express server with CORS, JSON parsing, Swagger UI
- [x] Create `src/api/routes/config.ts` — CRUD for agent config files
- [x] Create `src/api/routes/workflows.ts` — CRUD for workflow definitions
- [x] Create `src/api/routes/team.ts` — CRUD for team roster
- [x] Create `src/api/routes/mailbox.ts` — Read/write mailbox messages
- [x] Create `src/api/routes/agents.ts` — Agent status and management
- [x] Create `src/api/validation.ts` — JSON Schema validation with ajv
- [x] Create `src/api/websocket.ts` — Socket.io setup for real-time events
- [x] Create `src/api/file-watcher.ts` — Chokidar-based file change detection
- [x] Add `start:api` script to package.json
- [x] Create entry point `src/api/index.ts`

### Phase 2: React App Scaffolding + Config Wizard <!-- parallelizable: false -->

- [x] Scaffold Vite + React + TypeScript app in `web/`
- [x] Install frontend deps (react, react-dom, react-router-dom, react-hook-form, zod, @hookform/resolvers, @tanstack/react-query, tailwindcss, socket.io-client, lucide-react)
- [x] Create layout with sidebar navigation
- [x] Create config wizard with multi-step form (Agent, Mailbox, Copilot, Workspace, Logging, Manager, Quota)
- [x] Add JSON preview and download
- [x] Connect to API for loading/saving configs

### Phase 3: Workflow Visual Designer <!-- parallelizable: false -->

- [x] Install @xyflow/react
- [x] Create workflow editor page with React Flow canvas
- [x] State node component (shows role, name, tools)
- [x] Transition edges (success=green, failure=red)
- [x] State property editor sidebar
- [x] Add/remove states and transitions
- [x] Import from .workflow.json / export to .workflow.json
- [x] Validate against workflow schema

### Phase 4: Team & Mailbox UI <!-- parallelizable: false -->

- [x] Team roster management page (list, add, edit, remove agents)
- [x] Message composer (to, subject, priority, message type, body)
- [x] Mailbox browser (view messages per agent)

### Phase 5: Dashboard & Monitoring <!-- parallelizable: false -->

- [x] Dashboard page with agent status cards
- [x] Work item pipeline visualization
- [x] Real-time log viewer (WebSocket-streamed)
- [x] Quota usage display

## Dependencies

- Phase 2 depends on Phase 1 (API must exist)
- Phase 3 depends on Phase 2 (React app must exist)
- Phase 4 depends on Phase 2 (React app must exist)
- Phase 5 depends on Phase 2 (React app must exist)

## Success Criteria

- `npm run start:api` launches API on port 3001
- `npm run dev:web` launches React app on port 5173
- Config wizard generates valid config.json
- Workflow designer produces valid .workflow.json
- Messages can be submitted through the browser
