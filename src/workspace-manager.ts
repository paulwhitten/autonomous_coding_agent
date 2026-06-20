// Workspace manager for work items and task sequencing

import { readdir, readFile, writeFile, mkdir, rename } from 'fs/promises';
import path from 'path';
import type pino from 'pino';

export interface WorkItem {
  filename: string;
  sequence: number;
  title: string;
  content: string;
  fullPath: string;
}

export class WorkspaceManager {
  private workPath: string;
  private completedPath: string;
  private reviewPath: string;
  private failedPath: string;
  private workingFolderPath: string;
  private logger: pino.Logger;
  private getNextSequence: () => number;  // Callback to get next sequence from context
  private trackMessage: (messageSeq: number, mailboxFile: string, workItems: string[]) => void;
  
  constructor(
    workspacePath: string,
    logger: pino.Logger,
    getNextSequence: () => number,
    trackMessage: (messageSeq: number, mailboxFile: string, workItems: string[]) => void,
    tasksFolder: string = 'tasks',
    taskSubfolders?: {
      pending?: string;
      completed?: string;
      review?: string;
      failed?: string;
    },
    workingFolder: string = 'project'
  ) {
    // Apply defaults for subfolder names
    const subfolders = {
      pending: taskSubfolders?.pending || 'pending',
      completed: taskSubfolders?.completed || 'completed',
      review: taskSubfolders?.review || 'review',
      failed: taskSubfolders?.failed || 'failed'
    };
    
    const tasksPath = path.resolve(workspacePath, tasksFolder);
    this.workPath = path.resolve(tasksPath, subfolders.pending);
    this.completedPath = path.resolve(tasksPath, subfolders.completed);
    this.reviewPath = path.resolve(tasksPath, subfolders.review);
    this.failedPath = path.resolve(tasksPath, subfolders.failed);
    this.workingFolderPath = path.resolve(workspacePath, workingFolder);
    this.logger = logger;
    this.getNextSequence = getNextSequence;
    this.trackMessage = trackMessage;
  }
  
  /**
   * Initialize workspace directories
   */
  async initialize(): Promise<void> {
    await mkdir(this.workPath, { recursive: true });
    await mkdir(this.completedPath, { recursive: true });
    await mkdir(this.reviewPath, { recursive: true });
    await mkdir(this.failedPath, { recursive: true });
    await mkdir(this.workingFolderPath, { recursive: true });
    this.logger.info({
      work: this.workPath,
      completed: this.completedPath,
      review: this.reviewPath,
      failed: this.failedPath
    }, 'Workspace manager initialized');
  }
  
  /**
   * Get next work item (lowest sequence number)
   */
  async getNextWorkItem(): Promise<WorkItem | null> {
    const files = await readdir(this.workPath);
    const workItems = files
      .filter(f => f.endsWith('.md'))
      .map(f => this.parseWorkItemFilename(f))
      .filter((item): item is WorkItem => item !== null)
      .sort((a, b) => a.sequence - b.sequence);
    
    if (workItems.length === 0) {
      return null;
    }
    
    const nextItem = workItems[0];
    const fullContent = await readFile(nextItem.fullPath, 'utf-8');
    nextItem.content = fullContent;
    
    return nextItem;
  }
  
  /**
   * Get all work items
   */
  async getAllWorkItems(): Promise<WorkItem[]> {
    const files = await readdir(this.workPath);
    const workItems = files
      .filter(f => f.endsWith('.md'))
      .map(f => this.parseWorkItemFilename(f))
      .filter((item): item is WorkItem => item !== null)
      .sort((a, b) => a.sequence - b.sequence);
    
    return workItems;
  }
  
  /**
   * Check if work folder is empty
   */
  async hasWorkItems(): Promise<boolean> {
    const items = await this.getAllWorkItems();
    return items.length > 0;
  }

  /**
   * Get number of pending work items (for backpressure checks)
   */
  async getWorkItemCount(): Promise<number> {
    const items = await this.getAllWorkItems();
    return items.length;
  }

  /**
   * Get work items grouped by state (pending, completed, review, failed).
   * Used by the A2A status endpoint to serve live work item data.
   */
  async getWorkItemsByState(): Promise<Record<string, string[]>> {
    const result: Record<string, string[]> = { pending: [], completed: [], review: [], failed: [] };
    const dirs: Record<string, string> = {
      pending: this.workPath,
      completed: this.completedPath,
      review: this.reviewPath,
      failed: this.failedPath,
    };
    for (const [state, dir] of Object.entries(dirs)) {
      try {
        const files = await readdir(dir);
        result[state] = files
          .filter(f => f.endsWith('.md'))
          .sort()
          .map(f => {
            const parsed = this.parseWorkItemFilename(f, dir);
            return parsed ? parsed.title : f;
          });
      } catch { /* folder may not exist */ }
    }
    return result;
  }
  
