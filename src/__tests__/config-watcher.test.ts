// Tests for config-watcher.ts - Filesystem watcher for hot-reloading agent config

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { ConfigWatcher, HotReloadableFields } from '../config-watcher.js';
import { AgentConfig } from '../types.js';
import { createMockLogger } from './test-helpers.js';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import pino from 'pino';

function createTestConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    agent: {
      hostname: 'test-host',
      role: 'developer',
      roleDefinitionsFile: './roles.json',
      checkIntervalMs: 120000,
      stuckTimeoutMs: 300000,
      sdkTimeoutMs: 120000,
      taskRetryCount: 3,
      minWorkItems: 5,
      maxWorkItems: 20,
      timeoutStrategy: {
        enabled: true,
        tier1_multiplier: 1.5,
        tier2_backgroundThreshold: 2,
        tier3_decomposeThreshold: 3,
        tier4_adaptiveWindow: 3600000,
        tier4_adaptiveThreshold: 5,
      },
      validation: { mode: 'spot_check', reviewEveryNthItem: 5, milestones: [] },
      backpressure: {
        enabled: true,
        maxPendingWorkItems: 50,
        maxRecipientMailbox: 10,
        deferralLogIntervalMs: 300000,
      },
    },
    mailbox: {
      repoPath: '/tmp/mailbox',
      gitSync: false,
      autoCommit: false,
      commitMessage: 'auto',
      supportBroadcast: true,
      supportAttachments: true,
      supportPriority: true,
    },
    copilot: {
      model: 'gpt-5-mini',
      allowedTools: ['all'],
      permissions: {
        shell: 'allowlist',
        write: 'allow',
        read: 'allow',
        url: 'deny',
        mcp: 'deny',
      },
    },
    workspace: {
      path: '/tmp/workspace',
      tasksFolder: 'tasks',
      workingFolder: 'project',
      taskSubfolders: {
        pending: 'pending',
        completed: 'completed',
        review: 'review',
        failed: 'failed',
      },
      persistContext: true,
    },
    logging: {
      level: 'info',
      path: '/tmp/logs/agent.log',
      maxSizeMB: 100,
    },
    manager: {
      hostname: 'test-host',
      role: 'manager',
      escalationPriority: 'HIGH',
    },
    quota: {
      enabled: true,
      preset: 'adaptive',
      presetsFile: './quota-presets.json',
    },
    teamMembers: [
      { hostname: 'test-host', role: 'developer', responsibilities: 'all dev work' },
    ],
    ...overrides,
  };
}

