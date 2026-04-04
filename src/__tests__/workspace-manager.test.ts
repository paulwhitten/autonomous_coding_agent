// Tests for workspace-manager.ts - Work item management and sequence tracking

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { WorkspaceManager } from '../workspace-manager.js';
import { createMockLogger } from './test-helpers.js';
import { promises as fs } from 'fs';
import path from 'path';
import type pino from 'pino';
import os from 'os';

describe('WorkspaceManager', () => {
  let testDir: string;
  let logger: pino.Logger;
  let workspace: WorkspaceManager;
  let nextSequence: number;
  let trackedMessages: Array<{ messageSeq: number; mailboxFile: string; workItems: string[] }>;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-test-'));
    
    logger = createMockLogger();

    nextSequence = 1;
    trackedMessages = [];

    const getNextSequence = () => nextSequence++;
    const trackMessage = (messageSeq: number, mailboxFile: string, workItems: string[]) => {
      trackedMessages.push({ messageSeq, mailboxFile, workItems });
    };

    workspace = new WorkspaceManager(testDir, logger, getNextSequence, trackMessage);
    await workspace.initialize();
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('initialization', () => {
    it('should create workspace directories', async () => {
      const tasksPath = path.join(testDir, 'tasks');
      const pendingPath = path.join(tasksPath, 'pending');
      const completedPath = path.join(tasksPath, 'completed');
      const reviewPath = path.join(tasksPath, 'review');
      const failedPath = path.join(tasksPath, 'failed');
      const workingPath = path.join(testDir, 'project');

      expect(await fs.stat(pendingPath).then(() => true).catch(() => false)).toBe(true);
      expect(await fs.stat(completedPath).then(() => true).catch(() => false)).toBe(true);
      expect(await fs.stat(reviewPath).then(() => true).catch(() => false)).toBe(true);
      expect(await fs.stat(failedPath).then(() => true).catch(() => false)).toBe(true);
      expect(await fs.stat(workingPath).then(() => true).catch(() => false)).toBe(true);
    });
  });

  describe('createWorkItems', () => {
    it('should create work items with sequential IDs', async () => {
      const tasks = [
        { title: 'Do something', content: 'Task 1 details' },
        { title: 'Do another thing', content: 'Task 2 details' },
        { title: 'Finish up', content: 'Task 3 details' }
      ];

      await workspace.createWorkItems(tasks);

      const pendingPath = path.join(testDir, 'tasks', 'pending');
      const files = await fs.readdir(pendingPath);

      expect(files.length).toBe(3);
      expect(files).toContain('001_001_do_something.md');
      expect(files).toContain('001_002_do_another_thing.md');
      expect(files).toContain('001_003_finish_up.md');
    });

    it('should track message with created work item IDs', async () => {
      const tasks = [
        { title: 'Task A', content: 'Content A' },
        { title: 'Task B', content: 'Content B' }
      ];

      await workspace.createWorkItems(tasks, 'tracked_message.md');

      expect(trackedMessages.length).toBe(1);
      expect(trackedMessages[0].messageSeq).toBe(1);
      expect(trackedMessages[0].mailboxFile).toBe('tracked_message.md');
      expect(trackedMessages[0].workItems).toEqual(['001_001', '001_002']);
    });

    it('should use callback for sequence generation', async () => {
      nextSequence = 100; // Start at 100

      const tasks = [
        { title: 'First task', content: 'Content 1' },
        { title: 'Second task', content: 'Content 2' }
      ];

      await workspace.createWorkItems(tasks);

      const pendingPath = path.join(testDir, 'tasks', 'pending');
      const files = await fs.readdir(pendingPath);

      expect(files).toContain('100_001_first_task.md');
      expect(files).toContain('100_002_second_task.md');
      expect(nextSequence).toBe(101);
    });

    it('should sanitize task titles for filenames', async () => {
      const tasks = [
        { title: 'Task #1: Fix @bug in $module!', content: 'Fix the bug' },
        { title: 'Update (config) & settings', content: 'Update it' }
      ];

      await workspace.createWorkItems(tasks);

      const pendingPath = path.join(testDir, 'tasks', 'pending');
      const files = await fs.readdir(pendingPath);

      expect(files[0]).toMatch(/^001_001_task_1_fix_bug_in_module\.md$/);
      expect(files[1]).toMatch(/^001_002_update_config_settings\.md$/);
    });

    it('should write task content to work item file', async () => {
      const tasks = [
        { title: 'Important task', content: 'This is the task content\nWith multiple lines' }
      ];

      await workspace.createWorkItems(tasks);

      const pendingPath = path.join(testDir, 'tasks', 'pending');
      const files = await fs.readdir(pendingPath);
      const content = await fs.readFile(path.join(pendingPath, files[0]), 'utf-8');

      expect(content).toContain('This is the task content\nWith multiple lines');
    });
  });

  describe('hasWorkItems', () => {
    it('should return true when pending work items exist', async () => {
      await workspace.createWorkItems([{ title: 'Task 1', content: 'Content' }]);
      
      const hasPending = await workspace.hasWorkItems();
      expect(hasPending).toBe(true);
    });

    it('should return false when no pending work items', async () => {
      const hasPending = await workspace.hasWorkItems();
      expect(hasPending).toBe(false);
    });
  });

  describe('getNextWorkItem', () => {
    it('should return null when no work items pending', async () => {
      const workItem = await workspace.getNextWorkItem();
      expect(workItem).toBeNull();
    });

    it('should return work items in sequence order', async () => {
      const tasks = [
        { title: 'Third', content: 'C' },
        { title: 'First', content: 'A' },
        { title: 'Second', content: 'B' }
      ];

      await workspace.createWorkItems(tasks);

      const first = await workspace.getNextWorkItem();
      expect(first?.sequence).toBe(1001);
      expect(first?.title.toLowerCase()).toBe('third'); // Sanitized to lowercase
    });

    it('should return correct WorkItem structure', async () => {
      await workspace.createWorkItems([{ title: 'Test task', content: 'Test content' }]);

      const workItem = await workspace.getNextWorkItem();

      expect(workItem).not.toBeNull();
      expect(workItem).toHaveProperty('filename');
      expect(workItem).toHaveProperty('sequence');
      expect(workItem).toHaveProperty('title');
      expect(workItem).toHaveProperty('content');
      expect(workItem).toHaveProperty('fullPath');
      expect(workItem!.content).toBe('Test content');
    });
  });

  describe('completeWorkItem', () => {
    it('should move work item to completed folder', async () => {
      await workspace.createWorkItems([{ title: 'Complete me', content: 'Task content' }]);
      const workItem = await workspace.getNextWorkItem();
      
      await workspace.completeWorkItem(workItem!);

      const completedPath = path.join(testDir, 'tasks', 'completed');
      const pendingPath = path.join(testDir, 'tasks', 'pending');

      const completedFiles = await fs.readdir(completedPath);
      const pendingFiles = await fs.readdir(pendingPath);

      expect(completedFiles.length).toBe(1);
      expect(pendingFiles.length).toBe(0);
      expect(completedFiles[0]).toBe(workItem!.filename);
    });

    it('should preserve work item content when completing', async () => {
      const originalContent = 'Important task content\nWith details';
      await workspace.createWorkItems([{ title: 'Task', content: originalContent }]);
      const workItem = await workspace.getNextWorkItem();
      
      await workspace.completeWorkItem(workItem!);

      const completedPath = path.join(testDir, 'tasks', 'completed', workItem!.filename);
      const fileContent = await fs.readFile(completedPath, 'utf-8');

      expect(fileContent).toContain(originalContent);
    });
  });

  describe('moveToReviewFolder', () => {
    it('should move work item to review folder', async () => {
      await workspace.createWorkItems([{ title: 'Review me', content: 'Content' }]);
      const workItem = await workspace.getNextWorkItem();
      
      await workspace.moveToReviewFolder(workItem!);

      const reviewPath = path.join(testDir, 'tasks', 'review');
      const pendingPath = path.join(testDir, 'tasks', 'pending');

      const reviewFiles = await fs.readdir(reviewPath);
      const pendingFiles = await fs.readdir(pendingPath);

      expect(reviewFiles.length).toBe(1);
      expect(pendingFiles.length).toBe(0);
    });
  });

  describe('moveFromReviewToCompleted', () => {
    it('should move work item from review to completed', async () => {
      await workspace.createWorkItems([{ title: 'Approve me', content: 'Content' }]);
      const workItem = await workspace.getNextWorkItem();
      await workspace.moveToReviewFolder(workItem!);
      
      await workspace.moveFromReviewToCompleted(workItem!);

      const completedPath = path.join(testDir, 'tasks', 'completed');
      const reviewPath = path.join(testDir, 'tasks', 'review');

      const completedFiles = await fs.readdir(completedPath);
      const reviewFiles = await fs.readdir(reviewPath);

      expect(completedFiles.length).toBe(1);
      expect(reviewFiles.length).toBe(0);
    });
  });

  describe('getRecentCompletedItems', () => {
    it('should return completed items up to count', async () => {
      await workspace.createWorkItems([
        { title: 'Task A', content: 'Content A' },
        { title: 'Task B', content: 'Content B' },
        { title: 'Task C', content: 'Content C' },
      ]);

      const itemA = await workspace.getNextWorkItem();
      await workspace.completeWorkItem(itemA!);
      const itemB = await workspace.getNextWorkItem();
      await workspace.completeWorkItem(itemB!);
      const itemC = await workspace.getNextWorkItem();
      await workspace.completeWorkItem(itemC!);

      const recent = await workspace.getRecentCompletedItems(2);
      expect(recent.length).toBe(2);
    });

    it('should return all completed items when count is high', async () => {
      await workspace.createWorkItems([
        { title: 'Item 1', content: 'Content 1' },
        { title: 'Item 2', content: 'Content 2' },
      ]);

      const item1 = await workspace.getNextWorkItem();
      await workspace.completeWorkItem(item1!);
      const item2 = await workspace.getNextWorkItem();
      await workspace.completeWorkItem(item2!);

      const all = await workspace.getRecentCompletedItems(100);
      expect(all.length).toBe(2);
    });
  });

  describe('getCompletedSummary', () => {
    it('should return no completed message when empty', async () => {
      const summary = await workspace.getCompletedSummary();
      expect(summary).toContain('No completed work items');
    });

    it('should return summary with completed items', async () => {
      await workspace.createWorkItems([{ title: 'Done task', content: 'Content' }]);
      const item = await workspace.getNextWorkItem();
      await workspace.completeWorkItem(item!);

      const summary = await workspace.getCompletedSummary();
      expect(summary).toContain('Completed');
      expect(summary).toContain('done task');
    });
  });

  describe('getCompletedSummaryForMessage', () => {
    it('should return summary for specific message sequence', async () => {
      await workspace.createWorkItems([{ title: 'Task for msg', content: 'Content' }]);
      const item = await workspace.getNextWorkItem();
      await workspace.completeWorkItem(item!);

      const summary = await workspace.getCompletedSummaryForMessage('001');
      expect(summary).toContain('task for msg');
    });

    it('should return no completed message when no items match', async () => {
      const summary = await workspace.getCompletedSummaryForMessage('999');
      expect(summary).toContain('No completed work items');
    });
  });

  describe('getFailedSummaryForMessage', () => {
    it('should return summary for failed items', async () => {
      await workspace.createWorkItems([{ title: 'Failed task', content: 'Content' }]);
      const item = await workspace.getNextWorkItem();
      await workspace.moveToFailedFolder(item!);

      const summary = await workspace.getFailedSummaryForMessage('001');
      expect(summary).toContain('failed task');
    });

    it('should return empty when no failed items match', async () => {
      const summary = await workspace.getFailedSummaryForMessage('999');
      expect(summary).toContain('No failed work items');
    });
  });

  describe('getMessageStats', () => {
    it('should return zero stats for unknown message', async () => {
      const stats = await workspace.getMessageStats('999');
      expect(stats.total).toBe(0);
      expect(stats.pending).toBe(0);
      expect(stats.completed).toBe(0);
    });

    it('should count items across folders', async () => {
      await workspace.createWorkItems([
        { title: 'Pending item', content: 'Content' },
        { title: 'Complete item', content: 'Content' },
      ]);

      const pending = await workspace.getNextWorkItem();
      // Leave pending in pending
      const complete = await workspace.getNextWorkItem();
      await workspace.completeWorkItem(complete!);

      const stats = await workspace.getMessageStats('001');
      expect(stats.total).toBeGreaterThanOrEqual(1);
    });
  });

  describe('getWorkItemsInFolder', () => {
    it('should return work items from pending folder for message', async () => {
      await workspace.createWorkItems([{ title: 'In pending', content: 'Content' }]);

      const items = await workspace.getWorkItemsInFolder('pending', '001');
      expect(items.length).toBe(1);
    });

    it('should return completed items for message', async () => {
      await workspace.createWorkItems([{ title: 'To complete', content: 'Content' }]);
      const item = await workspace.getNextWorkItem();
      await workspace.completeWorkItem(item!);

      const items = await workspace.getWorkItemsInFolder('completed', '001');
      expect(items.length).toBe(1);
    });
  });

  describe('getStats', () => {
    it('should return stats with no work items', async () => {
      const stats = await workspace.getStats();
      expect(stats.workItems).toBe(0);
      expect(stats.nextSequence).toBe(1);
    });

    it('should count current work items', async () => {
      await workspace.createWorkItems([
        { title: 'Item A', content: 'Content' },
        { title: 'Item B', content: 'Content' },
      ]);

      const stats = await workspace.getStats();
      expect(stats.workItems).toBe(2);
    });
  });

  describe('clearCompleted', () => {
    it('should archive completed items', async () => {
      await workspace.createWorkItems([{ title: 'Clear me', content: 'Content' }]);
      const item = await workspace.getNextWorkItem();
      await workspace.completeWorkItem(item!);

      await workspace.clearCompleted();

      const completedPath = path.join(testDir, 'tasks', 'completed');
      const files = await fs.readdir(completedPath);
      const mdFiles = files.filter(f => f.endsWith('.md'));
      expect(mdFiles.length).toBe(0);
    });
  });

  describe('getWorkItemCount', () => {
    it('should return 0 when no items', async () => {
      const count = await workspace.getWorkItemCount();
      expect(count).toBe(0);
    });

    it('should return correct count', async () => {
      await workspace.createWorkItems([
        { title: 'Count A', content: 'Content' },
        { title: 'Count B', content: 'Content' },
      ]);
      const count = await workspace.getWorkItemCount();
      expect(count).toBe(2);
    });
  });

});
