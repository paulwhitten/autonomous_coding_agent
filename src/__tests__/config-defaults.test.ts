// Tests for config-defaults.ts -- Convention over Configuration

import { describe, it, expect } from '@jest/globals';
import { applyDefaults, deepMerge, sanitizeConfigForLogging, computeConfigOverrides, DEFAULT_CONFIG, DeepPartial } from '../config-defaults.js';
import { AgentConfig } from '../types.js';

describe('deepMerge', () => {
  it('should merge flat objects', () => {
    const target = { a: 1, b: 2 } as Record<string, unknown>;
    const source = { b: 3, c: 4 } as Record<string, unknown>;
    const result = deepMerge(target, source);
    expect(result).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('should deep-merge nested objects', () => {
    const target = { a: { x: 1, y: 2 }, b: 3 } as Record<string, unknown>;
    const source = { a: { y: 99 } } as Record<string, unknown>;
    const result = deepMerge(target, source);
    expect(result).toEqual({ a: { x: 1, y: 99 }, b: 3 });
  });

  it('should replace arrays entirely', () => {
    const target = { arr: [1, 2, 3] } as Record<string, unknown>;
    const source = { arr: [4, 5] } as Record<string, unknown>;
    const result = deepMerge(target, source);
    expect(result).toEqual({ arr: [4, 5] });
  });

  it('should not overwrite with null or undefined', () => {
    const target = { a: 1, b: 2 } as Record<string, unknown>;
    const source = { a: null, b: undefined } as Record<string, unknown>;
    const result = deepMerge(target, source);
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('should not mutate the original target', () => {
    const target = { a: { x: 1 } } as Record<string, unknown>;
    const source = { a: { x: 99 } } as Record<string, unknown>;
    deepMerge(target, source);
    expect((target.a as Record<string, unknown>).x).toBe(1);
  });
});

describe('applyDefaults', () => {
  it('should work with minimal config (only role and repoPath)', () => {
    const minimal: DeepPartial<AgentConfig> = {
      agent: { role: 'developer' },
      mailbox: { repoPath: '../my-mailbox' },
    };
    const result = applyDefaults(minimal);

    // Required fields preserved
    expect(result.agent.role).toBe('developer');
    expect(result.mailbox.repoPath).toBe('../my-mailbox');

    // Defaults filled in
    expect(result.agent.checkIntervalMs).toBe(60_000);
    expect(result.agent.stuckTimeoutMs).toBe(2_700_000);
    expect(result.agent.sdkTimeoutMs).toBe(300_000);
    expect(result.agent.taskRetryCount).toBe(3);
    expect(result.mailbox.gitSync).toBe(false);
    expect(result.mailbox.autoCommit).toBe(true);
    expect(result.copilot.model).toBe('gpt-4.1');
    expect(result.workspace.path).toBe('./workspace');
    expect(result.logging.level).toBe('info');
    expect(result.quota?.enabled).toBe(true);
  });

  it('should allow user overrides to take precedence', () => {
    const userConfig: DeepPartial<AgentConfig> = {
      agent: {
        role: 'qa',
        checkIntervalMs: 30_000,
        sdkTimeoutMs: 600_000,
      },
      mailbox: { repoPath: '/custom/path' },
      copilot: { model: 'gpt-5' },
      logging: { level: 'debug' },
    };
    const result = applyDefaults(userConfig);

    expect(result.agent.role).toBe('qa');
    expect(result.agent.checkIntervalMs).toBe(30_000);
    expect(result.agent.sdkTimeoutMs).toBe(600_000);
    expect(result.agent.stuckTimeoutMs).toBe(2_700_000); // default preserved
    expect(result.copilot.model).toBe('gpt-5');
    expect(result.logging.level).toBe('debug');
    expect(result.logging.maxSizeMB).toBe(100); // default preserved
  });

  it('should resolve auto-detect hostname', () => {
    const minimal: DeepPartial<AgentConfig> = {
      agent: { role: 'developer' },
      mailbox: { repoPath: '../mailbox' },
    };
    const result = applyDefaults(minimal);
    // hostname should be resolved (not 'auto-detect')
    expect(result.agent.hostname).not.toBe('auto-detect');
    expect(result.agent.hostname.length).toBeGreaterThan(0);
  });

  it('should preserve explicit hostname', () => {
    const userConfig: DeepPartial<AgentConfig> = {
      agent: { role: 'developer', hostname: 'my-server' },
      mailbox: { repoPath: '../mailbox' },
    };
    const result = applyDefaults(userConfig);
    expect(result.agent.hostname).toBe('my-server');
  });

  it('should throw when agent.role is missing', () => {
    const noRole: DeepPartial<AgentConfig> = {
      mailbox: { repoPath: '../mailbox' },
    } as DeepPartial<AgentConfig>;
    expect(() => applyDefaults(noRole)).toThrow('agent.role is required');
  });

  it('should throw when mailbox.repoPath is missing', () => {
    const noMailbox: DeepPartial<AgentConfig> = {
      agent: { role: 'developer' },
    } as DeepPartial<AgentConfig>;
    expect(() => applyDefaults(noMailbox)).toThrow('mailbox.repoPath is required');
  });

  it('should deep-merge nested timeoutStrategy overrides', () => {
    const userConfig: DeepPartial<AgentConfig> = {
      agent: {
        role: 'developer',
        timeoutStrategy: { tier1_multiplier: 2.0 },
      },
      mailbox: { repoPath: '../mailbox' },
    };
    const result = applyDefaults(userConfig);
    expect(result.agent.timeoutStrategy?.tier1_multiplier).toBe(2.0);
    expect(result.agent.timeoutStrategy?.enabled).toBe(true); // default preserved
    expect(result.agent.timeoutStrategy?.tier2_backgroundThreshold).toBe(2); // default preserved
  });

  it('should deep-merge workspace.taskSubfolders', () => {
    const userConfig: DeepPartial<AgentConfig> = {
      agent: { role: 'developer' },
      mailbox: { repoPath: '../mailbox' },
      workspace: {
        taskSubfolders: { completed: 'done' },
      },
    };
    const result = applyDefaults(userConfig);
    expect(result.workspace.taskSubfolders?.completed).toBe('done');
    expect(result.workspace.taskSubfolders?.pending).toBe('pending'); // default preserved
    expect(result.workspace.taskSubfolders?.failed).toBe('failed'); // default preserved
  });

  it('should handle manager as optional', () => {
    const minimal: DeepPartial<AgentConfig> = {
      agent: { role: 'manager' },
      mailbox: { repoPath: '../mailbox' },
    };
    const result = applyDefaults(minimal);
    // Manager gets default values from DEFAULT_CONFIG
    expect(result.manager).toBeDefined();
  });

  it('should allow overriding teamMembers array', () => {
    const userConfig: DeepPartial<AgentConfig> = {
      agent: { role: 'manager' },
      mailbox: { repoPath: '../mailbox' },
      teamMembers: [
        { hostname: 'dev1', role: 'developer', responsibilities: 'frontend' },
      ],
    };
    const result = applyDefaults(userConfig);
    expect(result.teamMembers).toHaveLength(1);
    expect(result.teamMembers![0].hostname).toBe('dev1');
  });
});

describe('DEFAULT_CONFIG', () => {
  it('should be a valid complete config object', () => {
    expect(DEFAULT_CONFIG.agent).toBeDefined();
    expect(DEFAULT_CONFIG.mailbox).toBeDefined();
    expect(DEFAULT_CONFIG.copilot).toBeDefined();
    expect(DEFAULT_CONFIG.workspace).toBeDefined();
    expect(DEFAULT_CONFIG.logging).toBeDefined();
    expect(DEFAULT_CONFIG.manager).toBeDefined();
    expect(DEFAULT_CONFIG.quota).toBeDefined();
  });

  it('should have consistent default values', () => {
    expect(DEFAULT_CONFIG.agent.checkIntervalMs).toBe(60_000);
    expect(DEFAULT_CONFIG.agent.stuckTimeoutMs).toBe(2_700_000);
    expect(DEFAULT_CONFIG.agent.sdkTimeoutMs).toBe(300_000);
    expect(DEFAULT_CONFIG.agent.taskRetryCount).toBe(3);
    expect(DEFAULT_CONFIG.agent.minWorkItems).toBe(5);
    expect(DEFAULT_CONFIG.agent.maxWorkItems).toBe(20);
    expect(DEFAULT_CONFIG.mailbox.gitSync).toBe(false);
    expect(DEFAULT_CONFIG.copilot.model).toBe('gpt-4.1');
  });
});

describe('sanitizeConfigForLogging', () => {
  it('should redact A2A authentication token', () => {
    const config = applyDefaults({
      agent: { role: 'developer' },
      mailbox: { repoPath: '../mailbox' },
      communication: {
        a2a: { authentication: { scheme: 'bearer', token: 'secret-token-123' } },
      },
    });
    const sanitized = sanitizeConfigForLogging(config);
    const comm = sanitized.communication as Record<string, unknown>;
    const a2a = (comm as any).a2a;
    expect(a2a.authentication.token).toBe('***REDACTED***');
  });

  it('should not mutate the original config', () => {
    const config = applyDefaults({
      agent: { role: 'developer' },
      mailbox: { repoPath: '../mailbox' },
      communication: {
        a2a: { authentication: { scheme: 'bearer', token: 'my-token' } },
      },
    });
    sanitizeConfigForLogging(config);
    expect(config.communication?.a2a?.authentication?.token).toBe('my-token');
  });

  it('should handle configs without sensitive fields', () => {
    const config = applyDefaults({
      agent: { role: 'developer' },
      mailbox: { repoPath: '../mailbox' },
    });
    const sanitized = sanitizeConfigForLogging(config);
    expect(sanitized.agent).toBeDefined();
    expect(sanitized.mailbox).toBeDefined();
  });
});

describe('computeConfigOverrides', () => {
  it('should always include identity fields', () => {
    const config = applyDefaults({
      agent: { role: 'developer' },
      mailbox: { repoPath: '../my-mailbox' },
    });
    const overrides = computeConfigOverrides(config);
    expect(overrides['agent.hostname']).toBeDefined();
    expect(overrides['agent.role']).toBe('developer');
    expect(overrides['mailbox.repoPath']).toBe('../my-mailbox');
  });

  it('should show only fields that differ from defaults', () => {
    const config = applyDefaults({
      agent: { role: 'qa', checkIntervalMs: 30_000 },
      mailbox: { repoPath: '../mailbox' },
      copilot: { model: 'gpt-5' },
    });
    const overrides = computeConfigOverrides(config);

    // Changed fields present
    expect(overrides['agent.role']).toBe('qa');
    expect(overrides['agent.checkIntervalMs']).toBe(30_000);
    expect(overrides['copilot.model']).toBe('gpt-5');

    // Unchanged fields absent (except always-included identity fields)
    expect(overrides['agent.stuckTimeoutMs']).toBeUndefined();
    expect(overrides['agent.sdkTimeoutMs']).toBeUndefined();
    expect(overrides['mailbox.gitSync']).toBeUndefined();
    expect(overrides['logging.level']).toBeUndefined();
  });

  it('should detect nested overrides', () => {
    const config = applyDefaults({
      agent: {
        role: 'developer',
        timeoutStrategy: { tier1_multiplier: 3.0 },
      },
      mailbox: { repoPath: '../mailbox' },
    });
    const overrides = computeConfigOverrides(config);
    expect(overrides['agent.timeoutStrategy.tier1_multiplier']).toBe(3.0);
    // Other timeoutStrategy fields match defaults, so they are absent
    expect(overrides['agent.timeoutStrategy.enabled']).toBeUndefined();
  });

  it('should return minimal overrides for a default-equivalent config', () => {
    const config = applyDefaults({
      agent: { role: 'developer' },
      mailbox: { repoPath: '../mailbox' },
    });
    const overrides = computeConfigOverrides(config);
    // Only identity fields and mailbox.repoPath (which deviates from default)
    const keys = Object.keys(overrides);
    expect(keys).toContain('agent.hostname');
    expect(keys).toContain('agent.role');
    expect(keys).toContain('mailbox.repoPath');
    // Should not have many other keys (hostname resolution makes agent.hostname differ)
    expect(keys.length).toBeLessThan(8);
  });
});
