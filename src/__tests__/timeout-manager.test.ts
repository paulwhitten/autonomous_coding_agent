// Tests for timeout-manager.ts

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { TimeoutManager, TimeoutEvent } from '../timeout-manager.js';
import { WorkItem } from '../workspace-manager.js';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

describe('TimeoutManager', () => {
  let testDir: string;
  let manager: TimeoutManager;
  const BASE_TIMEOUT = 120000;

  const makeWorkItem = (title: string, sequence: number): WorkItem => ({
    filename: `001_${String(sequence).padStart(3, '0')}_${title.toLowerCase().replace(/\s/g, '_')}.md`,
    sequence,
    title,
    content: `Content for ${title}`,
    fullPath: `/tmp/${title}`,
  });

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'timeout-manager-test-'));
    manager = new TimeoutManager(testDir, BASE_TIMEOUT);
    await manager.initialize();
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('constructor and initialize', () => {
    it('should initialize with empty events', async () => {
      const metrics = manager.getMetrics();
      expect(metrics.total_events).toBe(0);
    });

    it('should load existing events from file on initialize', async () => {
      const event: TimeoutEvent = {
        workItem: 'test task',
        sequence: 1,
        attempt: 0,
        timeout: BASE_TIMEOUT,
        strategy: 'direct' as any,
        result: 'timeout',
        timestamp: Date.now(),
      };
      await manager.recordTimeout(event);

      // Create a new manager and initialize it
      const manager2 = new TimeoutManager(testDir, BASE_TIMEOUT);
      await manager2.initialize();

      const metrics = manager2.getMetrics();
      expect(metrics.total_events).toBe(1);
    });

    it('should start fresh when no events file exists', async () => {
      const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fresh-timeout-'));
      try {
        const freshManager = new TimeoutManager(emptyDir, BASE_TIMEOUT);
        await freshManager.initialize(); // file doesn't exist yet
        expect(freshManager.getMetrics().total_events).toBe(0);
      } finally {
        await fs.rm(emptyDir, { recursive: true, force: true });
      }
    });
  });

  describe('getRecommendedStrategy - disabled config', () => {
    it('should return retry_extended with base timeout when disabled', () => {
      const disabledManager = new TimeoutManager(testDir, BASE_TIMEOUT, { enabled: false });
      const workItem = makeWorkItem('test task', 1);

      const result = disabledManager.getRecommendedStrategy(workItem);

      expect(result.strategy).toBe('retry_extended');
      expect(result.timeout).toBe(BASE_TIMEOUT);
      expect(result.reason).toContain('disabled');
    });
  });

  describe('getRecommendedStrategy - tier escalation', () => {
    it('should return base timeout on first attempt (no history)', () => {
      const workItem = makeWorkItem('new task', 99);
      const result = manager.getRecommendedStrategy(workItem);

      expect(result.strategy).toBe('retry_extended');
      expect(result.timeout).toBe(BASE_TIMEOUT);
    });

    it('should return extended timeout on second attempt (tier 1)', async () => {
      const workItem = makeWorkItem('stuck task', 1);

      // Record one timeout event
      await manager.recordTimeout({
        workItem: workItem.title,
        sequence: workItem.sequence,
        attempt: 0,
        timeout: BASE_TIMEOUT,
        strategy: 'direct' as any,
        result: 'timeout',
        timestamp: Date.now(),
      });

      const result = manager.getRecommendedStrategy(workItem);

      expect(result.strategy).toBe('retry_extended');
      expect(result.timeout).toBeGreaterThan(BASE_TIMEOUT);
    });

    it('should recommend background strategy after 2 timeouts (tier 2)', async () => {
      const workItem = makeWorkItem('bg task', 2);

      // Record two timeout events
      for (let i = 0; i < 2; i++) {
        await manager.recordTimeout({
          workItem: workItem.title,
          sequence: workItem.sequence,
          attempt: i,
          timeout: BASE_TIMEOUT,
          strategy: 'direct' as any,
          result: 'timeout',
          timestamp: Date.now(),
        });
      }

      const result = manager.getRecommendedStrategy(workItem);

      expect(result.strategy).toBe('background');
    });

    it('should recommend decompose strategy after 3+ timeouts (tier 3)', async () => {
      const workItem = makeWorkItem('complex task', 3);

      // Record three timeout events
      for (let i = 0; i < 3; i++) {
        await manager.recordTimeout({
          workItem: workItem.title,
          sequence: workItem.sequence,
          attempt: i,
          timeout: BASE_TIMEOUT,
          strategy: 'direct' as any,
          result: 'timeout',
          timestamp: Date.now(),
        });
      }

      const result = manager.getRecommendedStrategy(workItem);

      expect(result.strategy).toBe('decompose');
    });
  });

  describe('recordSuccess', () => {
    it('should record success event', async () => {
      const workItem = makeWorkItem('success task', 5);
      await manager.recordSuccess(workItem, 'direct', 5000);

      const metrics = manager.getMetrics();
      expect(metrics.total_events).toBe(1);
      expect(metrics.successes).toBe(1);
    });
  });

  describe('analyzePatterns', () => {
    it('should return ok recommendation with no events', () => {
      const pattern = manager.analyzePatterns();
      expect(pattern.recommendation).toBe('ok');
      expect(pattern.totalTimeouts).toBe(0);
    });

    it('should count recent timeouts', async () => {
      const workItem = makeWorkItem('pattern task', 7);

      for (let i = 0; i < 3; i++) {
        await manager.recordTimeout({
          workItem: workItem.title,
          sequence: workItem.sequence,
          attempt: i,
          timeout: BASE_TIMEOUT,
          strategy: 'direct' as any,
          result: 'timeout',
          timestamp: Date.now(),
        });
      }

      const pattern = manager.analyzePatterns();
      expect(pattern.recentTimeouts).toBe(3);
    });

    it('should recommend increase_baseline when all timeouts are on first attempt', async () => {
      // Need >= tier4_adaptiveThreshold (5) recent timeouts all on attempt 1
      for (let i = 0; i < 5; i++) {
        await manager.recordTimeout({
          workItem: `task_${i}`,
          sequence: i,
          attempt: 1,
          timeout: BASE_TIMEOUT,
          strategy: 'direct' as any,
          result: 'timeout',
          timestamp: Date.now(),
        });
      }

      const pattern = manager.analyzePatterns();
      expect(pattern.recommendation).toBe('increase_baseline');
    });

    it('should recommend decompose when many timeouts with varied attempts', async () => {
      for (let i = 0; i < 5; i++) {
        await manager.recordTimeout({
          workItem: `task_${i}`,
          sequence: i,
          attempt: i + 1, // varied attempts
          timeout: BASE_TIMEOUT,
          strategy: 'direct' as any,
          result: 'timeout',
          timestamp: Date.now(),
        });
      }

      const pattern = manager.analyzePatterns();
      expect(pattern.recommendation).toBe('decompose');
    });

    it('should identify successful strategy', async () => {
      await manager.recordSuccess(makeWorkItem('success task', 10), 'direct', 1000);

      const pattern = manager.analyzePatterns();
      expect(pattern.successfulStrategy).toBe('direct');
    });
  });

  describe('getMetrics', () => {
    it('should track timeouts and successes separately', async () => {
      const workItem = makeWorkItem('metrics task', 8);

      await manager.recordTimeout({
        workItem: workItem.title,
        sequence: workItem.sequence,
        attempt: 0,
        timeout: BASE_TIMEOUT,
        strategy: 'direct' as any,
        result: 'timeout',
        timestamp: Date.now(),
      });

      await manager.recordSuccess(workItem, 'extended', 3000);

      const metrics = manager.getMetrics();
      expect(metrics.total_events).toBe(2);
      expect(metrics.timeouts).toBe(1);
      expect(metrics.successes).toBe(1);
    });
  });

  describe('updateTimeout', () => {
    it('should update the base timeout', () => {
      manager.updateTimeout(60000);
      // No direct getter, but should not throw
      const workItem = makeWorkItem('updated task', 20);
      const result = manager.getRecommendedStrategy(workItem);
      // New timeout should apply to first attempt
      expect(result.timeout).toBe(60000);
    });

    it('should ignore invalid timeout values', () => {
      manager.updateTimeout(0);
      const workItem = makeWorkItem('invalid task', 21);
      const result = manager.getRecommendedStrategy(workItem);
      // Should still use original base timeout
      expect(result.timeout).toBe(BASE_TIMEOUT);
    });
  });
});
