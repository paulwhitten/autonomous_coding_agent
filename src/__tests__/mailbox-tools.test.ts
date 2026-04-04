// Tests for mailbox-tools.ts - Mailbox tool handlers

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createMailboxTools } from '../tools/mailbox-tools.js';
import { MailboxManager } from '../mailbox.js';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

describe('Mailbox Tools', () => {
  let testDir: string;
  let mailbox: MailboxManager;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailbox-tools-test-'));

    mailbox = new MailboxManager(
      testDir,
      'test_host',
      'developer',
      false,
      false,
      'Test commit',
      true, // supportBroadcast
      false,
      true
    );

    await mailbox.initialize();
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('createMailboxTools', () => {
    it('should create all expected tools', () => {
      const tools = createMailboxTools(mailbox);
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(0);
    });

    it('should include all standard tools', () => {
      const tools = createMailboxTools(mailbox);
      const names = tools.map((t: any) => t.name);
      expect(names).toContain('check_mailbox');
      expect(names).toContain('read_message');
      expect(names).toContain('archive_message');
      expect(names).toContain('send_message');
      expect(names).toContain('send_broadcast');
      expect(names).toContain('escalate_issue');
      expect(names).toContain('get_team_roster');
      expect(names).toContain('find_agents_by_role');
      expect(names).toContain('find_agents_by_capability');
      expect(names).toContain('get_agent_info');
      expect(names).toContain('send_completion_report');
    });

    it('should create tools with correct structure', () => {
      const tools = createMailboxTools(mailbox);
      tools.forEach((tool: any) => {
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('description');
        expect(tool).toHaveProperty('handler');
        expect(typeof tool.name).toBe('string');
        expect(typeof tool.description).toBe('string');
        expect(typeof tool.handler).toBe('function');
      });
    });
  });

  describe('check_mailbox handler', () => {
    it('should return no messages when mailbox is empty', async () => {
      const tools = createMailboxTools(mailbox);
      const tool = (tools as any[]).find((t: any) => t.name === 'check_mailbox');

      const result: any = await (tool as any).handler({});

      expect(result.hasNewMessages).toBe(false);
      expect(result.count).toBe(0);
      expect(result.messages).toEqual([]);
    });

    it('should return messages when mailbox has messages', async () => {
      await mailbox.sendMessage('test_host', 'developer', 'Test Subject', 'Test content', 'NORMAL');

      const tools = createMailboxTools(mailbox);
      const tool = (tools as any[]).find((t: any) => t.name === 'check_mailbox');

      const result: any = await (tool as any).handler({});

      expect(result.hasNewMessages).toBe(true);
      expect(result.count).toBeGreaterThan(0);
      expect(result.messages[0]).toHaveProperty('filename');
      expect(result.messages[0]).toHaveProperty('subject');
    });
  });

  describe('read_message handler', () => {
    it('should return error for non-existent message', async () => {
      const tools = createMailboxTools(mailbox);
      const tool = (tools as any[]).find((t: any) => t.name === 'read_message');

      const result: any = await (tool as any).handler({ filename: 'nonexistent.md' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('nonexistent.md');
    });

    it('should return message content for existing message', async () => {
      await mailbox.sendMessage('test_host', 'developer', 'Hello', 'Hello world content', 'NORMAL');

      const messages = await mailbox.checkForNewMessages();
      expect(messages.length).toBeGreaterThan(0);

      const tools = createMailboxTools(mailbox);
      const tool = (tools as any[]).find((t: any) => t.name === 'read_message');

      const result: any = await (tool as any).handler({ filename: messages[0].filename });

      expect(result.success).toBe(true);
      expect(result.message).toHaveProperty('content');
      expect(result.message.subject).toBe('Hello');
    });
  });

  describe('archive_message handler', () => {
    it('should return error for non-existent message', async () => {
      const tools = createMailboxTools(mailbox);
      const tool = (tools as any[]).find((t: any) => t.name === 'archive_message');

      const result: any = await (tool as any).handler({ filename: 'nonexistent.md' });

      expect(result.success).toBe(false);
    });

    it('should archive an existing message', async () => {
      await mailbox.sendMessage('test_host', 'developer', 'Archive me', 'Content', 'NORMAL');
      const messages = await mailbox.checkForNewMessages();

      const tools = createMailboxTools(mailbox);
      const tool = (tools as any[]).find((t: any) => t.name === 'archive_message');

      const result: any = await (tool as any).handler({ filename: messages[0].filename });

      expect(result.success).toBe(true);
    });
  });

  describe('send_message handler', () => {
    it('should send a message successfully', async () => {
      const tools = createMailboxTools(mailbox);
      const tool = (tools as any[]).find((t: any) => t.name === 'send_message');

      const result: any = await (tool as any).handler({
        toHostname: 'test_host',
        toRole: 'developer',
        subject: 'Test',
        content: 'Hello there',
        priority: 'NORMAL',
      });

      expect(result.success).toBe(true);
      expect(result.filepath).toBeDefined();
    });

    it('should fire onMessageSent callback when provided', async () => {
      const callback = jest.fn<any>();
      const tools = createMailboxTools(mailbox, callback);
      const tool = (tools as any[]).find((t: any) => t.name === 'send_message');

      await tool.handler({
        toHostname: 'other_host',
        toRole: 'qa',
        subject: 'Task delegation',
        content: 'Please do this',
        priority: 'HIGH',
      });

      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        toHostname: 'other_host',
        toRole: 'qa',
        subject: 'Task delegation',
      }));
    });

    it('should not fail when onMessageSent is not provided', async () => {
      const tools = createMailboxTools(mailbox);
      const tool = (tools as any[]).find((t: any) => t.name === 'send_message');

      const result: any = await (tool as any).handler({
        toHostname: 'test_host',
        toRole: 'developer',
        subject: 'No callback',
        content: 'Content',
      });

      expect(result.success).toBe(true);
    });

    it('should apply backpressure when recipient queue is too deep', async () => {
      for (let i = 0; i < 11; i++) {
        await mailbox.sendMessage('test_host', 'developer', `Msg ${i}`, 'Content', 'NORMAL');
      }

      const tools = createMailboxTools(mailbox);
      const tool = (tools as any[]).find((t: any) => t.name === 'send_message');

      const result: any = await (tool as any).handler({
        toHostname: 'test_host',
        toRole: 'developer',
        subject: 'Overflow',
        content: 'Overflowing',
        priority: 'NORMAL',
      });

      expect(result.success).toBe(false);
      expect(result.deferred).toBe(true);
    });
  });

  describe('send_broadcast handler', () => {
    it('should send a broadcast', async () => {
      const tools = createMailboxTools(mailbox);
      const tool = (tools as any[]).find((t: any) => t.name === 'send_broadcast');

      const result: any = await (tool as any).handler({
        subject: 'Team update',
        content: 'Everyone please note this',
        priority: 'NORMAL',
      });

      expect(result.success).toBe(true);
      expect(result.filepath).toBeDefined();
    });
  });

  describe('escalate_issue handler', () => {
    it('should escalate an issue', async () => {
      const tools = createMailboxTools(mailbox);
      const tool = (tools as any[]).find((t: any) => t.name === 'escalate_issue');

      const result: any = await (tool as any).handler({
        issue: 'Build is broken',
        context: 'Tried fixing tests but still failing',
      });

      expect(result.success).toBe(true);
    });
  });

  describe('send_completion_report handler', () => {
    it('should send a completion report', async () => {
      const tools = createMailboxTools(mailbox);
      const tool = (tools as any[]).find((t: any) => t.name === 'send_completion_report');

      const result: any = await (tool as any).handler({
        taskSubject: 'Implement feature X',
        results: 'Feature implemented and tested successfully.',
      });

      expect(result.success).toBe(true);
    });
  });

  describe('get_team_roster handler', () => {
    it('should return unavailable when no team.json exists', async () => {
      const tools = createMailboxTools(mailbox);
      const tool = (tools as any[]).find((t: any) => t.name === 'get_team_roster');

      const result: any = await (tool as any).handler({});

      expect(result.available).toBe(false);
    });
  });

  describe('find_agents_by_role handler', () => {
    it('should return not found when no roster exists', async () => {
      const tools = createMailboxTools(mailbox);
      const tool = (tools as any[]).find((t: any) => t.name === 'find_agents_by_role');

      const result: any = await (tool as any).handler({ role: 'developer' });

      expect(result.found).toBe(false);
    });
  });

  describe('find_agents_by_capability handler', () => {
    it('should return not found when no roster exists', async () => {
      const tools = createMailboxTools(mailbox);
      const tool = (tools as any[]).find((t: any) => t.name === 'find_agents_by_capability');

      const result: any = await (tool as any).handler({ capability: 'python' });

      expect(result.found).toBe(false);
    });
  });

  describe('get_agent_info handler', () => {
    it('should return not found when no roster exists', async () => {
      const tools = createMailboxTools(mailbox);
      const tool = (tools as any[]).find((t: any) => t.name === 'get_agent_info');

      const result: any = await (tool as any).handler({ agentId: 'dev_developer' });

      expect(result.found).toBe(false);
    });
  });
});
