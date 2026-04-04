// Tests for quota-manager.ts -- quota enforcement, model selection, state management

import { QuotaManager } from '../quota-manager.js';
import { AgentConfig } from '../types.js';
import { readFile, writeFile, rm, mkdir } from 'fs/promises';
import path from 'path';
import os from 'os';
import { createMockLogger } from './test-helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

/** Standard quota presets matching the production quota-presets.json shape. */
const PRESETS = {
  presets: {
    conservative: {
      description: 'Test conservative preset',
      limits: { monthly: 500, daily: 15 },
      modelFallback: {
        enabled: true,
        primary: 'claude-sonnet-4.5',
        fallback: 'gpt-4.1',
        switchAt: 0.5,
      },
      behavior: {
        onDailyLimit: 'pause',
        onMonthlyLimit: 'pause',
        onWarning: 'log',
      },
      tracking: {
        warningThresholds: [0.5, 0.75, 0.9],
      },
    },
    aggressive: {
      description: 'Test aggressive preset',
      limits: { monthly: 500 },
      modelFallback: { enabled: false },
      behavior: { onMonthlyLimit: 'warn', onWarning: 'log' },
      tracking: { warningThresholds: [0.9] },
    },
    adaptive: {
      description: 'Test adaptive preset',
      limits: { monthly: 100, daily: 10 },
      modelFallback: {
        enabled: true,
        primary: 'claude-sonnet-4.5',
        fallback: 'gpt-4.1',
        switchAt: 0.75,
      },
      priorityRules: {
        HIGH: { alwaysUsePrimary: true, bypassDailyLimit: false },
        NORMAL: { useFallbackAfter: 0.75 },
        LOW: { useFallbackAfter: 0.5, skipIfDailyLimitReached: true },
      },
      behavior: {
        onDailyLimit: 'pause',
        onMonthlyLimit: 'fallback',
        onWarning: 'log',
      },
      tracking: { warningThresholds: [0.5, 0.75, 0.9] },
    },
  },
  modelMultipliers: {
    models: {
      'gpt-4.1': 0,
      'gpt-4o': 0,
      'claude-sonnet-4.5': 1,
      'claude-opus-4.5': 3,
      'claude-haiku-4.5': 0.5,
    },
  },
};

function makeConfig(overrides: Record<string, any> = {}): AgentConfig {
  return {
    agent: {
      hostname: 'test-host',
      role: 'developer',
      checkIntervalMs: 60_000,
      stuckTimeoutMs: 1_800_000,
      sdkTimeoutMs: 120_000,
      taskRetryCount: 3,
      ...overrides.agent,
    },
    copilot: {
      model: 'gpt-4.1',
      ...overrides.copilot,
    },
    workspace: {
      path: tmpDir,
      workingFolder: 'project',
      ...overrides.workspace,
    },
    mailbox: {
      repoPath: '/tmp/mailbox',
      ...overrides.mailbox,
    },
    quota: {
      enabled: true,
      preset: 'conservative',
      presetsFile: path.join(tmpDir, 'quota-presets.json'),
      ...overrides.quota,
    },
  } as AgentConfig;
}

async function writePresets(presets = PRESETS): Promise<void> {
  await writeFile(
    path.join(tmpDir, 'quota-presets.json'),
    JSON.stringify(presets, null, 2),
    'utf-8',
  );
}

async function writeState(state: Record<string, any>): Promise<void> {
  await writeFile(
    path.join(tmpDir, 'quota_state.json'),
    JSON.stringify(state, null, 2),
    'utf-8',
  );
}

async function readState(): Promise<Record<string, any>> {
  const content = await readFile(path.join(tmpDir, 'quota_state.json'), 'utf-8');
  return JSON.parse(content);
}

const logger = createMockLogger();

