<!-- markdownlint-disable-file -->

# A2A Protocol Integration

This document describes the Agent2Agent (A2A) protocol integration added to the autonomous agent framework. The A2A protocol provides a standard way for agents to communicate, advertise capabilities, and discover each other across network boundaries.

## Architecture Overview

The integration follows a composite-backend pattern. Both the git-based mailbox and the A2A HTTP server are always active with sensible defaults -- no configuration is required. A `CompositeBackend` wraps both sources and merges incoming messages into a single FIFO queue ordered by timestamp (earliest first). To customize A2A behavior (port, TLS, known agents, etc.) add an optional `communication.a2a` block to `config.json`.

```text
+---------------------+
| CommunicationBackend|  (interface)
+----------+----------+
           |
   +-------v--------+
   |CompositeBackend |
   +---+--------+----+
       |        |
 +-----v--+ +---v-----+
 | Mailbox| |  A2A    |
 | Backend| | Backend |
 +--------+ +---------+
```

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| Backend interface | `src/communication-backend.ts` | Transport-agnostic API for send, receive, discover, audit |
| Composite backend | `src/backends/composite-backend.ts` | Wraps mailbox and A2A into a single FIFO queue |
| Git mailbox backend | `src/backends/git-mailbox-backend.ts` | Wraps MailboxManager for backward compatibility |
| A2A backend | `src/backends/a2a-backend.ts` | A2A client/server integration with inbox persistence |
| Backend factory | `src/backend-factory.ts` | Always creates both mailbox and A2A, returns CompositeBackend |
| Agent URI parser | `src/agent-uri.ts` | Parses `a2a://` and `mailbox://` transport URIs for routing decisions |
| Agent card utilities | `src/agent-card.ts` | Enriched agent cards with A2A skill mapping |
| Message mapper | `src/a2a-message-mapper.ts` | Bidirectional AgentMessage to A2A wire format |
| Agent executor | `src/a2a-executor.ts` | Bridges A2A requests to internal message pipeline |
| A2A HTTP server | `src/a2a-server.ts` | Express-based A2A server (JSON-RPC, REST, agent card) |
| Audit logger | `src/a2a-audit-logger.ts` | Git-backed JSONL audit capture |
| Discovery provider | `src/discovery-provider.ts` | Well-known URI probing and registry lookup |

## Configuration

Both the git mailbox and the A2A HTTP server start automatically with sensible defaults. No configuration is required for either. Add an optional `communication.a2a` block only when you need to override defaults:

```json
{
  "communication": {
    "a2a": {
      "serverPort": 4000,
      "transport": "jsonrpc",
      "tls": { "enabled": false },
      "authentication": { "scheme": "none" },
      "pushNotifications": { "enabled": false },
      "knownAgentUrls": [
        "http://dev-server-1:4000",
        "http://qa-server-1:4001"
      ],
      "registryUrl": "",
      "auditDir": "audit/a2a"
    }
  }
}
```

Omit the entire `communication` block to use all defaults.

### Configuration Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `a2a.serverPort` | number | 4000 | HTTP port for the local A2A server (0 = OS-assigned) |
| `a2a.agentCardPath` | string | `"/.well-known/agent-card.json"` | Path to serve the agent card |
| `a2a.transport` | string | `"jsonrpc"` | Wire protocol (`jsonrpc`, `rest`, `grpc`) |
| `a2a.tls.enabled` | boolean | false | Enable TLS for the A2A server |
| `a2a.authentication.scheme` | string | `"none"` | Authentication method (`none`, `bearer`, `apiKey`) |
| `a2a.pushNotifications.enabled` | boolean | false | Enable A2A push notifications |
| `a2a.knownAgentUrls` | string[] | [] | URLs of peer agents to probe at startup |
| `a2a.registryUrl` | string | `""` | Optional agent registry for dynamic lookup |
| `a2a.auditDir` | string | `"audit/a2a"` | Directory for audit log files |
| `a2a.agentCard` | object | _(derived)_ | Override auto-generated agent card fields |

## How the Backends Relate

### Always-on composite

