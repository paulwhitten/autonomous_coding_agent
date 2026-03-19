// Filesystem watcher for hot-reloading agent configuration at runtime.
//
// Watches config.json for changes and applies safe, hot-reloadable fields
// without requiring an agent restart. Structural changes (hostname, role,
// mailbox paths) are logged but ignored -- those require a restart.
//
// Also watches roles.json (roleDefinitionsFile) and regenerates
// .github/copilot-instructions.md when role definitions change.

import { readFile } from 'fs/promises';
import { watchFile, unwatchFile, existsSync } from 'fs';
import path from 'path';
import { AgentConfig } from './types.js';
import pino from 'pino';

/** Fields that can be safely updated at runtime without restarting */
export interface HotReloadableFields {
  checkIntervalMs: number;
  stuckTimeoutMs: number;
  sdkTimeoutMs: number;
  taskRetryCount: number;
  timeoutStrategy?: AgentConfig['agent']['timeoutStrategy'];
  validation?: AgentConfig['agent']['validation'];
  teamMembers?: AgentConfig['teamMembers'];
  quotaEnabled?: boolean;
  quotaPreset?: string;
}

export type ConfigChangeCallback = (
  updated: HotReloadableFields,
  fullConfig: AgentConfig
) => void;

export class ConfigWatcher {
  private configPath: string;
  private logger: pino.Logger;
  private callback: ConfigChangeCallback;
  private currentConfig: AgentConfig;
  private pollIntervalMs: number;
  private debounceMs: number;
  private debounceTimer: NodeJS.Timeout | null = null;
  private rolesDebounceTimer: NodeJS.Timeout | null = null;
  private watching: boolean = false;
  private rolesFilePath: string | null = null;
  private lastRolesHash: string = '';

  constructor(
    configPath: string,
    initialConfig: AgentConfig,
    callback: ConfigChangeCallback,
    logger: pino.Logger,
    options?: { pollIntervalMs?: number; debounceMs?: number }
  ) {
    this.configPath = configPath;
    this.currentConfig = structuredClone(initialConfig);
    this.callback = callback;
    this.logger = logger;
    this.pollIntervalMs = options?.pollIntervalMs ?? 5000;
    this.debounceMs = options?.debounceMs ?? 1000;
  }

  /** Start watching the config file and roles file for changes */
  start(): void {
    if (this.watching) return;
    this.watching = true;

    // Watch config.json
    watchFile(this.configPath, { interval: this.pollIntervalMs }, (_curr, _prev) => {
      this.handleFileChange();
    });

    // Resolve and watch roles.json if configured
    this.rolesFilePath = this.resolveRolesFile();
    if (this.rolesFilePath && existsSync(this.rolesFilePath)) {
      // Capture initial hash for comparison
      readFile(this.rolesFilePath, 'utf-8')
        .then(content => { this.lastRolesHash = this.simpleHash(content); })
        .catch(() => { /* ignore initial read failure */ });

      watchFile(this.rolesFilePath, { interval: this.pollIntervalMs }, (_curr, _prev) => {
        this.handleRolesFileChange();
      });
      this.logger.info(
        { path: this.rolesFilePath },
        'Roles file watcher started (changes will regenerate copilot-instructions.md)'
      );
    }

    this.logger.info(
      { path: this.configPath, pollIntervalMs: this.pollIntervalMs },
      'Config watcher started'
    );
  }

  /** Stop watching */
  stop(): void {
    if (!this.watching) return;
    this.watching = false;

    unwatchFile(this.configPath);

    if (this.rolesFilePath) {
      unwatchFile(this.rolesFilePath);
      this.rolesFilePath = null;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.rolesDebounceTimer) {
      clearTimeout(this.rolesDebounceTimer);
      this.rolesDebounceTimer = null;
    }

    this.logger.info('Config watcher stopped');
  }

  /** Handle a file change event (debounced) */
  private handleFileChange(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(async () => {
      this.debounceTimer = null;
      await this.reloadConfig();
    }, this.debounceMs);
  }

  /** Read, validate, diff, and apply config changes */
  private async reloadConfig(): Promise<void> {
    try {
      const raw = await readFile(this.configPath, 'utf-8');
      const newConfig: AgentConfig = JSON.parse(raw);

      // Validate required structure
      if (!newConfig.agent || !newConfig.mailbox || !newConfig.copilot) {
        this.logger.warn('Config reload skipped: missing required top-level fields');
        return;
      }

      // Detect structural changes that require restart
      const restartRequired = this.detectRestartRequired(newConfig);
      if (restartRequired.length > 0) {
        this.logger.warn(
          { fields: restartRequired },
          'Config contains structural changes that require a restart (ignored)'
        );
      }

      // Extract and diff hot-reloadable fields
      const changes = this.diffHotReloadable(newConfig);
      if (changes.length === 0) {
        this.logger.debug('Config file changed but no hot-reloadable differences detected');
        return;
      }

      // Build the updated fields object
      const updated: HotReloadableFields = {
        checkIntervalMs: newConfig.agent.checkIntervalMs,
        stuckTimeoutMs: newConfig.agent.stuckTimeoutMs,
        sdkTimeoutMs: newConfig.agent.sdkTimeoutMs,
        taskRetryCount: newConfig.agent.taskRetryCount ?? 3,
        timeoutStrategy: newConfig.agent.timeoutStrategy,
        validation: newConfig.agent.validation,
        teamMembers: newConfig.teamMembers,
        quotaEnabled: newConfig.quota?.enabled,
        quotaPreset: newConfig.quota?.preset,
      };

      this.logger.info(
        { changedFields: changes },
        'Config hot-reload: applying changes'
      );

      // Update our snapshot
      this.currentConfig = structuredClone(newConfig);

      // Notify the agent
      this.callback(updated, newConfig);

    } catch (error) {
      this.logger.error(
        { err: error },
        'Config reload failed (keeping current config)'
      );
    }
  }

