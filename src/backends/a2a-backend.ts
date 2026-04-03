// A2A Communication Backend
//
// Implements CommunicationBackend using the Agent2Agent protocol.
// Each agent runs an A2A server (Express-based) and uses the A2A
// client SDK to send messages to other agents.
//
// Requires: @a2a-js/sdk, express (peer dependencies).
// Always loaded -- the A2A server starts with sensible defaults.

import {
  CommunicationBackend,
  AgentAddress,
  AgentMessage,
  SendResult,
  AuditEntry,
  AuditFilter,
  DiscoveryQuery,
} from '../communication-backend.js';
import { EnrichedAgentCard, enrichTeamAgent, fromA2AAgentCard, toA2AAgentCard, mergeCapabilitiesAndSkills } from '../agent-card.js';
import { agentMessageToA2A } from '../a2a-message-mapper.js';
import { A2AAgentExecutor, OnA2AMessageReceived } from '../a2a-executor.js';
import { createA2AServer, A2AServer } from '../a2a-server.js';
import { A2AConfig, TeamAgent } from '../types.js';
import type { A2AAuditLogger } from '../a2a-audit-logger.js';
import type pino from 'pino';
import path from 'path';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// A2A Assignment File Persistence
//
// Incoming A2A assignments are written to an inbox directory as timestamped
// JSON files.  After processing, they are archived to an archive directory.
// This provides a durable, ordered, auditable record of all A2A assignments.
// ---------------------------------------------------------------------------

/**
 * Format a compact UTC timestamp suitable for use in a filename.
 * e.g. "20260402T153012Z"
 */
function formatInboxTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/**
 * Derive a deduplication key filename fragment from a message ID.
 * Strips characters that are not safe in filenames.
 */
function safeMessageId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Persist an incoming A2A assignment to the inbox directory.
 *
 * Filename format: `{timestamp}_{messageId}.json`
 *
 * @param inboxDir   Directory to write to (must exist).
 * @param assignment Assignment data to persist (must have an `id` field).
 * @param timestamp  Optional override timestamp string (used in tests).
 * @returns Absolute path of the written file.
 * @throws  Error with "duplicate" in the message if a file for this
 *          message ID already exists (deduplication by message ID).
 */
export async function persistA2AAssignment(
  inboxDir: string,
  assignment: Record<string, unknown>,
  timestamp?: string,
): Promise<string> {
  const msgId = String(assignment.id ?? randomUUID());
  const safeId = safeMessageId(msgId);
  const ts = timestamp ?? formatInboxTimestamp();

  // Scan for an existing file with the same message ID suffix to deduplicate.
  let existing: string[];
  try {
    existing = await fs.readdir(inboxDir);
  } catch {
    existing = [];
  }

  const alreadyExists = existing.some(f => f.endsWith(`_${safeId}.json`));
  if (alreadyExists) {
    throw new Error(`duplicate: A2A assignment with id "${msgId}" is already in the inbox`);
  }

  const filename = `${ts}_${safeId}.json`;
  const filePath = path.join(inboxDir, filename);
  await fs.writeFile(filePath, JSON.stringify(assignment, null, 2), 'utf-8');
  return filePath;
}

/**
 * Read all persisted A2A assignments from the inbox directory.
 *
 * Files are returned in ascending filename order (FIFO by timestamp prefix).
 * Non-JSON files and subdirectories are silently skipped.
 *
 * @param inboxDir  Directory to read from.
 * @returns Ordered array of parsed assignment objects.
 */
export async function readA2AAssignments(
  inboxDir: string,
): Promise<Array<Record<string, unknown>>> {
  let entries: string[];
  try {
    entries = await fs.readdir(inboxDir);
  } catch {
    return [];
  }

  const jsonFiles = entries.filter(f => f.endsWith('.json')).sort();
  const results: Array<Record<string, unknown>> = [];

  for (const file of jsonFiles) {
    try {
      const content = await fs.readFile(path.join(inboxDir, file), 'utf-8');
      results.push(JSON.parse(content));
    } catch {
      // Skip unparseable files -- do not crash the inbox drain
    }
  }

  return results;
}

/**
 * Archive a processed A2A assignment by moving it from the inbox to
 * the archive directory.
 *
 * @param filePath   Absolute path of the inbox file.
 * @param archiveDir Destination directory (must exist).
 */
