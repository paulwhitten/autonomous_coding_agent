// Tests for api/agent-browser.ts — persistent mDNS browser + health checks
//
// We test the module's public API (startAgentBrowser, stopAgentBrowser,
// getKnownAgents) via the bonjour-service mock (moduleNameMapper redirect).
// The broadcast() calls go through the real websocket module but are
// no-ops because initWebSocket() is never called (io stays null).

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import {
  mockFind,
  mockBrowserOn,
  mockBrowserStop,
  mockDestroy,
  resetMocks as resetBonjourMocks,
} from './mocks/bonjour-service-mock.js';
import {
  startAgentBrowser,
  stopAgentBrowser,
  getKnownAgents,
} from '../api/agent-browser.js';

// Mock global fetch for health checks
const originalFetch = globalThis.fetch;
const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;

beforeEach(() => {
  resetBonjourMocks();
  mockFetch.mockClear();
  globalThis.fetch = mockFetch as any;
  jest.useFakeTimers();
});

afterEach(() => {
  try { stopAgentBrowser(); } catch { /* ok */ }
  globalThis.fetch = originalFetch;
  jest.useRealTimers();
});

function makeTxtService(overrides: Record<string, string> = {}) {
  return {
    name: overrides.agentId || 'test_dev',
    host: 'test.local',
    txt: {
      agentId: 'test_dev',
      hostname: 'test',
      role: 'developer',
      pid: '123',
      startedAt: '2026-01-01T00:00:00.000Z',
      a2aUrl: 'http://test:4000',
      capabilities: 'python,typescript',
      ...overrides,
    },
  };
}

/** Wire up the mock browser 'on' handler so startAgentBrowser registers its callbacks. */
function captureHandlers(): { up: (s: any) => void; down: (s: any) => void } {
  const h = { up: (_s: any) => {}, down: (_s: any) => {} };
  (mockBrowserOn as any).mockImplementation((...args: any[]) => {
    const [event, handler] = args;
    if (event === 'up') h.up = handler;
    if (event === 'down') h.down = handler;
  });
  return h;
}

