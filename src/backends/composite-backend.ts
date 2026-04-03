// Composite Communication Backend
//
// Wraps the git mailbox backend and the A2A backend so both run
// concurrently.  The mailbox is always active; the A2A server starts
// when an a2a config block is present.
//
// receiveMessages() merges messages from both sources and returns them
// ordered by timestamp (earliest first).  This gives the agent a
// single FIFO queue regardless of how the assignment arrived.

import {
  CommunicationBackend,
  AgentAddress,
  AgentMessage,
  SendResult,
  AuditEntry,
  AuditFilter,
  DiscoveryQuery,
} from '../communication-backend.js';
import { EnrichedAgentCard } from '../agent-card.js';
import { parseAgentUri } from '../agent-uri.js';
import { GitMailboxBackend } from './git-mailbox-backend.js';
import type { A2ABackend } from './a2a-backend.js';
import type pino from 'pino';

/**
 * Composite backend that runs the git mailbox and A2A server side by side.
 *
 * - Messaging:  receiveMessages() merges both sources, sorted by timestamp.
 *               sendMessage() routes based on the target's URI scheme:
 *               a2a:// -> A2A backend, mailbox:// or absent -> mailbox.
 *               Falls back to the legacy url field when no URI is set.
 * - Discovery:  Merges roster from both backends.
 * - Sync:       Delegates to the mailbox backend (A2A is push-based).
 * - Audit:      Merges audit logs from both backends.
 */
export class CompositeBackend implements CommunicationBackend {
  readonly name = 'composite' as const;

  constructor(
    private mailbox: GitMailboxBackend,
    private a2a: A2ABackend | null,
    private logger: pino.Logger,
  ) {}

  /** Expose the underlying GitMailboxBackend for MailboxManager extraction. */
  getMailboxBackend(): GitMailboxBackend {
    return this.mailbox;
  }

  /** Expose the A2A backend (may be null if no a2a config). */
  getA2ABackend(): A2ABackend | null {
    return this.a2a;
  }

  // -- Lifecycle ----------------------------------------------------------

  async initialize(): Promise<void> {
    await this.mailbox.initialize();
    if (this.a2a) {
      await this.a2a.initialize();
      this.logger.info(
        { a2aPort: this.a2a.serverPort },
        'Composite backend: mailbox + A2A initialized',
      );
    } else {
      this.logger.info('Composite backend: mailbox initialized (A2A not configured)');
    }
  }

  async shutdown(): Promise<void> {
    if (this.a2a) {
      await this.a2a.shutdown();
    }
    await this.mailbox.shutdown();
    this.logger.info('Composite backend shut down');
  }

  // -- Messaging ----------------------------------------------------------

  async sendMessage(
    to: AgentAddress,
    message: Omit<AgentMessage, 'id' | 'from' | 'timestamp'>,
  ): Promise<SendResult> {
    // 1. URI scheme takes precedence when present on the target address.
    const parsed = parseAgentUri(to.uri);
    if (parsed.scheme === 'a2a' && this.a2a) {
      // Inject the resolved HTTP URL so A2ABackend can reach the target.
      const a2aTo = parsed.a2aUrl ? { ...to, url: parsed.a2aUrl } : to;
      return this.a2a.sendMessage(a2aTo, message);
    }
    if (parsed.scheme === 'a2a' && !this.a2a) {
      return {
        success: false,
        ref: '',
        message: `Target ${to.hostname}_${to.role} has a2a:// URI but no A2A backend is configured.`,
      };
    }

    // 2. Legacy fallback: route to A2A when the target has a bare url field.
    if (this.a2a && to.url) {
      return this.a2a.sendMessage(to, message);
    }

    // 3. Default: mailbox.
    return this.mailbox.sendMessage(to, message);
  }

  async sendBroadcast(
    message: Omit<AgentMessage, 'id' | 'from' | 'to' | 'timestamp'>,
  ): Promise<SendResult> {
    // Broadcast via mailbox (file-based to_all/) and A2A (HTTP to known agents).
    const mailboxResult = await this.mailbox.sendBroadcast(message);
    if (this.a2a) {
      const a2aResult = await this.a2a.sendBroadcast(message);
      return {
        success: mailboxResult.success || a2aResult.success,
        ref: `${mailboxResult.ref},${a2aResult.ref}`,
        message: `mailbox: ${mailboxResult.message || 'ok'}, a2a: ${a2aResult.message || 'ok'}`,
      };
    }
    return mailboxResult;
  }