export async function archiveA2AAssignment(
  filePath: string,
  archiveDir: string,
): Promise<void> {
  const dest = path.join(archiveDir, path.basename(filePath));
  await fs.rename(filePath, dest);
}

/**
 * Configuration for the A2A backend.
 */
export interface A2ABackendConfig {
  hostname: string;
  role: string;
  managerHostname: string;
  a2a: A2AConfig;
  /** Repo path used for team.json loading and audit log storage. */
  repoPath: string;
  /**
   * Base directory for a2a_inbox and a2a_archive subdirectories.
   * Defaults to repoPath when absent.
   * Typically set to the workspace.path for agents that want inbox
   * files co-located with their workspace rather than the mailbox repo.
   */
  inboxBaseDir?: string;
}

/**
 * A2A protocol communication backend.
 *
 * - Runs an A2A HTTP server to receive messages from other agents.
 * - Uses the A2A client SDK to send messages to remote agents.
 * - Persists incoming assignments to an inbox directory (FIFO audit trail).
 * - Archives processed assignments to an archive directory.
 * - Supports git-backed audit logging for regulatory evidence.
 */
export class A2ABackend implements CommunicationBackend {
  readonly name = 'a2a' as const;

  private config: A2ABackendConfig;
  private localAgent: AgentAddress;
  private agentId: string;
  private logger: pino.Logger;
  private server: A2AServer | null = null;
  private incomingQueue: AgentMessage[] = [];
  /** Maps message ID -> inbox file path for archive-on-acknowledge. */
  private inboxFilePaths: Map<string, string> = new Map();
  private knownAgents: Map<string, EnrichedAgentCard> = new Map();
  private auditLogger: A2AAuditLogger | null = null;

  /** Inbox directory for persisted incoming assignments. */
  private inboxDir: string;
  /** Archive directory for processed assignments. */
  private archiveDir: string;

  constructor(config: A2ABackendConfig, logger: pino.Logger) {
    this.config = config;
    this.agentId = `${config.hostname}_${config.role}`;
    this.localAgent = { hostname: config.hostname, role: config.role };
    this.logger = logger;
    const workspaceBase = config.inboxBaseDir ?? config.repoPath;
    this.inboxDir = path.join(workspaceBase, 'a2a_inbox');
    this.archiveDir = path.join(workspaceBase, 'a2a_archive');
  }

  /** The actual port the A2A server is listening on (0 before init). */
  get serverPort(): number {
    return this.server?.port ?? 0;
  }

  /** The agent card URL (empty before init). */
  get agentCardUrl(): string {
    return this.server?.agentCardUrl ?? '';
  }

  /**
   * Register a remote agent URL so this backend can send messages to it.
   * Useful in tests where ports are assigned dynamically.
   */
  registerKnownAgent(agentId: string, url: string): void {
    const existing = this.knownAgents.get(agentId);
    if (existing) {
      existing.url = url;
    } else {
      // Minimal entry -- enough for resolveAgentUrl to find it
      const [hostname, role] = agentId.split('_');
      this.knownAgents.set(agentId, {
        id: agentId,
        hostname: hostname || agentId,
        role: role || 'agent',
        url,
        capabilities: [],
        skills: [],
      } as any);
    }
  }

  // -- Lifecycle ----------------------------------------------------------

