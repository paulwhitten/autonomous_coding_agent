// Unit tests for SessionManager

import { SessionManager, SessionConfig, isRateLimitError, parseRateLimitDelay } from '../session-manager.js';
import { CopilotClient, CopilotSession } from '@github/copilot-sdk';
import pino from 'pino';
import { jest } from '@jest/globals';

describe('SessionManager', () => {
  let sessionManager: SessionManager;
  let mockClient: any;
  let mockSession: any;
  let mockLogger: pino.Logger;

  const defaultConfig: SessionConfig = {
    model: 'gpt-4.1',
    streaming: true,
    tools: []
  };

  beforeEach(() => {
    // Create mock logger
    mockLogger = pino({ level: 'silent' });

    // Create mock session
    mockSession = {
      sessionId: 'test-session-123',
      send: jest.fn<any>().mockResolvedValue('msg-456'),
      sendAndWait: jest.fn<any>().mockResolvedValue(undefined),
      on: jest.fn<any>().mockReturnValue(() => {}),
      abort: jest.fn<any>().mockResolvedValue(undefined),
      getMessages: jest.fn<any>().mockResolvedValue([])
    };

    // Create mock client
    mockClient = {
      createSession: jest.fn<any>().mockResolvedValue(mockSession),
      resumeSession: jest.fn<any>().mockResolvedValue(mockSession),
      deleteSession: jest.fn<any>().mockResolvedValue(undefined),
      getState: jest.fn<any>().mockReturnValue('connected'),
      listSessions: jest.fn<any>().mockResolvedValue([]),
      ping: jest.fn<any>().mockResolvedValue({ message: 'pong', timestamp: Date.now() }),
    };

    // Create session manager
    sessionManager = new SessionManager(mockClient, mockLogger);
  });

  afterEach(() => {
    sessionManager.dispose();
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with inactive state', () => {
      const state = sessionManager.getState();
      expect(state.isActive).toBe(false);
      expect(state.sessionId).toBeUndefined();
      expect(sessionManager.getSession()).toBeNull();
      expect(sessionManager.isActive()).toBe(false);
    });
  });

  describe('initializeSession', () => {
    it('should create new session when no sessionId provided', async () => {
      const sessionId = await sessionManager.initializeSession(
        undefined,
        defaultConfig
      );

      expect(sessionId).toBe('test-session-123');
      expect(mockClient.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-4.1',
          streaming: true,
          tools: [],
        })
      );
      // Default permission handler should be provided
      const callArgs = mockClient.createSession.mock.calls[0][0];
      expect(typeof callArgs.onPermissionRequest).toBe('function');
      expect(mockClient.resumeSession).not.toHaveBeenCalled();
      expect(sessionManager.isActive()).toBe(true);
      expect(sessionManager.getSession()).toBe(mockSession);
    });

    it('should pass onPermissionRequest and workingDirectory to createSession', async () => {
      const mockHandler = jest.fn();
      const configWithPermissions: SessionConfig = {
        ...defaultConfig,
        onPermissionRequest: mockHandler,
        workingDirectory: '/test/workspace',
      };

      await sessionManager.initializeSession(undefined, configWithPermissions);

      expect(mockClient.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          onPermissionRequest: mockHandler,
          workingDirectory: '/test/workspace',
        })
      );
    });

    it('should resume existing session when sessionId provided', async () => {
      const existingSessionId = 'existing-session-789';
      mockClient.resumeSession.mockResolvedValue({
        ...mockSession,
        sessionId: existingSessionId
      } as any);

      const sessionId = await sessionManager.initializeSession(
        existingSessionId,
        defaultConfig
      );

      expect(sessionId).toBe(existingSessionId);
      expect(mockClient.resumeSession).toHaveBeenCalledWith(existingSessionId,
        expect.objectContaining({
          tools: defaultConfig.tools,
          streaming: defaultConfig.streaming,
        })
      );
      // Default permission handler should be provided
      const resumeArgs = mockClient.resumeSession.mock.calls[0][1];
      expect(typeof resumeArgs.onPermissionRequest).toBe('function');
      expect(mockClient.createSession).not.toHaveBeenCalled();
    });

    it('should pass onPermissionRequest and workingDirectory to resumeSession', async () => {
      const mockHandler = jest.fn();
      const configWithPermissions: SessionConfig = {
        ...defaultConfig,
        onPermissionRequest: mockHandler,
        workingDirectory: '/test/workspace',
      };
      const existingSessionId = 'existing-session-789';
      mockClient.resumeSession.mockResolvedValue({
        ...mockSession,
        sessionId: existingSessionId,
      } as any);

      await sessionManager.initializeSession(existingSessionId, configWithPermissions);

      expect(mockClient.resumeSession).toHaveBeenCalledWith(existingSessionId, {
        tools: defaultConfig.tools,
        streaming: defaultConfig.streaming,
        onPermissionRequest: mockHandler,
        workingDirectory: '/test/workspace',
      });
    });

    it('should create new session if resume fails', async () => {
      mockClient.resumeSession.mockRejectedValue(new Error('Session expired'));

      const sessionId = await sessionManager.initializeSession(
        'expired-session',
        defaultConfig
      );

      expect(sessionId).toBe('test-session-123');
      expect(mockClient.resumeSession).toHaveBeenCalled();
      expect(mockClient.createSession).toHaveBeenCalled();
    });

    it('should force new session when forceNew is true', async () => {
      const sessionId = await sessionManager.initializeSession(
        'existing-session',
        defaultConfig,
        true // forceNew
      );

      expect(sessionId).toBe('test-session-123');
      expect(mockClient.createSession).toHaveBeenCalled();
      expect(mockClient.resumeSession).not.toHaveBeenCalled();
    });

    it('should update session state correctly', async () => {
      await sessionManager.initializeSession(undefined, defaultConfig);

      const state = sessionManager.getState();
      expect(state.isActive).toBe(true);
      expect(state.sessionId).toBe('test-session-123');
      expect(state.lastActivity).toBeInstanceOf(Date);
    });

    it('should clean up existing session before creating new one', async () => {
      // Create first session with listeners
      await sessionManager.initializeSession(undefined, defaultConfig);
      const unsubscribe1 = jest.fn();
      mockSession.on.mockReturnValue(unsubscribe1);
      sessionManager.addEventListener('session.idle' as any, () => {});

      // Create second session
      await sessionManager.initializeSession(undefined, defaultConfig, true);

      expect(unsubscribe1).toHaveBeenCalled();
    });
  });

  describe('sendPrompt', () => {
    beforeEach(async () => {
      await sessionManager.initializeSession(undefined, defaultConfig);
    });

    it('should send prompt to active session', async () => {
      const messageId = await sessionManager.sendPrompt('Test prompt');

      expect(messageId).toBe('msg-456');
      expect(mockSession.send).toHaveBeenCalledWith({ prompt: 'Test prompt' });
    });

    it('should update lastActivity timestamp', async () => {
      const beforeTime = new Date();
      await sessionManager.sendPrompt('Test');
      const state = sessionManager.getState();

      expect(state.lastActivity).toBeInstanceOf(Date);
      expect(state.lastActivity!.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
    });

    it('should throw error if no active session and renewal fails', async () => {
      const newManager = new SessionManager(mockClient, mockLogger);

      await expect(newManager.sendPrompt('Test')).rejects.toThrow(
        'ensureSession failed'
      );
    });
  });

  describe('sendPromptAndWait', () => {
    beforeEach(async () => {
      await sessionManager.initializeSession(undefined, defaultConfig);
    });

    it('should send prompt and wait for completion', async () => {
      await sessionManager.sendPromptAndWait('Test prompt', 30000);

      expect(mockSession.sendAndWait).toHaveBeenCalledWith({ prompt: 'Test prompt' }, 30000);
    });

    it('should update lastActivity timestamp', async () => {
      const beforeTime = new Date();
      await sessionManager.sendPromptAndWait('Test');
      const state = sessionManager.getState();

      expect(state.lastActivity).toBeInstanceOf(Date);
      expect(state.lastActivity!.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
    });

    it('should throw error if no active session and renewal fails', async () => {
      const newManager = new SessionManager(mockClient, mockLogger);

      await expect(newManager.sendPromptAndWait('Test')).rejects.toThrow(
        'ensureSession failed'
      );
    });
  });

  describe('addEventListener', () => {
    beforeEach(async () => {
      await sessionManager.initializeSession(undefined, defaultConfig);
    });

    it('should register event listener on session', () => {
      const handler = jest.fn();
      const unsubscribe = jest.fn();
      mockSession.on.mockReturnValue(unsubscribe);

      const returnedUnsubscribe = sessionManager.addEventListener('session.idle' as any as any, handler);

      expect(mockSession.on).toHaveBeenCalledWith('session.idle', handler);
      // returnedUnsubscribe is a diagnostic wrapper; calling it should invoke the SDK unsub
      expect(typeof returnedUnsubscribe).toBe('function');
      returnedUnsubscribe();
      expect(unsubscribe).toHaveBeenCalled();
    });

    it('should track event listeners for cleanup', () => {
      const unsubscribe1 = jest.fn();
      const unsubscribe2 = jest.fn();
      mockSession.on
        .mockReturnValueOnce(unsubscribe1)
        .mockReturnValueOnce(unsubscribe2);

      sessionManager.addEventListener('session.idle' as any, () => {});
      sessionManager.addEventListener('session.idle' as any, () => {});
      sessionManager.cleanupEventListeners();

      expect(unsubscribe1).toHaveBeenCalled();
      expect(unsubscribe2).toHaveBeenCalled();
    });

    it('should throw error if no active session', () => {
      const newManager = new SessionManager(mockClient, mockLogger);

      expect(() => newManager.addEventListener('session.idle' as any as any, () => {})).toThrow(
        'No active session - call ensureSession()'
      );
    });
  });

  describe('cleanupEventListeners', () => {
    beforeEach(async () => {
      await sessionManager.initializeSession(undefined, defaultConfig);
    });

    it('should call all unsubscribe functions', () => {
      const unsubscribes = [jest.fn(), jest.fn(), jest.fn()];
      mockSession.on
        .mockReturnValueOnce(unsubscribes[0])
        .mockReturnValueOnce(unsubscribes[1])
        .mockReturnValueOnce(unsubscribes[2]);

      sessionManager.addEventListener('session.idle' as any as any, () => {});
      sessionManager.addEventListener('session.idle' as any as any, () => {});
      sessionManager.addEventListener('session.idle' as any as any, () => {});

      sessionManager.cleanupEventListeners();

      unsubscribes.forEach(unsub => {
        expect(unsub).toHaveBeenCalled();
      });
    });

    it('should clear listeners array after cleanup', () => {
      const unsubscribe = jest.fn();
      mockSession.on.mockReturnValue(unsubscribe);

      sessionManager.addEventListener('session.idle' as any as any, () => {});
      sessionManager.cleanupEventListeners();

      // Cleanup again should do nothing
      sessionManager.cleanupEventListeners();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('should handle cleanup with no listeners gracefully', () => {
      expect(() => sessionManager.cleanupEventListeners()).not.toThrow();
    });
  });

  describe('abort', () => {
    beforeEach(async () => {
      await sessionManager.initializeSession(undefined, defaultConfig);
    });

    it('should call abort on active session', async () => {
      await sessionManager.abort();

      expect(mockSession.abort).toHaveBeenCalled();
    });

    it('should not throw if no active session', async () => {
      const newManager = new SessionManager(mockClient, mockLogger);

      // abort() is now graceful -- returns silently when no session
      await expect(newManager.abort()).resolves.toBeUndefined();
    });
  });

  describe('getMessages', () => {
    beforeEach(async () => {
      await sessionManager.initializeSession(undefined, defaultConfig);
    });

    it('should return messages from active session', async () => {
      const mockMessages = [
        { id: '1', timestamp: '2024-01-01', parentId: null, type: 'system.message' as const, data: { content: 'Hello', role: 'developer' as const } },
        { id: '2', timestamp: '2024-01-01', parentId: null, type: 'system.message' as const, data: { content: 'Hi there', role: 'system' as const } }
      ];
      mockSession.getMessages.mockResolvedValue(mockMessages as any);

      const messages = await sessionManager.getMessages();

      expect(messages).toEqual(mockMessages);
      expect(mockSession.getMessages).toHaveBeenCalled();
    });

    it('should return empty array if no active session', async () => {
      const newManager = new SessionManager(mockClient, mockLogger);

      // getMessages() is now graceful -- returns [] when no session
      const messages = await newManager.getMessages();
      expect(messages).toEqual([]);
    });
  });

  describe('reinitialize', () => {
    it('should create new session and clean up old one', async () => {
      // Create initial session
      await sessionManager.initializeSession(undefined, defaultConfig);
      const unsubscribe = jest.fn();
      mockSession.on.mockReturnValue(unsubscribe);
      sessionManager.addEventListener('session.idle' as any as any, () => {});

      // Reinitialize
      mockClient.createSession.mockResolvedValue({
        ...mockSession,
        sessionId: 'new-session-999'
      } as any);

      const newSessionId = await sessionManager.reinitialize(defaultConfig);

      expect(newSessionId).toBe('new-session-999');
      expect(unsubscribe).toHaveBeenCalled();
      expect(mockClient.createSession).toHaveBeenCalledTimes(2);
    });

    it('should force new session creation', async () => {
      await sessionManager.reinitialize(defaultConfig);

      // Should not attempt to resume
      expect(mockClient.resumeSession).not.toHaveBeenCalled();
      expect(mockClient.createSession).toHaveBeenCalled();
    });
  });

  describe('dispose', () => {
    it('should clean up all resources', async () => {
      await sessionManager.initializeSession(undefined, defaultConfig);
      const unsubscribe = jest.fn();
      mockSession.on.mockReturnValue(unsubscribe);
      sessionManager.addEventListener('session.idle' as any as any, () => {});

      sessionManager.dispose();

      expect(unsubscribe).toHaveBeenCalled();
      expect(sessionManager.getSession()).toBeNull();
      expect(sessionManager.isActive()).toBe(false);
      
      const state = sessionManager.getState();
      expect(state.isActive).toBe(false);
      expect(state.sessionId).toBeUndefined();
    });

    it('should handle dispose without initialization', () => {
      expect(() => sessionManager.dispose()).not.toThrow();
    });
  });

  describe('getState', () => {
    it('should return copy of state, not reference', async () => {
      await sessionManager.initializeSession(undefined, defaultConfig);
      
      const state1 = sessionManager.getState();
      const state2 = sessionManager.getState();

      expect(state1).toEqual(state2);
      expect(state1).not.toBe(state2); // Different objects
    });
  });

  describe('integration scenarios', () => {
    it('should handle session lifecycle: create -> use -> dispose', async () => {
      // Create
      const sessionId = await sessionManager.initializeSession(undefined, defaultConfig);
      expect(sessionManager.isActive()).toBe(true);

      // Use
      await sessionManager.sendPrompt('Test prompt');
      const unsubscribe = jest.fn();
      mockSession.on.mockReturnValue(unsubscribe);
      sessionManager.addEventListener('session.idle' as any as any, () => {});

      // Dispose
      sessionManager.dispose();
      expect(unsubscribe).toHaveBeenCalled();
      expect(sessionManager.isActive()).toBe(false);
    });

    it('should handle session recovery: fail -> reinitialize', async () => {
      // Initial session
      await sessionManager.initializeSession(undefined, defaultConfig);
      
      // Simulate failure (e.g., session expired)
      mockSession.send.mockRejectedValue(new Error('Session expired'));
      await expect(sessionManager.sendPrompt('Test')).rejects.toThrow();

      // Recover by reinitializing
      mockSession.send.mockResolvedValue('msg-recovered');
      await sessionManager.reinitialize(defaultConfig);
      
      const messageId = await sessionManager.sendPrompt('Recovered');
      expect(messageId).toBe('msg-recovered');
      expect(sessionManager.isActive()).toBe(true);
    });

    it('should handle multiple event listeners and cleanup', async () => {
      await sessionManager.initializeSession(undefined, defaultConfig);

      const unsubscribes = Array(10).fill(null).map(() => jest.fn());
      let unsubIndex = 0;
      mockSession.on.mockImplementation(() => unsubscribes[unsubIndex++]);

      // Add 10 listeners
      for (let i = 0; i < 10; i++) {
        sessionManager.addEventListener("session.idle" as any, () => {});
      }

      // Cleanup all
      sessionManager.cleanupEventListeners();

      unsubscribes.forEach(unsub => {
        expect(unsub).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('isRateLimitError', () => {
    it('should detect rate limit messages with "rate limit"', () => {
      expect(isRateLimitError('You have hit the rate limit')).toBe(true);
    });

    it('should detect rate limit messages with "429"', () => {
      expect(isRateLimitError('HTTP 429 Too Many Requests')).toBe(true);
    });

    it('should return false for non rate limit messages', () => {
      expect(isRateLimitError('Session expired')).toBe(false);
      expect(isRateLimitError('Network error')).toBe(false);
    });
  });

  describe('parseRateLimitDelay', () => {
    it('should parse minutes', () => {
      const ms = parseRateLimitDelay('try again in 46 minutes');
      expect(ms).toBe(46 * 60_000);
    });

    it('should parse seconds', () => {
      const ms = parseRateLimitDelay('try again in 30 seconds');
      expect(ms).toBe(30 * 1_000);
    });

    it('should parse hours', () => {
      const ms = parseRateLimitDelay('try again in 2 hours');
      expect(ms).toBe(2 * 3_600_000);
    });

    it('should return default when no parseable hint', () => {
      const ms = parseRateLimitDelay('rate limit exceeded');
      expect(ms).toBe(120_000);
    });

    it('should use provided default when no parseable hint', () => {
      const ms = parseRateLimitDelay('rate limit exceeded', 60_000);
      expect(ms).toBe(60_000);
    });
  });

  describe('rate limit backoff', () => {
    it('should not be rate limited by default', () => {
      expect(sessionManager.isRateLimited).toBe(false);
      expect(sessionManager.rateLimitRemainingMs).toBe(0);
    });

    it('should apply rate limit backoff', () => {
      sessionManager.setRateLimitBackoff(60_000);
      expect(sessionManager.isRateLimited).toBe(true);
      expect(sessionManager.rateLimitRemainingMs).toBeGreaterThan(0);
    });

    it('should clear rate limit backoff', () => {
      sessionManager.setRateLimitBackoff(60_000);
      sessionManager.clearRateLimitBackoff();
      expect(sessionManager.isRateLimited).toBe(false);
    });

    it('should be safe to clear when no backoff is active', () => {
      expect(() => sessionManager.clearRateLimitBackoff()).not.toThrow();
    });

    it('should throw when sending while rate limited', async () => {
      await sessionManager.initializeSession(undefined, defaultConfig);
      sessionManager.setRateLimitBackoff(60_000);

      await expect(sessionManager.sendPromptAndWait('test', 5000)).rejects.toThrow(/rate-limited/i);
    });

    it('should detect rate limit error from sendPromptAndWait and set backoff', async () => {
      await sessionManager.initializeSession(undefined, defaultConfig);
      mockSession.sendAndWait.mockRejectedValue(new Error('rate limit exceeded, try again in 1 minute'));

      await expect(sessionManager.sendPromptAndWait('test', 5000)).rejects.toThrow();
      expect(sessionManager.isRateLimited).toBe(true);
    });
  });

  describe('compressConversationHistory', () => {
    it('should return null when no session is active', async () => {
      const result = await sessionManager.compressConversationHistory();
      expect(result).toBeNull();
    });

    it('should return null when session has no messages', async () => {
      await sessionManager.initializeSession(undefined, defaultConfig);
      mockSession.getMessages.mockResolvedValue([]);

      const result = await sessionManager.compressConversationHistory();
      expect(result).toBeNull();
    });

    it('should compress user messages', async () => {
      await sessionManager.initializeSession(undefined, defaultConfig);
      mockSession.getMessages.mockResolvedValue([
        { type: 'user.message', data: { content: 'Build a feature' } },
      ]);

      const result = await sessionManager.compressConversationHistory();
      expect(result).toContain('[USER]');
      expect(result).toContain('Build a feature');
    });

    it('should compress assistant messages', async () => {
      await sessionManager.initializeSession(undefined, defaultConfig);
      mockSession.getMessages.mockResolvedValue([
        { type: 'assistant.message', data: { content: 'I completed the task' } },
      ]);

      const result = await sessionManager.compressConversationHistory();
      expect(result).toContain('[ASSISTANT]');
      expect(result).toContain('I completed the task');
    });

    it('should compress tool results', async () => {
      await sessionManager.initializeSession(undefined, defaultConfig);
      mockSession.getMessages.mockResolvedValue([
        { type: 'tool.result', data: { toolName: 'bash', result: 'output here' } },
      ]);

      const result = await sessionManager.compressConversationHistory();
      expect(result).toContain('[TOOL:bash]');
    });

    it('should handle getMessages error gracefully', async () => {
      await sessionManager.initializeSession(undefined, defaultConfig);
      mockSession.getMessages.mockRejectedValue(new Error('Connection lost'));

      const result = await sessionManager.compressConversationHistory();
      expect(result).toBeNull();
    });
  });

  describe('resetWithContext', () => {
    it('should create a new session and return session id', async () => {
      await sessionManager.initializeSession(undefined, defaultConfig);
      mockSession.getMessages.mockResolvedValue([]);

      const newId = await sessionManager.resetWithContext(defaultConfig);
      expect(newId).toBe('test-session-123');
    });

    it('should seed new session with context when history exists', async () => {
      await sessionManager.initializeSession(undefined, defaultConfig);
      mockSession.getMessages.mockResolvedValue([
        { type: 'user.message', data: { content: 'Prior task' } },
      ]);

      await sessionManager.resetWithContext(defaultConfig);
      // sendAndWait should have been called with seed prompt
      expect(mockSession.sendAndWait).toHaveBeenCalled();
    });

    it('should seed with preamble even when no history', async () => {
      await sessionManager.initializeSession(undefined, defaultConfig);
      mockSession.getMessages.mockResolvedValue([]);

      await sessionManager.resetWithContext(defaultConfig, 'Extra context here');
      // sendAndWait called to seed the preamble
      expect(mockSession.sendAndWait).toHaveBeenCalled();
    });
  });
});
