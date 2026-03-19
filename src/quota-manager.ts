// Quota management system with presets and per-task enforcement

import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { AgentConfig } from './types.js';
import type pino from 'pino';
import { createComponentLogger, logger as defaultLogger } from './logger.js';

interface QuotaPreset {
  description: string;
  limits: {
    monthly?: number;
    daily?: number;
    perTask?: number;
  };
  modelFallback?: {
    enabled: boolean;
    primary: string;
    fallback: string;
    switchAt: number;
  };
  priorityRules?: {
    [key: string]: {
      alwaysUsePrimary?: boolean;
      bypassDailyLimit?: boolean;
      useFallbackAfter?: number;
      skipIfDailyLimitReached?: boolean;
    };
  };
  behavior?: {
    onWarning?: string;
    onDailyLimit?: string;
    onMonthlyLimit?: string;
    pauseDuration?: number;
    pauseUntilNextDay?: boolean;
  };
  tracking?: {
    warningThresholds?: number[];
  };
}

interface QuotaState {
  month: string;
  used: {
    monthly: number;
    today: number;
    byModel: Record<string, number>;
    byPriority: Record<string, number>;
  };
  lastReset: string;
  todayDate: string;
  warnings: string[];
}

interface ModelMultipliers {
  models: Record<string, number>;
}

export class QuotaManager {
  private config: AgentConfig;
  private preset: QuotaPreset;
  private state: QuotaState;
  private stateFile: string;
  private logger: pino.Logger;
  private modelMultipliers: Record<string, number>;
  
  constructor(config: AgentConfig, logger?: pino.Logger) {
    this.config = config;
    this.logger = logger || createComponentLogger(defaultLogger, 'quota-manager');
    this.stateFile = path.resolve(config.workspace.path, 'quota_state.json');
    this.preset = {} as QuotaPreset;
    this.modelMultipliers = {};
    
    // Initialize default state
    this.state = this.createDefaultState();
  }
  
  /**
   * Initialize quota manager - load preset and state
   */
  async initialize(): Promise<void> {
    if (!this.config.quota?.enabled) {
      this.logger.info('Quota management disabled');
      return;
    }
    
    // Load preset
    await this.loadPreset();
    
    // Load model multipliers
    await this.loadModelMultipliers();
    
    // Load or create state
    await this.loadState();
    
    this.logger.info({
      preset: this.config.quota.preset,
      monthlyLimit: this.preset.limits.monthly,
      dailyLimit: this.preset.limits.daily,
      used: this.state.used
    }, 'Quota manager initialized');
  }
  
  /**
   * Load quota preset from file
   */
  private async loadPreset(): Promise<void> {
    const presetsFile = path.resolve(
      this.config.quota?.presetsFile || './quota-presets.json'
    );
    
    const content = await readFile(presetsFile, 'utf-8');
    const presets = JSON.parse(content);
    
    const presetName = this.config.quota?.preset || 'conservative';
    this.preset = presets.presets[presetName];
    
    if (!this.preset) {
      throw new Error(`Quota preset '${presetName}' not found`);
    }
    
    // Apply overrides
    if (this.config.quota?.overrides) {
      this.preset = this.mergeDeep(this.preset, this.config.quota.overrides);
    }
  }
  
  /**
   * Load model multipliers
   */
  private async loadModelMultipliers(): Promise<void> {
    const presetsFile = path.resolve(
      this.config.quota?.presetsFile || './quota-presets.json'
    );
    
    const content = await readFile(presetsFile, 'utf-8');
    const data: { modelMultipliers: ModelMultipliers } = JSON.parse(content);
    
    this.modelMultipliers = data.modelMultipliers.models;
  }
  
  /**
   * Create default quota state
   */
  private createDefaultState(): QuotaState {
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const today = now.toISOString().split('T')[0];
    
    return {
      month,
      used: {
        monthly: 0,
        today: 0,
        byModel: {},
        byPriority: {}
      },
      lastReset: now.toISOString(),
      todayDate: today,
      warnings: []
    };
  }
  
