// Mailbox operations for external mailbox protocol

import fs from 'fs/promises';
import path from 'path';
import { MailboxMessage, MessageType, TeamRoster } from './types.js';
import { parseMailboxMessage, formatMailboxTimestamp, createMailboxMessage, loadJSON } from './utils.js';
import { GitManager } from './git.js';
import type pino from 'pino';
import { createComponentLogger, logger as defaultLogger, logError, logWarning } from './logger.js';

export class MailboxManager {
  private mailboxPath: string;
  private priorityPath: string;
  private normalPath: string;
  private backgroundPath: string;
  private archivePath: string;
  private toAllPath: string;
  private attachmentsPath: string;
  private agentId: string;
  private git: GitManager;
  private autoCommit: boolean;
  private commitMessageTemplate: string;
  private supportBroadcast: boolean;
  private supportAttachments: boolean;
  private supportPriority: boolean;
  private logger: pino.Logger;
  private repoPath: string;
  private managerHostname: string;
  private teamRosterCache: { roster: TeamRoster; timestamp: number } | null = null;
  
  constructor(
    repoPath: string,
    hostname: string,
    role: string,
    gitSync: boolean = true,
    autoCommit: boolean = true,
    commitMessage: string = 'Auto-sync: {hostname}_{role} at {timestamp}',
    supportBroadcast: boolean = true,
    supportAttachments: boolean = true,
    supportPriority: boolean = true,
    managerHostname?: string
  ) {
    this.repoPath = repoPath;
    this.agentId = `${hostname}_${role}`;
    const mailboxBase = path.join(repoPath, 'mailbox');
    
    this.mailboxPath = path.join(mailboxBase, `to_${this.agentId}`);
    this.priorityPath = path.join(this.mailboxPath, 'priority');
    this.normalPath = path.join(this.mailboxPath, 'normal');
    this.backgroundPath = path.join(this.mailboxPath, 'background');
    this.archivePath = path.join(this.mailboxPath, 'archive');
    this.toAllPath = path.join(mailboxBase, 'to_all');
    this.attachmentsPath = path.join(repoPath, 'attachments');
    
    this.git = new GitManager(repoPath, gitSync);
    this.autoCommit = autoCommit;
    this.commitMessageTemplate = commitMessage;
    this.supportBroadcast = supportBroadcast;
    this.supportAttachments = supportAttachments;
    this.supportPriority = supportPriority;
    this.managerHostname = managerHostname || hostname;
    
    this.logger = createComponentLogger(defaultLogger, 'mailbox', { agentId: this.agentId });
  }
  
  /**
   * Initialize mailbox folders
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.mailboxPath, { recursive: true });
    await fs.mkdir(this.archivePath, { recursive: true });
    
    if (this.supportPriority) {
      await fs.mkdir(this.priorityPath, { recursive: true });
      await fs.mkdir(this.normalPath, { recursive: true });
      await fs.mkdir(this.backgroundPath, { recursive: true });
    }
    
    if (this.supportBroadcast) {
      await fs.mkdir(this.toAllPath, { recursive: true });
    }
    
    if (this.supportAttachments) {
      await fs.mkdir(this.attachmentsPath, { recursive: true });
    }
  }
  
  /**
   * Sync with git remote (pull latest changes)
   */
  async syncFromRemote(): Promise<{ success: boolean; message: string }> {
    if (!this.git.isEnabled()) {
      return { success: true, message: 'Git sync disabled' };
    }
    
    const result = await this.git.pull();
    return {
      success: result.success,
      message: result.error || result.output
    };
  }
  
  /**
   * Commit and push changes to git remote
   */
  async syncToRemote(customMessage?: string): Promise<{ success: boolean; message: string }> {
    if (!this.git.isEnabled() || !this.autoCommit) {
      return { success: true, message: 'Git sync/auto-commit disabled' };
    }
    
    const message = customMessage || this.formatCommitMessage();
    const result = await this.git.commitAndPush(message);
    
    return {
      success: result.success,
      message: result.error || result.output
    };
  }
  
  /**
   * Format commit message with template variables
   */
  private formatCommitMessage(): string {
    const timestamp = new Date().toISOString();
    return this.commitMessageTemplate
      .replace('{hostname}', this.agentId.split('_')[0])
      .replace('{role}', this.agentId.split('_')[1])
      .replace('{timestamp}', timestamp);
  }
  
  /**
   * Check for new messages in mailbox with priority handling
   * Priority order: priority/ > normal/ > background/
   * Falls back to root mailbox if priority structure not used
   */
  async checkForNewMessages(): Promise<MailboxMessage[]> {
    return this.listMessages();
  }

  /**
   * Peek at all pending messages without consuming (archiving) them.
   * Optionally filter by subject regex.
   */
  async peekMessages(subjectFilter?: RegExp): Promise<MailboxMessage[]> {
    const all = await this.listMessages();
    if (!subjectFilter) return all;
    return all.filter(m => subjectFilter.test(m.subject));
  }

