// Tests for config-validator.ts -- Runtime JSON Schema validation

import { describe, it, expect, beforeEach } from '@jest/globals';
import { validateConfig, formatValidationErrors, resetValidator } from '../config-validator.js';

beforeEach(() => {
  // Reset so each test gets a fresh schema load
  resetValidator();
});

describe('validateConfig', () => {
  it('should accept a minimal valid config', async () => {
    const result = await validateConfig({
      agent: { role: 'developer' },
      mailbox: { repoPath: '../mailbox' },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should accept a full valid config', async () => {
    const result = await validateConfig({
      agent: {
        hostname: 'my-host',
        role: 'qa',
        checkIntervalMs: 60000,
        stuckTimeoutMs: 2700000,
        sdkTimeoutMs: 300000,
        taskRetryCount: 3,
        minWorkItems: 5,
        maxWorkItems: 20,
        timeoutStrategy: { enabled: true, tier1_multiplier: 1.5 },
        validation: { mode: 'spot_check', reviewEveryNthItem: 5 },
        backpressure: { enabled: true, maxPendingWorkItems: 50 },
      },
      mailbox: {
        repoPath: '../mailbox',
        gitSync: true,
        autoCommit: true,
        commitMessage: 'sync',
        supportBroadcast: true,
        supportAttachments: true,
        supportPriority: true,
      },
      copilot: {
        model: 'gpt-5',
        allowedTools: ['all'],
        permissions: { shell: 'allowlist', write: 'allow', read: 'allow' },
      },
      workspace: { path: './workspace', persistContext: true },
      logging: { level: 'info', path: './logs/agent.log', maxSizeMB: 100 },
      manager: { hostname: 'mgr', role: 'manager', escalationPriority: 'HIGH' },
      quota: { enabled: true, preset: 'adaptive' },
      teamMembers: [],
    });
    expect(result.valid).toBe(true);
  });

  it('should reject unknown top-level properties', async () => {
    const result = await validateConfig({
      agent: { role: 'developer' },
      mailbox: { repoPath: '../mailbox' },
      unknownField: 'oops',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    const unknownErr = result.errors.find(e => e.path.includes('unknownField'));
    expect(unknownErr).toBeDefined();
    expect(unknownErr!.message).toContain('Unknown property');
  });

  it('should reject unknown agent properties (typo detection)', async () => {
    const result = await validateConfig({
      agent: { role: 'developer', checkIntervallMs: 60000 },  // note: typo
      mailbox: { repoPath: '../mailbox' },
    });
    expect(result.valid).toBe(false);
    const typoErr = result.errors.find(e => e.path.includes('checkIntervallMs'));
    expect(typoErr).toBeDefined();
    expect(typoErr!.message).toContain('Unknown property');
  });

  it('should accept custom role values (open enum)', async () => {
    const result = await validateConfig({
      agent: { role: 'architect' },  // custom role -- now allowed
      mailbox: { repoPath: '../mailbox' },
    });
    expect(result.valid).toBe(true);
  });

  it('should reject empty role string', async () => {
    const result = await validateConfig({
      agent: { role: '' },
      mailbox: { repoPath: '../mailbox' },
    });
    expect(result.valid).toBe(false);
    const roleErr = result.errors.find(e => e.path === 'agent.role');
    expect(roleErr).toBeDefined();
  });

  it('should reject missing agent.role', async () => {
    const result = await validateConfig({
      agent: { hostname: 'test' },
      mailbox: { repoPath: '../mailbox' },
    });
    expect(result.valid).toBe(false);
    const missingErr = result.errors.find(e => e.path === 'agent.role');
    expect(missingErr).toBeDefined();
    expect(missingErr!.message).toContain('Required');
  });

  it('should reject missing mailbox', async () => {
    const result = await validateConfig({
      agent: { role: 'developer' },
    });
    expect(result.valid).toBe(false);
    const missingErr = result.errors.find(e => e.path.includes('mailbox'));
    expect(missingErr).toBeDefined();
  });

  it('should reject wrong type for checkIntervalMs', async () => {
    const result = await validateConfig({
      agent: { role: 'developer', checkIntervalMs: 'fast' },
      mailbox: { repoPath: '../mailbox' },
    });
    expect(result.valid).toBe(false);
    const typeErr = result.errors.find(e => e.path === 'agent.checkIntervalMs');
    expect(typeErr).toBeDefined();
    expect(typeErr!.message).toContain('Expected type');
  });

  it('should accept checkIntervalMs below 20000 (no schema minimum)', async () => {
    const result = await validateConfig({
      agent: { role: 'developer', checkIntervalMs: 5000 },
      mailbox: { repoPath: '../mailbox' },
    });
    expect(result.valid).toBe(true);
  });

  it('should reject invalid logging level', async () => {
    const result = await validateConfig({
      agent: { role: 'developer' },
      mailbox: { repoPath: '../mailbox' },
      logging: { level: 'verbose' },
    });
    expect(result.valid).toBe(false);
    const levelErr = result.errors.find(e => e.path === 'logging.level');
    expect(levelErr).toBeDefined();
    expect(levelErr!.message).toContain('Allowed values');
  });

  it('should accept requirements-analyst role', async () => {
    const result = await validateConfig({
      agent: { role: 'requirements-analyst' },
      mailbox: { repoPath: '../mailbox' },
    });
    expect(result.valid).toBe(true);
  });

  it('should accept $schema property without error', async () => {
    const result = await validateConfig({
      $schema: './config.schema.json',
      agent: { role: 'developer' },
      mailbox: { repoPath: '../mailbox' },
    });
    expect(result.valid).toBe(true);
  });

  it('should accept manager: null', async () => {
    const result = await validateConfig({
      agent: { role: 'developer' },
      mailbox: { repoPath: '../mailbox' },
      manager: null,
    });
    expect(result.valid).toBe(true);
  });

  it('should reject invalid validation mode', async () => {
    const result = await validateConfig({
      agent: {
        role: 'developer',
        validation: { mode: 'custom_mode', reviewEveryNthItem: 3 },
      },
      mailbox: { repoPath: '../mailbox' },
    });
    expect(result.valid).toBe(false);
    const modeErr = result.errors.find(e => e.path.includes('mode'));
    expect(modeErr).toBeDefined();
  });

  it('should report multiple errors at once', async () => {
    const result = await validateConfig({
      agent: { role: 'invalid_role', checkIntervalMs: 'not_a_number' },
      mailbox: { repoPath: 123 },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe('formatValidationErrors', () => {
  it('should format errors into readable multi-line string', () => {
    const formatted = formatValidationErrors([
      { path: 'agent.role', message: 'Required property "role" is missing.' },
      { path: 'agent.checkIntervallMs', message: 'Unknown property "checkIntervallMs".', value: 'checkIntervallMs' },
    ]);
    expect(formatted).toContain('Config validation failed:');
    expect(formatted).toContain('agent.role');
    expect(formatted).toContain('checkIntervallMs');
    expect(formatted).toContain('Unknown property');
  });
});