describe('ConfigWatcher', () => {
  let testDir: string;
  let configPath: string;
  let watcher: ConfigWatcher;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'config-watcher-test-'));
    configPath = path.join(testDir, 'config.json');
  });

  afterEach(async () => {
    if (watcher) {
      watcher.stop();
    }
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('should create a watcher without errors', async () => {
    const config = createTestConfig();
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    const callback = jest.fn<(updated: HotReloadableFields, full: AgentConfig) => void>();
    watcher = new ConfigWatcher(configPath, config, callback, createMockLogger());

    expect(watcher).toBeDefined();
  });

  it('should start and stop without errors', async () => {
    const config = createTestConfig();
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    const callback = jest.fn<(updated: HotReloadableFields, full: AgentConfig) => void>();
    watcher = new ConfigWatcher(configPath, config, callback, createMockLogger());

    watcher.start();
    watcher.stop();
  });

  it('should not call back when config has not changed', async () => {
    const config = createTestConfig();
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    const callback = jest.fn<(updated: HotReloadableFields, full: AgentConfig) => void>();
    watcher = new ConfigWatcher(configPath, config, callback, createMockLogger(), {
      pollIntervalMs: 100,
      debounceMs: 50,
    });

    watcher.start();

    // Re-write the same config (triggers file change but no diff)
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    // Wait for poll + debounce
    await new Promise(r => setTimeout(r, 300));

    expect(callback).not.toHaveBeenCalled();
    watcher.stop();
  });

  it('should detect checkIntervalMs change and call back', async () => {
    const config = createTestConfig();
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    const callback = jest.fn<(updated: HotReloadableFields, full: AgentConfig) => void>();
    watcher = new ConfigWatcher(configPath, config, callback, createMockLogger(), {
      pollIntervalMs: 100,
      debounceMs: 50,
    });

    watcher.start();

    // Change checkIntervalMs
    const modified = createTestConfig();
    modified.agent.checkIntervalMs = 60000;
    await fs.writeFile(configPath, JSON.stringify(modified, null, 2));

    // Wait for poll + debounce
    await new Promise(r => setTimeout(r, 500));

    expect(callback).toHaveBeenCalledTimes(1);
    const [updated] = callback.mock.calls[0];
    expect(updated.checkIntervalMs).toBe(60000);

    watcher.stop();
  });

  it('should detect teamMembers change', async () => {
    const config = createTestConfig();
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    const callback = jest.fn<(updated: HotReloadableFields, full: AgentConfig) => void>();
    watcher = new ConfigWatcher(configPath, config, callback, createMockLogger(), {
      pollIntervalMs: 100,
      debounceMs: 50,
    });

    watcher.start();

    // Add a team member
    const modified = createTestConfig();
    modified.teamMembers = [
      { hostname: 'test-host', role: 'developer', responsibilities: 'all dev work' },
      { hostname: 'test-host', role: 'qa', responsibilities: 'testing' },
    ];
    await fs.writeFile(configPath, JSON.stringify(modified, null, 2));

    await new Promise(r => setTimeout(r, 500));

    expect(callback).toHaveBeenCalledTimes(1);
    const [updated] = callback.mock.calls[0];
    expect(updated.teamMembers).toHaveLength(2);

    watcher.stop();
  });

  it('should survive malformed JSON without crashing', async () => {
    const config = createTestConfig();
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    const callback = jest.fn<(updated: HotReloadableFields, full: AgentConfig) => void>();
    watcher = new ConfigWatcher(configPath, config, callback, createMockLogger(), {
      pollIntervalMs: 100,
      debounceMs: 50,
    });

    watcher.start();

    // Write malformed JSON
    await fs.writeFile(configPath, '{ this is not valid json !!!');

    await new Promise(r => setTimeout(r, 500));

    // Should not have called back, and should not have thrown
    expect(callback).not.toHaveBeenCalled();

    // Write valid config again -- should still work
    const modified = createTestConfig();
    modified.agent.checkIntervalMs = 30000;
    await fs.writeFile(configPath, JSON.stringify(modified, null, 2));

    await new Promise(r => setTimeout(r, 500));

    expect(callback).toHaveBeenCalledTimes(1);

    watcher.stop();
  });

  it('should survive missing required fields without calling back', async () => {
    const config = createTestConfig();
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    const callback = jest.fn<(updated: HotReloadableFields, full: AgentConfig) => void>();
    watcher = new ConfigWatcher(configPath, config, callback, createMockLogger(), {
      pollIntervalMs: 100,
      debounceMs: 50,
    });

    watcher.start();

    // Write valid JSON but missing required fields
    await fs.writeFile(configPath, JSON.stringify({ foo: 'bar' }, null, 2));

    await new Promise(r => setTimeout(r, 500));

    expect(callback).not.toHaveBeenCalled();

    watcher.stop();
  });

  it('should not apply structural changes (hostname, role)', async () => {
    const config = createTestConfig();
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    const callback = jest.fn<(updated: HotReloadableFields, full: AgentConfig) => void>();
    watcher = new ConfigWatcher(configPath, config, callback, createMockLogger(), {
      pollIntervalMs: 100,
      debounceMs: 50,
    });

    watcher.start();

    // Change ONLY hostname (structural, not hot-reloadable)
    const modified = createTestConfig();
    modified.agent.hostname = 'different-host';
    await fs.writeFile(configPath, JSON.stringify(modified, null, 2));

    await new Promise(r => setTimeout(r, 500));

    // No hot-reloadable fields changed, so callback should not fire
    expect(callback).not.toHaveBeenCalled();

    watcher.stop();
  });

  it('should detect multiple field changes in one update', async () => {
    const config = createTestConfig();
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    const callback = jest.fn<(updated: HotReloadableFields, full: AgentConfig) => void>();
    watcher = new ConfigWatcher(configPath, config, callback, createMockLogger(), {
      pollIntervalMs: 100,
      debounceMs: 50,
    });

    watcher.start();

    // Change multiple hot-reloadable fields at once
    const modified = createTestConfig();
    modified.agent.checkIntervalMs = 30000;
    modified.agent.sdkTimeoutMs = 60000;
    modified.agent.taskRetryCount = 5;
    await fs.writeFile(configPath, JSON.stringify(modified, null, 2));

    await new Promise(r => setTimeout(r, 500));

    expect(callback).toHaveBeenCalledTimes(1);
    const [updated] = callback.mock.calls[0];
    expect(updated.checkIntervalMs).toBe(30000);
    expect(updated.sdkTimeoutMs).toBe(60000);
    expect(updated.taskRetryCount).toBe(5);

    watcher.stop();
  });
});

