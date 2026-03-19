// Type definitions for the autonomous agent

import { PermissionsConfig } from './permission-handler.js';

export interface AgentConfig {
  agent: {
    hostname: string;
    role: 'developer' | 'qa' | 'manager' | 'researcher';
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
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    path: string;
    maxSizeMB: number;
  };
  manager: {
    hostname: string;
    role: string;
    escalationPriority: 'HIGH' | 'NORMAL' | 'LOW';
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
  }>;
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