  /**
   * Receive messages from both the mailbox and A2A backends, merged
   * and sorted by timestamp (earliest first -- FIFO).
   */
  async receiveMessages(): Promise<AgentMessage[]> {
    const mailboxMsgs = await this.mailbox.receiveMessages();
    const a2aMsgs = this.a2a ? await this.a2a.receiveMessages() : [];
    const merged = [...mailboxMsgs, ...a2aMsgs];
    merged.sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    return merged;
  }

  async peekMessages(subjectFilter?: RegExp): Promise<AgentMessage[]> {
    const mailboxMsgs = await this.mailbox.peekMessages(subjectFilter);
    const a2aMsgs = this.a2a ? await this.a2a.peekMessages(subjectFilter) : [];
    const merged = [...mailboxMsgs, ...a2aMsgs];
    merged.sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    return merged;
  }

  async acknowledgeMessage(messageId: string): Promise<void> {
    // Try both -- one will be a no-op if the message came from the other.
    await this.mailbox.acknowledgeMessage(messageId);
    if (this.a2a) {
      await this.a2a.acknowledgeMessage(messageId);
    }
  }

  // -- Completion / Escalation --------------------------------------------

  async sendCompletionReport(taskSubject: string, results: string): Promise<void> {
    // Always send via mailbox for file-based evidence trail.
    await this.mailbox.sendCompletionReport(taskSubject, results);
  }

  async escalate(issue: string, context: string): Promise<void> {
    await this.mailbox.escalate(issue, context);
  }

  // -- Discovery ----------------------------------------------------------

  async getTeamRoster(): Promise<EnrichedAgentCard[] | null> {
    const mailboxRoster = await this.mailbox.getTeamRoster();
    const a2aRoster = this.a2a ? await this.a2a.getTeamRoster() : null;
    if (!mailboxRoster && !a2aRoster) return null;
    // Merge, dedup by agent id
    const byId = new Map<string, EnrichedAgentCard>();
    for (const agent of mailboxRoster || []) byId.set(agent.id, agent);
    for (const agent of a2aRoster || []) byId.set(agent.id, agent); // A2A enrichment wins
    return Array.from(byId.values());
  }

  async discoverAgents(query: DiscoveryQuery): Promise<EnrichedAgentCard[]> {
    const mailboxAgents = await this.mailbox.discoverAgents(query);
    const a2aAgents = this.a2a ? await this.a2a.discoverAgents(query) : [];
    const byId = new Map<string, EnrichedAgentCard>();
    for (const agent of mailboxAgents) byId.set(agent.id, agent);
    for (const agent of a2aAgents) byId.set(agent.id, agent);
    return Array.from(byId.values());
  }

  // -- Backpressure -------------------------------------------------------

  async getRecipientQueueDepth(to: AgentAddress): Promise<number> {
    return this.mailbox.getRecipientQueueDepth(to);
  }

  // -- Audit --------------------------------------------------------------

  async getAuditLog(filter?: AuditFilter): Promise<AuditEntry[]> {
    const mailboxEntries = await this.mailbox.getAuditLog(filter);
    const a2aEntries = this.a2a ? await this.a2a.getAuditLog(filter) : [];
    return [...mailboxEntries, ...a2aEntries].sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp),
    );
  }

  // -- Sync ---------------------------------------------------------------

  async syncFromRemote(): Promise<{ success: boolean; message: string }> {
    // Only the mailbox needs git sync. A2A is push-based.
    return this.mailbox.syncFromRemote();
  }

  async syncToRemote(customMessage?: string): Promise<{ success: boolean; message: string }> {
    const mailboxResult = await this.mailbox.syncToRemote(customMessage);
    if (this.a2a) {
      await this.a2a.syncToRemote(customMessage);
    }
    return mailboxResult;
  }
}