  /**
   * List all pending messages without archiving them.
   * Used by both checkForNewMessages and peekMessages.
   */
  private async listMessages(): Promise<MailboxMessage[]> {
    const messages: MailboxMessage[] = [];
    
    try {
      if (this.supportPriority) {
        // Check priority folders in order
        const priorityMessages = await this.readMessagesFromFolder(this.priorityPath);
        const normalMessages = await this.readMessagesFromFolder(this.normalPath);
        const backgroundMessages = await this.readMessagesFromFolder(this.backgroundPath);
        
        // Priority messages first, then normal, then background
        messages.push(...priorityMessages);
        messages.push(...normalMessages);
        messages.push(...backgroundMessages);
      } else {
        // Legacy: Check root mailbox folder (excluding subfolders)
        const rootMessages = await this.readMessagesFromFolder(this.mailboxPath, true);
        messages.push(...rootMessages);
      }
      
      // Check broadcast mailbox if supported
      if (this.supportBroadcast) {
        const broadcastMessages = await this.readMessagesFromFolder(this.toAllPath);
        messages.push(...broadcastMessages);
      }
      
      // Sort by date within each priority level
      messages.sort((a, b) => a.date.getTime() - b.date.getTime());
      
      return messages;
    } catch (error) {
      logError(this.logger, error as Error, 'Error listing mailbox messages');
      return [];
    }
  }
  
  /**
   * Read messages from a specific folder
   */
  private async readMessagesFromFolder(folderPath: string, excludeSubfolders: boolean = false): Promise<MailboxMessage[]> {
    const messages: MailboxMessage[] = [];
    
    try {
      const files = await fs.readdir(folderPath);
      
      for (const file of files) {
        // Skip non-markdown files and known subfolders
        if (!file.endsWith('.md')) {
          continue;
        }
        
        // Skip subfolders when in legacy mode
        if (excludeSubfolders && (file === 'archive' || file === 'priority' || file === 'normal' || file === 'background')) {
          continue;
        }
        
        const filepath = path.join(folderPath, file);
        const stats = await fs.stat(filepath);
        
        // Skip directories
        if (stats.isDirectory()) {
          continue;
        }
        
        // Parse message
        const parsed = await parseMailboxMessage(filepath);
        
        messages.push({
          filename: file,
          filepath,
          date: new Date(parsed.date || stats.mtime),
          from: parsed.from,
          to: parsed.to,
          subject: parsed.subject,
          priority: parsed.priority as any,
          messageType: parsed.messageType,
          content: parsed.content,
          payload: parsed.payload,
        });
      }
    } catch (error) {
      // Folder might not exist yet
      logWarning(this.logger, 'Could not read from folder', { folderPath, error: (error as Error).message });
    }
    
    return messages;
  }
  
  /**
   * Archive a processed message
   */
  async archiveMessage(message: MailboxMessage): Promise<void> {
    const archiveDestination = path.join(this.archivePath, message.filename);
    await fs.rename(message.filepath, archiveDestination);
  }
  
  /**
   * Send a message to another agent's mailbox.
   * Priority determines which subfolder the message goes into.
   *
   * @param messageType  Optional strict message type for the header.
   *                     Defaults to 'unstructured'.
   * @param payload      Optional structured JSON payload (for workflow/oob).
   *                     When provided, the body is serialized JSON.
   */
  async sendMessage(
    toHostname: string,
    toRole: string,
    subject: string,
    content: string,
    priority?: 'HIGH' | 'NORMAL' | 'LOW',
    messageType?: MessageType,
    payload?: Record<string, unknown>,
  ): Promise<string> {
    // Validate and correct hostname - LLM sometimes passes "hostname_role" as hostname
    // e.g. "test-sdk_developer" instead of just "test-sdk"
    const correctedHostname = this.normalizeHostname(toHostname, toRole);
    if (correctedHostname !== toHostname) {
      this.logger.warn(
        { original: toHostname, corrected: correctedHostname, toRole },
        'Corrected toHostname - was hostname_role format, stripped role suffix'
      );
    }
    
    const timestamp = formatMailboxTimestamp();
    const sanitizedSubject = subject.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const filename = `${timestamp}_${sanitizedSubject}.md`;
    
    const targetMailboxBase = path.join(
      path.dirname(path.dirname(this.mailboxPath)),
      'mailbox',
      `to_${correctedHostname}_${toRole}`
    );
    
    // Determine target folder based on priority
    let targetMailbox = targetMailboxBase;
    if (this.supportPriority) {
      if (priority === 'HIGH') {
        targetMailbox = path.join(targetMailboxBase, 'priority');
      } else if (priority === 'LOW') {
        targetMailbox = path.join(targetMailboxBase, 'background');
      } else {
        // NORMAL or undefined goes to normal/
        targetMailbox = path.join(targetMailboxBase, 'normal');
      }
    }
    
    // Ensure target mailbox exists
    await fs.mkdir(targetMailbox, { recursive: true });
    
    const filepath = await createMailboxMessage(
      targetMailbox,
      filename,
      this.agentId,
      `${correctedHostname}_${toRole}`,
      subject,
      content,
      priority,
      messageType,
      payload,
    );
    
    // Auto-commit and push if enabled
    if (this.autoCommit) {
      await this.syncToRemote(`Message sent: ${subject}`);
    }
    
    return filepath;
  }
  
