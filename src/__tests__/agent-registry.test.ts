// Tests for agent-registry.ts — mDNS agent discovery

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { AgentRegistry, AgentRegistration } from '../agent-registry.js';
import {
  mockPublish,
  mockUnpublishAll,
  mockDestroy,
  mockFind,
  mockBrowserOn,
  mockBrowserStop,
  resetMocks,
} from './mocks/bonjour-service-mock.js';

interface PublishCall {
  name: string;
  type: string;
  port: number;
  txt: Record<string, string | undefined>;
}

type BrowserEventHandler = (service: Record<string, unknown>) => void;

describe('AgentRegistry', () => {
  let registry: AgentRegistry;

  const sampleRegistration: AgentRegistration = {
    agentId: 'test-host_developer',
    hostname: 'test-host',
    role: 'developer',
    pid: 12345,
    startedAt: '2026-01-01T00:00:00.000Z',
    a2aUrl: 'http://localhost:4000',
    capabilities: ['python', 'typescript'],
    description: 'Test developer agent',
    teamMembers: [{ hostname: 'qa-host', role: 'qa' }],
    mailboxRepoPath: '/tmp/mailbox',
    workspacePath: '/tmp/workspace',
    configPath: '/tmp/config.json',
  };

  beforeEach(() => {
    resetMocks();
    registry = new AgentRegistry();
  });

  afterEach(() => {
    try { registry.unpublish(); } catch { /* ok */ }
  });

  describe('publish', () => {
    it('should publish an mDNS service with correct type and TXT records', () => {
      registry.publish(sampleRegistration, 4000);

      expect(mockPublish).toHaveBeenCalledTimes(1);
      const call = mockPublish.mock.calls[0][0] as unknown as PublishCall;
      expect(call.name).toBe('test-host_developer');
      expect(call.type).toBe('autonomous-agent');
      expect(call.port).toBe(4000);
      expect(call.txt.agentId).toBe('test-host_developer');
      expect(call.txt.hostname).toBe('test-host');
      expect(call.txt.role).toBe('developer');
      expect(call.txt.pid).toBe('12345');
      expect(call.txt.a2aUrl).toBe('http://localhost:4000');
      expect(call.txt.capabilities).toBe('python,typescript');
      expect(call.txt.description).toBe('Test developer agent');
      expect(call.txt.mailboxRepoPath).toBe('/tmp/mailbox');
      expect(call.txt.workspacePath).toBe('/tmp/workspace');
      expect(call.txt.configPath).toBe('/tmp/config.json');
    });

    it('should encode teamMembers as JSON in TXT record', () => {
      registry.publish(sampleRegistration, 4000);

      const call = mockPublish.mock.calls[0][0] as unknown as PublishCall;
      const parsed = JSON.parse(call.txt.teamMembers as string);
      expect(parsed).toEqual([{ hostname: 'qa-host', role: 'qa' }]);
    });

    it('should omit optional fields when not provided', () => {
      const minimal: AgentRegistration = {
        agentId: 'min_agent',
        hostname: 'min',
        role: 'agent',
        pid: 1,
        startedAt: '2026-01-01T00:00:00.000Z',
      };
      registry.publish(minimal, 3000);

      const call = mockPublish.mock.calls[0][0] as unknown as PublishCall;
      expect(call.txt.a2aUrl).toBeUndefined();
      expect(call.txt.capabilities).toBeUndefined();
      expect(call.txt.teamMembers).toBeUndefined();
    });
  });

  describe('browse', () => {
    it('should start a browser for the correct service type', () => {
      registry.browse(100);
      expect(mockFind).toHaveBeenCalledWith({ type: 'autonomous-agent' });
    });

    it('should resolve discovered agents via the up event', async () => {
      // Simulate a discovered service
      mockBrowserOn.mockImplementation(((event: string, handler: BrowserEventHandler) => {
        if (event === 'up') {
          handler({
            name: 'test-host_developer',
            host: 'test-host.local',
            txt: {
              agentId: 'test-host_developer',
              hostname: 'test-host',
              role: 'developer',
              pid: '12345',
              startedAt: '2026-01-01T00:00:00.000Z',
              a2aUrl: 'http://test-host:4000',
              capabilities: 'python,typescript',
            },
          });
        }
      }) as unknown as typeof mockBrowserOn);

      const agents = await registry.browse(100);

      expect(agents).toHaveLength(1);
      expect(agents[0].agentId).toBe('test-host_developer');
      expect(agents[0].hostname).toBe('test-host');
      expect(agents[0].role).toBe('developer');
      expect(agents[0].pid).toBe(12345);
      expect(agents[0].a2aUrl).toBe('http://test-host:4000');
      expect(agents[0].capabilities).toEqual(['python', 'typescript']);
    });

    it('should deduplicate agents by agentId', async () => {
      mockBrowserOn.mockImplementation(((event: string, handler: BrowserEventHandler) => {
        if (event === 'up') {
          const service = {
            name: 'dup_agent',
            host: 'host.local',
            txt: { agentId: 'dup_agent', hostname: 'host', role: 'dev', pid: '1', startedAt: '2026-01-01T00:00:00.000Z' },
          };
          handler(service);
          handler(service); // duplicate
        }
      }) as unknown as typeof mockBrowserOn);

      const agents = await registry.browse(100);
      expect(agents).toHaveLength(1);
    });

    it('should stop the browser after timeout', async () => {
      mockBrowserOn.mockImplementation(() => {}); // no events
      await registry.browse(50);
      expect(mockBrowserStop).toHaveBeenCalledTimes(1);
    });

    it('should handle services without agentId gracefully', async () => {
      mockBrowserOn.mockImplementation(((event: string, handler: BrowserEventHandler) => {
        if (event === 'up') {
          handler({ name: 'bad', host: 'host', txt: {} }); // no agentId
        }
      }) as unknown as typeof mockBrowserOn);

      const agents = await registry.browse(100);
      expect(agents).toHaveLength(0);
    });

    it('should parse teamMembers JSON from TXT record', async () => {
      mockBrowserOn.mockImplementation(((event: string, handler: BrowserEventHandler) => {
        if (event === 'up') {
          handler({
            name: 'team_agent',
            host: 'host.local',
            txt: {
              agentId: 'team_agent',
              hostname: 'host',
              role: 'manager',
              pid: '99',
              startedAt: '2026-01-01T00:00:00.000Z',
              teamMembers: JSON.stringify([{ hostname: 'dev', role: 'developer' }]),
            },
          });
        }
      }) as unknown as typeof mockBrowserOn);

      const agents = await registry.browse(100);
      expect(agents[0].teamMembers).toEqual([{ hostname: 'dev', role: 'developer' }]);
    });

    it('should handle malformed teamMembers JSON gracefully', async () => {
      mockBrowserOn.mockImplementation(((event: string, handler: BrowserEventHandler) => {
        if (event === 'up') {
          handler({
            name: 'bad_team',
            host: 'host.local',
            txt: {
              agentId: 'bad_team',
              hostname: 'host',
              role: 'dev',
              pid: '1',
              startedAt: '2026-01-01T00:00:00.000Z',
              teamMembers: 'not-json',
            },
          });
        }
      }) as unknown as typeof mockBrowserOn);

      const agents = await registry.browse(100);
      expect(agents).toHaveLength(1);
      expect(agents[0].teamMembers).toBeUndefined();
    });
  });

  describe('unpublish', () => {
    it('should stop the published service and destroy bonjour', () => {
      const mockStop = jest.fn();
      mockPublish.mockReturnValue({ stop: mockStop });
      registry.publish(sampleRegistration, 4000);

      registry.unpublish();

      expect(mockStop).toHaveBeenCalledTimes(1);
      expect(mockUnpublishAll).toHaveBeenCalledTimes(1);
      expect(mockDestroy).toHaveBeenCalledTimes(1);
    });

    it('should handle unpublish when no service was published', () => {
      // Should not throw
      expect(() => registry.unpublish()).not.toThrow();
      expect(mockUnpublishAll).toHaveBeenCalledTimes(1);
      expect(mockDestroy).toHaveBeenCalledTimes(1);
    });
  });
});