Both the git mailbox and the A2A HTTP server are always active. `src/backend-factory.ts` wraps both in a `CompositeBackend` that:

1. Always creates `GitMailboxBackend`.
2. Always creates `A2ABackend` (using sensible defaults when `communication.a2a` is absent).
3. Returns a `CompositeBackend` that delegates to both.

`CompositeBackend.receiveMessages()` polls both sources and returns a merged FIFO queue sorted by timestamp (earliest first). `sendMessage()` routes based on the target's `uri` field: `a2a://` routes to the A2A backend, `mailbox://` or absent defaults to the git mailbox. The legacy `url` field is still respected as a fallback when no `uri` is set.

### Transport URI Scheme

Each agent in `team.json` may include an optional `uri` field that declares the preferred transport for reaching that agent. The URI scheme determines which backend delivers the message.

| Scheme | Example | Behavior |
|--------|---------|----------|
| `a2a://` | `a2a://dev-server-1:4000` | Route via A2A HTTP backend. The scheme is stripped and `http://` is prepended to form the HTTP URL. |
| `mailbox://` | `mailbox://dev-server-1_developer` | Route via the git mailbox backend (explicit). |
| _(absent)_ | _(no uri field)_ | Route via the git mailbox backend (default). Backward compatible with existing team.json files. |

Example `team.json` with mixed transports:

```json
{
  "team": { "name": "mixed-transport-team" },
  "agents": [
    {
      "hostname": "dev-server-1",
      "role": "developer",
      "capabilities": ["coding"],
      "uri": "a2a://dev-server-1:4000"
    },
    {
      "hostname": "qa-server",
      "role": "qa",
      "capabilities": ["testing"]
    }
  ]
}
```

In this example, messages to `dev-server-1` route through A2A (`http://dev-server-1:4000`), while messages to `qa-server` route through the git mailbox (no `uri` so the default applies).

**Backward compatibility.** Agents without a `uri` field automatically default to mailbox routing. Existing `team.json` files continue to work without changes.

**Hot-reload.** The `uri` field is part of `teamMembers` which is hot-reloadable. Updating a team member's URI in `config.json` at runtime causes the agent to use the new transport on the next message without restarting. The `team.json` file is watched by `ConfigWatcher` with filesystem polling (default 5-second interval) and changes trigger A2A known-agents cache invalidation. Discovered agent cards from remote URLs are cached separately by `DiscoveryProvider` with a 5-minute TTL.

### URI parsing

The `src/agent-uri.ts` module provides `parseAgentUri()` which converts a URI string into a routing decision:

```typescript
parseAgentUri('a2a://host:4000')   // { scheme: 'a2a', a2aUrl: 'http://host:4000' }
parseAgentUri('mailbox://agent')   // { scheme: 'mailbox' }
parseAgentUri(undefined)           // { scheme: 'mailbox' }  -- backward compat
parseAgentUri('')                  // { scheme: 'mailbox' }  -- backward compat
```

### A2A assignment persistence

Incoming A2A assignments are persisted as timestamped JSON files in `a2a_inbox/` (e.g., `20260402T153012Z_<msgid>.json`). On each poll the A2A backend reads the inbox, returns the messages, and after the agent acknowledges completion the file moves to `a2a_archive/`. Deduplication is by message ID.

### When to configure A2A

Both transports are always active. The table below shows when to add an explicit `communication.a2a` block to customize behavior.

| Scenario | Configuration |
|----------|---------------|
| Single machine or same-network team sharing a git repo | No configuration needed -- defaults work out of the box |
| Need a specific HTTP port or TLS for the A2A server | Add `communication.a2a` with `serverPort` or `tls` |
| Agents on separate hosts needing peer discovery | Add `communication.a2a` with `knownAgentUrls` |
| Cross-organisation agent interop using the A2A standard | Add `communication.a2a` with `registryUrl` |

## Agent Cards

Each agent advertises an A2A-compliant agent card at `/.well-known/agent-card.json`. The card includes structured skills derived from the team roster capabilities.

### Capability to Skill Mapping