beforeEach(async () => {
  tmpDir = path.join(
    os.tmpdir(),
    `quota-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(tmpDir, { recursive: true });
  await writePresets();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QuotaManager', () => {
  // ----- Initialization -----

  describe('initialize', () => {
    it('should initialize with conservative preset', async () => {
      const qm = new QuotaManager(makeConfig(), logger);
      await qm.initialize();

      const summary = qm.getUsageSummary();
      expect(summary.monthly.used).toBe(0);
      expect(summary.monthly.limit).toBe(500);
      expect(summary.daily.used).toBe(0);
      expect(summary.daily.limit).toBe(15);
    });

    it('should skip initialization when quota is disabled', async () => {
      const config = makeConfig({ quota: { enabled: false } });
      const qm = new QuotaManager(config, logger);
      await qm.initialize();

      // getUsageSummary should still work (returns defaults)
      const summary = qm.getUsageSummary();
      expect(summary.monthly.used).toBe(0);
    });

    it('should throw when preset name is invalid', async () => {
      const config = makeConfig({
        quota: {
          enabled: true,
          preset: 'nonexistent',
          presetsFile: path.join(tmpDir, 'quota-presets.json'),
        },
      });
      const qm = new QuotaManager(config, logger);
      await expect(qm.initialize()).rejects.toThrow(/not found/i);
    });

    it('should load existing state from file', async () => {
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const today = now.toISOString().split('T')[0];

      await writeState({
        month,
        used: { monthly: 42, today: 5, byModel: { 'gpt-4.1': 42 }, byPriority: { NORMAL: 42 } },
        lastReset: now.toISOString(),
        todayDate: today,
        warnings: [],
      });

      const qm = new QuotaManager(makeConfig(), logger);
      await qm.initialize();

      const summary = qm.getUsageSummary();
      expect(summary.monthly.used).toBe(42);
      expect(summary.daily.used).toBe(5);
    });

    it('should reset state when month changes', async () => {
      await writeState({
        month: '2024-01', // old month
        used: { monthly: 400, today: 10, byModel: {}, byPriority: {} },
        lastReset: '2024-01-15T00:00:00Z',
        todayDate: '2024-01-15',
        warnings: ['50% quota reached'],
      });

      const qm = new QuotaManager(makeConfig(), logger);
      await qm.initialize();

      const summary = qm.getUsageSummary();
      expect(summary.monthly.used).toBe(0);
      expect(summary.daily.used).toBe(0);
    });

    it('should reset daily counter when day changes', async () => {
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

      await writeState({
        month,
        used: { monthly: 42, today: 10, byModel: {}, byPriority: {} },
        lastReset: now.toISOString(),
        todayDate: '2000-01-01', // old day
        warnings: [],
      });

      const qm = new QuotaManager(makeConfig(), logger);
      await qm.initialize();

      const summary = qm.getUsageSummary();
      expect(summary.monthly.used).toBe(42); // monthly preserved
      expect(summary.daily.used).toBe(0);     // daily reset
    });

    it('should handle missing state file gracefully', async () => {
      // No state file written -- should create default
      const qm = new QuotaManager(makeConfig(), logger);
      await qm.initialize();

      const summary = qm.getUsageSummary();
      expect(summary.monthly.used).toBe(0);
    });
  });

  // ----- checkQuotaAndSelectModel -----

  describe('checkQuotaAndSelectModel', () => {
    it('should allow processing when quota is disabled', async () => {
      const config = makeConfig({ quota: { enabled: false } });
      const qm = new QuotaManager(config, logger);

      const result = await qm.checkQuotaAndSelectModel('NORMAL');
      expect(result.canProcess).toBe(true);
      expect(result.model).toBe('gpt-4.1');
    });

    it('should allow processing when under limits', async () => {
      const qm = new QuotaManager(makeConfig(), logger);
      await qm.initialize();

      const result = await qm.checkQuotaAndSelectModel('NORMAL');
      expect(result.canProcess).toBe(true);
    });

    it('should use primary model when under switchAt threshold', async () => {
      const qm = new QuotaManager(makeConfig(), logger);
      await qm.initialize();

      const result = await qm.checkQuotaAndSelectModel('NORMAL');
      expect(result.canProcess).toBe(true);
      // Under 50% -> primary model
      expect(result.model).toBe('claude-sonnet-4.5');
    });

    it('should switch to fallback model when over switchAt threshold', async () => {
      // Use state at 60% (300/500)
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const today = now.toISOString().split('T')[0];

      await writeState({
        month,
        used: { monthly: 300, today: 3, byModel: {}, byPriority: {} },
        lastReset: now.toISOString(),
        todayDate: today,
        warnings: [],
      });

      const qm = new QuotaManager(makeConfig(), logger);
      await qm.initialize();

      const result = await qm.checkQuotaAndSelectModel('NORMAL');
      expect(result.canProcess).toBe(true);
      // Over 50% (switchAt) -> fallback
      expect(result.model).toBe('gpt-4.1');
    });

    it('should block when monthly limit is reached', async () => {
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const today = now.toISOString().split('T')[0];

      await writeState({
        month,
        used: { monthly: 500, today: 3, byModel: {}, byPriority: {} },
        lastReset: now.toISOString(),
        todayDate: today,
        warnings: [],
      });

      const qm = new QuotaManager(makeConfig(), logger);
      await qm.initialize();

      const result = await qm.checkQuotaAndSelectModel('NORMAL');
      expect(result.canProcess).toBe(false);
      expect(result.reason).toContain('Monthly');
    });

    it('should block when daily limit is reached', async () => {
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const today = now.toISOString().split('T')[0];

      await writeState({
        month,
        used: { monthly: 50, today: 15, byModel: {}, byPriority: {} },
        lastReset: now.toISOString(),
        todayDate: today,
        warnings: [],
      });

      const qm = new QuotaManager(makeConfig(), logger);
      await qm.initialize();

      const result = await qm.checkQuotaAndSelectModel('NORMAL');
      expect(result.canProcess).toBe(false);
      expect(result.reason).toContain('Daily');
    });
  });

  // ----- Adaptive preset: priority rules -----

  describe('adaptive preset priority rules', () => {
    function adaptiveConfig(): AgentConfig {
      return makeConfig({
        quota: {
          enabled: true,
          preset: 'adaptive',
          presetsFile: path.join(tmpDir, 'quota-presets.json'),
        },
      });
    }

    it('should always use primary model for HIGH priority', async () => {
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const today = now.toISOString().split('T')[0];

      // Even at 90% usage, HIGH should get primary
      await writeState({
        month,
        used: { monthly: 90, today: 3, byModel: {}, byPriority: {} },
        lastReset: now.toISOString(),
        todayDate: today,
        warnings: [],
      });

      const qm = new QuotaManager(adaptiveConfig(), logger);
      await qm.initialize();

      const result = await qm.checkQuotaAndSelectModel('HIGH');
      expect(result.canProcess).toBe(true);
      expect(result.model).toBe('claude-sonnet-4.5');
    });

    it('should use fallback for NORMAL when over 75%', async () => {
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const today = now.toISOString().split('T')[0];

      await writeState({
        month,
        used: { monthly: 80, today: 3, byModel: {}, byPriority: {} },
        lastReset: now.toISOString(),
        todayDate: today,
        warnings: [],
      });

      const qm = new QuotaManager(adaptiveConfig(), logger);
      await qm.initialize();

      const result = await qm.checkQuotaAndSelectModel('NORMAL');
      expect(result.canProcess).toBe(true);
      expect(result.model).toBe('gpt-4.1');
    });

    it('should skip LOW priority when daily limit reached', async () => {
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const today = now.toISOString().split('T')[0];

      await writeState({
        month,
        used: { monthly: 30, today: 10, byModel: {}, byPriority: {} },
        lastReset: now.toISOString(),
        todayDate: today,
        warnings: [],
      });

      const qm = new QuotaManager(adaptiveConfig(), logger);
      await qm.initialize();

      const result = await qm.checkQuotaAndSelectModel('LOW');
      expect(result.canProcess).toBe(false);
      expect(result.reason).toContain('LOW priority');
    });

    it('should use fallback when monthly limit reached with fallback behavior', async () => {
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const today = now.toISOString().split('T')[0];

      await writeState({
        month,
        used: { monthly: 100, today: 3, byModel: {}, byPriority: {} },
        lastReset: now.toISOString(),
        todayDate: today,
        warnings: [],
      });

      const qm = new QuotaManager(adaptiveConfig(), logger);
      await qm.initialize();

      // Adaptive preset has onMonthlyLimit: 'fallback'
      const result = await qm.checkQuotaAndSelectModel('NORMAL');
      expect(result.canProcess).toBe(true);
      expect(result.model).toBe('gpt-4.1');
      expect(result.reason).toContain('fallback');
    });
  });

  // ----- Aggressive preset -----

  describe('aggressive preset', () => {
    function aggressiveConfig(): AgentConfig {
      return makeConfig({
        quota: {
          enabled: true,
          preset: 'aggressive',
          presetsFile: path.join(tmpDir, 'quota-presets.json'),
        },
        copilot: { model: 'claude-sonnet-4.5' },
      });
    }

    it('should always use configured model (no fallback)', async () => {
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const today = now.toISOString().split('T')[0];

      await writeState({
        month,
        used: { monthly: 400, today: 3, byModel: {}, byPriority: {} },
        lastReset: now.toISOString(),
        todayDate: today,
        warnings: [],
      });

      const qm = new QuotaManager(aggressiveConfig(), logger);
      await qm.initialize();

      const result = await qm.checkQuotaAndSelectModel('NORMAL');
      expect(result.canProcess).toBe(true);
      expect(result.model).toBe('claude-sonnet-4.5');
    });

    it('should warn but continue when monthly limit reached', async () => {
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const today = now.toISOString().split('T')[0];

      await writeState({
        month,
        used: { monthly: 500, today: 3, byModel: {}, byPriority: {} },
        lastReset: now.toISOString(),
        todayDate: today,
        warnings: [],
      });

      const qm = new QuotaManager(aggressiveConfig(), logger);
      await qm.initialize();

      // Aggressive preset has onMonthlyLimit: 'warn'
      const result = await qm.checkQuotaAndSelectModel('NORMAL');
      expect(result.canProcess).toBe(true);
      expect(result.reason).toContain('continuing');
    });
  });

  // ----- recordTaskCompletion -----

  describe('recordTaskCompletion', () => {
    it('should increment counters with model multiplier', async () => {
      const qm = new QuotaManager(makeConfig(), logger);
      await qm.initialize();

      // claude-sonnet-4.5 has multiplier 1
      await qm.recordTaskCompletion('claude-sonnet-4.5', 'NORMAL');

      const summary = qm.getUsageSummary();
      expect(summary.monthly.used).toBe(1);
      expect(summary.daily.used).toBe(1);
      expect(summary.byModel['claude-sonnet-4.5']).toBe(1);
      expect(summary.byPriority['NORMAL']).toBe(1);
    });

    it('should apply premium multiplier for expensive models', async () => {
      const qm = new QuotaManager(makeConfig(), logger);
      await qm.initialize();

      // claude-opus-4.5 has multiplier 3
      await qm.recordTaskCompletion('claude-opus-4.5', 'HIGH');

      const summary = qm.getUsageSummary();
      expect(summary.monthly.used).toBe(3);
      expect(summary.daily.used).toBe(3);
      expect(summary.byModel['claude-opus-4.5']).toBe(3);
    });

    it('should apply zero multiplier for free models', async () => {
      const qm = new QuotaManager(makeConfig(), logger);
      await qm.initialize();

      // gpt-4.1 has multiplier 0
      await qm.recordTaskCompletion('gpt-4.1', 'NORMAL');

      const summary = qm.getUsageSummary();
      expect(summary.monthly.used).toBe(0);
      expect(summary.daily.used).toBe(0);
    });

    it('should default multiplier to 1 for unknown models', async () => {
      const qm = new QuotaManager(makeConfig(), logger);
      await qm.initialize();

      await qm.recordTaskCompletion('unknown-model-xyz', 'NORMAL');

      const summary = qm.getUsageSummary();
      expect(summary.monthly.used).toBe(1);
    });

    it('should persist state to disk after recording', async () => {
      const qm = new QuotaManager(makeConfig(), logger);
      await qm.initialize();

      await qm.recordTaskCompletion('claude-sonnet-4.5', 'NORMAL');

      const state = await readState();
      expect(state.used.monthly).toBe(1);
      expect(state.used.today).toBe(1);
    });

    it('should accumulate across multiple recordings', async () => {
      const qm = new QuotaManager(makeConfig(), logger);
      await qm.initialize();

      await qm.recordTaskCompletion('claude-sonnet-4.5', 'NORMAL');
      await qm.recordTaskCompletion('claude-sonnet-4.5', 'HIGH');
      await qm.recordTaskCompletion('claude-haiku-4.5', 'LOW');

      const summary = qm.getUsageSummary();
      // 1 + 1 + 0.5 = 2.5
      expect(summary.monthly.used).toBe(2.5);
      expect(summary.byModel['claude-sonnet-4.5']).toBe(2);
      expect(summary.byModel['claude-haiku-4.5']).toBe(0.5);
    });

    it('should not record when quota is disabled', async () => {
      const config = makeConfig({ quota: { enabled: false } });
      const qm = new QuotaManager(config, logger);

      await qm.recordTaskCompletion('claude-sonnet-4.5', 'NORMAL');

      const summary = qm.getUsageSummary();
      expect(summary.monthly.used).toBe(0);
    });
  });

  // ----- getUsageSummary -----

  describe('getUsageSummary', () => {
    it('should calculate percentage correctly', async () => {
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const today = now.toISOString().split('T')[0];

      await writeState({
        month,
        used: { monthly: 250, today: 7, byModel: {}, byPriority: {} },
        lastReset: now.toISOString(),
        todayDate: today,
        warnings: [],
      });

      const qm = new QuotaManager(makeConfig(), logger);
      await qm.initialize();

      const summary = qm.getUsageSummary();
      expect(summary.monthly.percentage).toBeCloseTo(0.5);
      expect(summary.daily.percentage).toBeCloseTo(7 / 15);
    });

    it('should return zero percentage when no limit set', async () => {
      const config = makeConfig({
        quota: {
          enabled: true,
          preset: 'aggressive', // no daily limit
          presetsFile: path.join(tmpDir, 'quota-presets.json'),
        },
      });
      const qm = new QuotaManager(config, logger);
      await qm.initialize();

      const summary = qm.getUsageSummary();
      expect(summary.daily.percentage).toBe(0);
      expect(summary.daily.limit).toBeUndefined();
    });
  });

  // ----- Warning thresholds -----

  describe('warning thresholds', () => {
    it('should record warnings when thresholds are crossed', async () => {
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const today = now.toISOString().split('T')[0];

      // Start at 49% -- just under the 50% threshold
      await writeState({
        month,
        used: { monthly: 249, today: 3, byModel: {}, byPriority: {} },
        lastReset: now.toISOString(),
        todayDate: today,
        warnings: [],
      });

      const qm = new QuotaManager(makeConfig(), logger);
      await qm.initialize();

      // Record one more task to cross 50%
      await qm.recordTaskCompletion('claude-sonnet-4.5', 'NORMAL');

      // checkQuotaAndSelectModel triggers warning check
      await qm.checkQuotaAndSelectModel('NORMAL');

      const state = await readState();
      expect(state.warnings).toContain('50% quota reached');
    });
  });

  // ----- Preset overrides -----

  describe('preset overrides', () => {
    it('should apply config overrides on top of preset limits', async () => {
      const config = makeConfig({
        quota: {
          enabled: true,
          preset: 'conservative',
          presetsFile: path.join(tmpDir, 'quota-presets.json'),
          overrides: {
            limits: { daily: 50 },
          },
        },
      });
      const qm = new QuotaManager(config, logger);
      await qm.initialize();

      const summary = qm.getUsageSummary();
      // Monthly should remain 500 from preset, daily overridden to 50
      expect(summary.monthly.limit).toBe(500);
      expect(summary.daily.limit).toBe(50);
    });
  });

  // ----- Daily limit warn behavior -----

  describe('daily limit behaviors', () => {
    it('should continue with warn behavior on daily limit', async () => {
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const today = now.toISOString().split('T')[0];

      // Override conservative to warn on daily limit
      const config = makeConfig({
        quota: {
          enabled: true,
          preset: 'conservative',
          presetsFile: path.join(tmpDir, 'quota-presets.json'),
          overrides: {
            behavior: { onDailyLimit: 'warn' },
          },
        },
      });

      await writeState({
        month,
        used: { monthly: 50, today: 15, byModel: {}, byPriority: {} },
        lastReset: now.toISOString(),
        todayDate: today,
        warnings: [],
      });

      const qm = new QuotaManager(config, logger);
      await qm.initialize();

      const result = await qm.checkQuotaAndSelectModel('NORMAL');
      expect(result.canProcess).toBe(true);
      expect(result.reason).toContain('continuing');
    });

    it('should allow HIGH priority to bypass daily limit when configured', async () => {
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const today = now.toISOString().split('T')[0];

      // Override conservative to have HIGH bypass
      const config = makeConfig({
        quota: {
          enabled: true,
          preset: 'conservative',
          presetsFile: path.join(tmpDir, 'quota-presets.json'),
          overrides: {
            priorityRules: {
              HIGH: { bypassDailyLimit: true },
            },
          },
        },
      });

      await writeState({
        month,
        used: { monthly: 50, today: 15, byModel: {}, byPriority: {} },
        lastReset: now.toISOString(),
        todayDate: today,
        warnings: [],
      });

      const qm = new QuotaManager(config, logger);
      await qm.initialize();

      const result = await qm.checkQuotaAndSelectModel('HIGH');
      expect(result.canProcess).toBe(true);
      expect(result.reason).toContain('bypasses');
    });
  });
});
