// Type definitions for the autonomous agent

import { PermissionsConfig } from './permission-handler.js';

/**
 * Full agent configuration.
 *
 * Convention over Configuration: only `agent.role` and `mailbox.repoPath` are
 * required.  All other fields have sensible defaults defined in
 * config-defaults.ts and are filled by `applyDefaults()` at startup.
 *
 * After `applyDefaults()` runs, every field is guaranteed to be present --
 * the optional markers here reflect what users may omit in their config file.
 */
export interface AgentConfig {
  agent: {
    hostname: string;
    role: string;
    roleDefinitionsFile?: string;
    /** Path to a custom roles overlay JSON (relative to config.json or absolute).
     *  Merged on top of roleDefinitionsFile to add or override role definitions. */
    customRolesFile?: string;
    /** Path to a custom_instructions.json file (relative to config.json or absolute).
     *  Contains project-specific overlays (coding standards, git workflow, project context)
     *  that are merged into the generated copilot-instructions.md.
     *  If omitted, the generator looks for custom_instructions.json next to roleDefinitionsFile. */
    customInstructionsFile?: string;
    /** Path to a .workflow.json file (relative to config.json or absolute).
     *  When set, the workflow engine drives prompt construction, tool gating,
     *  and state transitions instead of the static roles.json prompts. */
    workflowFile?: string;
    checkIntervalMs: number;
    stuckTimeoutMs: number;
    sdkTimeoutMs: number;
    taskRetryCount?: number;  // Number of retries for failed work items (default: 3)
    minWorkItems?: number;       // Minimum work items for task decomposition (default: 5)
    maxWorkItems?: number;       // Maximum work items for task decomposition (default: 20)
    /** Free-form guidance injected into every decomposition prompt.
     *  Applies to all tasks (workflow and non-workflow).  Workflow-level
     *  tasks/decompositionPrompt on StateDefinition layer on top. */
    decompositionPrompt?: string;
    backpressure?: {
      enabled?: boolean;              // Enable backpressure (default: true)
      maxPendingWorkItems?: number;    // Max pending work items before deferring new messages (default: 50)
      maxRecipientMailbox?: number;    // Max unread messages in recipient mailbox before sender backs off (default: 10)
      deferralLogIntervalMs?: number;  // Min interval between backpressure log warnings (default: 300000 = 5min)
    };
    timeoutStrategy?: {
      enabled?: boolean;
      tier1_multiplier?: number;
      tier2_backgroundThreshold?: number;
      tier3_decomposeThreshold?: number;
      tier4_adaptiveWindow?: number;
      tier4_adaptiveThreshold?: number;
    };
    validation?: {
      mode: 'none' | 'spot_check' | 'milestone' | 'always';
      reviewEveryNthItem: number;
      milestones?: number[];
    };
    /** Max concurrent delegations the manager will have in-flight at once.
     *  0 or absent = disabled (no gate).  Requires role = 'manager'. */
    wipLimit?: number;
  };
  mailbox: {
    repoPath: string;
    gitSync: boolean;
    autoCommit: boolean;
    commitMessage: string;
    supportBroadcast: boolean;
    supportAttachments: boolean;
    supportPriority?: boolean;  // Enable priority/normal/background folders
  };
  copilot: {
    model: string;
    allowedTools: string[] | 'all';
    permissions?: Partial<PermissionsConfig>;
  };
  workspace: {
    path: string;
    tasksFolder?: string;
    workingFolder?: string;
    taskSubfolders?: {
      pending?: string;
      completed?: string;
      review?: string;
      failed?: string;
    };
    persistContext: boolean;
    /** Git repository URL to clone into the working folder on first startup. */
    projectRepo?: string;
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    path: string;
    maxSizeMB: number;
  };
  manager?: {
    hostname: string;
    role: string;
    escalationPriority: 'HIGH' | 'NORMAL' | 'LOW';
    /** Transport URI for the manager agent (defaults to mailbox when absent). */
    uri?: string;
  };
  quota?: {
    enabled: boolean;
    preset: string;
    presetsFile?: string;
    overrides?: any;
    sharedQuotaUrl?: string;
  };
  teamMembers?: Array<{
    hostname: string;
    role: string;
    responsibilities: string;
    /**
     * Transport URI indicating how to reach this agent.
     * Schemes: `a2a://host:port`, `mailbox://agent_id`, or absent (defaults to mailbox).
     */
    uri?: string;
  }>;
  /** Communication backend configuration (defaults to git mailbox). */
  communication?: CommunicationConfig;
}

