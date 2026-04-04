// Tests for discovery-provider.ts - Agent discovery and caching

import { describe, it, expect, beforeEach } from '@jest/globals';
import { DiscoveryProvider } from '../discovery-provider.js';
import { createMockLogger } from './test-helpers.js';
import type { TeamAgent } from '../types.js';

describe('DiscoveryProvider', () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  describe('seedFromRoster', () => {
    it('should populate cache from team roster', () => {
      const dp = new DiscoveryProvider({}, logger);
      const agents: TeamAgent[] = [
        { id: 'dev-1_developer', hostname: 'dev-1', role: 'developer', capabilities: ['python'] },
        { id: 'qa-1_qa', hostname: 'qa-1', role: 'qa', capabilities: ['testing'] },
      ];
      dp.seedFromRoster(agents);

      const all = dp.getAllCached();
      expect(all).toHaveLength(2);
      expect(all.map(a => a.id).sort()).toEqual(['dev-1_developer', 'qa-1_qa']);
    });

    it('should enrich agents with skills from capabilities', () => {
      const dp = new DiscoveryProvider({}, logger);
      dp.seedFromRoster([
        { id: 'dev_developer', hostname: 'dev', role: 'developer', capabilities: ['python', 'docker'] },
      ]);

      const agents = dp.getAllCached();
      expect(agents[0].skills).toHaveLength(2);
      expect(agents[0].skills![0].id).toBe('python');
    });
  });

  describe('findByCapability', () => {
    it('should find agents by flat capability', () => {
      const dp = new DiscoveryProvider({}, logger);
      dp.seedFromRoster([
        { id: 'a_developer', hostname: 'a', role: 'developer', capabilities: ['python'] },
        { id: 'b_qa', hostname: 'b', role: 'qa', capabilities: ['testing'] },
      ]);

      const results = dp.findByCapability('python');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('a_developer');
    });

    it('should find agents by skill tag', () => {
      const dp = new DiscoveryProvider({}, logger);
      dp.seedFromRoster([
        { id: 'a_developer', hostname: 'a', role: 'developer', capabilities: ['python'] },
      ]);

      // Auto-generated skill tags include the role
      const results = dp.findByCapability('developer');
      expect(results).toHaveLength(1);
    });

    it('should be case-insensitive', () => {
      const dp = new DiscoveryProvider({}, logger);
      dp.seedFromRoster([
        { id: 'a_dev', hostname: 'a', role: 'developer', capabilities: ['Python'] },
      ]);

      expect(dp.findByCapability('python')).toHaveLength(1);
      expect(dp.findByCapability('PYTHON')).toHaveLength(1);
    });

    it('should return empty array when no matches', () => {
      const dp = new DiscoveryProvider({}, logger);
      dp.seedFromRoster([
        { id: 'a_dev', hostname: 'a', role: 'developer', capabilities: ['python'] },
      ]);

      expect(dp.findByCapability('java')).toEqual([]);
    });
  });

  describe('findById', () => {
    it('should find a specific agent by ID', async () => {
      const dp = new DiscoveryProvider({}, logger);
      dp.seedFromRoster([
        { id: 'dev-1_developer', hostname: 'dev-1', role: 'developer' },
      ]);

      const agent = await dp.findById('dev-1_developer');
      expect(agent).not.toBeNull();
      expect(agent!.hostname).toBe('dev-1');
    });

    it('should return null for unknown agent', async () => {
      const dp = new DiscoveryProvider({}, logger);
      const result = await dp.findById('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('cache expiry', () => {
    it('should exclude expired entries from getAllCached', () => {
      // TTL = 1ms -- everything expires immediately
      const dp = new DiscoveryProvider({ cacheTtlMs: 1 }, logger);
      dp.seedFromRoster([
        { id: 'a_dev', hostname: 'a', role: 'developer' },
      ]);

      // Wait a bit to ensure expiry
      const start = Date.now();
      while (Date.now() - start < 5) { /* spin */ }

      expect(dp.getAllCached()).toEqual([]);
    });
  });

  describe('generateAgentCard', () => {
    it('should produce an A2A-compatible agent card', () => {
      const dp = new DiscoveryProvider({}, logger);
      const agent: TeamAgent = {
        id: 'test_developer',
        hostname: 'test',
        role: 'developer',
        capabilities: ['python'],
      };

      const card = dp.generateAgentCard(agent, { serverPort: 5000 });
      expect(card.name).toBe('test_developer');
      expect(card.url).toContain(':5000');
      expect(card.protocolVersion).toBe('0.3.0');
      expect((card.skills as any[]).length).toBe(1);
    });
  });

  describe('searchRegistry', () => {
    it('should return empty when no registry is configured', async () => {
      const dp = new DiscoveryProvider({}, logger);
      const results = await dp.searchRegistry({ role: 'developer' });
      expect(results).toEqual([]);
    });
  });
});