  /**
   * Create work items from a list of tasks
   */
  async createWorkItems(tasks: Array<{ title: string; content: string }>, mailboxFile?: string): Promise<void> {
    // Get next message sequence from context (persistent across restarts)
    const messageSeq = this.getNextSequence();
    const messageSeqStr = String(messageSeq).padStart(3, '0');
    
    const workItemIds: string[] = [];
    
    for (let i = 0; i < tasks.length; i++) {
      const taskSeq = String(i + 1).padStart(3, '0');
      const filename = `${messageSeqStr}_${taskSeq}_${this.sanitizeFilename(tasks[i].title)}.md`;
      const filepath = path.join(this.workPath, filename);
      
      workItemIds.push(`${messageSeqStr}_${taskSeq}`);
      
      await writeFile(filepath, tasks[i].content, 'utf-8');
      await this.logger.info(`Created work item: ${filename}`);
    }
    
    // Track message in persistent context
    if (mailboxFile) {
      this.trackMessage(messageSeq, mailboxFile, workItemIds);
    }
  }
  
  /**
   * Mark work item as completed (move to completed folder)
   */
  async completeWorkItem(workItem: WorkItem): Promise<void> {
    const completedPath = path.join(this.completedPath, workItem.filename);
    await rename(workItem.fullPath, completedPath);
    await this.logger.info(`Completed work item: ${workItem.filename}`);
  }
  
  /**
   * Move work item to review folder
   */
  async moveToReviewFolder(workItem: WorkItem): Promise<void> {
    const reviewPath = path.join(this.reviewPath, workItem.filename);
    await rename(workItem.fullPath, reviewPath);
    await this.logger.info(`Moved to review: ${workItem.filename}`);
  }
  
  /**
   * Move work item from review to completed folder
   */
  async moveFromReviewToCompleted(workItem: WorkItem): Promise<void> {
    const reviewFilePath = path.join(this.reviewPath, workItem.filename);
    const completedPath = path.join(this.completedPath, workItem.filename);
    await rename(reviewFilePath, completedPath);
    await this.logger.info(`Auto-approved and completed: ${workItem.filename}`);
  }
  
  /**
   * Move work item to failed folder
   */
  async moveToFailedFolder(workItem: WorkItem): Promise<void> {
    const failedPath = path.join(this.failedPath, workItem.filename);
    await rename(workItem.fullPath, failedPath);
    await this.logger.info(`Moved to failed: ${workItem.filename}`);
  }
  
  /**
   * Get recent completed items (for context)
   */
  async getRecentCompletedItems(count: number): Promise<WorkItem[]> {
    const files = await readdir(this.completedPath);
    const completedItems = files
      .filter(f => f.endsWith('.md'))
      .map(f => this.parseWorkItemFilename(f, this.completedPath))
      .filter((item): item is WorkItem => item !== null)
      .sort((a, b) => b.sequence - a.sequence) // Descending order
      .slice(0, count);
    
    // Load content for context
    for (const item of completedItems) {
      try {
        item.content = await readFile(item.fullPath, 'utf-8');
      } catch {
        item.content = 'Content unavailable';
      }
    }
    
    return completedItems;
  }
  
  /**
   * Get summary of completed work items
   */
  async getCompletedSummary(): Promise<string> {
    const files = await readdir(this.completedPath);
    const completedItems = files
      .filter(f => f.endsWith('.md'))
      .map(f => this.parseWorkItemFilename(f, this.completedPath))
      .filter((item): item is WorkItem => item !== null)
      .sort((a, b) => a.sequence - b.sequence);
    
    if (completedItems.length === 0) {
      return 'No completed work items yet.';
    }
    
    let summary = `Completed ${completedItems.length} work items:\n\n`;
    for (const item of completedItems) {
      summary += `- ${item.filename}: ${item.title}\n`;
    }
    
    return summary;
  }
  
  /**
   * Get summary of completed work items for a specific message
   */
  async getCompletedSummaryForMessage(messageSeq: string): Promise<string> {
    const files = await readdir(this.completedPath);
    const completedItems = files
      .filter(f => f.endsWith('.md') && f.startsWith(`${messageSeq}_`))
      .map(f => this.parseWorkItemFilename(f, this.completedPath))
      .filter((item): item is WorkItem => item !== null)
      .sort((a, b) => a.sequence - b.sequence);
    
    if (completedItems.length === 0) {
      return 'No completed work items for this message.';
    }
    
    let summary = '';
    for (const item of completedItems) {
      summary += `- ${item.filename}: ${item.title}\n`;
    }
    
    return summary;
  }
  