// ---------------------------------------------------------------------------
// Communication Backend Configuration
// ---------------------------------------------------------------------------

/**
 * User-configurable fields for the A2A Agent Card.
 * All fields are optional -- sensible defaults are derived from
 * agent.hostname, agent.role, and other A2AConfig values.
 */
export interface AgentCardConfig {
  /** Display name for this agent (default: "<hostname>_<role>"). */
  name?: string;
  /** Human-readable description (default: "Autonomous <role> agent"). */
  description?: string;
  /** Semantic version of the agent (default: "1.0.0"). */
  version?: string;
  /** Provider / organization metadata. */
  provider?: { organization: string; url?: string };
  /** Extra skills to advertise beyond those auto-derived from capabilities.
   *  Merged (additive) with the auto-derived skill list. */
  skills?: Array<{
    id: string;
    name: string;
    description: string;
    tags: string[];
    inputModes?: string[];
    outputModes?: string[];
    examples?: string[];
  }>;
  /** Accepted input MIME types (default: ["text/plain"]). */
  inputModes?: string[];
  /** Produced output MIME types (default: ["text/plain"]). */
  outputModes?: string[];
  /** Opaque protocol extensions map. */
  extensions?: Record<string, unknown>;
}

/**
 * A2A-specific configuration options.
 */
export interface A2AConfig {
  /** HTTP port for the A2A server (default: 4000). */
  serverPort?: number;
  /** Path to serve the agent card (default: "/.well-known/agent-card.json"). */
  agentCardPath?: string;
  /** Transport protocol: "jsonrpc" | "rest" | "grpc" (default: "jsonrpc"). */
  transport?: 'jsonrpc' | 'rest' | 'grpc';
  /** Customizable fields for the agent card served at the agentCardPath.
   *  All fields are optional -- defaults are derived from agent identity. */
  agentCard?: AgentCardConfig;
  /** TLS configuration. */
  tls?: {
    enabled?: boolean;
    certPath?: string;
    keyPath?: string;
  };
  /** Authentication scheme for serving and consuming A2A endpoints. */
  authentication?: {
    scheme?: 'bearer' | 'apiKey' | 'none';
    token?: string;
    headerName?: string;
  };
  /** Push notification configuration for long-running tasks. */
  pushNotifications?: {
    enabled?: boolean;
    webhookUrl?: string;
  };
  /** URLs of known A2A agents for direct discovery. */
  knownAgentUrls?: string[];
  /** Optional registry URL for catalog-based discovery. */
  registryUrl?: string;
  /** Directory for git-backed audit logs (relative to repo root). */
  auditDir?: string;
}

/**
 * Top-level communication configuration.
 *
 * Both the mailbox (filesystem) and the A2A HTTP server are always
 * active with sensible defaults.  Add an `a2a` block only when you
 * need to override defaults (port, TLS, known agents, etc.).
 */
export interface CommunicationConfig {
  /** A2A overrides.  Omit entirely to use all defaults. */
  a2a?: A2AConfig;
}

/**
 * Discriminator for the mailbox message format.
 *
 * - 'workflow'      Structured WorkflowAssignment JSON payload.
 * - 'oob'           Structured OutOfBandMessage JSON payload.
 * - 'status'        Informational message (completion reports, status updates).
 *                   Logged by receiver but NOT decomposed into work items.
 * - 'unstructured'  Free-text body (legacy / human messages).
 *
 * When the header is absent the message is treated as 'unstructured'.
 */
export type MessageType = 'workflow' | 'oob' | 'status' | 'unstructured';

export interface MailboxMessage {
  filename: string;
  filepath: string;
  date: Date;
  from: string;
  to: string;
  subject: string;
  priority?: 'HIGH' | 'NORMAL' | 'LOW';
  /** Strict message type from the MessageType header.  When missing,
   *  defaults to 'unstructured' for backward compatibility. */
  messageType: MessageType;
  /** Raw text body after the header separator.  For structured types
   *  this is the JSON source; for unstructured it is free text. */
  content: string;
  /** Parsed JSON payload (only present when messageType is
   *  'workflow' or 'oob' and the body passes JSON validation). */
  payload?: Record<string, unknown>;
}