describe('ConfigWatcher roles.json watching', () => {
  let testDir: string;
  let configPath: string;
  let rolesPath: string;
  let githubDir: string;
  let watcher: ConfigWatcher;

  const baseRoles = {
    developer: {
      name: 'Developer',
      description: 'Implements code',
      primaryResponsibilities: ['Write code'],
      notYourJob: ['Manage team'],
    },
    manager: {
      name: 'Manager',
      description: 'Coordinates team',
      primaryResponsibilities: ['Delegate work'],
      notYourJob: ['Write code'],
    },
  };

  /** Create a logger whose methods are jest.fn() spies */
  function createSpyLogger() {
    const logger = {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      fatal: jest.fn(),
      trace: jest.fn(),
      child: jest.fn(),
      level: 'debug',
    };
    logger.child.mockReturnValue(logger);
    return logger as unknown as pino.Logger;
  }

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'roles-watcher-test-'));
    configPath = path.join(testDir, 'config.json');
    rolesPath = path.join(testDir, 'roles.json');
    githubDir = path.join(testDir, 'workspace', '.github');

    // Write initial roles file
    await fs.writeFile(rolesPath, JSON.stringify(baseRoles, null, 2));

    // Create workspace/.github/ so generateCopilotInstructions can write there
    await fs.mkdir(githubDir, { recursive: true });
  });

  afterEach(async () => {
    if (watcher) {
      watcher.stop();
    }
    await fs.rm(testDir, { recursive: true, force: true });
  });

  function createTestConfigWithRoles(): AgentConfig {
    return createTestConfig({
      agent: {
        hostname: 'test-host',
        role: 'developer',
        roleDefinitionsFile: rolesPath,
        checkIntervalMs: 120000,
        stuckTimeoutMs: 300000,
        sdkTimeoutMs: 120000,
        taskRetryCount: 3,
        timeoutStrategy: { enabled: true },
        validation: { mode: 'spot_check', reviewEveryNthItem: 5 },
      },
      workspace: {
        path: path.join(testDir, 'workspace'),
        persistContext: true,
      },
    });
  }

  it('should start watching roles.json when roleDefinitionsFile is set', async () => {
    const config = createTestConfigWithRoles();
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    const callback = jest.fn<(updated: HotReloadableFields, full: AgentConfig) => void>();
    const logger = createSpyLogger();
    watcher = new ConfigWatcher(configPath, config, callback, logger, {
      pollIntervalMs: 100,
      debounceMs: 50,
    });

    watcher.start();

    // Wait for initial hash capture
    await new Promise(r => setTimeout(r, 200));

    watcher.stop();

    // Logger should have logged that roles watcher started
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ path: rolesPath }),
      expect.stringContaining('Roles file watcher started')
    );
  });

  it('should not watch roles file when roleDefinitionsFile is not set', async () => {
    const config = createTestConfig();
    delete (config.agent as any).roleDefinitionsFile; // explicitly remove
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    const callback = jest.fn<(updated: HotReloadableFields, full: AgentConfig) => void>();
    const logger = createSpyLogger();
    watcher = new ConfigWatcher(configPath, config, callback, logger, {
      pollIntervalMs: 100,
      debounceMs: 50,
    });

    watcher.start();
    await new Promise(r => setTimeout(r, 200));
    watcher.stop();

    // Should NOT have logged roles watcher started
    const infoCalls = (logger.info as jest.Mock).mock.calls;
    const rolesLogFound = infoCalls.some(
      (call: any[]) => typeof call[1] === 'string' && call[1].includes('Roles file watcher started')
    );
    expect(rolesLogFound).toBe(false);
  });

  it('should detect roles.json content change', async () => {
    const config = createTestConfigWithRoles();
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    const callback = jest.fn<(updated: HotReloadableFields, full: AgentConfig) => void>();
    const logger = createSpyLogger();
    watcher = new ConfigWatcher(configPath, config, callback, logger, {
      pollIntervalMs: 100,
      debounceMs: 50,
    });

    watcher.start();

    // Wait for initial hash capture
    await new Promise(r => setTimeout(r, 200));

    // Modify roles.json content
    const modifiedRoles = {
      ...baseRoles,
      developer: {
        ...baseRoles.developer,
        primaryResponsibilities: ['Write code', 'Push to origin'],
      },
    };
    await fs.writeFile(rolesPath, JSON.stringify(modifiedRoles, null, 2));

    // Wait for poll + debounce + regeneration
    await new Promise(r => setTimeout(r, 500));

    // Should have logged the change detection
    const infoCalls = (logger.info as jest.Mock).mock.calls;
    const changeDetected = infoCalls.some(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('Roles file changed')
    );
    expect(changeDetected).toBe(true);

    watcher.stop();
  });

  it('should ignore roles.json touch without content change', async () => {
    const config = createTestConfigWithRoles();
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    const callback = jest.fn<(updated: HotReloadableFields, full: AgentConfig) => void>();
    const logger = createSpyLogger();
    watcher = new ConfigWatcher(configPath, config, callback, logger, {
      pollIntervalMs: 100,
      debounceMs: 50,
    });

    watcher.start();

    // Wait for initial hash capture
    await new Promise(r => setTimeout(r, 200));

    // Re-write same content (touch)
    await fs.writeFile(rolesPath, JSON.stringify(baseRoles, null, 2));

    await new Promise(r => setTimeout(r, 500));

    // Should have logged "content unchanged"
    const debugCalls = (logger.debug as jest.Mock).mock.calls;
    const unchangedLogged = debugCalls.some(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('content unchanged')
    );
    expect(unchangedLogged).toBe(true);

    watcher.stop();
  });

  it('should survive malformed roles.json without crashing', async () => {
    const config = createTestConfigWithRoles();
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    const callback = jest.fn<(updated: HotReloadableFields, full: AgentConfig) => void>();
    const logger = createSpyLogger();
    watcher = new ConfigWatcher(configPath, config, callback, logger, {
      pollIntervalMs: 100,
      debounceMs: 50,
    });

    watcher.start();
    await new Promise(r => setTimeout(r, 200));

    // Write malformed JSON to roles file
    await fs.writeFile(rolesPath, '{ this is broken json !!!');

    await new Promise(r => setTimeout(r, 500));

    // Should have logged an error but not crashed
    expect(logger.error).toHaveBeenCalled();

    // Watcher should still be functional -- write valid roles
    const modifiedRoles = {
      ...baseRoles,
      qa: { name: 'QA', description: 'Tests', primaryResponsibilities: ['Test'], notYourJob: ['Code'] },
    };
    await fs.writeFile(rolesPath, JSON.stringify(modifiedRoles, null, 2));

    await new Promise(r => setTimeout(r, 500));

    // Should recover and detect the valid change
    const infoCalls = (logger.info as jest.Mock).mock.calls;
    const changeDetected = infoCalls.some(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('Roles file changed')
    );
    expect(changeDetected).toBe(true);

    watcher.stop();
  });

  it('should clean up roles watcher on stop', async () => {
    const config = createTestConfigWithRoles();
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    const callback = jest.fn<(updated: HotReloadableFields, full: AgentConfig) => void>();
    const logger = createSpyLogger();
    watcher = new ConfigWatcher(configPath, config, callback, logger, {
      pollIntervalMs: 100,
      debounceMs: 50,
    });

    watcher.start();
    await new Promise(r => setTimeout(r, 200));

    watcher.stop();

    // Modify roles after stop -- should NOT trigger anything
    const modifiedRoles = { ...baseRoles, newRole: { name: 'New' } };
    await fs.writeFile(rolesPath, JSON.stringify(modifiedRoles, null, 2));

    await new Promise(r => setTimeout(r, 500));

    // No change detection after stop
    const infoCalls = (logger.info as jest.Mock).mock.calls;
    const changeAfterStop = infoCalls.some(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('Roles file changed')
    );
    expect(changeAfterStop).toBe(false);
  });
});