  /**
   * Load state from file or create new
   */
  private async loadState(): Promise<void> {
    try {
      const content = await readFile(this.stateFile, 'utf-8');
      const savedState = JSON.parse(content);
      
      // Check if month or day has changed
      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const today = now.toISOString().split('T')[0];
      
      if (savedState.month !== currentMonth) {
        // New month - reset
        this.logger.info('New month detected, resetting quota');
        this.state = this.createDefaultState();
      } else if (savedState.todayDate !== today) {
        // New day - reset daily counter
        this.logger.info('New day detected, resetting daily quota');
        savedState.used.today = 0;
        savedState.todayDate = today;
        this.state = savedState;
      } else {
        this.state = savedState;
      }
    } catch (error) {
      // File doesn't exist, use default
      this.state = this.createDefaultState();
    }
  }
  
  /**
   * Save state to file
   */
  private async saveState(): Promise<void> {
    await writeFile(this.stateFile, JSON.stringify(this.state, null, 2), 'utf-8');
  }
  
  /**
   * Check if can process task and select model
   */
  async checkQuotaAndSelectModel(
    priority: 'HIGH' | 'NORMAL' | 'LOW' = 'NORMAL'
  ): Promise<{
    canProcess: boolean;
    model: string;
    reason?: string;
  }> {
    if (!this.config.quota?.enabled) {
      return {
        canProcess: true,
        model: this.config.copilot.model
      };
    }
    
    // Check monthly limit
    if (this.preset.limits.monthly) {
      if (this.state.used.monthly >= this.preset.limits.monthly) {
        return await this.handleMonthlyLimitReached(priority);
      }
    }
    
    // Check daily limit
    if (this.preset.limits.daily) {
      if (this.state.used.today >= this.preset.limits.daily) {
        return await this.handleDailyLimitReached(priority);
      }
    }
    
    // Select model based on quota usage
    const model = await this.selectModel(priority);
    
    // Check for warnings
    await this.checkWarnings();
    
    return {
      canProcess: true,
      model
    };
  }
  
  /**
   * Select model based on quota usage and priority
   */
  private async selectModel(priority: 'HIGH' | 'NORMAL' | 'LOW'): Promise<string> {
    const fallback = this.preset.modelFallback;
    
    if (!fallback?.enabled) {
      return this.config.copilot.model;
    }
    
    // Check priority rules
    const priorityRule = this.preset.priorityRules?.[priority];
    if (priorityRule?.alwaysUsePrimary) {
      return fallback.primary;
    }
    
    // Calculate quota usage percentage
    const monthlyUsage = this.preset.limits.monthly 
      ? this.state.used.monthly / this.preset.limits.monthly
      : 0;
    
    // Determine fallback threshold for this priority
    let fallbackThreshold = fallback.switchAt;
    if (priorityRule?.useFallbackAfter !== undefined) {
      fallbackThreshold = priorityRule.useFallbackAfter;
    }
    
    // Switch to fallback model if past threshold
    if (monthlyUsage >= fallbackThreshold) {
      this.logger.info(`Switching to fallback model (${Math.round(monthlyUsage * 100)}% quota used)`);
      return fallback.fallback;
    }
    
    return fallback.primary;
  }
  
  /**
   * Handle monthly limit reached
   */
  private async handleMonthlyLimitReached(
    priority: 'HIGH' | 'NORMAL' | 'LOW'
  ): Promise<{ canProcess: boolean; model: string; reason: string }> {
    const behavior = this.preset.behavior?.onMonthlyLimit || 'pause';
    
    this.logger.warn({
      used: this.state.used.monthly,
      limit: this.preset.limits.monthly
    }, 'Monthly quota limit reached');
    
    if (behavior === 'fallback' && this.preset.modelFallback?.enabled) {
      // Use fallback model
      return {
        canProcess: true,
        model: this.preset.modelFallback.fallback,
        reason: 'Monthly limit reached, using fallback model'
      };
    }
    
    if (behavior === 'warn') {
      // Just warn, continue
      return {
        canProcess: true,
        model: this.config.copilot.model,
        reason: 'Monthly limit reached but continuing'
      };
    }
    
    // Default: pause/stop
    return {
      canProcess: false,
      model: this.config.copilot.model,
      reason: 'Monthly quota limit reached'
    };
  }
  