describe('agent-browser', () => {
  describe('startAgentBrowser', () => {
    it('should create a browser for the autonomous-agent service type', () => {
      startAgentBrowser();
      expect(mockFind).toHaveBeenCalledWith({ type: 'autonomous-agent' });
    });

    it('should not start multiple browsers', () => {
      startAgentBrowser();
      startAgentBrowser(); // second call should be no-op
      expect(mockFind).toHaveBeenCalledTimes(1);
    });

    it('should track discovered agents via getKnownAgents', () => {
      const h = captureHandlers();
      mockFetch.mockResolvedValue({ ok: true } as Response);

      startAgentBrowser();
      h.up(makeTxtService());

      const agents = getKnownAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0]).toMatchObject({
        agentId: 'test_dev',
        hostname: 'test',
        role: 'developer',
      });
    });

    it('should remove agents on service down', () => {
      const h = captureHandlers();
      mockFetch.mockResolvedValue({ ok: true } as Response);

      startAgentBrowser();
      h.up(makeTxtService());
      expect(getKnownAgents()).toHaveLength(1);

      h.down(makeTxtService());
      expect(getKnownAgents()).toHaveLength(0);
    });

    it('should parse capabilities from TXT record', () => {
      const h = captureHandlers();
      mockFetch.mockResolvedValue({ ok: true } as Response);

      startAgentBrowser();
      h.up(makeTxtService({ capabilities: 'go,rust,python' }));

      const agents = getKnownAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].capabilities).toEqual(['go', 'rust', 'python']);
    });

    it('should parse teamMembers JSON from TXT record', () => {
      const h = captureHandlers();
      mockFetch.mockResolvedValue({ ok: true } as Response);

      startAgentBrowser();
      h.up(makeTxtService({
        teamMembers: JSON.stringify([{ hostname: 'qa', role: 'qa' }]),
      } as Record<string, string>));

      const agents = getKnownAgents();
      expect(agents[0].teamMembers).toEqual([{ hostname: 'qa', role: 'qa' }]);
    });

    it('should handle missing TXT fields gracefully', () => {
      const h = captureHandlers();
      mockFetch.mockResolvedValue({ ok: true } as Response);

      startAgentBrowser();
      h.up({ name: 'minimal', host: 'host.local', txt: {} });

      const agents = getKnownAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].agentId).toBe('minimal');
      // Falls back to service.host when txt.hostname is missing
      expect(agents[0].hostname).toBe('host.local');
    });
  });

  describe('health checks', () => {
    it('should set health to online when health endpoint returns ok', async () => {
      const h = captureHandlers();
      mockFetch.mockResolvedValue({ ok: true } as Response);

      startAgentBrowser();
      h.up(makeTxtService());

      await jest.advanceTimersByTimeAsync(0);

      expect(getKnownAgents()[0].health).toBe('online');
    });

    it('should set health to degraded when health endpoint returns non-ok', async () => {
      const h = captureHandlers();
      mockFetch.mockResolvedValue({ ok: false, status: 500 } as Response);

      startAgentBrowser();
      h.up(makeTxtService());

      await jest.advanceTimersByTimeAsync(0);

      expect(getKnownAgents()[0].health).toBe('degraded');
    });

    it('should set health to offline when health endpoint throws', async () => {
      const h = captureHandlers();
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      startAgentBrowser();
      h.up(makeTxtService());

      await jest.advanceTimersByTimeAsync(0);

      expect(getKnownAgents()[0].health).toBe('offline');
    });

    it('should run periodic health checks at 30s interval', async () => {
      const h = captureHandlers();
      mockFetch.mockResolvedValue({ ok: true } as Response);

      startAgentBrowser();
      h.up(makeTxtService());
      await jest.advanceTimersByTimeAsync(0);

      mockFetch.mockClear();
      // Advance 30s to fire the setInterval, then 3s more so the
      // inner discoverAgents(2000) setTimeout resolves and the
      // health-check fetch actually executes.
      await jest.advanceTimersByTimeAsync(30_000);
      await jest.advanceTimersByTimeAsync(3_000);

      expect(mockFetch).toHaveBeenCalled();
    });

    it('should update health on periodic check transition', async () => {
      const h = captureHandlers();
      mockFetch.mockResolvedValue({ ok: true } as Response);

      startAgentBrowser();
      h.up(makeTxtService());
      await jest.advanceTimersByTimeAsync(0);
      expect(getKnownAgents()[0].health).toBe('online');

      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      // Advance 30s to fire the setInterval, then 3s more so the
      // inner discoverAgents(2000) setTimeout resolves.
      await jest.advanceTimersByTimeAsync(30_000);
      await jest.advanceTimersByTimeAsync(3_000);

      expect(getKnownAgents()[0].health).toBe('offline');
    });
  });

  describe('stopAgentBrowser', () => {
    it('should stop the browser and clear known agents', () => {
      const h = captureHandlers();
      mockFetch.mockResolvedValue({ ok: true } as Response);

      startAgentBrowser();
      h.up(makeTxtService());
      expect(getKnownAgents()).toHaveLength(1);

      stopAgentBrowser();

      expect(getKnownAgents()).toHaveLength(0);
      expect(mockBrowserStop).toHaveBeenCalledTimes(1);
      expect(mockDestroy).toHaveBeenCalledTimes(1);
    });
  });

  describe('getKnownAgents', () => {
    it('should return empty array when no agents discovered', () => {
      expect(getKnownAgents()).toEqual([]);
    });

    it('should return all discovered agents', () => {
      const h = captureHandlers();
      mockFetch.mockResolvedValue({ ok: true } as Response);

      startAgentBrowser();
      h.up(makeTxtService());
      h.up(makeTxtService({ agentId: 'qa_agent', hostname: 'qa-host', role: 'qa' }));

      expect(getKnownAgents()).toHaveLength(2);
    });
  });
});
