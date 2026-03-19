// Test Harness Library
//
// Wraps the agent's message creation, mailbox management, and log
// validation code paths so smoke tests call the real implementations
// instead of duplicating format knowledge in bash scripts.
//
// Every function here delegates to the same code the agent uses at
// runtime.  If the message format, directory layout, or log strings
// change in the source, the harness picks up the change automatically.
//
// Usage:
//   - Programmatically from TypeScript tests (import this module)
//   - From bash scripts via scripts/smoke-test-cli.ts

import fs from 'fs/promises';
import path from 'path';
import { createMailboxMessage, formatMailboxTimestamp } from './utils.js';
import type {
  WorkflowAssignment,
  TaskState,
} from './workflow-types.js';

// -----------------------------------------------------------------------
// Constants -- mailbox path conventions from mailbox.ts
// -----------------------------------------------------------------------

/**
 * Compose an agent identifier from hostname and role.
 * Matches the convention in MailboxManager: `${hostname}_${role}`.
 */
export function agentIdentity(hostname: string, role: string): string {
  return `${hostname}_${role}`;
}

/** Priority queue names matching MailboxManager subfolder structure. */
export const QUEUES = ['priority', 'normal', 'background', 'archive'] as const;
export type QueueName = (typeof QUEUES)[number];

// -----------------------------------------------------------------------
// Log Event Registry
//
// Maps stable event names to the regex patterns that match them in
// log output.  Smoke tests reference event names; this registry is
// the SINGLE place that must stay in sync with the source code.
//
// TODO: Extract these as named constants in the source modules
// (agent.ts, mailbox-tools.ts, completion-tracker.ts) and import
// them here, eliminating even this mapping.
// -----------------------------------------------------------------------

export interface LogEventDef {
  /** Regex pattern to match against log line text */
  pattern: string;
  /** Human-readable description */
  description: string;
  /** Source file where this log line originates */
  source: string;
}

export const LOG_EVENTS: Record<string, LogEventDef> = {
  // -- Workflow engine lifecycle (agent.ts) --
  workflow_loaded: {
    pattern: 'Workflow engine loaded',
    description: 'Workflow definition loaded from JSON file',
    source: 'agent.ts',
  },
  workflow_assignment_received: {
    pattern: 'Received workflow assignment',
    description: 'Agent received and parsed a WorkflowAssignment',
    source: 'agent.ts',
  },
  workflow_task_activated: {
    pattern: 'Workflow task activated',
    description: 'Task state ingested, prompt and tools resolved',
    source: 'agent.ts',
  },
  workflow_transition: {
    pattern: 'Workflow state transition',
    description: 'State machine moved to a new state',
    source: 'agent.ts',
  },
  workflow_completion_sent: {
    pattern: 'Sent workflow completion',
    description: 'Completion message with embedded task state sent to manager',
    source: 'agent.ts',
  },
  workflow_terminal: {
    pattern: 'Workflow task reached terminal state',
    description: 'Task reached a terminal state (DONE, ESCALATED, etc.)',
    source: 'agent.ts',
  },

  // -- Message processing (agent.ts, completion-tracker.ts) --
  work_item_completed: {
    pattern: 'Work item completed',
    description: 'A single work item finished execution',
    source: 'agent.ts',
  },
  message_completed: {
    pattern: 'Message \\d+ completed',
    description: 'Full message processing completed (all work items done)',
    source: 'completion-tracker.ts',
  },
  no_messages: {
    pattern: 'No new messages in mailbox',
    description: 'Mailbox poll found no pending messages',
    source: 'agent.ts',
  },

  // -- Tool invocations (mailbox-tools.ts) --
  tool_send_message: {
    pattern: 'TOOL INVOKED: send_message',
    description: 'Agent invoked the send_message tool',
    source: 'mailbox-tools.ts',
  },
  tool_get_team_roster: {
    pattern: 'TOOL INVOKED: get_team_roster',
    description: 'Agent invoked the get_team_roster tool',
    source: 'mailbox-tools.ts',
  },

  // -- State actions (workflow-engine.ts) --
  state_action_set_context: {
    pattern: 'State action: set_context',
    description: 'Entry/exit action set a context variable',
    source: 'workflow-engine.ts',
  },
  state_action_send_to_role: {
    pattern: 'State action: send_to_role',
    description: 'Entry/exit action recorded a send_to_role intent',
    source: 'workflow-engine.ts',
  },
  state_action_log: {
    pattern: 'State action log:',
    description: 'Entry/exit action emitted a log message',
    source: 'workflow-engine.ts',
  },

  // -- Envelope leak guard (agent.ts, Fix #5) --
  envelope_leak_stripped: {
    pattern: 'no workflow is loaded -- stripping envelope',
    description: 'Workflow envelope stripped from message when no workflow loaded',
    source: 'agent.ts',
  },

  // -- Auto-wrap workflow selection (agent.ts, Fix #6) --
  auto_wrap_fallback: {
    pattern: 'No workflow matched agent role -- falling back',
    description: 'Auto-wrap could not match a workflow to agent role',
    source: 'agent.ts',
  },
  auto_wrap: {
    pattern: 'Auto-wrapping unstructured message as workflow assignment',
    description: 'Unstructured message auto-wrapped into workflow assignment',
    source: 'agent.ts',
  },

  // -- Error detection (runtime) --
  crash: {
    pattern: 'unhandled|uncaught|FATAL|panic',
    description: 'Unhandled error, uncaught exception, or crash indicator',
    source: 'runtime',
  },
};

