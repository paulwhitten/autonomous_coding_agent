// Communication Backend Interface
//
// Abstracts inter-agent communication so the autonomous agent can use
// either the git shared mailbox or the A2A protocol (or both).
// The interface is intentionally transport-agnostic.

import { EnrichedAgentCard, AgentSkill } from './agent-card.js';

// ---------------------------------------------------------------------------
// Shared Message Types (transport-independent)
// ---------------------------------------------------------------------------

/**
 * Address identifying a target agent.
 * For mailbox: hostname + role are used to derive the folder path.
 * For A2A: url is used to reach the agent's HTTP endpoint.
 */
export interface AgentAddress {
  hostname: string;
  role: string;
  /** A2A endpoint URL (optional -- only needed for A2A backend). */
  url?: string;
  /**
   * Transport URI indicating which backend should deliver this message.
   * Schemes: `a2a://host:port`, `mailbox://agent_id`.
   * When absent, defaults to mailbox.
   */
  uri?: string;
}

/**
 * Transport-independent message representation.
 * Maps to MailboxMessage (git backend) or A2A Message/Task (A2A backend).
 */
export interface AgentMessage {
  /** Unique message identifier. */
  id: string;
  /** Sender agent address. */
  from: AgentAddress;
  /** Recipient agent address. */
  to: AgentAddress;
  /** Brief subject / title. */
  subject: string;
  /** Full message body (text content). */
  content: string;
  /** Priority level. */
  priority: 'HIGH' | 'NORMAL' | 'LOW';
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Message type discriminator. */
  messageType: 'workflow' | 'oob' | 'status' | 'unstructured';
  /** Structured payload for workflow/oob messages. */
  payload?: Record<string, unknown>;
  /** Original filename or external reference (backend-specific). */
  sourceRef?: string;
}

/**
 * Result of sending a message.
 */
export interface SendResult {
  success: boolean;
  /** Backend-specific reference (file path, task ID, etc.). */
  ref: string;
  /** Error or informational message. */
  message?: string;
  /** True if the send was deferred due to backpressure. */
  deferred?: boolean;
}

/**
 * Filter criteria for the audit log.
 */
export interface AuditFilter {
  /** Only entries after this timestamp. */
  after?: string;
  /** Only entries before this timestamp. */
  before?: string;
  /** Filter by direction. */
  direction?: 'inbound' | 'outbound';
  /** Filter by remote agent ID. */
  remoteAgent?: string;
  /** Maximum entries to return. */
  limit?: number;
}

/**
 * A single audit log entry.
 */
export interface AuditEntry {
  id: string;
  timestamp: string;
  direction: 'inbound' | 'outbound';
  localAgent: string;
  remoteAgent: string;
  protocol: 'mailbox' | 'a2a';
  method: string;
  taskId?: string;
  summary: string;
  /** Git commit SHA or equivalent evidence reference. */
  evidenceRef?: string;
}

/**
 * Query for discovering agents by capability, role, or other criteria.
 */
export interface DiscoveryQuery {
  role?: string;
  capability?: string;
  skillId?: string;
  tag?: string;
}

// ---------------------------------------------------------------------------
// Backend Interface
// ---------------------------------------------------------------------------

/**
 * Abstract communication backend.
 *
 * Implementations:
 *   - GitMailboxBackend (wraps MailboxManager)
 *   - A2ABackend (wraps @a2a-js/sdk client + server)
 *   - CompositeBackend (mailbox + A2A running side by side)
 */
export interface CommunicationBackend {
  /** Backend name for logging and config references. */
  readonly name: 'mailbox' | 'a2a' | 'composite';

  /** Initialize the backend (create directories, start servers, etc.). */
  initialize(): Promise<void>;

  /** Shut down gracefully (stop servers, flush buffers). */
  shutdown(): Promise<void>;

  // -- Messaging ----------------------------------------------------------

  /** Send a message to another agent. */
  sendMessage(to: AgentAddress, message: Omit<AgentMessage, 'id' | 'from' | 'timestamp'>): Promise<SendResult>;

  /** Send a broadcast to all agents (if supported). */
  sendBroadcast(message: Omit<AgentMessage, 'id' | 'from' | 'to' | 'timestamp'>): Promise<SendResult>;

  /** Receive pending messages (consuming or non-consuming depends on impl). */
  receiveMessages(): Promise<AgentMessage[]>;

  /** Peek at messages without consuming them. */
  peekMessages(subjectFilter?: RegExp): Promise<AgentMessage[]>;

  /** Mark a message as processed (archive, acknowledge, etc.). */
  acknowledgeMessage(messageId: string): Promise<void>;

  // -- Completion / Escalation shortcuts ----------------------------------

  /** Send a task completion report to the manager. */
  sendCompletionReport(taskSubject: string, results: string): Promise<void>;

  /** Escalate an issue to the manager. */
  escalate(issue: string, context: string): Promise<void>;

  // -- Discovery ----------------------------------------------------------

  /** Get the full team roster with enriched agent cards. */
  getTeamRoster(): Promise<EnrichedAgentCard[] | null>;

  /** Find agents matching a discovery query. */
  discoverAgents(query: DiscoveryQuery): Promise<EnrichedAgentCard[]>;

  // -- Backpressure -------------------------------------------------------

  /** Get the number of unread messages in a recipient's queue. */
  getRecipientQueueDepth(to: AgentAddress): Promise<number>;

  // -- Audit --------------------------------------------------------------

  /** Retrieve audit log entries. */
  getAuditLog(filter?: AuditFilter): Promise<AuditEntry[]>;

  // -- Sync ---------------------------------------------------------------

  /** Sync with remote (git pull, etc.). Returns success status. */
  syncFromRemote(): Promise<{ success: boolean; message: string }>;

  /** Push local changes to remote (git push, etc.). */
  syncToRemote(customMessage?: string): Promise<{ success: boolean; message: string }>;
}
