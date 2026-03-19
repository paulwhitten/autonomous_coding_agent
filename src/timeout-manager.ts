// Timeout management with adaptive strategies
import { writeFile, readFile, mkdir } from 'fs/promises';
import path from 'path';
import { WorkItem } from './workspace-manager.js';
import type pino from 'pino';
import { createComponentLogger, logger as defaultLogger, logError } from './logger.js';

export interface TimeoutEvent {
  workItem: string;
  sequence: number;
  attempt: number;
  timeout: number;
  strategy: 'direct' | 'extended' | 'background' | 'decomposed';
  result: 'success' | 'timeout' | 'error';
  timestamp: number;
  duration?: number;
  category?: string;
}

export interface TimeoutPattern {
  totalTimeouts: number;
  recentTimeouts: number;
  byStrategy: Record<string, number>;
  byCategory: Record<string, number>;
  successfulStrategy?: string;
  recommendation: 'increase_baseline' | 'category_timeout' | 'decompose' | 'ok';
}

export type TimeoutStrategy = 'retry_extended' | 'background' | 'decompose' | 'escalate';

export interface TimeoutConfig {
  enabled: boolean;
  tier1_multiplier: number;
  tier2_backgroundThreshold: number;
  tier3_decomposeThreshold: number;
  tier4_adaptiveWindow: number;
  tier4_adaptiveThreshold: number;
}

/**
 * Manages SDK timeout tracking and adaptive strategy selection
 */
export class TimeoutManager {
  private events: TimeoutEvent[] = [];
  private workspacePath: string;
  private eventsFile: string;
  private config: TimeoutConfig;
  private baseTimeout: number;
  private logger: pino.Logger;
  
  constructor(workspacePath: string, baseTimeout: number, config?: Partial<TimeoutConfig>) {
    this.workspacePath = workspacePath;
    this.eventsFile = path.join(workspacePath, 'timeout_events.json');
    this.baseTimeout = baseTimeout;
    this.config = {
      enabled: true,
      tier1_multiplier: 1.5,
      tier2_backgroundThreshold: 2,
      tier3_decomposeThreshold: 3,
      tier4_adaptiveWindow: 3600000,
      tier4_adaptiveThreshold: 5,
      ...config
    };
    
    this.logger = createComponentLogger(defaultLogger, 'timeout-manager');
  }
  
  /** Update the base timeout at runtime (from config hot-reload) */
  updateTimeout(newBaseTimeout: number): void {
    if (newBaseTimeout > 0 && newBaseTimeout !== this.baseTimeout) {
      this.logger.info(
        { oldTimeout: this.baseTimeout, newTimeout: newBaseTimeout },
        'Base timeout updated via config hot-reload'
      );
      this.baseTimeout = newBaseTimeout;
    }
  }

  async initialize(): Promise<void> {
    try {
      const data = await readFile(this.eventsFile, 'utf-8');
      this.events = JSON.parse(data);
    } catch (err) {
      // File doesn't exist yet, start fresh
      this.events = [];
    }
  }
  
  async recordTimeout(event: TimeoutEvent): Promise<void> {
    this.events.push(event);
    await this.save();
  }
  
  async recordSuccess(workItem: WorkItem, strategy: string, duration: number): Promise<void> {
    const event: TimeoutEvent = {
      workItem: workItem.title,
      sequence: workItem.sequence,
      attempt: this.getAttemptCount(workItem),
      timeout: this.baseTimeout,
      strategy: strategy as any,
      result: 'success',
      timestamp: Date.now(),
      duration
    };
    
    this.events.push(event);
    await this.save();
  }
  
  /**
   * Get recommended timeout strategy for a work item
   */
  getRecommendedStrategy(workItem: WorkItem): {
    strategy: TimeoutStrategy;
    timeout: number;
    reason: string;
  } {
    if (!this.config.enabled) {
      return {
        strategy: 'retry_extended',
        timeout: this.baseTimeout,
        reason: 'Adaptive timeout disabled'
      };
    }
    
    const attemptCount = this.getAttemptCount(workItem);
    const history = this.getWorkItemHistory(workItem);
    
    // First attempt - use base timeout
    if (attemptCount === 0) {
      return {
        strategy: 'retry_extended',
        timeout: this.baseTimeout,
        reason: `First attempt with base timeout (${this.baseTimeout / 1000}s)`
      };
    }
    
    // Tier 1: First timeout - retry with extended timeout
    if (attemptCount === 1) {
      const extendedTimeout = this.baseTimeout * this.config.tier1_multiplier;
      
      return {
        strategy: 'retry_extended',
        timeout: extendedTimeout,
        reason: `First timeout - retrying with ${extendedTimeout / 1000}s (${this.config.tier1_multiplier}x base)`
      };
    }
    
    // Tier 2: Second timeout - switch to background process
    if (attemptCount === this.config.tier2_backgroundThreshold) {
      const extendedTimeout = this.baseTimeout * this.config.tier1_multiplier;
      
      return {
        strategy: 'background',
        timeout: extendedTimeout,
        reason: `Two timeouts - background pattern with ${extendedTimeout / 1000}s (${this.config.tier1_multiplier}x base)`
      };
    }
    
    // Tier 3: Third+ timeout - decompose further
    if (attemptCount >= this.config.tier3_decomposeThreshold) {
      const extendedTimeout = this.baseTimeout * this.config.tier1_multiplier;
      
      return {
        strategy: 'decompose',
        timeout: extendedTimeout,
        reason: `Multiple timeouts - decompose needed (keeping ${extendedTimeout / 1000}s timeout)`
      };
    }
    
    // Check if we have pattern data suggesting a better approach
    const pattern = this.analyzePatterns();
    if (pattern.recommendation === 'category_timeout' && history.category) {
      const categoryTimeout = this.getCategoryTimeout(history.category);
      return {
        strategy: 'retry_extended',
        timeout: categoryTimeout,
        reason: `Category '${history.category}' typically needs ${categoryTimeout / 1000}s`
      };
    }
    
    return {
      strategy: 'retry_extended',
      timeout: this.baseTimeout,
      reason: 'Default retry strategy'
    };
  }
  