  async initialize(): Promise<void> {
    this.logger.info({ backend: 'a2a', agentId: this.agentId }, 'Initializing A2A backend');

    // Ensure inbox and archive directories exist.
    await fs.mkdir(this.inboxDir, { recursive: true });
    await fs.mkdir(this.archiveDir, { recursive: true });

    // Recover any assignments that were persisted but not yet processed
    // (e.g. after a crash or interrupted shutdown).
    const existing = await readA2AAssignments(this.inboxDir);
    if (existing.length > 0) {
      this.logger.info({ count: existing.length }, 'Recovering persisted A2A assignments from inbox');
    }
    for (const assignment of existing) {
      const msgId = String(assignment.id ?? '');
      // Reconstruct the file path using the same naming convention.
      const entries = await fs.readdir(this.inboxDir);
      const safeId = msgId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const file = entries.find(f => f.endsWith(`_${safeId}.json`));
      const agentMsg = assignment as unknown as AgentMessage;
      this.incomingQueue.push(agentMsg);
      if (file) {
        this.inboxFilePaths.set(msgId, path.join(this.inboxDir, file));
      }
    }

    // Build our own agent card
    const selfCard = this.buildSelfAgentCard();
    this.selfCard = selfCard;

    // Create the executor that bridges A2A requests to internal processing
    const onMessage: OnA2AMessageReceived = async (msg) => {
      // Persist first so no assignment is lost even if the queue is not
      // drained before a crash.
      try {
        const filePath = await persistA2AAssignment(this.inboxDir, msg as unknown as Record<string, unknown>);
        this.inboxFilePaths.set(msg.id, filePath);
      } catch (err) {
        // If already in inbox (duplicate delivery), skip re-queuing.
        if (String(err).includes('duplicate')) {
          this.logger.debug({ msgId: msg.id }, 'Skipping duplicate A2A assignment');
          return `Duplicate assignment ignored: ${msg.subject}`;
        }
        this.logger.warn({ error: String(err) }, 'Failed to persist A2A assignment to inbox');
      }
      this.incomingQueue.push(msg);
      this.logger.info(
        { from: `${msg.from.hostname}_${msg.from.role}`, subject: msg.subject },
        'A2A message queued',
      );
      return `Message received and queued: ${msg.subject}`;
    };

    const executor = new A2AAgentExecutor(this.localAgent, onMessage, this.logger);

    // Start the A2A server
    this.server = await createA2AServer(
      selfCard,
      executor,
      this.config.a2a,
      this.logger,
    );
    await this.server.start();

    // Patch the agent card URL to the actual port (critical for port 0)
    this.updateSelfCardUrl(this.server.port);

    // Initialize audit logger if configured
    const auditDir = this.config.a2a.auditDir || 'audit/a2a';
    try {
      const { A2AAuditLogger: AuditLoggerClass } = await import('../a2a-audit-logger.js');
      this.auditLogger = new AuditLoggerClass(
        path.join(this.config.repoPath, auditDir),
        this.agentId,
        this.logger,
      );
      await this.auditLogger.initialize();
    } catch (err) {
      this.logger.warn({ error: String(err) }, 'Audit logger not available -- continuing without audit');
    }

    // Pre-load known agents from configuration
    await this.reloadKnownAgents();

    this.logger.info(
      { port: this.server.port, agentCard: this.server.agentCardUrl },
      'A2A backend initialized',
    );
  }

  async shutdown(): Promise<void> {
    if (this.server) {
      await this.server.stop();
      this.server = null;
    }
    this.logger.info({ backend: 'a2a' }, 'A2A backend shut down');
  }

  // -- Messaging ----------------------------------------------------------

  async sendMessage(
    to: AgentAddress,
    message: Omit<AgentMessage, 'id' | 'from' | 'timestamp'>,
  ): Promise<SendResult> {
    const targetUrl = to.url || this.resolveAgentUrl(to);
    if (!targetUrl) {
      return {
        success: false,
        ref: '',
        message: `Cannot resolve URL for agent ${to.hostname}_${to.role}. Add URL to team.json or knownAgentUrls.`,
      };
    }

    try {
      // Dynamic import of A2A client -- use 'any' to avoid compile-time
      // coupling to the @a2a-js/sdk package which is an optional peer dep.
      const clientMod: any = await import('@a2a-js/sdk/client');
      const factory = new clientMod.ClientFactory();
      const client = await factory.createFromUrl(targetUrl);

      const a2aPayload = agentMessageToA2A(message, this.agentId);

      const startMs = Date.now();
      const response = await client.sendMessage(a2aPayload as any);
      const durationMs = Date.now() - startMs;

      // Audit log
      if (this.auditLogger) {
        await this.auditLogger.logEntry({
          direction: 'outbound',
          remoteAgent: `${to.hostname}_${to.role}`,
          method: 'sendMessage',
          request: a2aPayload,
          response,
          durationMs,
          status: 'success',
        });
      }

      const ref = (response as any)?.id ?? (response as any)?.messageId ?? randomUUID();

      return { success: true, ref: String(ref) };
    } catch (error) {
      // Audit log error
      if (this.auditLogger) {
        await this.auditLogger.logEntry({
          direction: 'outbound',
          remoteAgent: `${to.hostname}_${to.role}`,
          method: 'sendMessage',
          request: message,
          response: null,
          durationMs: 0,
          status: 'error',
          error: String(error),
        });
      }

      return { success: false, ref: '', message: String(error) };
    }
  }

