// Tests for a2a-audit-logger.ts - Audit log persistence and querying

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { A2AAuditLogger } from '../a2a-audit-logger.js';
import type { A2AAuditRawEntry } from '../a2a-audit-logger.js';
import { createMockLogger } from './test-helpers.js';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

describe('A2AAuditLogger', () => {
  let testDir: string;
  let auditDir: string;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'a2a-audit-test-'));
    auditDir = path.join(testDir, 'audit', 'a2a');
    logger = createMockLogger();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeEntry(overrides?: Partial<A2AAuditRawEntry>): A2AAuditRawEntry {
    return {
      direction: 'outbound',
      remoteAgent: 'remote-host_qa',
      method: 'sendMessage',
      request: { text: 'hello' },
      response: { id: 'task-1' },
      durationMs: 100,
      status: 'success',
      ...overrides,
    };
  }

  describe('initialize', () => {
    it('should create the audit directory', async () => {
      const al = new A2AAuditLogger(auditDir, 'test_agent', logger);
      await al.initialize();

      const stat = await fs.stat(auditDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('logEntry', () => {
    it('should append a JSONL entry to the log file', async () => {
      const al = new A2AAuditLogger(auditDir, 'test_agent', logger);
      await al.initialize();

      const id = await al.logEntry(makeEntry());
      expect(id).toBeTruthy();

      const logFile = path.join(auditDir, 'test_agent-audit.jsonl');
      const content = await fs.readFile(logFile, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(1);

      const parsed = JSON.parse(lines[0]);
      expect(parsed.id).toBe(id);
      expect(parsed.agentId).toBe('test_agent');
      expect(parsed.direction).toBe('outbound');
      expect(parsed.remoteAgent).toBe('remote-host_qa');
    });

    it('should append multiple entries', async () => {
      const al = new A2AAuditLogger(auditDir, 'test_agent', logger);
      await al.initialize();

      await al.logEntry(makeEntry());
      await al.logEntry(makeEntry({ direction: 'inbound', remoteAgent: 'other_dev' }));
      await al.logEntry(makeEntry({ status: 'error', error: 'timeout' }));

      const logFile = path.join(auditDir, 'test_agent-audit.jsonl');
      const content = await fs.readFile(logFile, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(3);
    });

    it('should skip entry when not initialized', async () => {
      const al = new A2AAuditLogger(auditDir, 'test_agent', logger);
      // Do not call initialize()
      const id = await al.logEntry(makeEntry());
      expect(id).toBe('');
    });
  });

  describe('queryEntries', () => {
    it('should return all entries when no filter', async () => {
      const al = new A2AAuditLogger(auditDir, 'test_agent', logger);
      await al.initialize();

      await al.logEntry(makeEntry());
      await al.logEntry(makeEntry({ direction: 'inbound' }));

      const entries = await al.queryEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0].protocol).toBe('a2a');
    });

    it('should return empty array when log file does not exist', async () => {
      const al = new A2AAuditLogger(auditDir, 'no_such_agent', logger);
      await al.initialize();

      const entries = await al.queryEntries();
      expect(entries).toEqual([]);
    });

    it('should filter by direction', async () => {
      const al = new A2AAuditLogger(auditDir, 'test_agent', logger);
      await al.initialize();

      await al.logEntry(makeEntry({ direction: 'outbound' }));
      await al.logEntry(makeEntry({ direction: 'inbound' }));
      await al.logEntry(makeEntry({ direction: 'outbound' }));

      const entries = await al.queryEntries({ direction: 'inbound' });
      expect(entries).toHaveLength(1);
    });

    it('should filter by remoteAgent', async () => {
      const al = new A2AAuditLogger(auditDir, 'test_agent', logger);
      await al.initialize();

      await al.logEntry(makeEntry({ remoteAgent: 'agent-a' }));
      await al.logEntry(makeEntry({ remoteAgent: 'agent-b' }));

      const entries = await al.queryEntries({ remoteAgent: 'agent-a' });
      expect(entries).toHaveLength(1);
    });

    it('should filter by time range', async () => {
      const al = new A2AAuditLogger(auditDir, 'test_agent', logger);
      await al.initialize();

      await al.logEntry(makeEntry());
      // Small delay to ensure different timestamps
      await new Promise(r => setTimeout(r, 50));
      const afterTs = new Date().toISOString();
      await al.logEntry(makeEntry({ remoteAgent: 'later-agent' }));

      const entries = await al.queryEntries({ after: afterTs });
      expect(entries.length).toBeGreaterThanOrEqual(1);
    });

    it('should respect limit', async () => {
      const al = new A2AAuditLogger(auditDir, 'test_agent', logger);
      await al.initialize();

      await al.logEntry(makeEntry());
      await al.logEntry(makeEntry());
      await al.logEntry(makeEntry());

      const entries = await al.queryEntries({ limit: 2 });
      expect(entries).toHaveLength(2);
    });
  });

  describe('sanitization', () => {
    it('should handle very large request payloads', async () => {
      const al = new A2AAuditLogger(auditDir, 'test_agent', logger);
      await al.initialize();

      const largePayload = 'x'.repeat(60000);
      await al.logEntry(makeEntry({ request: largePayload }));

      const logFile = path.join(auditDir, 'test_agent-audit.jsonl');
      const content = await fs.readFile(logFile, 'utf-8');
      const parsed = JSON.parse(content.trim());
      // Should be truncated
      expect((parsed.request as string).length).toBeLessThan(60000);
      expect(parsed.request).toContain('[truncated]');
    });
  });
});