  /** Check for fields that cannot be hot-reloaded */
  private detectRestartRequired(newConfig: AgentConfig): string[] {
    const changed: string[] = [];

    if (newConfig.agent.hostname !== this.currentConfig.agent.hostname) {
      changed.push('agent.hostname');
    }
    if (newConfig.agent.role !== this.currentConfig.agent.role) {
      changed.push('agent.role');
    }
    if (newConfig.mailbox.repoPath !== this.currentConfig.mailbox.repoPath) {
      changed.push('mailbox.repoPath');
    }
    if (newConfig.workspace.path !== this.currentConfig.workspace.path) {
      changed.push('workspace.path');
    }
    if (newConfig.logging.path !== this.currentConfig.logging.path) {
      changed.push('logging.path');
    }

    return changed;
  }

  /** Compare hot-reloadable fields and return names of those that changed */
  private diffHotReloadable(newConfig: AgentConfig): string[] {
    const changed: string[] = [];
    const oldAgent = this.currentConfig.agent;
    const newAgent = newConfig.agent;

    if (newAgent.checkIntervalMs !== oldAgent.checkIntervalMs) {
      changed.push('agent.checkIntervalMs');
    }
    if (newAgent.stuckTimeoutMs !== oldAgent.stuckTimeoutMs) {
      changed.push('agent.stuckTimeoutMs');
    }
    if (newAgent.sdkTimeoutMs !== oldAgent.sdkTimeoutMs) {
      changed.push('agent.sdkTimeoutMs');
    }
    if ((newAgent.taskRetryCount ?? 3) !== (oldAgent.taskRetryCount ?? 3)) {
      changed.push('agent.taskRetryCount');
    }
    if (JSON.stringify(newAgent.timeoutStrategy) !== JSON.stringify(oldAgent.timeoutStrategy)) {
      changed.push('agent.timeoutStrategy');
    }
    if (JSON.stringify(newAgent.validation) !== JSON.stringify(oldAgent.validation)) {
      changed.push('agent.validation');
    }
    if (JSON.stringify(newConfig.teamMembers) !== JSON.stringify(this.currentConfig.teamMembers)) {
      changed.push('teamMembers');
    }
    if (newConfig.quota?.enabled !== this.currentConfig.quota?.enabled) {
      changed.push('quota.enabled');
    }
    if (newConfig.quota?.preset !== this.currentConfig.quota?.preset) {
      changed.push('quota.preset');
    }

    return changed;
  }

  /** Resolve the roles.json path from config */
  private resolveRolesFile(): string | null {
    const rolesFile = this.currentConfig.agent.roleDefinitionsFile;
    if (!rolesFile) return null;
    // Resolve relative to config.json directory
    const configDir = path.dirname(this.configPath);
    return path.resolve(configDir, rolesFile);
  }

  /** Handle roles.json file change (debounced) */
  private handleRolesFileChange(): void {
    if (this.rolesDebounceTimer) {
      clearTimeout(this.rolesDebounceTimer);
    }

    this.rolesDebounceTimer = setTimeout(async () => {
      this.rolesDebounceTimer = null;
      await this.reloadRoles();
    }, this.debounceMs);
  }

  /** Re-read roles.json and regenerate copilot-instructions.md if content changed */
  private async reloadRoles(): Promise<void> {
    if (!this.rolesFilePath) return;

    try {
      const raw = await readFile(this.rolesFilePath, 'utf-8');
      const newHash = this.simpleHash(raw);

      // Skip if content hasn't actually changed (mtime-only updates)
      if (newHash === this.lastRolesHash) {
        this.logger.debug('Roles file touched but content unchanged');
        return;
      }
      this.lastRolesHash = newHash;

      // Validate it's parseable JSON
      JSON.parse(raw);

      this.logger.info('Roles file changed -- regenerating copilot-instructions.md');

      // Dynamically import to avoid circular deps
      const { generateCopilotInstructions } = await import('./generate-instructions.js');
      const workspaceRoot = path.resolve(this.currentConfig.workspace.path);
      await generateCopilotInstructions(this.currentConfig, workspaceRoot);

      this.logger.info('Copilot instructions regenerated from updated roles.json');
    } catch (error) {
      this.logger.error(
        { err: error },
        'Failed to regenerate instructions from roles.json (keeping current instructions)'
      );
    }
  }

  /** Simple hash for content comparison (not cryptographic) */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0; // Convert to 32-bit integer
    }
    return hash.toString(36);
  }
}