  async sendBroadcast(
    message: Omit<AgentMessage, 'id' | 'from' | 'to' | 'timestamp'>,
  ): Promise<SendResult> {
    // Broadcast to all known agents
    const agents = Array.from(this.knownAgents.values());
    const results: SendResult[] = [];

    for (const agent of agents) {
      if (agent.id === this.agentId) continue; // Skip self
      const to: AgentAddress = {
        hostname: agent.hostname,
        role: agent.role,
        url: agent.url,
      };
      const result = await this.sendMessage(to, { ...message, to });
      results.push(result);
    }

    const allSuccess = results.every(r => r.success);
    return {
      success: allSuccess,
      ref: `broadcast-${randomUUID()}`,
      message: `Broadcast to ${results.length} agents: ${results.filter(r => r.success).length} succeeded`,
    };
  }

  async receiveMessages(): Promise<AgentMessage[]> {
    // Drain the incoming queue
    const messages = [...this.incomingQueue];
    this.incomingQueue = [];
    return messages;
  }

  async peekMessages(subjectFilter?: RegExp): Promise<AgentMessage[]> {
    if (!subjectFilter) return [...this.incomingQueue];
    return this.incomingQueue.filter(m => subjectFilter.test(m.subject));
  }

  async acknowledgeMessage(messageId: string): Promise<void> {
    // Remove from incoming queue
    this.incomingQueue = this.incomingQueue.filter(m => m.id !== messageId);

    // Archive the persisted inbox file so processed assignments are not
    // re-queued on the next startup.
    const filePath = this.inboxFilePaths.get(messageId);
    if (filePath) {
      try {
        await archiveA2AAssignment(filePath, this.archiveDir);
        this.logger.debug({ messageId, filePath }, 'Archived A2A assignment');
      } catch (err) {
        this.logger.warn(
          { messageId, filePath, error: String(err) },
          'Failed to archive A2A assignment -- file may have already been moved',
        );
      }
      this.inboxFilePaths.delete(messageId);
    }
  }

  // -- Completion / Escalation --------------------------------------------

  async sendCompletionReport(taskSubject: string, results: string): Promise<void> {
    const managerAddress: AgentAddress = {
      hostname: this.config.managerHostname,
      role: 'manager',
    };
    await this.sendMessage(managerAddress, {
      subject: `Task Complete: ${taskSubject}`,
      content: `Task completion report:\n\n${results}\n\nAgent: ${this.agentId}\nCompleted: ${new Date().toISOString()}`,
      priority: 'NORMAL',
      messageType: 'status',
      to: managerAddress,
    });
  }

  async escalate(issue: string, context: string): Promise<void> {
    const managerAddress: AgentAddress = {
      hostname: this.config.managerHostname,
      role: 'manager',
    };
    await this.sendMessage(managerAddress, {
      subject: `Escalation: ${issue}`,
      content: `Need assistance with the following issue:\n\n**Issue:** ${issue}\n\n**Context:**\n${context}\n\n**Agent:** ${this.agentId}\n**Time:** ${new Date().toISOString()}`,
      priority: 'HIGH',
      messageType: 'unstructured',
      to: managerAddress,
    });
  }

  // -- Discovery ----------------------------------------------------------

  async getTeamRoster(): Promise<EnrichedAgentCard[] | null> {
    if (this.knownAgents.size === 0) return null;
    return Array.from(this.knownAgents.values());
  }

  async discoverAgents(query: DiscoveryQuery): Promise<EnrichedAgentCard[]> {
    const all = Array.from(this.knownAgents.values());

    return all.filter(agent => {
      if (query.role && agent.role !== query.role) return false;

      if (query.capability) {
        const capLower = query.capability.toLowerCase();
        const hasCap = agent.capabilities?.some(c => c.toLowerCase() === capLower);
        if (!hasCap) return false;
      }

      if (query.skillId) {
        const skills = mergeCapabilitiesAndSkills(agent.capabilities, agent.skills, agent.role);
        if (!skills.some(s => s.id === query.skillId)) return false;
      }

      if (query.tag) {
        const tagLower = query.tag.toLowerCase();
        const skills = mergeCapabilitiesAndSkills(agent.capabilities, agent.skills, agent.role);
        if (!skills.some(s => s.tags.some(t => t.toLowerCase() === tagLower))) return false;
      }

      return true;
    });
  }

