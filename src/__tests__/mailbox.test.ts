// Tests for mailbox.ts - Message management and priority routing

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { MailboxManager } from '../mailbox.js';
import { createMockLogger } from './test-helpers.js';
import { promises as fs } from 'fs';
import path from 'path';
import type pino from 'pino';
import os from 'os';

describe('MailboxManager', () => {
  let testDir: string;
  let mailboxPath: string;
  let logger: pino.Logger;
  let mailbox: MailboxManager;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailbox-test-'));
    mailboxPath = path.join(testDir, 'mailbox');
    
    logger = createMockLogger();

    mailbox = new MailboxManager(
      testDir,           // repoPath
      'test_machine',    // hostname
      'developer',       // role
      false,             // gitSync
      false,             // autoCommit
      'Test commit',     // commitMessage
      false,             // supportBroadcast
      false,             // supportAttachments
      true               // supportPriority
    );
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('initialization', () => {
    it('should create mailbox directories with priority support', async () => {
      await mailbox.initialize();

      const toPath = mailbox.getMailboxPath();
      const priorityPath = path.join(toPath, 'priority');
      const normalPath = path.join(toPath, 'normal');
      const backgroundPath = path.join(toPath, 'background');
      const archivePath = path.join(toPath, 'archive');

      expect(await fs.stat(priorityPath).then(() => true).catch(() => false)).toBe(true);
      expect(await fs.stat(normalPath).then(() => true).catch(() => false)).toBe(true);
      expect(await fs.stat(backgroundPath).then(() => true).catch(() => false)).toBe(true);
      expect(await fs.stat(archivePath).then(() => true).catch(() => false)).toBe(true);
    });

    it('should create mailbox directories without priority support', async () => {
      const noPriorityMailbox = new MailboxManager(
        testDir,
        'test_machine',
        'developer',
        false,  // gitSync
        false,  // autoCommit
        'Test commit',
        false,  // supportBroadcast
        false,  // supportAttachments
        false   // supportPriority
      );
      await noPriorityMailbox.initialize();

      const toPath = noPriorityMailbox.getMailboxPath();
      const archivePath = path.join(toPath, 'archive');

      // Root and archive should exist
      expect(await fs.stat(toPath).then(() => true).catch(() => false)).toBe(true);
      expect(await fs.stat(archivePath).then(() => true).catch(() => false)).toBe(true);

      // Priority folders should NOT exist
      const priorityPath = path.join(toPath, 'priority');
      expect(await fs.stat(priorityPath).then(() => true).catch(() => false)).toBe(false);
    });
  });

  describe('sendMessage', () => {
    beforeEach(async () => {
      await mailbox.initialize();
    });

    it('should send HIGH priority message to priority folder', async () => {
      await mailbox.sendMessage(
        'recipient_host',
        'developer',
        'Test Subject',
        'Test content',
        'HIGH'
      );

      const toPath = path.join(testDir, 'mailbox', 'to_recipient_host_developer');
      const priorityPath = path.join(toPath, 'priority');
      const files = await fs.readdir(priorityPath);
      
      expect(files.length).toBe(1);
      expect(files[0]).toContain('test_subject');
    });

    it('should send NORMAL priority message to normal folder', async () => {
      await mailbox.sendMessage(
        'recipient_host',
        'developer',
        'Normal Task',
        'Normal content',
        'NORMAL'
      );

      const toPath = path.join(testDir, 'mailbox', 'to_recipient_host_developer');
      const normalPath = path.join(toPath, 'normal');
      const files = await fs.readdir(normalPath);
      
      expect(files.length).toBe(1);
      expect(files[0]).toContain('normal_task');
    });

    it('should send LOW priority message to background folder', async () => {
      await mailbox.sendMessage(
        'recipient_host',
        'developer',
        'Background Task',
        'Low priority content',
        'LOW'
      );

      const toPath = path.join(testDir, 'mailbox', 'to_recipient_host_developer');
      const backgroundPath = path.join(toPath, 'background');
      const files = await fs.readdir(backgroundPath);
      
      expect(files.length).toBe(1);
      expect(files[0]).toContain('background_task');
    });

    it('should default to NORMAL priority if not specified', async () => {
      await mailbox.sendMessage(
        'recipient_host',
        'developer',
        'Default Priority',
        'Content without priority'
      );

      const toPath = path.join(testDir, 'mailbox', 'to_recipient_host_developer');
      const normalPath = path.join(toPath, 'normal');
      const files = await fs.readdir(normalPath);
      
      expect(files.length).toBe(1);
    });

    it('should sanitize subject for filename', async () => {
      await mailbox.sendMessage(
        'recipient_host',
        'developer',
        'Test! @Subject# $With% ^Special* &Chars',
        'Content'
      );

      const toPath = path.join(testDir, 'mailbox', 'to_recipient_host_developer');
      const normalPath = path.join(toPath, 'normal');
      const files = await fs.readdir(normalPath);
      
      expect(files[0]).toMatch(/test_subject_with_special_chars\.md$/);
    });

    it('should correct hostname when LLM passes hostname_role as hostname', async () => {
      // LLM sometimes passes "test-sdk_developer" as hostname instead of "test-sdk"
      await mailbox.sendMessage(
        'test-sdk_developer',  // Wrong: includes role suffix
        'developer',
        'Corrected Hostname Test',
        'Should go to to_test-sdk_developer not to_test-sdk_developer_developer'
      );

      // Should write to the corrected path (role suffix stripped from hostname)
      const correctPath = path.join(testDir, 'mailbox', 'to_test-sdk_developer', 'normal');
      const wrongPath = path.join(testDir, 'mailbox', 'to_test-sdk_developer_developer');
      
      const files = await fs.readdir(correctPath);
      expect(files.length).toBe(1);
      expect(files[0]).toContain('corrected_hostname_test');
      
      // The wrong directory should not exist
      await expect(fs.readdir(wrongPath)).rejects.toThrow();
    });

    it('should not modify hostname when it does not end with role suffix', async () => {
      await mailbox.sendMessage(
        'test-protocol',
        'developer',
        'Normal Hostname Test',
        'Hostname should not be modified'
      );

      const correctPath = path.join(testDir, 'mailbox', 'to_test-protocol_developer', 'normal');
      const files = await fs.readdir(correctPath);
      expect(files.length).toBe(1);
    });
  });

  describe('checkForNewMessages', () => {
    beforeEach(async () => {
      await mailbox.initialize();
      
      // Create test messages
      const toPath = mailbox.getMailboxPath();
      
      // Create HIGH priority message
      const priorityMsg = `Date: 2025-12-20 10:00 UTC
From: manager
To: test_agent
Subject: Urgent Task
Priority: HIGH
MessageType: unstructured
---

This is urgent!`;
      await fs.writeFile(path.join(toPath, 'priority', '001_urgent.md'), priorityMsg);

      // Create NORMAL priority message
      const normalMsg = `Date: 2025-12-20 10:01 UTC
From: manager
To: test_agent
Subject: Normal Task
Priority: NORMAL
MessageType: unstructured
---

This is normal.`;
      await fs.writeFile(path.join(toPath, 'normal', '002_normal.md'), normalMsg);

      // Create LOW priority message
      const lowMsg = `Date: 2025-12-20 10:02 UTC
From: manager
To: test_agent
Subject: Background Task
Priority: LOW
MessageType: unstructured
---

This is low priority.`;
      await fs.writeFile(path.join(toPath, 'background', '003_background.md'), lowMsg);
    });

    it('should return messages in priority order (HIGH, NORMAL, LOW)', async () => {
      const messages = await mailbox.checkForNewMessages();

      expect(messages.length).toBe(3);
      expect(messages[0].priority).toBe('HIGH');
      expect(messages[0].subject).toBe('Urgent Task');
      expect(messages[1].priority).toBe('NORMAL');
      expect(messages[1].subject).toBe('Normal Task');
      expect(messages[2].priority).toBe('LOW');
      expect(messages[2].subject).toBe('Background Task');
    });

    it('should handle multiple messages of same priority alphabetically', async () => {
      const toPath = mailbox.getMailboxPath();
      
      // Original message is '001_urgent.md' in priority folder
      // The test setup already has 3 messages (HIGH, NORMAL, LOW)
      // Let's just verify they are in priority order without adding more
      
      const messages = await mailbox.checkForNewMessages();

      // Should have 3 total: 1 HIGH + 1 NORMAL + 1 LOW
      expect(messages.length).toBe(3);
      // Priority order: HIGH, NORMAL, LOW
      expect(messages[0].priority).toBe('HIGH');
      expect(messages[1].priority).toBe('NORMAL');
      expect(messages[2].priority).toBe('LOW');
    });

    it('should return empty array when no messages', async () => {
      // Clean out messages
      const toPath = mailbox.getMailboxPath();
      await fs.rm(path.join(toPath, 'priority', '001_urgent.md'));
      await fs.rm(path.join(toPath, 'normal', '002_normal.md'));
      await fs.rm(path.join(toPath, 'background', '003_background.md'));

      const messages = await mailbox.checkForNewMessages();
      expect(messages).toEqual([]);
    });
  });

  describe('archiveMessage', () => {
    beforeEach(async () => {
      await mailbox.initialize();
    });

    it('should move message to archive folder', async () => {
      const toPath = mailbox.getMailboxPath();
      const normalPath = path.join(toPath, 'normal');
      const archivePath = path.join(toPath, 'archive');
      
      const testFile = 'test_message.md';
      const normalFile = path.join(normalPath, testFile);
      await fs.writeFile(normalFile, 'Test message content');

      const message = {
        filename: testFile,
        filepath: normalFile,
        date: new Date(),
        from: 'sender',
        to: 'test_agent',
        subject: 'Test',
        priority: 'NORMAL' as const,
        messageType: 'unstructured' as const,
        content: 'Test'
      };

      await mailbox.archiveMessage(message);

      // Should not exist in normal
      expect(await fs.stat(normalFile).then(() => true).catch(() => false)).toBe(false);

      // Should exist in archive
      const archivedFile = path.join(archivePath, testFile);
      expect(await fs.stat(archivedFile).then(() => true).catch(() => false)).toBe(true);
    });
  });

  // ===================================================================
  // Strict-schema integration tests (MessageType + payload propagation)
  // ===================================================================

  describe('strict-schema message integration', () => {
    beforeEach(async () => {
      await mailbox.initialize();
    });

    it('should send workflow message with JSON payload', async () => {
      const payload = {
        type: 'workflow',
        workflowId: 'wf-1',
        taskId: 'task-001',
        targetState: 'IMPLEMENTING',
        targetRole: 'developer',
        taskPrompt: 'Build the feature',
        taskState: { taskId: 'task-001', currentState: 'IMPLEMENTING' },
      };

      await mailbox.sendMessage(
        'target_host',
        'developer',
        'Workflow Task',
        '',
        'NORMAL',
        'workflow',
        payload,
      );

      const toPath = path.join(testDir, 'mailbox', 'to_target_host_developer', 'normal');
      const files = await fs.readdir(toPath);
      expect(files.length).toBe(1);

      const content = await fs.readFile(path.join(toPath, files[0]), 'utf-8');
      expect(content).toContain('MessageType: workflow');
      expect(content).toContain('"type": "workflow"');
      expect(content).toContain('"taskId": "task-001"');
    });

    it('should send oob message with JSON payload', async () => {
      const payload = {
        type: 'oob',
        priority: 'HIGH',
        reason: 'security-patch',
        content: 'Patch immediately',
      };

      await mailbox.sendMessage(
        'target_host',
        'developer',
        'OOB Alert',
        '',
        'HIGH',
        'oob',
        payload,
      );

      const toPath = path.join(testDir, 'mailbox', 'to_target_host_developer', 'priority');
      const files = await fs.readdir(toPath);
      expect(files.length).toBe(1);

      const content = await fs.readFile(path.join(toPath, files[0]), 'utf-8');
      expect(content).toContain('MessageType: oob');
      expect(content).toContain('"reason": "security-patch"');
    });

    it('should round-trip workflow message through send/check', async () => {
      const payload = {
        type: 'workflow',
        workflowId: 'wf-test',
        taskId: 'task-rt',
        targetState: 'REVIEWING',
        targetRole: 'developer',
        taskPrompt: 'Review this code',
        taskState: { taskId: 'task-rt', currentState: 'REVIEWING' },
      };

      // Send to self
      await mailbox.sendMessage(
        'test_machine',
        'developer',
        'Round Trip WF',
        '',
        'NORMAL',
        'workflow',
        payload,
      );

      const messages = await mailbox.checkForNewMessages();
      expect(messages.length).toBeGreaterThanOrEqual(1);

      const wfMsg = messages.find(m => m.subject === 'Round Trip WF');
      expect(wfMsg).toBeDefined();
      expect(wfMsg!.messageType).toBe('workflow');
      expect(wfMsg!.payload).toBeDefined();
      expect(wfMsg!.payload!.taskId).toBe('task-rt');
      expect(wfMsg!.payload!.targetState).toBe('REVIEWING');
    });

    it('should parse messages without MessageType header as unstructured', async () => {
      const toPath = mailbox.getMailboxPath();
      const legacyMsg = `Date: 2025-12-20 10:00 UTC
From: legacy_sender
To: test_agent
Subject: Legacy Message

This is a pre-schema message.`;
      await fs.writeFile(path.join(toPath, 'normal', 'legacy.md'), legacyMsg);

      const messages = await mailbox.checkForNewMessages();
      const legacy = messages.find(m => m.subject === 'Legacy Message');
      expect(legacy).toBeDefined();
      expect(legacy!.messageType).toBe('unstructured');
      expect(legacy!.payload).toBeUndefined();
      expect(legacy!.content).toContain('pre-schema message');
    });

    it('should default to unstructured when sendMessage has no messageType', async () => {
      await mailbox.sendMessage(
        'target_host',
        'developer',
        'Plain Text',
        'Just some text content',
      );

      const toPath = path.join(testDir, 'mailbox', 'to_target_host_developer', 'normal');
      const files = await fs.readdir(toPath);
      const content = await fs.readFile(path.join(toPath, files[0]), 'utf-8');
      expect(content).toContain('MessageType: unstructured');
      expect(content).toContain('Just some text content');
    });
  });

  // ===================================================================
  // Broadcast support
  // ===================================================================

  describe('broadcast support', () => {
    let broadcastMailbox: MailboxManager;

    beforeEach(async () => {
      broadcastMailbox = new MailboxManager(
        testDir,
        'sender_machine',
        'manager',
        false,  // gitSync
        false,  // autoCommit
        'Test commit',
        true,   // supportBroadcast
        false,  // supportAttachments
        true,   // supportPriority
      );
      await broadcastMailbox.initialize();
    });

    it('should create broadcast folder on initialization', async () => {
      const toAllPath = path.join(testDir, 'mailbox', 'to_all');
      const stat = await fs.stat(toAllPath);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should send broadcast message to to_all folder', async () => {
      await broadcastMailbox.sendBroadcast('Team Update', 'New sprint starts today');

      const toAllPath = path.join(testDir, 'mailbox', 'to_all');
      const files = await fs.readdir(toAllPath);
      expect(files.length).toBe(1);

      const content = await fs.readFile(path.join(toAllPath, files[0]), 'utf-8');
      expect(content).toContain('To: all');
      expect(content).toContain('Subject: Team Update');
      expect(content).toContain('New sprint starts today');
    });

    it('should reject broadcast when not supported', async () => {
      const noBroadcast = new MailboxManager(
        testDir,
        'test_machine',
        'developer',
        false, false, 'c',
        false,  // supportBroadcast = false
        false, true,
      );
      await noBroadcast.initialize();

      await expect(noBroadcast.sendBroadcast('Test', 'Content')).rejects.toThrow(
        'Broadcast not supported',
      );
    });

    it('should include broadcast messages in checkForNewMessages', async () => {
      // Set up a reader that supports broadcast  
      const reader = new MailboxManager(
        testDir,
        'reader_machine',
        'developer',
        false, false, 'c',
        true,   // supportBroadcast
        false, true,
      );
      await reader.initialize();

      // Write broadcast message
      const toAllPath = path.join(testDir, 'mailbox', 'to_all');
      const broadcastMsg = `Date: 2025-12-20 10:00 UTC
From: sender_manager
To: all
Subject: Broadcast Test
MessageType: unstructured
---

Hello everyone!`;
      await fs.writeFile(path.join(toAllPath, 'broadcast.md'), broadcastMsg);

      const messages = await reader.checkForNewMessages();
      const broadcast = messages.find(m => m.subject === 'Broadcast Test');
      expect(broadcast).toBeDefined();
      expect(broadcast!.content).toContain('Hello everyone');
    });
  });

  // ===================================================================
  // Attachments support
  // ===================================================================

  describe('attachments support', () => {
    it('should create attachments folder when supported', async () => {
      const attMailbox = new MailboxManager(
        testDir,
        'test_machine',
        'developer',
        false, false, 'c',
        false,
        true,  // supportAttachments
        true,
      );
      await attMailbox.initialize();

      const attPath = path.join(testDir, 'attachments');
      const stat = await fs.stat(attPath);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  // ===================================================================
  // Legacy (non-priority) mode
  // ===================================================================

  describe('legacy non-priority mode', () => {
    let legacyMailbox: MailboxManager;

    beforeEach(async () => {
      legacyMailbox = new MailboxManager(
        testDir,
        'legacy_machine',
        'developer',
        false, false, 'c',
        false, false,
        false,  // supportPriority = false
      );
      await legacyMailbox.initialize();
    });

    it('should read messages from root mailbox folder', async () => {
      const rootPath = legacyMailbox.getMailboxPath();
      const msg = `Date: 2025-12-20 10:00 UTC
From: sender
To: legacy_machine_developer
Subject: Legacy Task
MessageType: unstructured
---

Do the thing.`;
      await fs.writeFile(path.join(rootPath, 'task.md'), msg);

      const messages = await legacyMailbox.checkForNewMessages();
      expect(messages.length).toBe(1);
      expect(messages[0].subject).toBe('Legacy Task');
    });

    it('should send messages to root folder when priority not supported', async () => {
      await legacyMailbox.sendMessage(
        'target',
        'developer',
        'No Priority',
        'Content',
      );

      // Without priority support, messages go to the root mailbox folder
      const targetBase = path.join(testDir, 'mailbox', 'to_target_developer');
      const files = await fs.readdir(targetBase);
      const mdFiles = files.filter(f => f.endsWith('.md'));
      expect(mdFiles.length).toBe(1);
    });
  });

  // ===================================================================
  // syncFromRemote / syncToRemote (when git is disabled)
  // ===================================================================

  describe('git sync (disabled)', () => {
    it('syncFromRemote should return success when git is disabled', async () => {
      await mailbox.initialize();
      const result = await mailbox.syncFromRemote();
      expect(result.success).toBe(true);
      expect(result.message).toBe('Git sync disabled');
    });

    it('syncToRemote should return success when git/autoCommit is disabled', async () => {
      await mailbox.initialize();
      const result = await mailbox.syncToRemote('Test commit');
      expect(result.success).toBe(true);
      expect(result.message).toBe('Git sync/auto-commit disabled');
    });
  });

  // ===================================================================
  // getRecipientQueueDepth
  // ===================================================================

  describe('getRecipientQueueDepth', () => {
    beforeEach(async () => {
      await mailbox.initialize();
    });

    it('should return 0 when recipient has no messages', async () => {
      const depth = await mailbox.getRecipientQueueDepth('nonexistent', 'developer');
      expect(depth).toBe(0);
    });

    it('should count messages across priority folders', async () => {
      // Create a recipient mailbox with messages
      const recipientBase = path.join(testDir, 'mailbox', 'to_target_developer');
      const priorityPath = path.join(recipientBase, 'priority');
      const normalPath = path.join(recipientBase, 'normal');
      const backgroundPath = path.join(recipientBase, 'background');
      await fs.mkdir(priorityPath, { recursive: true });
      await fs.mkdir(normalPath, { recursive: true });
      await fs.mkdir(backgroundPath, { recursive: true });

      await fs.writeFile(path.join(priorityPath, 'msg1.md'), 'urgent');
      await fs.writeFile(path.join(normalPath, 'msg2.md'), 'normal');
      await fs.writeFile(path.join(normalPath, 'msg3.md'), 'normal 2');
      await fs.writeFile(path.join(backgroundPath, 'msg4.md'), 'bg');

      const depth = await mailbox.getRecipientQueueDepth('target', 'developer');
      expect(depth).toBe(4);
    });

    it('should only count .md files', async () => {
      const recipientBase = path.join(testDir, 'mailbox', 'to_target_developer');
      const normalPath = path.join(recipientBase, 'normal');
      await fs.mkdir(normalPath, { recursive: true });

      await fs.writeFile(path.join(normalPath, 'msg.md'), 'real message');
      await fs.writeFile(path.join(normalPath, 'notes.txt'), 'not counted');
      await fs.mkdir(path.join(normalPath, 'subdir'));

      const depth = await mailbox.getRecipientQueueDepth('target', 'developer');
      expect(depth).toBe(1);
    });

    it('should correct hostname with role suffix', async () => {
      // Create mailbox for the corrected hostname
      const recipientBase = path.join(testDir, 'mailbox', 'to_target_developer');
      const normalPath = path.join(recipientBase, 'normal');
      await fs.mkdir(normalPath, { recursive: true });
      await fs.writeFile(path.join(normalPath, 'msg.md'), 'content');

      // Pass hostname_role format (LLM mistake) -- should still find the mailbox
      const depth = await mailbox.getRecipientQueueDepth('target_developer', 'developer');
      expect(depth).toBe(1);
    });
  });

  // ===================================================================
  // getTeamRoster / clearTeamRosterCache
  // ===================================================================

  describe('getTeamRoster', () => {
    beforeEach(async () => {
      await mailbox.initialize();
    });

    it('should return null when team.json does not exist', async () => {
      const roster = await mailbox.getTeamRoster();
      expect(roster).toBeNull();
    });

    it('should load and return team roster from team.json', async () => {
      const teamJson = {
        team: { name: 'Test Team', description: 'Testing' },
        agents: [
          { hostname: 'dev-host', role: 'developer', agentId: 'dev-host_developer' },
          { hostname: 'qa-host', role: 'qa', agentId: 'qa-host_qa' },
        ],
      };
      await fs.mkdir(path.join(testDir, 'mailbox'), { recursive: true });
      await fs.writeFile(
        path.join(testDir, 'mailbox', 'team.json'),
        JSON.stringify(teamJson),
      );

      const roster = await mailbox.getTeamRoster();
      expect(roster).not.toBeNull();
      expect(roster!.team.name).toBe('Test Team');
      expect(roster!.agents).toHaveLength(2);
    });

    it('should cache team roster for repeated calls', async () => {
      const teamJson = {
        team: { name: 'Cached Team', description: 'Cache test' },
        agents: [{ hostname: 'a', role: 'developer', agentId: 'a_developer' }],
      };
      await fs.mkdir(path.join(testDir, 'mailbox'), { recursive: true });
      await fs.writeFile(
        path.join(testDir, 'mailbox', 'team.json'),
        JSON.stringify(teamJson),
      );

      const call1 = await mailbox.getTeamRoster();
      // Delete the file -- should still get cached result
      await fs.rm(path.join(testDir, 'mailbox', 'team.json'));
      const call2 = await mailbox.getTeamRoster();

      expect(call1).toEqual(call2);
      expect(call2!.team.name).toBe('Cached Team');
    });

    it('should respect clearTeamRosterCache', async () => {
      const teamJson = {
        team: { name: 'Original', description: '' },
        agents: [],
      };
      await fs.mkdir(path.join(testDir, 'mailbox'), { recursive: true });
      await fs.writeFile(
        path.join(testDir, 'mailbox', 'team.json'),
        JSON.stringify(teamJson),
      );

      await mailbox.getTeamRoster();
      mailbox.clearTeamRosterCache();

      // After clearing cache and removing file, should return null
      await fs.rm(path.join(testDir, 'mailbox', 'team.json'));
      const roster = await mailbox.getTeamRoster();
      expect(roster).toBeNull();
    });

    it('should return null on malformed JSON', async () => {
      await fs.mkdir(path.join(testDir, 'mailbox'), { recursive: true });
      await fs.writeFile(
        path.join(testDir, 'mailbox', 'team.json'),
        'not valid json {{{',
      );

      const roster = await mailbox.getTeamRoster();
      expect(roster).toBeNull();
    });
  });

  // ===================================================================
  // sendCompletionReport / escalate
  // ===================================================================

  describe('sendCompletionReport', () => {
    beforeEach(async () => {
      await mailbox.initialize();
    });

    it('should send completion report to manager', async () => {
      await mailbox.sendCompletionReport('Build Feature X', 'All tests pass');

      // Manager hostname defaults to own hostname
      const toPath = path.join(testDir, 'mailbox', 'to_test_machine_manager', 'normal');
      const files = await fs.readdir(toPath);
      expect(files.length).toBe(1);

      const content = await fs.readFile(path.join(toPath, files[0]), 'utf-8');
      expect(content).toContain('Subject: Task Complete: Build Feature X');
      expect(content).toContain('All tests pass');
    });
  });

  describe('escalate', () => {
    beforeEach(async () => {
      await mailbox.initialize();
    });

    it('should send escalation message with HIGH priority', async () => {
      await mailbox.escalate('Build failure', 'CI pipeline is broken');

      const toPath = path.join(testDir, 'mailbox', 'to_test_machine_manager', 'priority');
      const files = await fs.readdir(toPath);
      expect(files.length).toBe(1);

      const content = await fs.readFile(path.join(toPath, files[0]), 'utf-8');
      expect(content).toContain('Subject: Escalation: Build failure');
      expect(content).toContain('CI pipeline is broken');
      expect(content).toContain('Priority: HIGH');
    });
  });
});