describe('ConfigWatcher team.json watching', () => {
  let testDir: string;
  let configPath: string;
  let teamFilePath: string;
  let watcher: ConfigWatcher;

  const baseTeam = {
    team: { name: 'test-team', description: 'Unit test team' },
    agents: [
      { hostname: 'mgr', role: 'manager', capabilities: ['coordination'] },
      { hostname: 'dev', role: 'developer', capabilities: ['coding'] },
    ],
  };

  function createSpyLogger() {
    const logger = {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      fatal: jest.fn(),
      trace: jest.fn(),
      child: jest.fn(),
      level: 'debug',
    };
    logger.child.mockReturnValue(logger);
    return logger as unknown as pino.Logger;
  }

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-watcher-test-'));
    configPath = path.join(testDir, 'config.json');

    // Create mailbox/team.json matching the repoPath layout
    const mailboxDir = path.join(testDir, 'repo', 'mailbox');
    await fs.mkdir(mailboxDir, { recursive: true });
    teamFilePath = path.join(mailboxDir, 'team.json');
    await fs.writeFile(teamFilePath, JSON.stringify(baseTeam, null, 2));
  });

  afterEach(async () => {
    if (watcher) {
      watcher.stop();
    }
    await fs.rm(testDir, { recursive: true, force: true });
  });

  function createTestConfigWithTeam(): AgentConfig {
    return createTestConfig({
      mailbox: {
        repoPath: path.join(testDir, 'repo'),
        gitSync: false,
        autoCommit: false,
        commitMessage: 'auto',
        supportBroadcast: true,
        supportAttachments: true,
        supportPriority: true,
      },
    });
  }

  it('should start watching team.json when repoPath is configured', async () => {
    const config = createTestConfigWithTeam();
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    const callback = jest.fn<(updated: HotReloadableFields, full: AgentConfig) => void>();
    const logger = createSpyLogger();
    watcher = new ConfigWatcher(configPath, config, callback, logger, {
      pollIntervalMs: 100,
      debounceMs: 50,
    });

    watcher.start();
    await new Promise(r => setTimeout(r, 200));
    watcher.stop();

    const infoCalls = (logger.info as jest.Mock).mock.calls;
    const teamLogFound = infoCalls.some(
      (call: any[]) => typeof call[1] === 'string' && call[1].includes('Team roster watcher started')
    );
    expect(teamLogFound).toBe(true);
  });

  it('should call onTeamRosterChange when team.json content changes', async () => {
    const config = createTestConfigWithTeam();
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    const callback = jest.fn<(updated: HotReloadableFields, full: AgentConfig) => void>();
    const onTeamChange = jest.fn();
    const logger = createSpyLogger();
    watcher = new ConfigWatcher(configPath, config, callback, logger, {
      pollIntervalMs: 100,
      debounceMs: 50,
      onTeamRosterChange: onTeamChange,
    });

    watcher.start();
    await new Promise(r => setTimeout(r, 200));

    // Add a new agent to team.json
    const modified = {
      ...baseTeam,
      agents: [
        ...baseTeam.agents,
        { hostname: 'qa', role: 'qa', capabilities: ['testing'] },
      ],
    };
    await fs.writeFile(teamFilePath, JSON.stringify(modified, null, 2));

    await new Promise(r => setTimeout(r, 500));

    expect(onTeamChange).toHaveBeenCalledTimes(1);

    watcher.stop();
  });

  it('should ignore team.json touch without content change', async () => {
    const config = createTestConfigWithTeam();
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    const callback = jest.fn<(updated: HotReloadableFields, full: AgentConfig) => void>();
    const onTeamChange = jest.fn();
    const logger = createSpyLogger();
    watcher = new ConfigWatcher(configPath, config, callback, logger, {
      pollIntervalMs: 100,
      debounceMs: 50,
      onTeamRosterChange: onTeamChange,
    });

    watcher.start();
    await new Promise(r => setTimeout(r, 200));

    // Re-write identical content
    await fs.writeFile(teamFilePath, JSON.stringify(baseTeam, null, 2));

    await new Promise(r => setTimeout(r, 500));

    expect(onTeamChange).not.toHaveBeenCalled();

    const debugCalls = (logger.debug as jest.Mock).mock.calls;
    const unchangedLogged = debugCalls.some(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('Team file touched but content unchanged')
    );
    expect(unchangedLogged).toBe(true);

    watcher.stop();
  });

  it('should clean up team.json watcher on stop', async () => {
    const config = createTestConfigWithTeam();
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    const callback = jest.fn<(updated: HotReloadableFields, full: AgentConfig) => void>();
    const onTeamChange = jest.fn();
    watcher = new ConfigWatcher(configPath, config, callback, createSpyLogger(), {
      pollIntervalMs: 100,
      debounceMs: 50,
      onTeamRosterChange: onTeamChange,
    });

    watcher.start();
    await new Promise(r => setTimeout(r, 200));

    watcher.stop();

    // Modify after stop -- callback should not fire
    const modified = { ...baseTeam, agents: [] };
    await fs.writeFile(teamFilePath, JSON.stringify(modified, null, 2));

    await new Promise(r => setTimeout(r, 500));

    expect(onTeamChange).not.toHaveBeenCalled();
  });
});
