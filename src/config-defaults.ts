// Convention over Configuration: sensible defaults for every config field.
//
// Users only need to specify what differs from these defaults.
// The minimum viable config is:
//
//   { "agent": { "role": "developer" }, "mailbox": { "repoPath": "../shared-mailbox" } }
//
// All other values are filled from this module via applyDefaults().

import { AgentConfig } from './types.js';
import * as os from 'os';

/**
 * Deep-partial type that makes every nested property optional.
 * Used for user-supplied config that may omit any field.
 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object
    ? T[P] extends Array<infer U>
      ? Array<DeepPartial<U>>
      : DeepPartial<T[P]>
    : T[P];
};

/**
 * The minimum fields a user must provide.  Everything else has a default.
 */
export interface MinimalConfig {
  agent: {
    role: string;
  } & DeepPartial<AgentConfig['agent']>;
  mailbox: {
    repoPath: string;
  } & DeepPartial<AgentConfig['mailbox']>;
  [key: string]: unknown;
}

/**
 * Canonical default values for every AgentConfig field.
 *
 * agent.hostname is set to 'auto-detect' here and resolved to os.hostname()
 * at startup in applyDefaults().
 */
export const DEFAULT_CONFIG: AgentConfig = {
  agent: {
    hostname: 'auto-detect',
    role: 'developer',  // overridden by user -- required
    roleDefinitionsFile: './roles.json',
    checkIntervalMs: 60_000,
    stuckTimeoutMs: 2_700_000,
    sdkTimeoutMs: 300_000,
    taskRetryCount: 3,
    minWorkItems: 5,
    maxWorkItems: 20,
    timeoutStrategy: {
      enabled: true,
      tier1_multiplier: 1.5,
      tier2_backgroundThreshold: 2,
      tier3_decomposeThreshold: 3,
      tier4_adaptiveWindow: 3_600_000,
      tier4_adaptiveThreshold: 5,
    },
    validation: {
      mode: 'spot_check',
      reviewEveryNthItem: 5,
      milestones: [],
    },
    backpressure: {
      enabled: true,
      maxPendingWorkItems: 50,
      maxRecipientMailbox: 10,
      deferralLogIntervalMs: 300_000,
    },
  },
  mailbox: {
    repoPath: '../shared-mailbox',  // overridden by user -- required
    gitSync: false,
    autoCommit: true,
    commitMessage: 'Auto-sync: {hostname}_{role} at {timestamp}',
    supportBroadcast: true,
    supportAttachments: true,
    supportPriority: true,
  },
  copilot: {
    model: 'gpt-4.1',
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
    path: './workspace',
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
    path: './logs/agent.log',
    maxSizeMB: 100,
  },
  manager: {
    hostname: 'auto-detect',
    role: 'manager',
    escalationPriority: 'HIGH',
  },
  quota: {
    enabled: true,
    preset: 'adaptive',
    presetsFile: './quota-presets.json',
  },
  teamMembers: [],
};

/**
 * Recursively merge source into target, returning a new object.
 * - Arrays from source replace target arrays entirely (no element merge).
 * - Null/undefined source values do not overwrite target values.
 * - Primitives from source overwrite target primitives.
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Record<string, unknown>,
): T {
  const result = { ...target } as Record<string, unknown>;

  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = result[key];

    if (srcVal === undefined || srcVal === null) {
      continue;
    }

    if (Array.isArray(srcVal)) {
      result[key] = srcVal;
    } else if (
      typeof srcVal === 'object' &&
      typeof tgtVal === 'object' &&
      tgtVal !== null &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      );
    } else {
      result[key] = srcVal;
    }
  }

  return result as T;
}

/**
 * Apply convention-over-configuration defaults to a partial user config.
 *
 * Validates that the two required fields are present, deep-merges user
 * values over DEFAULT_CONFIG, and resolves 'auto-detect' hostname.
 */
export function applyDefaults(partial: DeepPartial<AgentConfig>): AgentConfig {
  // Validate required fields
  if (!partial.agent?.role) {
    throw new Error(
      'Config error: agent.role is required. ' +
      'Example: { "agent": { "role": "developer" }, "mailbox": { "repoPath": "../shared-mailbox" } }',
    );
  }
  if (!partial.mailbox?.repoPath) {
    throw new Error(
      'Config error: mailbox.repoPath is required. ' +
      'Example: { "agent": { "role": "developer" }, "mailbox": { "repoPath": "../shared-mailbox" } }',
    );
  }

  // Deep-merge user config over defaults
  const merged = deepMerge(
    structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>,
    partial as unknown as Record<string, unknown>,
  ) as unknown as AgentConfig;

  // Resolve auto-detect hostname
  if (merged.agent.hostname === 'auto-detect') {
    merged.agent.hostname = os.hostname();
  }

  // Resolve manager.hostname auto-detect to match agent hostname
  if (merged.manager?.hostname === 'auto-detect') {
    merged.manager.hostname = os.hostname();
  }

  return merged;
}

/**
 * Create a sanitized copy of the config safe for logging.
 * Redacts sensitive fields (tokens, keys) while preserving structure.
 */
export function sanitizeConfigForLogging(config: AgentConfig): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(config));

  // Redact sensitive fields
  if (clone.communication?.a2a?.authentication?.token) {
    clone.communication.a2a.authentication.token = '***REDACTED***';
  }
  if (clone.communication?.a2a?.tls?.keyPath) {
    clone.communication.a2a.tls.keyPath = '***REDACTED***';
  }
  if (clone.copilot?.permissions?.shellAllowAdditional) {
    // Not sensitive, but can be very long -- keep it
  }

  return clone;
}

/**
 * Compute the user overrides: fields in `config` that differ from DEFAULT_CONFIG.
 *
 * Returns a sparse object containing only the paths where the effective
 * config diverges from defaults.  Useful for concise logging -- operators
 * see what they changed rather than the full effective config.
 *
 * hostname and manager.hostname are always included because they are
 * resolved from 'auto-detect' and the effective value is useful context.
 */
export function computeConfigOverrides(config: AgentConfig): Record<string, unknown> {
  const defaults = DEFAULT_CONFIG as unknown as Record<string, unknown>;
  const effective = config as unknown as Record<string, unknown>;
  const diff = diffObjects(defaults, effective, '');

  // Always include identity fields for operator context
  diff['agent.hostname'] = config.agent.hostname;
  diff['agent.role'] = config.agent.role;
  diff['mailbox.repoPath'] = config.mailbox.repoPath;

  return diff;
}

/**
 * Recursively compare two objects and return paths that differ.
 */
function diffObjects(
  defaults: Record<string, unknown>,
  effective: Record<string, unknown>,
  prefix: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const key of new Set([...Object.keys(defaults), ...Object.keys(effective)])) {
    const path = prefix ? `${prefix}.${key}` : key;
    const dVal = defaults[key];
    const eVal = effective[key];

    if (eVal === undefined) continue;
    if (dVal === undefined) {
      result[path] = eVal;
      continue;
    }

    if (
      typeof dVal === 'object' && dVal !== null && !Array.isArray(dVal) &&
      typeof eVal === 'object' && eVal !== null && !Array.isArray(eVal)
    ) {
      const nested = diffObjects(
        dVal as Record<string, unknown>,
        eVal as Record<string, unknown>,
        path,
      );
      Object.assign(result, nested);
    } else if (JSON.stringify(dVal) !== JSON.stringify(eVal)) {
      result[path] = eVal;
    }
  }

  return result;
}