  // -- Backpressure -------------------------------------------------------

  async getRecipientQueueDepth(_to: AgentAddress): Promise<number> {
    // A2A does not expose recipient queue depth natively.
    // Return 0 to effectively disable sender-side backpressure over A2A.
    return 0;
  }

  // -- Audit --------------------------------------------------------------

  async getAuditLog(filter?: AuditFilter): Promise<AuditEntry[]> {
    if (!this.auditLogger) return [];
    return this.auditLogger.queryEntries(filter);
  }

  // -- Sync ---------------------------------------------------------------

  async syncFromRemote(): Promise<{ success: boolean; message: string }> {
    // A2A is push-based; no pull needed.
    return { success: true, message: 'A2A backend: no sync needed (push-based)' };
  }

  async syncToRemote(_customMessage?: string): Promise<{ success: boolean; message: string }> {
    // Commit audit logs if audit logger is enabled
    if (this.auditLogger) {
      await this.auditLogger.commitAuditLog();
    }
    return { success: true, message: 'A2A audit log committed' };
  }

  // -- Internal -----------------------------------------------------------

  /**
   * Build the A2A Agent Card for this agent from its configuration.
   * The card is initially constructed with the configured port.  After
   * server.start() resolves an OS-assigned port, updateSelfCardUrl()
   * patches the card URL to the actual runtime address.
   */
  private buildSelfAgentCard(): Record<string, unknown> {
    const cardCfg = this.config.a2a.agentCard;
    const selfTeamAgent: TeamAgent = {
      id: this.agentId,
      hostname: this.config.hostname,
      role: this.config.role,
      description: cardCfg?.description || `Autonomous ${this.config.role} agent`,
    };
    const enriched = enrichTeamAgent(selfTeamAgent);
    return toA2AAgentCard(enriched, {
      protocolVersion: '0.3.0',
      serverPort: this.config.a2a.serverPort ?? 4000,
      overrides: cardCfg,
    });
  }

  /**
   * Patch the self card URL to reflect the actual server port.
   * Required when serverPort is 0 (OS-assigned).
   */
  private selfCard: Record<string, unknown> | null = null;

  private updateSelfCardUrl(actualPort: number): void {
    if (this.selfCard) {
      this.selfCard.url = `http://localhost:${actualPort}/a2a/jsonrpc`;
    }
  }

  /**
   * Resolve an agent's A2A URL from known agents.
   */
  private resolveAgentUrl(to: AgentAddress): string | undefined {
    const agentId = `${to.hostname}_${to.role}`;
    const known = this.knownAgents.get(agentId);
    if (known?.url) return known.url;

    // Try constructing from known agent URLs in config
    const port = this.config.a2a.serverPort ?? 4000;
    return `http://${to.hostname}:${port}`;
  }

  /**
   * Reload known agents from team.json and knownAgentUrls config.
   * Called during initialize() and when team.json changes on disk.
   */
  async reloadKnownAgents(): Promise<void> {
    // Load from team.json (same location as mailbox backend)
    const teamFilePath = path.join(this.config.repoPath, 'mailbox', 'team.json');
    try {
      const content = await fs.readFile(teamFilePath, 'utf-8');
      const roster = JSON.parse(content);
      for (const agent of roster.agents || []) {
        const enriched = enrichTeamAgent(agent);
        this.knownAgents.set(enriched.id, enriched);
      }
      this.logger.info({ count: roster.agents?.length }, 'Loaded agents from team.json');
    } catch {
      this.logger.debug('No team.json found -- only configured URLs will be used');
    }

    // Load from knownAgentUrls by fetching their agent cards
    for (const url of this.config.a2a.knownAgentUrls || []) {
      try {
        const response = await fetch(`${url}/.well-known/agent-card.json`);
        if (response.ok) {
          const cardJson = await response.json();
          const agent = fromA2AAgentCard(cardJson as Record<string, unknown>);
          agent.url = url;
          this.knownAgents.set(agent.id, agent);
          this.logger.info({ url, agentId: agent.id }, 'Discovered A2A agent');
        }
      } catch (err) {
        this.logger.warn({ url, error: String(err) }, 'Failed to fetch agent card');
      }
    }
  }
}