  /**
   * Analyze timeout patterns to detect systemic issues
   */
  analyzePatterns(): TimeoutPattern {
    const now = Date.now();
    const windowStart = now - this.config.tier4_adaptiveWindow;
    
    const recentEvents = this.events.filter(e => e.timestamp >= windowStart);
    const recentTimeouts = recentEvents.filter(e => e.result === 'timeout');
    
    const byStrategy: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    
    recentEvents.forEach(event => {
      byStrategy[event.strategy] = (byStrategy[event.strategy] || 0) + 1;
      if (event.category) {
        byCategory[event.category] = (byCategory[event.category] || 0) + 1;
      }
    });
    
    // Determine recommendation
    let recommendation: TimeoutPattern['recommendation'] = 'ok';
    
    if (recentTimeouts.length >= this.config.tier4_adaptiveThreshold) {
      // Check if all timeouts are in same category
      const timeoutCategories = recentTimeouts
        .filter(e => e.category)
        .map(e => e.category!);
      
      const uniqueCategories = new Set(timeoutCategories);
      
      if (uniqueCategories.size === 1 && timeoutCategories.length >= 3) {
        recommendation = 'category_timeout';
      } else if (recentTimeouts.every(e => e.attempt === 1)) {
        recommendation = 'increase_baseline';
      } else {
        recommendation = 'decompose';
      }
    }
    
    // Find most successful strategy
    const successfulStrategies = recentEvents
      .filter(e => e.result === 'success')
      .map(e => e.strategy);
    
    const strategyCounts = successfulStrategies.reduce((acc, s) => {
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    const successfulStrategy = Object.entries(strategyCounts)
      .sort((a, b) => b[1] - a[1])[0]?.[0];
    
    return {
      totalTimeouts: this.events.filter(e => e.result === 'timeout').length,
      recentTimeouts: recentTimeouts.length,
      byStrategy,
      byCategory,
      successfulStrategy,
      recommendation
    };
  }
  
  /**
   * Get timeout statistics and metrics
   */
  getMetrics(): {
    total_events: number;
    timeouts: number;
    successes: number;
    tier1_successes: number;
    tier2_successes: number;
    tier3_successes: number;
    avg_resolution_attempts: number;
  } {
    const timeouts = this.events.filter(e => e.result === 'timeout');
    const successes = this.events.filter(e => e.result === 'success');
    
    const tier1 = successes.filter(e => e.strategy === 'extended');
    const tier2 = successes.filter(e => e.strategy === 'background');
    const tier3 = successes.filter(e => e.strategy === 'decomposed');
    
    // Calculate average attempts to success
    const workItemAttempts = new Map<string, number>();
    this.events.forEach(e => {
      const current = workItemAttempts.get(e.workItem) || 0;
      if (e.attempt > current) {
        workItemAttempts.set(e.workItem, e.attempt);
      }
    });
    
    const avgAttempts = workItemAttempts.size > 0
      ? Array.from(workItemAttempts.values()).reduce((a, b) => a + b, 0) / workItemAttempts.size
      : 0;
    
    return {
      total_events: this.events.length,
      timeouts: timeouts.length,
      successes: successes.length,
      tier1_successes: tier1.length,
      tier2_successes: tier2.length,
      tier3_successes: tier3.length,
      avg_resolution_attempts: Math.round(avgAttempts * 10) / 10
    };
  }
  
  private getAttemptCount(workItem: WorkItem): number {
    const history = this.events.filter(
      e => e.sequence === workItem.sequence || e.workItem === workItem.title
    );
    return history.length;  // 0 = first attempt, 1 = second attempt (after 1 timeout), etc.
  }
  
  private getWorkItemHistory(workItem: WorkItem): {
    attempts: number;
    timeouts: number;
    category?: string;
  } {
    const events = this.events.filter(
      e => e.sequence === workItem.sequence || e.workItem === workItem.title
    );
    
    return {
      attempts: events.length,
      timeouts: events.filter(e => e.result === 'timeout').length,
      category: events[0]?.category
    };
  }
  
  private getCategoryTimeout(category: string): number {
    const categoryEvents = this.events.filter(
      e => e.category === category && e.result === 'success' && e.duration
    );
    
    if (categoryEvents.length === 0) {
      return this.baseTimeout * 2;
    }
    
    // Use 95th percentile of successful durations
    const durations = categoryEvents.map(e => e.duration!).sort((a, b) => a - b);
    const p95Index = Math.floor(durations.length * 0.95);
    const p95Duration = durations[p95Index];
    
    // Add 20% buffer
    return Math.ceil(p95Duration * 1.2);
  }
  
  private async save(): Promise<void> {
    try {
      await writeFile(this.eventsFile, JSON.stringify(this.events, null, 2), 'utf-8');
    } catch (err) {
      logError(this.logger, err as Error, 'Failed to save timeout events');
    }
  }
}