Flat capability strings from `team.json` are automatically converted to structured A2A skills:

```text
capabilities: ["python", "testing"]
  ->
skills: [
  { id: "python", name: "python", tags: ["python", "developer"] },
  { id: "testing", name: "testing", tags: ["testing", "developer"] }
]
```

Explicit `skills[]` entries in `team.json` take precedence and are merged with auto-generated skills.

### Team Roster Schema Extension

The `team.json` schema supports optional A2A fields on each agent:

```json
{
  "id": "dev-server-1_developer",
  "hostname": "dev-server-1",
  "role": "developer",
  "skills": [
    {
      "id": "python-dev",
      "name": "Python Development",
      "description": "Write and debug Python code",
      "tags": ["python", "debugging"],
      "inputModes": ["text/plain"],
      "outputModes": ["text/plain", "application/json"]
    }
  ],
  "url": "http://dev-server-1:4000",
  "protocolVersion": "0.3.0"
}
```

## Discovery

The `DiscoveryProvider` supports three discovery mechanisms:

1. **Local roster** -- agents from `team.json` are seeded into the cache at startup
2. **Well-known URI** -- probe `http://<host>/.well-known/agent-card.json` for remote agents
3. **Registry** -- query a central registry when `registryUrl` is configured

Discovery works with both backends. Even when using the git mailbox, the `find_agents_by_capability` tool searches structured skills and tags.

## Audit and Regulatory Evidence

When using the A2A backend, all protocol interactions are captured in JSONL audit logs:

```text
audit/a2a/
  dev-server-1_developer-audit.jsonl
  qa-server-1_qa-audit.jsonl
```

Each line contains:

```json
{
  "id": "uuid",
  "timestamp": "2026-03-10T12:00:00.000Z",
  "agentId": "dev-server-1_developer",
  "direction": "outbound",
  "remoteAgent": "qa-server-1_qa",
  "method": "sendMessage",
  "status": "success",
  "durationMs": 145,
  "request": { "..." },
  "response": { "..." }
}
```

Audit logs are committed to git via `syncToRemote()` for tamper-evidence.

## Message Format Mapping

The mapper translates between the internal `AgentMessage` format and A2A wire messages:

| AgentMessage field | A2A wire location |
|--------------------|-------------------|
| `content` | `parts[0].text` |
| `subject` | `metadata.subject` |
| `priority` | `metadata.priority` |
| `messageType` | `metadata.messageType` |
| `from` | `metadata.fromAgent` |
| `attachments` | Additional `parts[]` entries |

## Backward Compatibility

- The git mailbox is always active regardless of whether a `communication` config is present
- All existing mailbox tools (`check_mailbox`, `send_message`, etc.) continue to work unchanged
- The `get_team_roster` and `find_agents_by_capability` tools return enriched agent cards regardless of which backends are running
- The A2A SDK (`@a2a-js/sdk`) is a required dependency (always loaded)

## Dependencies

| Package | Version | Required When |
|---------|---------|---------------|
| `@a2a-js/sdk` | ^0.3.12 | Always (A2A is always active) |
| `express` | ^5.1.0 | Always (A2A is always active) |

Install dependencies:

```bash
npm install @a2a-js/sdk express
```

---

## Assignment Persistence and Processing Order (2026-04-02)

**A2A assignments are now persisted in the workspace as timestamped files upon receipt.**

- Incoming A2A assignment messages are written to a designated inbox directory (e.g., `workspace/a2a_inbox/20260402T153012Z_<msgid>.json`).
- Assignments are processed in timestamp order (FIFO) from the inbox, ensuring correct handling order and recovery after restart.
- After successful processing, assignment files are moved to an archive directory (e.g., `workspace/a2a_archive/`).
- This approach provides:
  - Persistence and recovery
  - Natural ordering
  - Full audit trail
  - Unified handling with file-based mailbox assignments
- Deduplication is handled by message ID: if a file with the same message ID already exists in inbox or archive, duplicates are ignored.

This is now implemented via the `CompositeBackend` which merges messages from both the git mailbox and A2A inbox, sorted by timestamp.
