// Tests for agent-card.ts - Enriched agent cards and A2A conversion

import { describe, it, expect } from '@jest/globals';
import {
  capabilitiesToSkills,
  mergeCapabilitiesAndSkills,
  enrichTeamAgent,
  toA2AAgentCard,
  fromA2AAgentCard,
  inferRoleFromSkills,
} from '../agent-card.js';
import type { AgentSkill, EnrichedAgentCard } from '../agent-card.js';
import type { TeamAgent } from '../types.js';

describe('agent-card', () => {
  // ---------------------------------------------------------------
  // capabilitiesToSkills
  // ---------------------------------------------------------------
  describe('capabilitiesToSkills', () => {
    it('should convert flat capabilities to skills with tags', () => {
      const skills = capabilitiesToSkills(['python', 'testing'], 'developer');
      expect(skills).toHaveLength(2);
      expect(skills[0]).toEqual(
        expect.objectContaining({
          id: 'python',
          name: expect.any(String),
          tags: expect.arrayContaining(['python', 'developer']),
        }),
      );
    });

    it('should handle empty capabilities', () => {
      expect(capabilitiesToSkills([])).toEqual([]);
    });

    it('should work without a role', () => {
      const skills = capabilitiesToSkills(['csv-analysis']);
      expect(skills[0].tags).toEqual(['csv-analysis']);
      expect(skills[0].tags).not.toContain(undefined);
    });

    it('should title-case hyphenated capability names', () => {
      const skills = capabilitiesToSkills(['csv-analysis']);
      expect(skills[0].name).toBe('Csv Analysis');
    });
  });

  // ---------------------------------------------------------------
  // mergeCapabilitiesAndSkills
  // ---------------------------------------------------------------
  describe('mergeCapabilitiesAndSkills', () => {
    it('should return empty array when both inputs are undefined', () => {
      expect(mergeCapabilitiesAndSkills(undefined, undefined)).toEqual([]);
    });

    it('should return skills when capabilities are undefined', () => {
      const skills: AgentSkill[] = [
        { id: 'python', name: 'Python', description: 'Python dev', tags: ['python'] },
      ];
      const result = mergeCapabilitiesAndSkills(undefined, skills);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('python');
    });

    it('should deduplicate -- skills take precedence over auto-generated from capabilities', () => {
      const skills: AgentSkill[] = [
        { id: 'python', name: 'Python Dev', description: 'Custom', tags: ['code'] },
      ];
      const result = mergeCapabilitiesAndSkills(['python', 'testing'], skills, 'developer');
      expect(result).toHaveLength(2);
      // First should be the explicit skill
      expect(result[0].description).toBe('Custom');
      // Second should be auto-generated from 'testing'
      expect(result[1].id).toBe('testing');
    });
  });

  // ---------------------------------------------------------------
  // enrichTeamAgent
  // ---------------------------------------------------------------
  describe('enrichTeamAgent', () => {
    it('should generate skills from capabilities when skills are absent', () => {
      const agent: TeamAgent = {
        id: 'dev-1_developer',
        hostname: 'dev-1',
        role: 'developer',
        capabilities: ['python', 'docker'],
      };
      const enriched = enrichTeamAgent(agent);
      expect(enriched.skills).toHaveLength(2);
      expect(enriched.skills![0].id).toBe('python');
    });

    it('should preserve existing skills', () => {
      const agent: TeamAgent & { skills: AgentSkill[] } = {
        id: 'dev-1_developer',
        hostname: 'dev-1',
        role: 'developer',
        skills: [{ id: 'custom', name: 'Custom', description: 'Custom skill', tags: ['custom'] }],
      };
      const enriched = enrichTeamAgent(agent);
      expect(enriched.skills).toHaveLength(1);
      expect(enriched.skills![0].id).toBe('custom');
    });

    it('should set default input/output modes', () => {
      const agent: TeamAgent = { id: 'a', hostname: 'a', role: 'developer' };
      const enriched = enrichTeamAgent(agent);
      expect(enriched.inputModes).toEqual(['text/plain']);
      expect(enriched.outputModes).toEqual(['text/plain']);
    });

    it('should derive id from hostname and role when id is missing', () => {
      const agent = { hostname: 'server-1', role: 'developer' } as TeamAgent;
      const enriched = enrichTeamAgent(agent);
      expect(enriched.id).toBe('server-1_developer');
    });

    it('should not overwrite an explicitly provided id', () => {
      const agent: TeamAgent = { id: 'custom-id', hostname: 'h', role: 'r' };
      const enriched = enrichTeamAgent(agent);
      expect(enriched.id).toBe('custom-id');
    });
  });

  // ---------------------------------------------------------------
  // toA2AAgentCard
  // ---------------------------------------------------------------
  describe('toA2AAgentCard', () => {
    it('should produce a valid A2A card JSON', () => {
      const enriched: EnrichedAgentCard = {
        id: 'dev-1_developer',
        hostname: 'dev-1',
        role: 'developer',
        description: 'Dev agent',
        capabilities: ['python'],
        skills: [{ id: 'python', name: 'Python', description: 'Python dev', tags: ['python'] }],
      };
      const card = toA2AAgentCard(enriched, { protocolVersion: '0.3.0', serverPort: 5000 });

      expect(card.name).toBe('dev-1_developer');
      expect(card.description).toBe('Dev agent');
      expect(card.protocolVersion).toBe('0.3.0');
      expect(card.url).toContain(':5000');
      expect((card.skills as any[]).length).toBe(1);
      expect((card.skills as any[])[0].id).toBe('python');
    });

    it('should use default port and protocol version', () => {
      const enriched: EnrichedAgentCard = {
        id: 'a_agent',
        hostname: 'a',
        role: 'agent',
      };
      const card = toA2AAgentCard(enriched);
      expect(card.protocolVersion).toBe('0.3.0');
      expect(card.url).toContain(':4000');
    });

    it('should apply config overrides for name, description, version', () => {
      const enriched: EnrichedAgentCard = {
        id: 'dev-1_developer',
        hostname: 'dev-1',
        role: 'developer',
      };
      const card = toA2AAgentCard(enriched, {
        overrides: {
          name: 'my-custom-agent',
          description: 'Custom description',
          version: '2.5.0',
        },
      });
      expect(card.name).toBe('my-custom-agent');
      expect(card.description).toBe('Custom description');
      expect(card.version).toBe('2.5.0');
    });

    it('should merge extra skills from overrides with auto-derived', () => {
      const enriched: EnrichedAgentCard = {
        id: 'dev-1_developer',
        hostname: 'dev-1',
        role: 'developer',
        capabilities: ['python'],
      };
      const card = toA2AAgentCard(enriched, {
        overrides: {
          skills: [
            { id: 'ml-analysis', name: 'ML Analysis', description: 'ML work', tags: ['ml'] },
          ],
        },
      });
      const skills = card.skills as any[];
      expect(skills.length).toBe(2);
      expect(skills.map((s: any) => s.id)).toContain('python');
      expect(skills.map((s: any) => s.id)).toContain('ml-analysis');
    });

    it('should not duplicate skills when override id matches auto-derived', () => {
      const enriched: EnrichedAgentCard = {
        id: 'dev-1_developer',
        hostname: 'dev-1',
        role: 'developer',
        capabilities: ['python'],
      };
      const card = toA2AAgentCard(enriched, {
        overrides: {
          skills: [
            { id: 'python', name: 'Python Override', description: 'Better Python', tags: ['python'] },
          ],
        },
      });
      const skills = card.skills as any[];
      // Auto-derived "python" wins; override with same id is skipped
      expect(skills.length).toBe(1);
      expect(skills[0].id).toBe('python');
    });

    it('should apply provider from overrides', () => {
      const enriched: EnrichedAgentCard = {
        id: 'a_agent',
        hostname: 'a',
        role: 'agent',
      };
      const card = toA2AAgentCard(enriched, {
        overrides: {
          provider: { organization: 'Contoso', url: 'https://contoso.com' },
        },
      });
      expect(card.provider).toEqual({ organization: 'Contoso', url: 'https://contoso.com' });
    });

    it('should apply inputModes/outputModes from overrides', () => {
      const enriched: EnrichedAgentCard = {
        id: 'a_agent',
        hostname: 'a',
        role: 'agent',
      };
      const card = toA2AAgentCard(enriched, {
        overrides: {
          inputModes: ['application/json'],
          outputModes: ['text/plain', 'application/json'],
        },
      });
      expect(card.defaultInputModes).toEqual(['application/json']);
      expect(card.defaultOutputModes).toEqual(['text/plain', 'application/json']);
    });

    it('should merge extensions from card and overrides', () => {
      const enriched: EnrichedAgentCard = {
        id: 'a_agent',
        hostname: 'a',
        role: 'agent',
        extensions: { existing: true },
      };
      const card = toA2AAgentCard(enriched, {
        overrides: {
          extensions: { custom: 'value' },
        },
      });
      expect(card.extensions).toEqual({ existing: true, custom: 'value' });
    });
  });

  // ---------------------------------------------------------------
  // fromA2AAgentCard
  // ---------------------------------------------------------------
  describe('fromA2AAgentCard', () => {
    it('should convert an A2A card back to EnrichedAgentCard', () => {
      const a2a = {
        name: 'remote-1_qa',
        description: 'QA agent',
        url: 'http://remote-1:4000/a2a/jsonrpc',
        protocolVersion: '0.3.0',
        skills: [
          { id: 'validation', name: 'Validation', description: 'Test validation', tags: ['qa', 'testing'] },
        ],
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain', 'application/json'],
      };

      const result = fromA2AAgentCard(a2a);
      expect(result.id).toBe('remote-1_qa');
      expect(result.hostname).toBe('remote-1');
      expect(result.role).toBe('qa');
      expect(result.skills).toHaveLength(1);
      expect(result.url).toBe('http://remote-1:4000/a2a/jsonrpc');
      expect(result.protocolVersion).toBe('0.3.0');
    });

    it('should infer hostname from URL when name is missing', () => {
      const a2a = {
        url: 'http://myhost:4000/a2a',
        skills: [],
      };
      const result = fromA2AAgentCard(a2a);
      expect(result.hostname).toBe('myhost');
    });

    it('should handle missing optional fields gracefully', () => {
      const result = fromA2AAgentCard({});
      expect(result.id).toBe('unknown');
      expect(result.hostname).toBe('unknown');
      expect(result.skills).toEqual([]);
    });
  });

  // ---------------------------------------------------------------
  // inferRoleFromSkills
  // ---------------------------------------------------------------
  describe('inferRoleFromSkills', () => {
    it('should infer developer from python tag', () => {
      const skills: AgentSkill[] = [
        { id: 'py', name: 'Python', description: '', tags: ['python'] },
      ];
      expect(inferRoleFromSkills(skills)).toBe('developer');
    });

    it('should infer qa from testing tag', () => {
      const skills: AgentSkill[] = [
        { id: 'test', name: 'Test', description: '', tags: ['testing'] },
      ];
      expect(inferRoleFromSkills(skills)).toBe('qa');
    });

    it('should infer manager from coordination tag', () => {
      const skills: AgentSkill[] = [
        { id: 'coord', name: 'Coord', description: '', tags: ['coordination'] },
      ];
      expect(inferRoleFromSkills(skills)).toBe('manager');
    });

    it('should return agent when no known role matches', () => {
      const skills: AgentSkill[] = [
        { id: 'x', name: 'X', description: '', tags: ['custom'] },
      ];
      expect(inferRoleFromSkills(skills)).toBe('agent');
    });
  });

  // ---------------------------------------------------------------
  // Round-trip
  // ---------------------------------------------------------------
  describe('round-trip', () => {
    it('should survive toA2A -> fromA2A round trip', () => {
      const original: EnrichedAgentCard = {
        id: 'test-host_developer',
        hostname: 'test-host',
        role: 'developer',
        description: 'A developer agent',
        capabilities: ['python', 'docker'],
        skills: [
          { id: 'python', name: 'Python', description: 'Python coding', tags: ['python', 'developer'] },
          { id: 'docker', name: 'Docker', description: 'Container mgmt', tags: ['docker', 'developer'] },
        ],
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
      };

      const a2aCard = toA2AAgentCard(original, { serverPort: 4000 });
      const roundTripped = fromA2AAgentCard(a2aCard);

      expect(roundTripped.id).toBe(original.id);
      expect(roundTripped.skills).toHaveLength(2);
      expect(roundTripped.skills![0].id).toBe('python');
      expect(roundTripped.skills![1].id).toBe('docker');
    });
  });
});
