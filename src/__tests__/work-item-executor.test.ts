// Unit tests for WorkItemExecutor

import { WorkItemExecutor, WorkItemExecutorConfig } from '../work-item-executor.js';
import { SessionManager } from '../session-manager.js';
import { WorkspaceManager, WorkItem } from '../workspace-manager.js';
import { TimeoutManager } from '../timeout-manager.js';
import pino from 'pino';
import { jest } from '@jest/globals';

describe('WorkItemExecutor', () => {
  let executor: WorkItemExecutor;
  let mockSessionManager: any;
  let mockWorkspace: any;
  let mockTimeoutManager: any;
  let mockLogger: pino.Logger;
  let mockConfig: WorkItemExecutorConfig;
  
  const createMockWorkItem = (overrides?: Partial<WorkItem>): WorkItem => ({
    filename: 'test_001_task.md',
    fullPath: '/test/workspace/tasks/pending/test_001_task.md',
    sequence: 1001,
    title: 'Test Task',
    content: 'Test content',
    ...overrides
  });
  
  beforeEach(() => {
    // Create mock logger
    mockLogger = pino({ level: 'silent' });
    
    // Create mock session manager
    mockSessionManager = {
      sendPrompt: jest.fn<any>().mockResolvedValue('msg-123'),
      addEventListener: jest.fn<any>().mockReturnValue(jest.fn()),
      cleanupEventListeners: jest.fn<any>(),
      abort: jest.fn<any>().mockResolvedValue(undefined),
      getMessages: jest.fn<any>().mockResolvedValue([]),
      ensureSession: jest.fn<any>().mockResolvedValue(undefined),
    };
    
    // Create mock workspace manager
    mockWorkspace = {
      getRecentCompletedItems: jest.fn<any>().mockResolvedValue([]),
      completeWorkItem: jest.fn<any>().mockResolvedValue(undefined),
      moveToFailedFolder: jest.fn<any>().mockResolvedValue(undefined)
    };
    
    // Create mock timeout manager
    mockTimeoutManager = {
      getRecommendedStrategy: jest.fn<any>().mockResolvedValue({
        strategy: 'retry_extended',
        timeout: 120000,
        reason: 'Test strategy'
      }),
      recordSuccess: jest.fn<any>().mockResolvedValue(undefined),
      recordTimeout: jest.fn<any>().mockResolvedValue(undefined)
    };
    
    // Create test config
    mockConfig = {
      workspacePath: '/test/workspace',
      workingFolder: 'project',
      sdkTimeoutMs: 120000,
      gracePeriodMs: 60000,
      taskRetryCount: 3
    };
    
    // Create executor
    executor = new WorkItemExecutor(
      mockSessionManager,
      mockWorkspace,
      mockTimeoutManager,
      mockConfig,
      mockLogger
    );
  });
  
  afterEach(() => {
    jest.clearAllMocks();
  });
  
  describe('execute', () => {
    it('should execute work item successfully', async () => {
      const workItem = createMockWorkItem();
      
      // Mock idle event to trigger immediately
      mockSessionManager.addEventListener.mockImplementation((event: string, handler: Function) => {
        if (event === 'session.idle') {
          setTimeout(() => handler({ data: {} }), 10);
        }
        return jest.fn();
      });
      
      const result = await executor.execute(workItem);
      
      expect(result.success).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(result.duration).toBeGreaterThan(0);
      expect(mockSessionManager.sendPrompt).toHaveBeenCalled();
      expect(mockTimeoutManager.recordSuccess).toHaveBeenCalled();
    });
    
    it('should include context from recent completed items', async () => {
      const workItem = createMockWorkItem();
      const recentItems = [
        { sequence: 999, title: 'Previous Task 1', filename: 'test.md', content: 'test' },
        { sequence: 1000, title: 'Previous Task 2', filename: 'test2.md', content: 'test2' }
      ];
      
      mockWorkspace.getRecentCompletedItems.mockResolvedValue(recentItems);
      
      mockSessionManager.addEventListener.mockImplementation((event: string, handler: Function) => {
        if (event === 'session.idle') {
          setTimeout(() => handler({ data: {} }), 10);
        }
        return jest.fn();
      });
      
      await executor.execute(workItem);
      
      const promptCall = mockSessionManager.sendPrompt.mock.calls[0][0];
      expect(promptCall).toContain('Previous Task 1');
      expect(promptCall).toContain('Previous Task 2');
      expect(promptCall).toContain('- #999: Previous Task 1');
      expect(promptCall).toContain('- #1000: Previous Task 2');
    });
    
    it('should handle timeout with grace period completion', async () => {
      const workItem = createMockWorkItem();
      
      // Mock idle to trigger after timeout but during grace period
      mockSessionManager.addEventListener.mockImplementation((event: string, handler: Function) => {
        if (event === 'session.idle') {
          // Complete during grace period (timeout + 50ms)
          setTimeout(() => handler({ data: {} }), 120);
        }
        return jest.fn();
      });
      
      mockTimeoutManager.getRecommendedStrategy.mockResolvedValue({
        strategy: 'retry_extended',
        timeout: 80, // Short timeout for test
        reason: 'Test'
      });
      
      mockConfig.gracePeriodMs = 100; // Grace period allows completion
      const newExecutor = new WorkItemExecutor(
        mockSessionManager,
        mockWorkspace,
        mockTimeoutManager,
        mockConfig,
        mockLogger
      );
      
      const result = await newExecutor.execute(workItem);
      
      expect(result.success).toBe(true);
      expect(result.timedOut).toBe(false); // Completed during grace period
    });
    
    it('should handle complete timeout failure', async () => {
      const workItem = createMockWorkItem();
      
      // Never trigger idle event
      mockSessionManager.addEventListener.mockReturnValue(jest.fn());
      
      mockTimeoutManager.getRecommendedStrategy.mockResolvedValue({
        strategy: 'retry_extended',
        timeout: 50,
        reason: 'Test'
      });
      
      mockConfig.gracePeriodMs = 50;
      const newExecutor = new WorkItemExecutor(
        mockSessionManager,
        mockWorkspace,
        mockTimeoutManager,
        mockConfig,
        mockLogger
      );
      
      const result = await newExecutor.execute(workItem);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('did not complete');
      expect(mockSessionManager.abort).toHaveBeenCalled();
      expect(mockTimeoutManager.recordTimeout).toHaveBeenCalled();
    });
    
    it('should handle session protocol errors', async () => {
      const workItem = createMockWorkItem();
      
      mockSessionManager.sendPrompt.mockRejectedValue(
        new Error('Invalid messages with role tool')
      );
      
      const result = await executor.execute(workItem);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('Session protocol error');
    });
    
    it('should handle session expired errors', async () => {
      const workItem = createMockWorkItem();
      
      mockSessionManager.sendPrompt.mockRejectedValue(
        new Error('Session not found')
      );
      
      const result = await executor.execute(workItem);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('Session expired');
    });
    
    it('should call getRecommendedStrategy with work item', async () => {
      const workItem = createMockWorkItem();
      
      mockSessionManager.addEventListener.mockImplementation((event: string, handler: Function) => {
        if (event === 'session.idle') {
          setTimeout(() => handler({ data: {} }), 10);
        }
        return jest.fn();
      });
      
      await executor.execute(workItem);
      
      expect(mockTimeoutManager.getRecommendedStrategy).toHaveBeenCalledWith(workItem);
    });
  });
  
  describe('buildWorkPrompt', () => {
    it('should include working directory in prompt', async () => {
      const workItem = createMockWorkItem();
      
      mockSessionManager.addEventListener.mockImplementation((event: string, handler: Function) => {
        if (event === 'session.idle') {
          setTimeout(() => handler({ data: {} }), 10);
        }
        return jest.fn();
      });
      
      await executor.execute(workItem);
      
      const prompt = mockSessionManager.sendPrompt.mock.calls[0][0];
      expect(prompt).toContain('/test/workspace/project');
    });
    
    it('should include work item details', async () => {
      const workItem = createMockWorkItem({
        sequence: 2005,
        title: 'Custom Task',
        content: 'Custom content here'
      });
      
      mockSessionManager.addEventListener.mockImplementation((event: string, handler: Function) => {
        if (event === 'session.idle') {
          setTimeout(() => handler({ data: {} }), 10);
        }
        return jest.fn();
      });
      
      await executor.execute(workItem);
      
      const prompt = mockSessionManager.sendPrompt.mock.calls[0][0];
      expect(prompt).toContain('2005');
      expect(prompt).toContain('Custom Task');
      expect(prompt).toContain('Custom content here');
    });
    
    it('should include testing instructions in unified prompt', async () => {
      const workItem = createMockWorkItem();
      
      mockSessionManager.addEventListener.mockImplementation((event: string, handler: Function) => {
        if (event === 'session.idle') {
          setTimeout(() => handler({ data: {} }), 10);
        }
        return jest.fn();
      });
      
      await executor.execute(workItem);
      
      const prompt = mockSessionManager.sendPrompt.mock.calls[0][0];
      expect(prompt).toContain('Test your work');
      expect(prompt).toContain('verified it works');
    });

    it('should include working directory in prompt', async () => {
      const workItem = createMockWorkItem();
      
      mockSessionManager.addEventListener.mockImplementation((event: string, handler: Function) => {
        if (event === 'session.idle') {
          setTimeout(() => handler({ data: {} }), 10);
        }
        return jest.fn();
      });
      
      await executor.execute(workItem);
      
      const prompt = mockSessionManager.sendPrompt.mock.calls[0][0];
      expect(prompt).toContain('Working Directory');
      expect(prompt).toContain('executing one work item from a decomposed assignment');
    });

    it('should log sequence when building prompt', async () => {
      const workItem = createMockWorkItem({ sequence: 42 });
      
      const logSpy = jest.spyOn(mockLogger, 'info');
      
      mockSessionManager.addEventListener.mockImplementation((event: string, handler: Function) => {
        if (event === 'session.idle') {
          setTimeout(() => handler({ data: {} }), 10);
        }
        return jest.fn();
      });
      
      await executor.execute(workItem);
      
      // Verify sequence was logged when building prompt
      const logCalls = logSpy.mock.calls.map(call => call[0]);
      const seqLog = logCalls.find(log => 
        typeof log === 'object' && log !== null && 'sequence' in log
      );
      
      expect(seqLog).toBeDefined();
    });
  });
  
  describe('setupStreamingHandlers', () => {
    it('should set up message delta handler', async () => {
      const workItem = createMockWorkItem();
      
      mockSessionManager.addEventListener.mockImplementation((event: string, handler: Function) => {
        if (event === 'session.idle') {
          setTimeout(() => handler({ data: {} }), 10);
        }
        return jest.fn();
      });
      
      await executor.execute(workItem);
      
      const addEventCalls = mockSessionManager.addEventListener.mock.calls;
      const messageDeltaCall = addEventCalls.find((call: any[]) => 
        call[0] === 'assistant.message_delta'
      );
      
      expect(messageDeltaCall).toBeDefined();
    });
    
    it('should set up session idle handler', async () => {
      const workItem = createMockWorkItem();
      
      mockSessionManager.addEventListener.mockImplementation((event: string, handler: Function) => {
        if (event === 'session.idle') {
          setTimeout(() => handler({ data: {} }), 10);
        }
        return jest.fn();
      });
      
      await executor.execute(workItem);
      
      const addEventCalls = mockSessionManager.addEventListener.mock.calls;
      const idleHandlerCalls = addEventCalls.filter((call: any[]) => 
        call[0] === 'session.idle'
      );
      
      // Should have multiple idle handlers (one for streaming, one for execution wait)
      expect(idleHandlerCalls.length).toBeGreaterThan(0);
    });
  });
  
  describe('retry tracking', () => {
    it('should track retry attempts', () => {
      executor.setRetryAttempt('test.md', 2);
      
      expect(executor.getRetryAttempt('test.md')).toBe(2);
    });
    
    it('should return 0 for unknown work items', () => {
      expect(executor.getRetryAttempt('unknown.md')).toBe(0);
    });
    
    it('should clear retry attempts', () => {
      executor.setRetryAttempt('test.md', 3);
      executor.clearRetryAttempt('test.md');
      
      expect(executor.getRetryAttempt('test.md')).toBe(0);
    });
  });
  
  describe('calculateNextTimeout', () => {
    it('should return base timeout for first attempt', () => {
      const result = executor.calculateNextTimeout(120000, 0, 1.5);
      
      expect(result).toBe(120000);
    });
    
    it('should apply multiplier for subsequent attempts', () => {
      const result = executor.calculateNextTimeout(120000, 1, 1.5);
      
      expect(result).toBe(180000); // 120000 * 1.5
    });
    
    it('should compound multiplier correctly', () => {
      const result = executor.calculateNextTimeout(120000, 2, 1.5);
      
      expect(result).toBe(270000); // 120000 * 1.5^2
    });
  });
  
  describe('error handling', () => {
    it('should cleanup listeners on success', async () => {
      const workItem = createMockWorkItem();
      
      mockSessionManager.addEventListener.mockImplementation((event: string, handler: Function) => {
        if (event === 'session.idle') {
          setTimeout(() => handler({ data: {} }), 10);
        }
        return jest.fn();
      });
      
      await executor.execute(workItem);
      
      expect(mockSessionManager.cleanupEventListeners).toHaveBeenCalled();
    });
    
    it('should cleanup listeners on failure', async () => {
      const workItem = createMockWorkItem();
      
      mockSessionManager.sendPrompt.mockRejectedValue(new Error('Test error'));
      
      await executor.execute(workItem);
      
      expect(mockSessionManager.cleanupEventListeners).toHaveBeenCalled();
    });
    
    it('should log session status on timeout', async () => {
      const workItem = createMockWorkItem();
      
      mockSessionManager.addEventListener.mockReturnValue(jest.fn());
      mockSessionManager.getMessages.mockResolvedValue([
        { type: 'assistant.message_delta', timestamp: Date.now(), data: {} },
        { type: 'tool.execution_start', timestamp: Date.now(), data: {} }
      ]);
      
      mockTimeoutManager.getRecommendedStrategy.mockResolvedValue({
        strategy: 'retry_extended',
        timeout: 50,
        reason: 'Test'
      });
      
      mockConfig.gracePeriodMs = 50;
      const newExecutor = new WorkItemExecutor(
        mockSessionManager,
        mockWorkspace,
        mockTimeoutManager,
        mockConfig,
        mockLogger
      );
      
      await newExecutor.execute(workItem);
      
      expect(mockSessionManager.getMessages).toHaveBeenCalled();
    });
  });
  
  describe('integration scenarios', () => {
    it('should handle full execution lifecycle', async () => {
      const workItem = createMockWorkItem();
      const recentItems = [
        { sequence: 999, title: 'Previous', filename: 'prev.md', content: 'prev' }
      ];
      
      mockWorkspace.getRecentCompletedItems.mockResolvedValue(recentItems);
      mockSessionManager.addEventListener.mockImplementation((event: string, handler: Function) => {
        if (event === 'session.idle') {
          setTimeout(() => handler({ data: {} }), 10);
        }
        return jest.fn();
      });
      
      const result = await executor.execute(workItem);
      
      expect(result.success).toBe(true);
      expect(mockWorkspace.getRecentCompletedItems).toHaveBeenCalledWith(3);
      expect(mockTimeoutManager.getRecommendedStrategy).toHaveBeenCalledWith(workItem);
      expect(mockSessionManager.sendPrompt).toHaveBeenCalled();
      expect(mockTimeoutManager.recordSuccess).toHaveBeenCalled();
      expect(mockSessionManager.cleanupEventListeners).toHaveBeenCalled();
    });
    
    it('should handle execution with abort event', async () => {
      const workItem = createMockWorkItem();
      let abortHandlerCalled = false;
      
      mockSessionManager.addEventListener.mockImplementation((event: string, handler: Function) => {
        if (event === 'session.idle') {
          setTimeout(() => handler({ data: {} }), 10);
        } else if (event === 'abort') {
          abortHandlerCalled = true;
          setTimeout(() => handler({ data: { reason: 'Test abort' } }), 5);
        }
        return jest.fn();
      });
      
      const result = await executor.execute(workItem);
      
      expect(result.success).toBe(true);
      expect(abortHandlerCalled).toBe(true);
    });
  });

  // =====================================================================
  // Anti-stuttering: duplicate-delta detection canary
  // =====================================================================

  describe('duplicate-delta detection canary', () => {
    it('should accumulate unique deltas normally', async () => {
      const workItem = createMockWorkItem();
      let deltaHandler: Function;

      mockSessionManager.addEventListener.mockImplementation((event: string, handler: Function) => {
        if (event === 'assistant.message_delta') {
          deltaHandler = handler;
        }
        if (event === 'session.idle') {
          // Fire deltas then idle
          setTimeout(() => {
            deltaHandler({ data: { deltaContent: 'Hello ' } });
            deltaHandler({ data: { deltaContent: 'World' } });
            handler({ data: {} });
          }, 10);
        }
        return jest.fn();
      });

      const result = await executor.execute(workItem);

      expect(result.success).toBe(true);
      // Both unique deltas should be accumulated in responseText
      expect(result.responseText).toContain('Hello ');
      expect(result.responseText).toContain('World');
    });

    it('should skip duplicate deltas arriving within 10ms', async () => {
      const workItem = createMockWorkItem();
      let deltaHandler: Function;
      let idleHandler: Function;

      mockSessionManager.addEventListener.mockImplementation((event: string, handler: Function) => {
        if (event === 'assistant.message_delta') {
          deltaHandler = handler;
        }
        if (event === 'session.idle') {
          idleHandler = handler;
        }
        return jest.fn();
      });

      // Start execution (will block on idle)
      const resultPromise = executor.execute(workItem);

      // Wait for handlers to be registered
      await new Promise(resolve => setTimeout(resolve, 50));

      // Simulate stuttering: same content delivered rapidly
      const now = Date.now();
      jest.spyOn(Date, 'now')
        .mockReturnValueOnce(now)       // first "Requirements" — accepted
        .mockReturnValueOnce(now + 1)   // duplicate within 10ms — skipped
        .mockReturnValueOnce(now + 2)   // duplicate within 10ms — skipped
        .mockReturnValueOnce(now + 100) // different content, 100ms later — accepted
        .mockReturnValue(now + 200);    // idle timestamp

      deltaHandler!({ data: { deltaContent: 'Requirements' } });
      deltaHandler!({ data: { deltaContent: 'Requirements' } }); // duplicate
      deltaHandler!({ data: { deltaContent: 'Requirements' } }); // duplicate
      deltaHandler!({ data: { deltaContent: ' analysis' } });    // unique

      // Trigger idle to complete execution
      idleHandler!({ data: {} });

      const result = await resultPromise;

      expect(result.success).toBe(true);
      // Only one "Requirements" should be accumulated, not three
      expect(result.responseText).toBe('Requirements analysis');

      jest.restoreAllMocks();
    });

    it('should allow same content after sufficient time gap', async () => {
      const workItem = createMockWorkItem();
      let deltaHandler: Function;
      let idleHandler: Function;

      mockSessionManager.addEventListener.mockImplementation((event: string, handler: Function) => {
        if (event === 'assistant.message_delta') {
          deltaHandler = handler;
        }
        if (event === 'session.idle') {
          idleHandler = handler;
        }
        return jest.fn();
      });

      const resultPromise = executor.execute(workItem);
      await new Promise(resolve => setTimeout(resolve, 50));

      // Simulate repeated content with >10ms gap (legitimate repetition)
      const now = Date.now();
      jest.spyOn(Date, 'now')
        .mockReturnValueOnce(now)        // first "ok" — accepted
        .mockReturnValueOnce(now + 50)   // same content, 50ms later — accepted (not a dup)
        .mockReturnValue(now + 100);

      deltaHandler!({ data: { deltaContent: 'ok' } });
      deltaHandler!({ data: { deltaContent: 'ok' } }); // same but 50ms gap

      idleHandler!({ data: {} });

      const result = await resultPromise;

      expect(result.success).toBe(true);
      // Both should be accumulated since >10ms apart
      expect(result.responseText).toBe('okok');

      jest.restoreAllMocks();
    });
  });
});