// -----------------------------------------------------------------------
// Mailbox path helpers
// -----------------------------------------------------------------------

/**
 * Compute the mailbox directory for an agent.
 * Matches MailboxManager: `{basePath}/mailbox/to_{hostname}_{role}/`
 */
export function mailboxDir(
  basePath: string,
  hostname: string,
  role: string,
): string {
  return path.join(basePath, 'mailbox', `to_${agentIdentity(hostname, role)}`);
}

/**
 * Compute the path to a specific queue within an agent's mailbox.
 */
export function queueDir(
  basePath: string,
  hostname: string,
  role: string,
  queue: QueueName = 'normal',
): string {
  return path.join(mailboxDir(basePath, hostname, role), queue);
}

// -----------------------------------------------------------------------
// Mailbox initialization
// -----------------------------------------------------------------------

/**
 * Create the full mailbox directory tree for an agent.
 * Mirrors MailboxManager.initialize() exactly.
 *
 * @returns The agent's mailbox root directory path
 */
export async function initMailbox(
  basePath: string,
  hostname: string,
  role: string,
  opts: {
    priority?: boolean;
    broadcast?: boolean;
    attachments?: boolean;
  } = {},
): Promise<string> {
  const { priority = true, broadcast = false, attachments = false } = opts;
  const dir = mailboxDir(basePath, hostname, role);

  if (priority) {
    for (const q of QUEUES) {
      await fs.mkdir(path.join(dir, q), { recursive: true });
    }
  } else {
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(path.join(dir, 'archive'), { recursive: true });
  }

  if (broadcast) {
    await fs.mkdir(path.join(basePath, 'mailbox', 'to_all'), { recursive: true });
  }
  if (attachments) {
    await fs.mkdir(path.join(basePath, 'attachments'), { recursive: true });
  }

  return dir;
}

// -----------------------------------------------------------------------
// Message filename generation
// -----------------------------------------------------------------------

/**
 * Generate a mailbox-compatible filename.
 * Matches the convention in MailboxManager: `{timestamp}_{sanitized_subject}.md`
 */
export function generateFilename(subject: string, date?: Date): string {
  const timestamp = formatMailboxTimestamp(date || new Date());
  const sanitized = subject
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 60);
  return `${timestamp}_${sanitized}.md`;
}

// -----------------------------------------------------------------------
// Plain message creation
// -----------------------------------------------------------------------

/**
 * Create a plain mailbox message using the canonical format from utils.ts.
 *
 * Delegates to the real `createMailboxMessage()` so the header format
 * (Date/From/To/Subject/Priority + --- separator) is always correct.
 *
 * @returns Absolute path of the created message file
 */
export async function createPlainMessage(opts: {
  dir: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  priority?: string;
  filename?: string;
}): Promise<string> {
  const filename = opts.filename || generateFilename(opts.subject);
  return createMailboxMessage(
    opts.dir,
    filename,
    opts.from,
    opts.to,
    opts.subject,
    opts.body,
    opts.priority,
  );
}

// -----------------------------------------------------------------------
// Workflow assignment message creation
// -----------------------------------------------------------------------

/**
 * Create a workflow assignment message using the strict two-section format.
 *
 * Writes a MessageType: workflow header with the WorkflowAssignment as a
 * JSON payload body.  No embedded WORKFLOW_MSG markers -- the entire body
 * is machine-parseable JSON.
 *
 * If `workItems` is supplied, the receiving agent will skip LLM
 * decomposition and queue the items directly.
 *
 * @returns Absolute path of the created message file
 */