  /**
   * Send broadcast message to all agents
   */
  async sendBroadcast(
    subject: string,
    content: string,
    priority?: 'HIGH' | 'NORMAL' | 'LOW'
  ): Promise<string> {
    if (!this.supportBroadcast) {
      throw new Error('Broadcast not supported in this configuration');
    }
    
    const timestamp = formatMailboxTimestamp();
    const sanitizedSubject = subject.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const filename = `${timestamp}_${sanitizedSubject}.md`;
    
    const filepath = await createMailboxMessage(
      this.toAllPath,
      filename,
      this.agentId,
      'all',
      subject,
      content,
      priority
    );
    
    // Auto-commit and push if enabled
    if (this.autoCommit) {
      await this.syncToRemote(`Broadcast: ${subject}`);
    }
    
    return filepath;
  }
  
  /**
   * Send completion report
   */
  async sendCompletionReport(
    taskSubject: string,
    results: string
  ): Promise<void> {
    await this.sendMessage(
      this.managerHostname,
      'manager',
      `Task Complete: ${taskSubject}`,
      `Task completion report:

${results}

Agent: ${this.agentId}
Completed: ${new Date().toISOString()}
`,
      'NORMAL'
    );
  }
  
  /**
   * Send escalation message
   */
  async escalate(
    issue: string,
    context: string
  ): Promise<void> {
    await this.sendMessage(
      this.managerHostname,
      'manager',
      `Escalation: ${issue}`,
      `Need assistance with the following issue:

**Issue:** ${issue}

**Context:**
${context}

**Agent:** ${this.agentId}
**Time:** ${new Date().toISOString()}

Please advise on how to proceed.
`,
      'HIGH'
    );
  }
  
  /**
   * Normalize hostname to strip role suffix if LLM mistakenly includes it.
   * e.g. if toHostname="test-sdk_developer" and toRole="developer",
   * returns "test-sdk" since the role will be appended separately.
   */
  private normalizeHostname(toHostname: string, toRole: string): string {
    // Check if hostname ends with _role (common LLM mistake)
    const roleSuffix = `_${toRole}`;
    if (toHostname.endsWith(roleSuffix)) {
      return toHostname.slice(0, -roleSuffix.length);
    }
    return toHostname;
  }
  
  /**
   * Get the number of unread messages in a recipient's mailbox folders.
   * Used for sender-side backpressure -- counts files across priority/, normal/, background/.
   */
  async getRecipientQueueDepth(toHostname: string, toRole: string): Promise<number> {
    const correctedHostname = this.normalizeHostname(toHostname, toRole);
    const targetMailboxBase = path.join(
      path.dirname(path.dirname(this.mailboxPath)),
      'mailbox',
      `to_${correctedHostname}_${toRole}`
    );

    let count = 0;
    const folders = this.supportPriority
      ? ['priority', 'normal', 'background']
      : ['.'];

    for (const folder of folders) {
      const folderPath = folder === '.' ? targetMailboxBase : path.join(targetMailboxBase, folder);
      try {
        const files = await fs.readdir(folderPath);
        count += files.filter(f => f.endsWith('.md')).length;
      } catch {
        // Folder may not exist yet -- that's fine, count stays 0
      }
    }

    return count;
  }

  /**
   * Get mailbox path for debugging
   */
  getMailboxPath(): string {
    return this.mailboxPath;
  }
  
  /**
   * Get team roster from mailbox/team.json
   * Returns null if file doesn't exist
   * Caches result for 5 minutes to avoid repeated file reads
   */
  async getTeamRoster(): Promise<TeamRoster | null> {
    const now = Date.now();
    const CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes
    
    // Return cached result if still fresh
    if (this.teamRosterCache && (now - this.teamRosterCache.timestamp) < CACHE_DURATION_MS) {
      return this.teamRosterCache.roster;
    }
    
    const teamFilePath = path.join(this.repoPath, 'mailbox', 'team.json');
    
    try {
      // Check if file exists
      await fs.access(teamFilePath);
      
      // Load and parse team.json
      const content = await fs.readFile(teamFilePath, 'utf-8');
      const roster = JSON.parse(content) as TeamRoster;
      
      // Cache the result
      this.teamRosterCache = {
        roster: roster,
        timestamp: now
      };
      
      this.logger.debug({ 
        agentCount: roster.agents.length,
        teamName: roster.team.name 
      }, 'Team roster loaded');
      
      return roster;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // File doesn't exist - not an error, just means no roster configured
        this.logger.debug('No team.json found in mailbox');
        return null;
      }
      
      // Log actual errors
      logError(this.logger, error, 'Failed to load team roster');
      return null;
    }
  }
  
  /**
   * Clear the team roster cache
   * Call this if you know the team.json file has been updated
   */
  clearTeamRosterCache(): void {
    this.teamRosterCache = null;
  }
}
