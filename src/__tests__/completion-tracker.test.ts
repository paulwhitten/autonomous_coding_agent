// Tests for CompletionTracker

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { CompletionTracker, MessageStats } from '../completion-tracker.js';
import { WorkspaceManager, WorkItem } from '../workspace-manager.js';
import { CommunicationBackend } from '../communication-backend.js';
import pino from 'pino';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

// Helper to create test work items
function createWorkItem(filename: string, sequence: number): WorkItem {
  return {
    filename,
    title: 'Test Item',
    content: 'Test content',
    sequence,
    fullPath: `/tmp/test/${filename}`
  };
}

describe('CompletionTracker', () => {
  let tracker: CompletionTracker;
  let mockWorkspace: any;
  let mockBackend: any;
  let mockLogger: any;
  let testWorkspacePath: string;
  
  const testConfig = {
    managerHostname: 'test-manager',
    managerRole: 'manager',
    agentId: 'test-agent',
    workspacePath: '', // Will be set in beforeEach
    gitSync: false,
    autoCommit: false
  };
  
  beforeEach(async () => {
    // Create a real temp directory for this test
    testWorkspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'completion-tracker-test-'));
    const failedPath = path.join(testWorkspacePath, 'tasks', 'failed');
    await fs.mkdir(failedPath, { recursive: true });
    testConfig.workspacePath = testWorkspacePath;
    
    mockWorkspace = {
      getMessageStats: jest.fn(),
      getCompletedSummaryForMessage: jest.fn(),
      getFailedSummaryForMessage: jest.fn(),
      getWorkItemsInFolder: jest.fn(),
      getCompletedSummary: jest.fn(),
      getStats: jest.fn()
    };
    
    mockBackend = {
      sendMessage: jest.fn<any>().mockResolvedValue({ success: true, ref: '' }),
      escalate: jest.fn<any>(),
      syncToRemote: jest.fn<any>(),
      getTeamRoster: jest.fn<any>().mockResolvedValue(null),
    };
    
    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn()
    };
    
    tracker = new CompletionTracker(
      mockWorkspace as WorkspaceManager,
      mockBackend as CommunicationBackend,
      testConfig,
      mockLogger as pino.Logger
    );
  });
  
  afterEach(async () => {
    // Clean up temp directory
    if (testWorkspacePath) {
      await fs.rm(testWorkspacePath, { recursive: true, force: true });
    }
  });
  
  describe('checkMessageCompletion', () => {
    it('should skip old format filenames without message sequence', async () => {
      const workItem = createWorkItem('old_format.md', 1);
      
      await tracker.checkMessageCompletion(workItem);
      
      expect(mockWorkspace.getMessageStats).not.toHaveBeenCalled();
    });
    
    it('should not report if pending items remain', async () => {
      const workItem = createWorkItem('001_002_test_item.md', 1002);
      
      mockWorkspace.getMessageStats.mockResolvedValue({
        total: 5,
        pending: 2,
        completed: 3,
        reviewed: 0,
        failed: 0
      });
      
      await tracker.checkMessageCompletion(workItem);
      
      expect(mockWorkspace.getMessageStats).toHaveBeenCalledWith('001');
      expect(mockBackend.sendMessage).not.toHaveBeenCalled();
    });
    
    it('should send completion report for successful assignment', async () => {
      const workItem = createWorkItem('001_005_test_item.md', 1005);
      
      const stats: MessageStats = {
        total: 5,
        pending: 0,
        completed: 5,
        reviewed: 0,
        failed: 0
      };
      
      mockWorkspace.getMessageStats.mockResolvedValue(stats);
      mockWorkspace.getCompletedSummaryForMessage.mockResolvedValue('Test summary');
      
      await tracker.checkMessageCompletion(workItem);
      
      expect(mockLogger.info).toHaveBeenCalledWith('Message 001 completed: 5/5 items');
      expect(mockBackend.sendMessage).toHaveBeenCalledWith(
        { hostname: 'test-manager', role: 'manager' },
        expect.objectContaining({
          subject: 'Assignment 001 completed',
          content: expect.stringContaining('successfully completed'),
          priority: 'NORMAL',
          messageType: 'status',
        }),
      );
    });
    
    it('should handle partial failure with recovery', async () => {
      const workItem = createWorkItem('002_010_test_item.md', 2010);
      
      const stats: MessageStats = {
        total: 10,
        pending: 0,
        completed: 8,
        reviewed: 0,
        failed: 2
      };
      
      mockWorkspace.getMessageStats.mockResolvedValue(stats);
      mockWorkspace.getCompletedSummaryForMessage.mockResolvedValue('Test summary');
      mockWorkspace.getWorkItemsInFolder.mockImplementation((folder: string) => {
        if (folder === 'failed') {
          return Promise.resolve([
            { filename: '002_003_failed_item.md', title: 'Failed Item 1' },
            { filename: '002_007_failed_item.md', title: 'Failed Item 2' }
          ]);
        }
        return Promise.resolve([
          { filename: '002_001_completed.md', title: 'Completed 1' }
        ]);
      });
      
      await tracker.checkMessageCompletion(workItem);
      
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Message 002 completed with recovery: 8/10 items (2 failed but recovered)'
      );
      expect(mockBackend.sendMessage).toHaveBeenCalled();
    });
    
    it('should escalate complete failure', async () => {
      const workItem = createWorkItem('003_005_test_item.md', 3005);
      
      const stats: MessageStats = {
        total: 5,
        pending: 0,
        completed: 0,
        reviewed: 0,
        failed: 5
      };
      
      mockWorkspace.getMessageStats.mockResolvedValue(stats);
      mockWorkspace.getFailedSummaryForMessage.mockResolvedValue('All items failed');
      
      await tracker.checkMessageCompletion(workItem);
      
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Message 003 failed: 5/5 items failed, none completed'
      );
      expect(mockBackend.escalate).toHaveBeenCalledWith(
        'Assignment 003 failed completely',
        expect.stringContaining('failed with no successful work items')
      );
    });
    
    it('should include recovered items in completion report', async () => {
      const workItem = createWorkItem('004_003_test_item.md', 4003);
      
      const stats: MessageStats = {
        total: 3,
        pending: 0,
        completed: 2,
        reviewed: 0,
        failed: 1
      };
      
      mockWorkspace.getMessageStats.mockResolvedValue(stats);
      mockWorkspace.getCompletedSummaryForMessage.mockResolvedValue('Summary');
      mockWorkspace.getWorkItemsInFolder.mockResolvedValue([]);
      
      await tracker.checkMessageCompletion(workItem);
      
      const callArgs = mockBackend.sendMessage.mock.calls[0];
      expect(callArgs[1].content).toContain('Failed (recovered): 1');
      expect(callArgs[1].content).toContain('Completed with recovery');
    });
  });
  
  describe('sendProjectCompletionReport', () => {
    it('should send project completion report to manager', async () => {
      mockWorkspace.getCompletedSummary.mockResolvedValue('All tasks completed');
      mockWorkspace.getStats.mockResolvedValue({
        completedItems: 25,
        workItems: 0
      });
      
      await tracker.sendProjectCompletionReport();
      
      expect(mockLogger.info).toHaveBeenCalledWith('Sending project completion report');
      expect(mockBackend.sendMessage).toHaveBeenCalledWith(
        { hostname: 'test-manager', role: 'manager' },
        expect.objectContaining({
          subject: 'Project Completed',
          content: expect.stringContaining('All work items completed'),
          priority: 'NORMAL',
          messageType: 'status',
        }),
      );
      expect(mockLogger.info).toHaveBeenCalledWith('Completion report sent');
    });
    
    it('should include statistics in project report', async () => {
      mockWorkspace.getCompletedSummary.mockResolvedValue('Summary');
      mockWorkspace.getStats.mockResolvedValue({
        completedItems: 42,
        workItems: 0
      });
      
      await tracker.sendProjectCompletionReport();
      
      const callArgs = mockBackend.sendMessage.mock.calls[0];
      expect(callArgs[1].content).toContain('Total work items: 42');
      expect(callArgs[1].content).toContain('test-agent');
    });
    
    it('should sync to git when configured', async () => {
      const trackerWithGit = new CompletionTracker(
        mockWorkspace as WorkspaceManager,
        mockBackend as CommunicationBackend,
        { ...testConfig, gitSync: true, autoCommit: true },
        mockLogger as pino.Logger
      );
      
      mockWorkspace.getCompletedSummary.mockResolvedValue('Summary');
      mockWorkspace.getStats.mockResolvedValue({ completedItems: 10, workItems: 0 });
      
      await trackerWithGit.sendProjectCompletionReport();
      
      expect(mockBackend.syncToRemote).toHaveBeenCalledWith('Project completion report');
    });
    
    it('should not sync to git when disabled', async () => {
      mockWorkspace.getCompletedSummary.mockResolvedValue('Summary');
      mockWorkspace.getStats.mockResolvedValue({ completedItems: 10, workItems: 0 });
      
      await tracker.sendProjectCompletionReport();
      
      expect(mockBackend.syncToRemote).not.toHaveBeenCalled();
    });
  });
  
  describe('recovery notes', () => {
    it('should create recovery notes for failed items in successful assignment', async () => {
      const workItem = createWorkItem('005_005_test_item.md', 5005);
      
      const stats: MessageStats = {
        total: 5,
        pending: 0,
        completed: 3,
        reviewed: 0,
        failed: 2
      };
      
      mockWorkspace.getMessageStats.mockResolvedValue(stats);
      mockWorkspace.getCompletedSummaryForMessage.mockResolvedValue('Summary');
      mockWorkspace.getWorkItemsInFolder.mockImplementation((folder: string) => {
        if (folder === 'failed') {
          return Promise.resolve([
            { filename: '005_002_failed.md', title: 'Failed Item', content: '', sequence: 5002, fullPath: '/tmp/failed.md' }
          ]);
        }
        return Promise.resolve([
          { filename: '005_001_done.md', title: 'Done Item', content: '', sequence: 5001, fullPath: '/tmp/done.md' }
        ]);
      });
      
      await tracker.checkMessageCompletion(workItem);
      
      // Verify recovery note was created in the actual filesystem
      const recoveryPath = path.join(testWorkspacePath, 'tasks', 'failed', '005_002_failed-recovery.md');
      const recoveryContent = await fs.readFile(recoveryPath, 'utf-8');
      
      expect(recoveryContent).toContain('# Recovery Note');
      expect(recoveryContent).toContain('Failed Item');
      expect(recoveryContent).toContain('Assignment 005: **Successfully completed**');
      expect(recoveryContent).toContain('Total work items: 5');
      expect(recoveryContent).toContain('Completed: 3');
      expect(recoveryContent).toContain('Failed: 2');
      
      expect(mockWorkspace.getWorkItemsInFolder).toHaveBeenCalledWith('failed', '005');
      expect(mockWorkspace.getWorkItemsInFolder).toHaveBeenCalledWith('completed', '005');
      expect(mockBackend.sendMessage).toHaveBeenCalled();
    });
  });
  
  describe('message sequence extraction', () => {
    it('should extract message sequence from 3-digit format', async () => {
      const workItem = createWorkItem('001_002_test.md', 1002);
      
      mockWorkspace.getMessageStats.mockResolvedValue({
        total: 1,
        pending: 1,
        completed: 0,
        reviewed: 0,
        failed: 0
      });
      
      await tracker.checkMessageCompletion(workItem);
      
      expect(mockWorkspace.getMessageStats).toHaveBeenCalledWith('001');
    });
    
    it('should extract message sequence from 4-digit format', async () => {
      const workItem = createWorkItem('1234_5678_test.md', 12345678);
      
      mockWorkspace.getMessageStats.mockResolvedValue({
        total: 1,
        pending: 1,
        completed: 0,
        reviewed: 0,
        failed: 0
      });
      
      await tracker.checkMessageCompletion(workItem);
      
      expect(mockWorkspace.getMessageStats).toHaveBeenCalledWith('1234');
    });
  });
  
  describe('git changes', () => {
    it('should include git changes in completion report', async () => {
      const workItem = createWorkItem('006_001_test.md', 6001);
      
      mockWorkspace.getMessageStats.mockResolvedValue({
        total: 1,
        pending: 0,
        completed: 1,
        reviewed: 0,
        failed: 0
      });
      mockWorkspace.getCompletedSummaryForMessage.mockResolvedValue('Summary');
      
      await tracker.checkMessageCompletion(workItem);
      
      const callArgs = mockBackend.sendMessage.mock.calls[0];
      expect(callArgs[1].content).toContain('Changes made:');
    });
  });
  
  describe('edge cases', () => {
    it('should handle empty stats gracefully', async () => {
      const workItem = createWorkItem('007_001_test.md', 7001);
      
      mockWorkspace.getMessageStats.mockResolvedValue({
        total: 0,
        pending: 0,
        completed: 0,
        reviewed: 0,
        failed: 0
      });
      
      await tracker.checkMessageCompletion(workItem);
      
      // Should not send any messages for empty stats
      expect(mockBackend.sendMessage).not.toHaveBeenCalled();
      expect(mockBackend.escalate).not.toHaveBeenCalled();
    });
    
    it('should handle reviewed items as successful', async () => {
      const workItem = createWorkItem('008_003_test.md', 8003);
      
      mockWorkspace.getMessageStats.mockResolvedValue({
        total: 3,
        pending: 0,
        completed: 0,
        reviewed: 3,
        failed: 0
      });
      mockWorkspace.getCompletedSummaryForMessage.mockResolvedValue('Summary');
      
      await tracker.checkMessageCompletion(workItem);
      
      expect(mockLogger.info).toHaveBeenCalledWith('Message 008 completed: 0/3 items');
      expect(mockBackend.sendMessage).toHaveBeenCalled();
    });
  });
});