export async function createWorkflowMessage(opts: {
  dir: string;
  workflowId: string;
  taskId: string;
  targetState: string;
  targetRole: string;
  taskPrompt: string;
  from: string;
  to: string;
  subject?: string;
  context?: Record<string, string>;
  filename?: string;
  /** Optional pre-decomposed work items to skip LLM breakdown */
  workItems?: Array<{ title: string; content: string }>;
}): Promise<string> {
  const now = new Date().toISOString();

  // Build a TaskState matching what WorkflowEngine.createTask() produces
  const taskState: TaskState = {
    taskId: opts.taskId,
    workflowId: opts.workflowId,
    currentState: opts.targetState,
    context: opts.context || {},
    retryCount: 0,
    history: [
      {
        fromState: '__init__',
        toState: opts.targetState,
        result: 'success' as const,
        role: 'manager',
        timestamp: now,
      },
    ],
    notes: [],
    createdAt: now,
    updatedAt: now,
  };

  // Build the assignment payload (strict schema -- no embedded markers)
  const assignment: WorkflowAssignment = {
    type: 'workflow',
    workflowId: opts.workflowId,
    taskId: opts.taskId,
    targetState: opts.targetState,
    targetRole: opts.targetRole,
    taskPrompt: opts.taskPrompt,
    taskState,
    workItems: opts.workItems,
  };

  const subject = opts.subject || `Workflow Assignment: ${opts.targetState}`;
  const filename = opts.filename || generateFilename(subject);

  // Write using the strict two-section format: header + JSON payload
  return createMailboxMessage(
    opts.dir,
    filename,
    opts.from,
    opts.to,
    subject,
    '', // content unused -- payload provides the body
    undefined, // priority
    'workflow',
    assignment as unknown as Record<string, unknown>,
  );
}

// -----------------------------------------------------------------------
// Delivery verification
// -----------------------------------------------------------------------

export interface DeliveryResult {
  /** Number of .md message files found */
  count: number;
  /** Sorted list of filenames */
  files: string[];
}

/**
 * Count messages in an agent's mailbox queue.
 * Returns 0 if the directory does not exist (no error).
 */
export async function checkDelivery(
  basePath: string,
  hostname: string,
  role: string,
  queue: QueueName = 'normal',
): Promise<DeliveryResult> {
  const dir = queueDir(basePath, hostname, role, queue);
  try {
    const entries = await fs.readdir(dir);
    const mdFiles = entries.filter(f => f.endsWith('.md')).sort();
    return { count: mdFiles.length, files: mdFiles };
  } catch {
    return { count: 0, files: [] };
  }
}

// -----------------------------------------------------------------------
// Log event checking
// -----------------------------------------------------------------------

export interface LogCheckResult {
  /** Whether at least one matching line was found */
  found: boolean;
  /** Number of matching lines */
  count: number;
  /** First matching line (for diagnostics) */
  firstMatch?: string;
}

/**
 * Check a log file for a named event from the LOG_EVENTS registry.
 *
 * @param logFile    Path to the log file (pino JSON or plain text)
 * @param eventName  Key from LOG_EVENTS
 * @throws           If eventName is not in LOG_EVENTS
 */
export async function checkLogEvent(
  logFile: string,
  eventName: string,
): Promise<LogCheckResult> {
  const event = LOG_EVENTS[eventName];
  if (!event) {
    const known = Object.keys(LOG_EVENTS).join(', ');
    throw new Error(`Unknown log event "${eventName}". Known events: ${known}`);
  }
  return checkLogPattern(logFile, event.pattern);
}

/**
 * Check a log file for an arbitrary regex pattern.
 * Handles both pino JSON log lines (checks the `msg` field) and
 * plain-text log lines.
 */
export async function checkLogPattern(
  logFile: string,
  pattern: string,
): Promise<LogCheckResult> {
  const regex = new RegExp(pattern, 'i');

  let content: string;
  try {
    content = await fs.readFile(logFile, 'utf-8');
  } catch {
    return { found: false, count: 0 };
  }

  const matches: string[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;

    // Try structured (pino JSON) format first
    let text = line;
    try {
      const obj = JSON.parse(line);
      text = obj.msg || obj.message || line;
    } catch {
      // Plain text line -- use as-is
    }

    if (regex.test(text)) {
      matches.push(line);
    }
  }

  return {
    found: matches.length > 0,
    count: matches.length,
    firstMatch: matches[0],
  };
}