export interface TeamAgent {
  id: string;                    // e.g., "dev-server-1_developer"
  hostname: string;              // e.g., "dev-server-1"
  role: string;                  // e.g., "developer"
  description?: string;          // Human-readable description
  capabilities?: string[];       // e.g., ["python", "circuit-processing"]
  timezone?: string;             // e.g., "America/Los_Angeles"
  contact?: string;              // Optional contact info

  // A2A-inspired enrichment fields (all optional, backward-compatible)
  /** Structured skill descriptions -- richer alternative to flat capabilities[]. */
  skills?: import('./agent-card.js').AgentSkill[];
  /** Accepted input MIME types (e.g., ["text/plain", "application/json"]). */
  inputModes?: string[];
  /** Produced output MIME types. */
  outputModes?: string[];
  /** A2A protocol version if this agent speaks A2A (e.g., "0.3.0"). */
  protocolVersion?: string;
  /** Network endpoint URL for A2A communication. */
  url?: string;
  /**
   * Transport URI indicating how to reach this agent.
   * Schemes: `a2a://host:port`, `mailbox://agent_id`, or absent (defaults to mailbox).
   * When present, overrides the url field for routing decisions.
   */
  uri?: string;
  /** Provider / organization metadata. */
  provider?: { organization: string; url?: string };
  /** Authentication requirements for this agent endpoint. */
  security?: Array<{ type: string; in?: string; name?: string }>;
  /** Protocol extensions (opaque key-value map). */
  extensions?: Record<string, unknown>;
}

export interface TeamRoleInfo {
  agents: string[];              // Array of agent IDs with this role
  description?: string;          // Role description
}

export interface TeamRoster {
  team: {
    name: string;
    description?: string;
    created?: string;
    updated?: string;
  };
  agents: TeamAgent[];
  roles?: Record<string, TeamRoleInfo>;
}

export interface TaskAssignment {
  messageId: string;
  subject: string;
  description: string;
  acceptanceCriteria: string[];
  dueDate?: Date;
  priority: 'HIGH' | 'NORMAL' | 'LOW';
}

export interface SessionContext {
  agentId: string;
  sessionId?: string;
  currentTask?: TaskAssignment;
  taskStartTime?: Date;
  lastMailboxCheck: Date;
  messagesProcessed: number;
  status: 'idle' | 'working' | 'stuck' | 'escalated' | 'breaking_down_task';
  workingDirectory: string;

  // Message sequence tracking (Option B: persistent state)
  nextMessageSequence?: number;
  messageTracking?: {
    [messageSeq: string]: {
      mailboxFile: string;           // Original mailbox filename
      mailboxTimestamp?: string;     // Timestamp from filename (for reference)
      decomposedAt?: string;         // ISO timestamp when decomposed
      archivedAt?: string;           // ISO timestamp when archived
      status: 'pending' | 'decomposed' | 'in_progress' | 'completed';
      workItemsCreated?: string[];   // List of work item IDs (e.g., ["002_001", "002_002"])
      pendingWorkItems?: string[];   // Currently pending work items
    };
  };

  // QA rework cycle tracking (prevents infinite rejection loops)
  // Key format: "rework:<original task name>", value: cycle count
  reworkTracking?: {
    [reworkKey: string]: number;
  };

  // In-flight delegation tracking for WIP gate (manager only).
  // Key: "<targetHostname_role>:<subject>" truncated to 120 chars.
  // Persisted to session_context.json so the WIP gate survives restarts.
  inFlightDelegations?: {
    [key: string]: {
      delegatedTo: string;       // hostname_role of target agent
      subject: string;           // message subject (for completion matching)
      sentAt: string;            // ISO timestamp
      workflowTaskId?: string;   // workflow task ID if applicable
      timeoutMs?: number;        // watchdog timeout ms (default: stuckTimeoutMs or 30min)
    };
  };
}

export interface AgentStatus {
  running: boolean;
  currentTask?: string;
  uptime: number;
  tasksCompleted: number;
  lastActivity: Date;
}
