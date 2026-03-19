// CompletionTracker - Handles assignment completion tracking and reporting

import { WorkspaceManager, WorkItem } from './workspace-manager.js';
import { MailboxManager } from './mailbox.js';
import pino from 'pino';
import path from 'path';
import fs from 'fs/promises';

/**
 * Message statistics for completion tracking
 */
export interface MessageStats {
  total: number;
  pending: number;
  completed: number;
  reviewed: number;
  failed: number;
}

/**
 * Configuration for completion tracking
 */
export interface CompletionTrackerConfig {
  managerHostname: string;
  managerRole: string;
  agentId: string;
  workspacePath: string;
  gitSync: boolean;
  autoCommit: boolean;
}

/**
 * Tracks work item completion and generates reports
 */
export class CompletionTracker {
  constructor(
    private workspace: WorkspaceManager,
    private mailbox: MailboxManager,
    private config: CompletionTrackerConfig,
    private logger: pino.Logger
  ) {}
  
  /**
   * Check if message assignment is complete and handle reporting
   * 
   * @param workItem - The work item that was just completed
   */
  async checkMessageCompletion(workItem: WorkItem): Promise<void> {
    // Extract message sequence from hierarchical filename (MMM_TTT_title.md)
    const match = workItem.filename.match(/^(\d{3,})_(\d{3,})_/);
    if (!match) {
      // Old format, skip message tracking
      return;
    }
    
    const messageSeq = match[1];
    
    // Count all work items for this message across all folders
    const stats = await this.workspace.getMessageStats(messageSeq);
    
    // Check if all items for this message are done (no pending)
    if (stats.pending === 0 && stats.total > 0) {
      // Assignment complete - check if it succeeded or failed
      const succeeded = stats.completed + stats.reviewed > 0;
      const hasFailed = stats.failed > 0;
      
      if (succeeded && hasFailed) {
        // Partial failure with recovery - create recovery notes
        this.logger.info(`Message ${messageSeq} completed with recovery: ${stats.completed}/${stats.total} items (${stats.failed} failed but recovered)`);
        await this.createRecoveryNotes(messageSeq, stats);
        await this.sendMessageCompletionReport(messageSeq, stats);
      } else if (succeeded) {
        // Complete success
        this.logger.info(`Message ${messageSeq} completed: ${stats.completed}/${stats.total} items`);
        await this.sendMessageCompletionReport(messageSeq, stats);
      } else {
        // Complete failure - escalate
        this.logger.error(`Message ${messageSeq} failed: ${stats.failed}/${stats.total} items failed, none completed`);
        await this.escalateFailedAssignment(messageSeq, stats);
      }
    }
  }
  
  /**
   * Send completion report to manager when all work items for a message are done
   */
  private async sendMessageCompletionReport(messageSeq: string, stats: MessageStats): Promise<void> {
    const completedSummary = await this.workspace.getCompletedSummaryForMessage(messageSeq);
    const gitChanges = await this.getRecentGitChanges();
    
    const hasFailed = stats.failed > 0;
    const status = hasFailed 
      ? `Completed with recovery (${stats.failed} work items failed but alternate approaches succeeded)`
      : 'All items completed';
    
    const subject = `Assignment ${messageSeq} completed`;
    const content = `Assignment ${messageSeq} has been successfully completed.

**Summary:**
- Total work items: ${stats.total}
- Completed: ${stats.completed}
- Reviewed: ${stats.reviewed}${hasFailed ? `\n- Failed (recovered): ${stats.failed}` : ''}
- Status: ${status}

**Work completed:**
${completedSummary}

**Changes made:**
\`\`\`
${gitChanges}
\`\`\`

**Next steps:**
Review the changes in the project workspace if needed.`;

    await this.mailbox.sendMessage(
      this.config.managerHostname,
      this.config.managerRole,
      subject,
      content,
      'NORMAL',
      'status',
    );
    
    this.logger.info(`Sent completion report to manager for assignment ${messageSeq}`);
  }
  
  /**
   * Create recovery notes in failed folder documenting successful recovery
   */
  private async createRecoveryNotes(messageSeq: string, stats: MessageStats): Promise<void> {
    const failedFiles = await this.workspace.getWorkItemsInFolder('failed', messageSeq);
    const completedFiles = await this.workspace.getWorkItemsInFolder('completed', messageSeq);
    
    for (const failedItem of failedFiles) {
      const recoveryNote = `# Recovery Note

This work item failed after all retries, but the assignment succeeded through alternate approaches.

## Failed Work Item
${failedItem.title}

## Assignment Status
- Assignment ${messageSeq}: **Successfully completed**
- Total work items: ${stats.total}
- Completed: ${stats.completed}
- Failed: ${stats.failed}

## Recovery Strategy
The agent used alternative approaches or subsequent work items to achieve the assignment goals despite this failure.

## Completed Work Items
${completedFiles.map(f => `- ${f.title}`).join('\n')}

This demonstrates the agent's ability to adapt and recover from failures at the work item level while maintaining assignment-level success.
`;

      const recoveryFilename = failedItem.filename.replace('.md', '-recovery.md');
      const failedPath = path.join(this.config.workspacePath, 'tasks', 'failed');
      const recoveryPath = path.join(failedPath, recoveryFilename);
      await fs.writeFile(recoveryPath, recoveryNote, 'utf-8');
      
      this.logger.info(`Created recovery note: ${recoveryFilename}`);
    }
  }
  
  /**
   * Escalate completely failed assignment to manager
   */
  private async escalateFailedAssignment(messageSeq: string, stats: MessageStats): Promise<void> {
    const failedSummary = await this.workspace.getFailedSummaryForMessage(messageSeq);
    
    await this.mailbox.escalate(
      `Assignment ${messageSeq} failed completely`,
      `Assignment ${messageSeq} failed with no successful work items.

**Summary:**
- Total work items: ${stats.total}
- Failed: ${stats.failed}
- Completed: ${stats.completed}
- Status: Complete failure

**Failed work items:**
${failedSummary}

**Action needed:**
Review the failed work items and either:
1. Decompose into smaller, simpler tasks
2. Provide additional context or constraints
3. Adjust task complexity`
    );
    
    this.logger.error(`Escalated complete failure of assignment ${messageSeq} to manager`);
  }
  
  /**
   * Get recent git changes for reporting
   */
  private async getRecentGitChanges(): Promise<string> {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      
      const { stdout } = await execAsync('git diff --stat HEAD~1..HEAD 2>/dev/null || echo "No git changes"');
      return stdout.trim() || 'No git repository or changes';
    } catch {
      return 'Git changes unavailable';
    }
  }
  
  /**
   * Send project completion report when all work items done
   */
  async sendProjectCompletionReport(): Promise<void> {
    this.logger.info('Sending project completion report');
    
    const summary = await this.workspace.getCompletedSummary();
    const stats = await this.workspace.getStats();
    
    const report = `# Project Completion Report

**Status:** All work items completed

**Summary:**
${summary}

**Statistics:**
- Total work items: ${stats.completedItems}
- Remaining: ${stats.workItems}

**Agent:** ${this.config.agentId}
**Timestamp:** ${new Date().toISOString()}

All tasks from the project have been completed and tested.`;

    await this.mailbox.sendMessage(
      this.config.managerHostname,
      this.config.managerRole,
      'Project Completed',
      report,
      'NORMAL',
      'status',
    );
    
    this.logger.info('Completion report sent');
    
    // Git sync
    if (this.config.gitSync && this.config.autoCommit) {
      await this.mailbox.syncToRemote('Project completion report');
    }
  }
}