  /**
   * Handle daily limit reached
   */
  private async handleDailyLimitReached(
    priority: 'HIGH' | 'NORMAL' | 'LOW'
  ): Promise<{ canProcess: boolean; model: string; reason: string }> {
    // Check if priority bypasses daily limit
    const priorityRule = this.preset.priorityRules?.[priority];
    if (priorityRule?.bypassDailyLimit) {
      this.logger.info(`${priority} priority task bypassing daily limit`);
      return {
        canProcess: true,
        model: this.config.copilot.model,
        reason: 'High priority bypasses daily limit'
      };
    }
    
    // Check if should skip LOW priority tasks
    if (priority === 'LOW' && priorityRule?.skipIfDailyLimitReached) {
      this.logger.info('Skipping LOW priority task (daily limit reached)');
      return {
        canProcess: false,
        model: this.config.copilot.model,
        reason: 'Daily limit reached, skipping LOW priority'
      };
    }
    
    const behavior = this.preset.behavior?.onDailyLimit || 'pause';
    
    this.logger.warn({
      used: this.state.used.today,
      limit: this.preset.limits.daily
    }, 'Daily quota limit reached');
    
    if (behavior === 'warn') {
      return {
        canProcess: true,
        model: this.config.copilot.model,
        reason: 'Daily limit reached but continuing'
      };
    }
    
    // Default: pause
    return {
      canProcess: false,
      model: this.config.copilot.model,
      reason: 'Daily quota limit reached'
    };
  }
  
  /**
   * Check warning thresholds
   */
  private async checkWarnings(): Promise<void> {
    const thresholds = this.preset.tracking?.warningThresholds || [];
    const monthlyLimit = this.preset.limits.monthly;
    
    if (!monthlyLimit) return;
    
    const usage = this.state.used.monthly / monthlyLimit;
    
    for (const threshold of thresholds) {
      const warningKey = `${threshold * 100}%`;
      const warningMessage = `${warningKey} quota reached`;
      
      if (usage >= threshold && !this.state.warnings.includes(warningMessage)) {
        this.logger.warn({
          used: this.state.used.monthly,
          limit: monthlyLimit
        }, warningMessage);
        
        this.state.warnings.push(warningMessage);
        await this.saveState();
      }
    }
  }
  
  /**
   * Record task completion
   */
  async recordTaskCompletion(
    model: string,
    priority: 'HIGH' | 'NORMAL' | 'LOW' = 'NORMAL'
  ): Promise<void> {
    if (!this.config.quota?.enabled) return;
    
    // Get model multiplier (default 1 if unknown)
    const multiplier = this.modelMultipliers[model] ?? 1;
    const requests = 1 * multiplier;
    
    // Update counters
    this.state.used.monthly += requests;
    this.state.used.today += requests;
    this.state.used.byModel[model] = (this.state.used.byModel[model] || 0) + requests;
    this.state.used.byPriority[priority] = (this.state.used.byPriority[priority] || 0) + requests;
    
    this.logger.info({
      model,
      multiplier,
      requests,
      totalMonthly: this.state.used.monthly,
      totalToday: this.state.used.today
    }, 'Quota usage recorded');
    
    await this.saveState();
  }
  
  /**
   * Get current usage summary
   */
  getUsageSummary(): {
    monthly: { used: number; limit?: number; percentage: number };
    daily: { used: number; limit?: number; percentage: number };
    byModel: Record<string, number>;
    byPriority: Record<string, number>;
  } {
    const limits = this.preset?.limits;
    return {
      monthly: {
        used: this.state.used.monthly,
        limit: limits?.monthly,
        percentage: limits?.monthly 
          ? this.state.used.monthly / limits.monthly
          : 0
      },
      daily: {
        used: this.state.used.today,
        limit: limits?.daily,
        percentage: limits?.daily
          ? this.state.used.today / limits.daily
          : 0
      },
      byModel: this.state.used.byModel,
      byPriority: this.state.used.byPriority
    };
  }
  
  /**
   * Deep merge objects
   */
  private mergeDeep(target: any, source: any): any {
    const output = { ...target };
    
    for (const key in source) {
      if (source[key] instanceof Object && key in target) {
        output[key] = this.mergeDeep(target[key], source[key]);
      } else {
        output[key] = source[key];
      }
    }
    
    return output;
  }
}
