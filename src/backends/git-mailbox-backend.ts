// Git Mailbox Communication Backend
//
// Wraps the existing MailboxManager to implement the CommunicationBackend
// interface.  This is the default backend and preserves full backward
// compatibility with the file-based git mailbox protocol.

import { MailboxManager } from '../mailbox.js';
import { enrichTeamAgent, mergeCapabilitiesAndSkills } from '../agent-card.js';
import { EnrichedAgentCard } from '../agent-card.js';
import {
  CommunicationBackend,
  AgentAddress,
  AgentMessage,
  SendResult,
  AuditFilter,
  AuditEntry,
  DiscoveryQuery,
} from '../communication-backend.js';
import type pino from 'pino';

/**
 * Configuration subset needed by the git mailbox backend.
 */
export interface GitMailboxBackendConfig {
  repoPath: string;
  hostname: string;
  role: string;
  gitSync: boolean;
  autoCommit: boolean;
  commitMessage: string;
  supportBroadcast: boolean;
  supportAttachments: boolean;
  supportPriority: boolean;
  managerHostname?: string;
}

/**
 * Git-based shared mailbox backend.
 *
 * Delegates all operations to the existing MailboxManager.
 * Archive folder + git commits form the audit trail.
 */
export class GitMailboxBackend implements CommunicationBackend {
  readonly name = 'mailbox' as const;

  private mailbox: MailboxManager;
  private agentId: string;
  private managerHostname: string;
  private managerRole: string;
  private logger: pino.Logger;

  constructor(config: GitMailboxBackendConfig, logger: pino.Logger) {
    this.logger = logger;
    this.agentId = `${config.hostname}_${config.role}`;
    this.managerHostname = config.managerHostname || config.hostname;
    this.managerRole = 'manager';

    this.mailbox = new MailboxManager(
      config.repoPath,
      config.hostname,
      config.role,
      config.gitSync,
      config.autoCommit,
      config.commitMessage,
      config.supportBroadcast,
      config.supportAttachments,
      config.supportPriority,
      config.managerHostname,
    );
  }

  /** Expose the underlying MailboxManager for tool wiring. */
  getMailboxManager(): MailboxManager {
    return this.mailbox;
  }

  async initialize(): Promise<void> {
    await this.mailbox.initialize();
    this.logger.info({ backend: 'mailbox' }, 'Git mailbox backend initialized');
  }

  async shutdown(): Promise<void> {
    // No persistent resources to clean up for file-based backend.
    this.logger.info({ backend: 'mailbox' }, 'Git mailbox backend shut down');
  }

  // -- Messaging ----------------------------------------------------------

  async sendMessage(
    to: AgentAddress,
    message: Omit<AgentMessage, 'id' | 'from' | 'timestamp'>,
  ): Promise<SendResult> {
    try {
      const filepath = await this.mailbox.sendMessage(
        to.hostname,
        to.role,
        message.subject,
        message.content,
        message.priority,
        message.messageType,
        message.payload,
      );
      return { success: true, ref: filepath };
    } catch (error) {
      return { success: false, ref: '', message: String(error) };
    }
  }

  async sendBroadcast(
    message: Omit<AgentMessage, 'id' | 'from' | 'to' | 'timestamp'>,
  ): Promise<SendResult> {
    try {
      const filepath = await this.mailbox.sendBroadcast(
        message.subject,
        message.content,
        message.priority,
      );
      return { success: true, ref: filepath };
    } catch (error) {
      return { success: false, ref: '', message: String(error) };
    }
  }

  async receiveMessages(): Promise<AgentMessage[]> {
    const messages = await this.mailbox.checkForNewMessages();
    return messages.map(m => this.toAgentMessage(m));
  }

  async peekMessages(subjectFilter?: RegExp): Promise<AgentMessage[]> {
    const messages = await this.mailbox.peekMessages(subjectFilter);
    return messages.map(m => this.toAgentMessage(m));
  }

  async acknowledgeMessage(messageId: string): Promise<void> {
    // messageId is the filename; find and archive it.
    const messages = await this.mailbox.checkForNewMessages();
    const msg = messages.find(m => m.filename === messageId);
    if (msg) {
      await this.mailbox.archiveMessage(msg);
    }
  }

  // -- Completion / Escalation --------------------------------------------

  async sendCompletionReport(taskSubject: string, results: string): Promise<void> {
    await this.mailbox.sendCompletionReport(taskSubject, results);
  }

  async escalate(issue: string, context: string): Promise<void> {
    await this.mailbox.escalate(issue, context);
  }

  // -- Discovery ----------------------------------------------------------

  async getTeamRoster(): Promise<EnrichedAgentCard[] | null> {
    const roster = await this.mailbox.getTeamRoster();
    if (!roster) return null;
    return roster.agents.map(a => enrichTeamAgent(a));
  }

  async discoverAgents(query: DiscoveryQuery): Promise<EnrichedAgentCard[]> {
    const roster = await this.mailbox.getTeamRoster();
    if (!roster) return [];

    const enriched = roster.agents.map(a => enrichTeamAgent(a));

    return enriched.filter(agent => {
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

  async getRecipientQueueDepth(to: AgentAddress): Promise<number> {
    return this.mailbox.getRecipientQueueDepth(to.hostname, to.role);
  }

  // -- Audit --------------------------------------------------------------

  async getAuditLog(_filter?: AuditFilter): Promise<AuditEntry[]> {
    // The git mailbox audit trail lives in git history + archive/ folder.
    // A full implementation would shell out to `git log` and parse entries.
    // For now, return an empty array; the git history IS the audit log.
    this.logger.debug('Audit log for mailbox backend is in git history');
    return [];
  }

  // -- Sync ---------------------------------------------------------------

  async syncFromRemote(): Promise<{ success: boolean; message: string }> {
    return this.mailbox.syncFromRemote();
  }

  async syncToRemote(customMessage?: string): Promise<{ success: boolean; message: string }> {
    return this.mailbox.syncToRemote(customMessage);
  }

  // -- Internal -----------------------------------------------------------

  private toAgentMessage(m: {
    filename: string;
    filepath: string;
    date: Date;
    from: string;
    to: string;
    subject: string;
    priority?: 'HIGH' | 'NORMAL' | 'LOW';
    messageType: string;
    content: string;
    payload?: Record<string, unknown>;
  }): AgentMessage {
    const [fromHost, ...fromRoleParts] = m.from.split('_');
    const [toHost, ...toRoleParts] = m.to.split('_');

    return {
      id: m.filename,
      from: { hostname: fromHost, role: fromRoleParts.join('_') },
      to: { hostname: toHost, role: toRoleParts.join('_') },
      subject: m.subject,
      content: m.content,
      priority: m.priority || 'NORMAL',
      timestamp: m.date.toISOString(),
      messageType: (m.messageType as AgentMessage['messageType']) || 'unstructured',
      payload: m.payload,
      sourceRef: m.filepath,
    };
  }
}
