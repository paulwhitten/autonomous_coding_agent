// Tests for git-mailbox-backend.ts - Backend wrapper for MailboxManager

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { GitMailboxBackend } from '../backends/git-mailbox-backend.js';
import { createMockLogger } from './test-helpers.js';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import type pino from 'pino';

describe('GitMailboxBackend', () => {
  let testDir: string;
  let logger: pino.Logger;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-backend-test-'));
    logger = createMockLogger();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  function createBackend(overrides?: Record<string, unknown>) {
    return new GitMailboxBackend(
      {
        repoPath: testDir,
        hostname: 'test-host',
        role: 'developer',
        gitSync: false,
        autoCommit: false,
        commitMessage: 'test',
        supportBroadcast: false,
        supportAttachments: false,
        supportPriority: true,
        managerHostname: 'mgr-host',
        ...overrides,
      },
      logger,
    );
  }

  describe('lifecycle', () => {
    it('should have name "mailbox"', () => {
      const backend = createBackend();
      expect(backend.name).toBe('mailbox');
    });

    it('should initialize and create mailbox directories', async () => {
      const backend = createBackend();
      await backend.initialize();

      const mailboxPath = path.join(testDir, 'mailbox', 'to_test-host_developer');
      const stat = await fs.stat(mailboxPath);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should shutdown without error', async () => {
      const backend = createBackend();
      await backend.initialize();
      await expect(backend.shutdown()).resolves.toBeUndefined();
    });
  });

  describe('sendMessage', () => {
    it('should send a message and return success', async () => {
      const backend = createBackend();
      await backend.initialize();

      const result = await backend.sendMessage(
        { hostname: 'target-host', role: 'qa' },
        {
          to: { hostname: 'target-host', role: 'qa' },
          subject: 'Test subject',
          content: 'Test content',
          priority: 'HIGH',
          messageType: 'workflow',
        },
      );

      expect(result.success).toBe(true);
      expect(result.ref).toBeTruthy();
    });
  });

  describe('receiveMessages', () => {
    it('should receive messages sent to this agent', async () => {
      const backend = createBackend();
      await backend.initialize();

      // Send from an external agent to this one
      const mm = backend.getMailboxManager();
      await mm.sendMessage('test-host', 'developer', 'Hello', 'Body', 'NORMAL');

      const messages = await backend.receiveMessages();
      expect(messages.length).toBeGreaterThanOrEqual(1);
      expect(messages[0].subject).toBe('Hello');
      expect(messages[0].from).toBeDefined();
      expect(messages[0].to).toBeDefined();
    });
  });

  describe('getMailboxManager', () => {
    it('should expose the underlying MailboxManager', () => {
      const backend = createBackend();
      const mm = backend.getMailboxManager();
      expect(mm).toBeDefined();
      expect(typeof mm.initialize).toBe('function');
    });
  });

  describe('discovery', () => {
    it('should return null roster when no team.json', async () => {
      const backend = createBackend();
      await backend.initialize();
      const roster = await backend.getTeamRoster();
      expect(roster).toBeNull();
    });

    it('should return enriched agents from team.json', async () => {
      // Create team.json before initialize so the MailboxManager finds it
      const mailboxDir = path.join(testDir, 'mailbox');
      await fs.mkdir(mailboxDir, { recursive: true });
      await fs.writeFile(
        path.join(mailboxDir, 'team.json'),
        JSON.stringify({
          team: { name: 'test-team', description: 'Test team' },
          agents: [
            { id: 'dev-host_developer', hostname: 'dev-host', role: 'developer', capabilities: ['python'] },
          ],
        }),
      );

      const backend = createBackend();
      await backend.initialize();

      // Invalidate the team roster cache so it re-reads
      backend.getMailboxManager().clearTeamRosterCache();

      const roster = await backend.getTeamRoster();
      expect(roster).not.toBeNull();
      expect(roster!.length).toBe(1);
      expect(roster![0].skills).toBeDefined();
    });
  });

  describe('audit', () => {
    it('should return empty audit log (git-backed)', async () => {
      const backend = createBackend();
      await backend.initialize();
      const entries = await backend.getAuditLog();
      expect(entries).toEqual([]);
    });
  });

  describe('sync', () => {
    it('should skip git sync when gitSync is false', async () => {
      const backend = createBackend();
      await backend.initialize();
      const result = await backend.syncFromRemote();
      // With gitSync=false, syncFromRemote returns success
      expect(result.success).toBe(true);
    });
  });
});