  /**
   * Get failed work items summary for a message
   */
  async getFailedSummaryForMessage(messageSeq: string): Promise<string> {
    const files = await readdir(this.failedPath);
    const failedItems = files
      .filter(f => f.endsWith('.md') && !f.endsWith('-recovery.md') && f.startsWith(`${messageSeq}_`))
      .map(f => this.parseWorkItemFilename(f, this.failedPath))
      .filter((item): item is WorkItem => item !== null)
      .sort((a, b) => a.sequence - b.sequence);
    
    if (failedItems.length === 0) {
      return 'No failed work items for this message.';
    }
    
    let summary = '';
    for (const item of failedItems) {
      summary += `- ${item.filename}: ${item.title}\n`;
    }
    
    return summary;
  }
  
  /**
   * Get work items from a specific folder for a message
   */
  async getWorkItemsInFolder(folder: 'pending' | 'completed' | 'failed' | 'review', messageSeq: string): Promise<WorkItem[]> {
    const folderPaths = {
      'pending': this.workPath,
      'completed': this.completedPath,
      'failed': this.failedPath,
      'review': this.reviewPath
    };
    
    const folderPath = folderPaths[folder];
    const files = await readdir(folderPath);
    
    return files
      .filter(f => f.endsWith('.md') && !f.endsWith('-recovery.md') && f.startsWith(`${messageSeq}_`))
      .map(f => this.parseWorkItemFilename(f, folderPath))
      .filter((item): item is WorkItem => item !== null)
      .sort((a, b) => a.sequence - b.sequence);
  }
  
  /**
   * Get statistics for work items belonging to a specific message
   */
  async getMessageStats(messageSeq: string): Promise<{
    total: number;
    pending: number;
    completed: number;
    reviewed: number;
    failed: number;
  }> {
    const folders = [
      { path: this.workPath, type: 'pending' },
      { path: this.completedPath, type: 'completed' },
      { path: this.reviewPath, type: 'reviewed' },
      { path: this.failedPath, type: 'failed' }
    ];
    
    const stats = {
      total: 0,
      pending: 0,
      completed: 0,
      reviewed: 0,
      failed: 0
    };
    
    for (const folder of folders) {
      try {
        const files = await readdir(folder.path);
        const count = files.filter(f => 
          f.endsWith('.md') && f.startsWith(`${messageSeq}_`)
        ).length;
        
        (stats as any)[folder.type] = count;
        stats.total += count;
      } catch (err) {
        // Folder might not exist yet
      }
    }
    
    return stats;
  }
  
  /**
   * Clear completed folder (for new project)
   */
  async clearCompleted(): Promise<void> {
    const files = await readdir(this.completedPath);
    for (const file of files) {
      const filepath = path.join(this.completedPath, file);
      await rename(filepath, filepath + '.archived');
    }
    await this.logger.info('Cleared completed folder');
  }
  
  /**
   * Parse work item filename to extract sequence and title
   */
  private parseWorkItemFilename(filename: string, basePath?: string): WorkItem | null {
    // Support both formats:
    // New hierarchical: 001_001_task_title.md (message 1, task 1)
    // Old simple: 001_task_title.md (for backwards compatibility)
    
    const hierarchicalMatch = filename.match(/^(\d{3,})_(\d{3,})_(.+)\.md$/);
    const simpleMatch = filename.match(/^(\d{3,})_(.+)\.md$/);
    
    if (hierarchicalMatch) {
      const messageSeq = parseInt(hierarchicalMatch[1], 10);
      const taskSeq = parseInt(hierarchicalMatch[2], 10);
      // Use combined sequence for sorting: message*1000 + task
      const combinedSeq = messageSeq * 1000 + taskSeq;
      const title = hierarchicalMatch[3].replace(/_/g, ' ');
      const fullPath = path.join(basePath || this.workPath, filename);
      
      return {
        filename,
        sequence: combinedSeq,
        title,
        content: '',
        fullPath
      };
    } else if (simpleMatch) {
      const sequence = parseInt(simpleMatch[1], 10);
      const title = simpleMatch[2].replace(/_/g, ' ');
      const fullPath = path.join(basePath || this.workPath, filename);
      
      return {
        filename,
        sequence,
        title,
        content: '',
        fullPath
      };
    }
    
    return null;
  }
  
  /**
   * Sanitize title for filename
   */
  private sanitizeFilename(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .substring(0, 50);
  }
  
  /**
   * Get work folder statistics
   */
  async getStats(): Promise<{
    workItems: number;
    completedItems: number;
    nextSequence: number;
  }> {
    const workItems = await this.getAllWorkItems();
    const completedFiles = await readdir(this.completedPath);
    const completedCount = completedFiles.filter(f => f.endsWith('.md')).length;
    
    let nextSequence = 1;
    if (workItems.length > 0) {
      nextSequence = Math.max(...workItems.map(i => i.sequence)) + 1;
    }
    
    return {
      workItems: workItems.length,
      completedItems: completedCount,
      nextSequence
    };
  }
}
