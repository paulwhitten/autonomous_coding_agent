// Tests for role-loader.ts - Shared role-loading with customRolesFile overlay

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { loadMergedRoles, RoleDefinitions } from '../role-loader.js';
import { AgentConfig } from '../types.js';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testDir: string;

function makeConfig(overrides?: Partial<AgentConfig['agent']>): AgentConfig {
  return {
    agent: {
      hostname: 'test-host',
      role: 'developer',
      checkIntervalMs: 60000,
      stuckTimeoutMs: 300000,
      sdkTimeoutMs: 120000,
      ...overrides,
    },
    mailbox: {
      repoPath: '/tmp/mailbox',
      gitSync: false,
      autoCommit: false,
      commitMessage: 'auto',
      supportBroadcast: false,
      supportAttachments: false,
      supportPriority: false,
    },
    copilot: { model: 'gpt-4.1', allowedTools: ['all'] },
    workspace: { path: '/tmp/workspace', persistContext: true },
    logging: { level: 'info', path: '/tmp/log', maxSizeMB: 100 },
    manager: { hostname: 'mgr', role: 'manager', escalationPriority: 'HIGH' },
  } as AgentConfig;
}

const baseRoles: RoleDefinitions = {
  developer: {
    name: 'Developer',
    description: 'Writes code',
    isDelegator: false,
    breakdownFraming: 'coding',
    primaryResponsibilities: ['Write code', 'Write tests'],
  },
  manager: {
    name: 'Manager',
    description: 'Delegates work',
    isDelegator: true,
    breakdownFraming: 'project manager',
    primaryResponsibilities: ['Coordinate team'],
  },
  qa: {
    name: 'QA',
    description: 'Tests code',
    isDelegator: false,
    breakdownFraming: 'quality assurance',
    primaryResponsibilities: ['Test code'],
  },
};

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-loader-test-'));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadMergedRoles', () => {
  // ----- Base-only loading ------------------------------------------------

  describe('base roles only (no customRolesFile)', () => {
    it('should load all roles from base file', async () => {
      const rolesPath = path.join(testDir, 'roles.json');
      await fs.writeFile(rolesPath, JSON.stringify(baseRoles, null, 2));

      const config = makeConfig({ roleDefinitionsFile: rolesPath });
      const roles = await loadMergedRoles(config, testDir);

      expect(Object.keys(roles)).toEqual(['developer', 'manager', 'qa']);
      expect(roles.developer.name).toBe('Developer');
      expect(roles.manager.isDelegator).toBe(true);
      expect(roles.qa.breakdownFraming).toBe('quality assurance');
    });

    it('should preserve all fields from each role', async () => {
      const rolesPath = path.join(testDir, 'roles.json');
      await fs.writeFile(rolesPath, JSON.stringify(baseRoles, null, 2));

      const config = makeConfig({ roleDefinitionsFile: rolesPath });
      const roles = await loadMergedRoles(config, testDir);

      expect(roles.developer.primaryResponsibilities).toEqual(['Write code', 'Write tests']);
    });

    it('should throw when base roles file does not exist', async () => {
      const config = makeConfig({
        roleDefinitionsFile: path.join(testDir, 'nonexistent.json'),
      });

      await expect(loadMergedRoles(config, testDir)).rejects.toThrow();
    });

    it('should throw when base roles file is malformed JSON', async () => {
      const rolesPath = path.join(testDir, 'roles.json');
      await fs.writeFile(rolesPath, '{ broken json !!!');

      const config = makeConfig({ roleDefinitionsFile: rolesPath });
      await expect(loadMergedRoles(config, testDir)).rejects.toThrow();
    });
  });

  // ----- Custom overlay --------------------------------------------------

  describe('with customRolesFile overlay', () => {
    it('should add new roles from custom file', async () => {
      const rolesPath = path.join(testDir, 'roles.json');
      await fs.writeFile(rolesPath, JSON.stringify(baseRoles, null, 2));

      const customRoles: RoleDefinitions = {
        'requirements-analyst': {
          name: 'Requirements Analyst',
          description: 'Defines requirements',
          isDelegator: false,
          breakdownFraming: 'requirements engineering',
        },
      };
      const customPath = path.join(testDir, 'custom-roles.json');
      await fs.writeFile(customPath, JSON.stringify(customRoles, null, 2));

      const config = makeConfig({
        roleDefinitionsFile: rolesPath,
        customRolesFile: customPath,
      });

      const roles = await loadMergedRoles(config, testDir);

      expect(Object.keys(roles)).toEqual(
        expect.arrayContaining(['developer', 'manager', 'qa', 'requirements-analyst']),
      );
      expect(roles['requirements-analyst'].name).toBe('Requirements Analyst');
      expect(roles['requirements-analyst'].isDelegator).toBe(false);
    });

    it('should override existing base role with custom definition', async () => {
      const rolesPath = path.join(testDir, 'roles.json');
      await fs.writeFile(rolesPath, JSON.stringify(baseRoles, null, 2));

      // Override developer role entirely
      const customRoles: RoleDefinitions = {
        developer: {
          name: 'Custom Developer',
          description: 'Overridden developer',
          isDelegator: false,
          breakdownFraming: 'embedded C',
          primaryResponsibilities: ['Write embedded firmware'],
        },
      };
      const customPath = path.join(testDir, 'custom-roles.json');
      await fs.writeFile(customPath, JSON.stringify(customRoles, null, 2));

      const config = makeConfig({
        roleDefinitionsFile: rolesPath,
        customRolesFile: customPath,
      });

      const roles = await loadMergedRoles(config, testDir);

      // Custom wins
      expect(roles.developer.name).toBe('Custom Developer');
      expect(roles.developer.breakdownFraming).toBe('embedded C');
      expect(roles.developer.primaryResponsibilities).toEqual(['Write embedded firmware']);

      // Other base roles remain untouched
      expect(roles.manager.name).toBe('Manager');
      expect(roles.qa.name).toBe('QA');
    });

    it('should add AND override simultaneously', async () => {
      const rolesPath = path.join(testDir, 'roles.json');
      await fs.writeFile(rolesPath, JSON.stringify(baseRoles, null, 2));

      const customRoles: RoleDefinitions = {
        qa: {
          name: 'Security QA',
          description: 'Security-focused testing',
          isDelegator: false,
          breakdownFraming: 'security verification',
        },
        'security-auditor': {
          name: 'Security Auditor',
          description: 'Regulatory compliance auditing',
          isDelegator: false,
          breakdownFraming: 'security audit',
        },
      };
      const customPath = path.join(testDir, 'custom-roles.json');
      await fs.writeFile(customPath, JSON.stringify(customRoles, null, 2));

      const config = makeConfig({
        roleDefinitionsFile: rolesPath,
        customRolesFile: customPath,
      });

      const roles = await loadMergedRoles(config, testDir);

      expect(Object.keys(roles)).toHaveLength(4); // dev, mgr, qa(overridden), security-auditor(new)
      expect(roles.qa.name).toBe('Security QA');
      expect(roles['security-auditor'].name).toBe('Security Auditor');
      expect(roles.developer.name).toBe('Developer'); // untouched
    });

    it('should NOT modify base role definitions object in memory', async () => {
      const rolesPath = path.join(testDir, 'roles.json');
      await fs.writeFile(rolesPath, JSON.stringify(baseRoles, null, 2));

      const customRoles: RoleDefinitions = {
        developer: { name: 'Overridden' },
      };
      const customPath = path.join(testDir, 'custom-roles.json');
      await fs.writeFile(customPath, JSON.stringify(customRoles, null, 2));

      const config = makeConfig({
        roleDefinitionsFile: rolesPath,
        customRolesFile: customPath,
      });

      // Load twice; second load re-reads files from disk
      const roles1 = await loadMergedRoles(config, testDir);
      const roles2 = await loadMergedRoles(config, testDir);

      expect(roles1.developer.name).toBe('Overridden');
      expect(roles2.developer.name).toBe('Overridden');
    });
  });

  // ----- Graceful fallback when custom file has issues --------------------

  describe('graceful fallback for bad customRolesFile', () => {
    it('should return base roles when custom file does not exist', async () => {
      const rolesPath = path.join(testDir, 'roles.json');
      await fs.writeFile(rolesPath, JSON.stringify(baseRoles, null, 2));

      const config = makeConfig({
        roleDefinitionsFile: rolesPath,
        customRolesFile: path.join(testDir, 'nonexistent-custom.json'),
      });

      const roles = await loadMergedRoles(config, testDir);

      // Falls back to base without throwing
      expect(Object.keys(roles)).toEqual(['developer', 'manager', 'qa']);
      expect(roles.developer.name).toBe('Developer');
    });

    it('should return base roles when custom file is malformed JSON', async () => {
      const rolesPath = path.join(testDir, 'roles.json');
      await fs.writeFile(rolesPath, JSON.stringify(baseRoles, null, 2));

      const customPath = path.join(testDir, 'custom-roles.json');
      await fs.writeFile(customPath, '{ broken !!!');

      const config = makeConfig({
        roleDefinitionsFile: rolesPath,
        customRolesFile: customPath,
      });

      const roles = await loadMergedRoles(config, testDir);

      // Falls back to base without throwing
      expect(Object.keys(roles)).toEqual(['developer', 'manager', 'qa']);
    });

    it('should return base roles when custom file is empty', async () => {
      const rolesPath = path.join(testDir, 'roles.json');
      await fs.writeFile(rolesPath, JSON.stringify(baseRoles, null, 2));

      const customPath = path.join(testDir, 'custom-roles.json');
      await fs.writeFile(customPath, '');

      const config = makeConfig({
        roleDefinitionsFile: rolesPath,
        customRolesFile: customPath,
      });

      const roles = await loadMergedRoles(config, testDir);

      // Empty string fails JSON.parse -- falls back to base
      expect(Object.keys(roles)).toEqual(['developer', 'manager', 'qa']);
    });
  });

  // ----- isDelegator correctness -----------------------------------------

  describe('isDelegator flag preservation', () => {
    it('should preserve isDelegator=true for manager in base roles', async () => {
      const rolesPath = path.join(testDir, 'roles.json');
      await fs.writeFile(rolesPath, JSON.stringify(baseRoles, null, 2));

      const config = makeConfig({ roleDefinitionsFile: rolesPath });
      const roles = await loadMergedRoles(config, testDir);

      expect(roles.manager.isDelegator).toBe(true);
      expect(roles.developer.isDelegator).toBe(false);
      expect(roles.qa.isDelegator).toBe(false);
    });

    it('should allow custom role to set isDelegator=true', async () => {
      const rolesPath = path.join(testDir, 'roles.json');
      await fs.writeFile(rolesPath, JSON.stringify(baseRoles, null, 2));

      const customRoles: RoleDefinitions = {
        'lead-architect': {
          name: 'Lead Architect',
          isDelegator: true,
          breakdownFraming: 'architecture',
        },
      };
      const customPath = path.join(testDir, 'custom-roles.json');
      await fs.writeFile(customPath, JSON.stringify(customRoles, null, 2));

      const config = makeConfig({
        roleDefinitionsFile: rolesPath,
        customRolesFile: customPath,
      });

      const roles = await loadMergedRoles(config, testDir);

      expect(roles['lead-architect'].isDelegator).toBe(true);
    });

    it('should allow custom role to flip isDelegator from true to false', async () => {
      const rolesPath = path.join(testDir, 'roles.json');
      await fs.writeFile(rolesPath, JSON.stringify(baseRoles, null, 2));

      // Override manager to be a non-delegator (edge case: someone wants
      // a "hands-on manager" that executes directly)
      const customRoles: RoleDefinitions = {
        manager: {
          ...baseRoles.manager,
          isDelegator: false,
          breakdownFraming: 'hands-on management',
        },
      };
      const customPath = path.join(testDir, 'custom-roles.json');
      await fs.writeFile(customPath, JSON.stringify(customRoles, null, 2));

      const config = makeConfig({
        roleDefinitionsFile: rolesPath,
        customRolesFile: customPath,
      });

      const roles = await loadMergedRoles(config, testDir);

      expect(roles.manager.isDelegator).toBe(false);
      expect(roles.manager.breakdownFraming).toBe('hands-on management');
    });

    it('custom role without isDelegator should not inherit base isDelegator', async () => {
      const rolesPath = path.join(testDir, 'roles.json');
      await fs.writeFile(rolesPath, JSON.stringify(baseRoles, null, 2));

      // Shallow merge replaces entire object -- custom definition wins entirely
      const customRoles: RoleDefinitions = {
        manager: {
          name: 'Custom Manager',
          // isDelegator intentionally omitted
        },
      };
      const customPath = path.join(testDir, 'custom-roles.json');
      await fs.writeFile(customPath, JSON.stringify(customRoles, null, 2));

      const config = makeConfig({
        roleDefinitionsFile: rolesPath,
        customRolesFile: customPath,
      });

      const roles = await loadMergedRoles(config, testDir);

      // Shallow merge replaces the whole manager entry: isDelegator is undefined
      expect(roles.manager.isDelegator).toBeUndefined();
      expect(roles.manager.name).toBe('Custom Manager');
    });
  });

  // ----- Path resolution -------------------------------------------------

  describe('path resolution', () => {
    it('should resolve roleDefinitionsFile relative to configDir', async () => {
      const subDir = path.join(testDir, 'sub');
      await fs.mkdir(subDir, { recursive: true });

      const rolesPath = path.join(subDir, 'roles.json');
      await fs.writeFile(rolesPath, JSON.stringify(baseRoles, null, 2));

      const config = makeConfig({
        roleDefinitionsFile: 'sub/roles.json',
      });

      const roles = await loadMergedRoles(config, testDir);
      expect(roles.developer.name).toBe('Developer');
    });

    it('should resolve customRolesFile relative to configDir', async () => {
      const rolesPath = path.join(testDir, 'roles.json');
      await fs.writeFile(rolesPath, JSON.stringify(baseRoles, null, 2));

      const customDir = path.join(testDir, 'project');
      await fs.mkdir(customDir, { recursive: true });

      const customPath = path.join(customDir, 'custom-roles.json');
      await fs.writeFile(
        customPath,
        JSON.stringify({ analyst: { name: 'Analyst' } }, null, 2),
      );

      const config = makeConfig({
        roleDefinitionsFile: rolesPath,
        customRolesFile: 'project/custom-roles.json',
      });

      const roles = await loadMergedRoles(config, testDir);
      expect(roles.analyst).toBeDefined();
      expect(roles.analyst.name).toBe('Analyst');
    });

    it('should handle absolute paths for both files', async () => {
      const rolesPath = path.join(testDir, 'roles.json');
      await fs.writeFile(rolesPath, JSON.stringify(baseRoles, null, 2));

      const customPath = path.join(testDir, 'custom.json');
      await fs.writeFile(
        customPath,
        JSON.stringify({ extra: { name: 'Extra' } }, null, 2),
      );

      const config = makeConfig({
        roleDefinitionsFile: rolesPath, // absolute
        customRolesFile: customPath,     // absolute
      });

      const roles = await loadMergedRoles(config, '/some/other/dir');
      expect(roles.extra).toBeDefined();
      expect(roles.developer).toBeDefined();
    });
  });

  // ----- Edge cases -------------------------------------------------------

  describe('edge cases', () => {
    it('should handle empty base roles', async () => {
      const rolesPath = path.join(testDir, 'roles.json');
      await fs.writeFile(rolesPath, '{}');

      const customPath = path.join(testDir, 'custom.json');
      await fs.writeFile(
        customPath,
        JSON.stringify({ solo: { name: 'Solo' } }, null, 2),
      );

      const config = makeConfig({
        roleDefinitionsFile: rolesPath,
        customRolesFile: customPath,
      });

      const roles = await loadMergedRoles(config, testDir);
      expect(Object.keys(roles)).toEqual(['solo']);
    });

    it('should handle empty custom roles (no-op overlay)', async () => {
      const rolesPath = path.join(testDir, 'roles.json');
      await fs.writeFile(rolesPath, JSON.stringify(baseRoles, null, 2));

      const customPath = path.join(testDir, 'custom.json');
      await fs.writeFile(customPath, '{}');

      const config = makeConfig({
        roleDefinitionsFile: rolesPath,
        customRolesFile: customPath,
      });

      const roles = await loadMergedRoles(config, testDir);
      expect(Object.keys(roles)).toEqual(['developer', 'manager', 'qa']);
    });

    it('should handle custom roles with complex nested objects', async () => {
      const rolesPath = path.join(testDir, 'roles.json');
      await fs.writeFile(rolesPath, JSON.stringify(baseRoles, null, 2));

      const customRoles: RoleDefinitions = {
        'hal-developer': {
          name: 'HAL Developer',
          description: 'Hardware abstraction layer',
          isDelegator: false,
          breakdownFraming: 'HAL implementation',
          primaryResponsibilities: ['Write HAL drivers', 'Port to embedded systems'],
          workingStyle: {
            principle: 'Deterministic real-time code',
            guidelines: ['No dynamic allocation', 'MISRA C compliant'],
          },
          instructionSection: ['Focus on protocol HAL layer'],
        },
      };
      const customPath = path.join(testDir, 'custom.json');
      await fs.writeFile(customPath, JSON.stringify(customRoles, null, 2));

      const config = makeConfig({
        roleDefinitionsFile: rolesPath,
        customRolesFile: customPath,
      });

      const roles = await loadMergedRoles(config, testDir);

      const hal = roles['hal-developer'];
      expect(hal.name).toBe('HAL Developer');
      expect(hal.isDelegator).toBe(false);
      expect(hal.breakdownFraming).toBe('HAL implementation');
      const ws = hal.workingStyle as { principle: string; guidelines: string[] };
      expect(ws.principle).toBe('Deterministic real-time code');
      expect(ws.guidelines).toHaveLength(2);
    });

    it('should survive base roles being an array (non-object)', async () => {
      const rolesPath = path.join(testDir, 'roles.json');
      await fs.writeFile(rolesPath, '[]');

      const config = makeConfig({ roleDefinitionsFile: rolesPath });

      // JSON.parse succeeds but spread on array gives numeric indexes --
      // this is a caller error but should not crash
      const roles = await loadMergedRoles(config, testDir);
      expect(roles).toBeDefined();
    });
  });
});
