// Tests for the strict message schema (v2)
//
// Covers:
//   - parseMailboxMessage:  header extraction, MessageType detection,
//                           JSON payload parsing, downgrade on bad JSON,
//                           backward compat with missing MessageType
//   - createMailboxMessage: header serialization, JSON body for structured
//                           types, free text for unstructured, priority
//   - Round-trip:           create -> parse preserves all fields
//   - Edge cases:           empty body, malformed headers, nested markers,
//                           extra headers, missing separator

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
  parseMailboxMessage,
  createMailboxMessage,
  formatMailboxTimestamp,
} from '../utils.js';

describe('Message Schema v2', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'msg-schema-test-'));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  // =====================================================================
  // parseMailboxMessage
  // =====================================================================

  describe('parseMailboxMessage', () => {
    async function writeAndParse(content: string) {
      const filepath = path.join(testDir, 'test.md');
      await fs.writeFile(filepath, content, 'utf-8');
      return parseMailboxMessage(filepath);
    }

    // --- Header parsing ---

    it('should parse standard headers', async () => {
      const msg = await writeAndParse(
        `Date: 2026-02-26T12:00:00Z\nFrom: sender_mgr\nTo: recv_dev\nSubject: Hello World\n---\n\nBody text`,
      );
      expect(msg.date).toBe('2026-02-26T12:00:00Z');
      expect(msg.from).toBe('sender_mgr');
      expect(msg.to).toBe('recv_dev');
      expect(msg.subject).toBe('Hello World');
    });

    it('should parse Priority header', async () => {
      const msg = await writeAndParse(
        `Date: 2026-02-26T12:00:00Z\nFrom: a\nTo: b\nSubject: s\nPriority: HIGH\n---\n\nBody`,
      );
      expect(msg.priority).toBe('HIGH');
    });

    it('should default missing fields to empty string', async () => {
      const msg = await writeAndParse(`---\n\nBody only`);
      expect(msg.date).toBe('');
      expect(msg.from).toBe('');
      expect(msg.to).toBe('');
      expect(msg.subject).toBe('');
      expect(msg.messageType).toBe('unstructured');
    });

    it('should handle headers with colons in value', async () => {
      const msg = await writeAndParse(
        `Date: 2026-02-26T12:00:00Z\nFrom: a\nTo: b\nSubject: Task: implement feature\n---\n\nBody`,
      );
      expect(msg.subject).toBe('Task: implement feature');
    });

    it('should stop header parsing at blank line', async () => {
      const msg = await writeAndParse(
        `Date: 2026-02-26T12:00:00Z\nFrom: a\nTo: b\nSubject: test\n\nBody after blank line`,
      );
      expect(msg.content).toBe('Body after blank line');
      expect(msg.subject).toBe('test');
    });

    it('should stop header parsing at --- separator', async () => {
      const msg = await writeAndParse(
        `Date: 2026-02-26T12:00:00Z\nFrom: a\nTo: b\nSubject: test\n---\nBody after separator`,
      );
      expect(msg.content).toBe('Body after separator');
    });

    // --- MessageType detection ---

    it('should detect MessageType: workflow', async () => {
      const payload = { type: 'workflow', taskId: 't1' };
      const msg = await writeAndParse(
        `Date: x\nFrom: a\nTo: b\nSubject: s\nMessageType: workflow\n---\n\n${JSON.stringify(payload)}`,
      );
      expect(msg.messageType).toBe('workflow');
      expect(msg.payload).toBeDefined();
      expect(msg.payload!.type).toBe('workflow');
    });

    it('should detect MessageType: oob', async () => {
      const payload = { type: 'oob', priority: 'HIGH', reason: 'test', content: 'fix it' };
      const msg = await writeAndParse(
        `Date: x\nFrom: a\nTo: b\nSubject: s\nMessageType: oob\n---\n\n${JSON.stringify(payload)}`,
      );
      expect(msg.messageType).toBe('oob');
      expect(msg.payload).toBeDefined();
      expect(msg.payload!.type).toBe('oob');
    });

    it('should detect MessageType: unstructured', async () => {
      const msg = await writeAndParse(
        `Date: x\nFrom: a\nTo: b\nSubject: s\nMessageType: unstructured\n---\n\nFree text body`,
      );
      expect(msg.messageType).toBe('unstructured');
      expect(msg.payload).toBeUndefined();
      expect(msg.content).toBe('Free text body');
    });

    it('should detect MessageType: status', async () => {
      const msg = await writeAndParse(
        `Date: x\nFrom: a\nTo: b\nSubject: Assignment 001 completed\nMessageType: status\n---\n\nAll work items completed.`,
      );
      expect(msg.messageType).toBe('status');
      expect(msg.payload).toBeUndefined();
      expect(msg.content).toBe('All work items completed.');
    });

    it('should default to unstructured when MessageType header is absent', async () => {
      const msg = await writeAndParse(
        `Date: x\nFrom: a\nTo: b\nSubject: s\n---\n\nNo type header`,
      );
      expect(msg.messageType).toBe('unstructured');
    });

    it('should default to unstructured when MessageType is unknown', async () => {
      const msg = await writeAndParse(
        `Date: x\nFrom: a\nTo: b\nSubject: s\nMessageType: bogus\n---\n\nBody`,
      );
      expect(msg.messageType).toBe('unstructured');
    });

    // --- JSON payload parsing ---

    it('should parse valid JSON payload for workflow type', async () => {
      const payload = {
        type: 'workflow',
        workflowId: 'wf-1',
        taskId: 'task-1',
        targetState: 'IMPLEMENTING',
        targetRole: 'developer',
        taskPrompt: 'Build it',
        taskState: { taskId: 'task-1', currentState: 'IMPLEMENTING' },
      };
      const msg = await writeAndParse(
        `Date: x\nFrom: a\nTo: b\nSubject: s\nMessageType: workflow\n---\n\n${JSON.stringify(payload, null, 2)}`,
      );
      expect(msg.messageType).toBe('workflow');
      expect(msg.payload).toEqual(payload);
    });

    it('should downgrade to unstructured when workflow body is not valid JSON', async () => {
      const msg = await writeAndParse(
        `Date: x\nFrom: a\nTo: b\nSubject: s\nMessageType: workflow\n---\n\nNot JSON at all`,
      );
      expect(msg.messageType).toBe('unstructured');
      expect(msg.payload).toBeUndefined();
      expect(msg.content).toBe('Not JSON at all');
    });

    it('should downgrade to unstructured when oob body is not valid JSON', async () => {
      const msg = await writeAndParse(
        `Date: x\nFrom: a\nTo: b\nSubject: s\nMessageType: oob\n---\n\n{invalid json}`,
      );
      expect(msg.messageType).toBe('unstructured');
      expect(msg.payload).toBeUndefined();
    });

    it('should downgrade to unstructured when JSON is an array', async () => {
      const msg = await writeAndParse(
        `Date: x\nFrom: a\nTo: b\nSubject: s\nMessageType: workflow\n---\n\n[1, 2, 3]`,
      );
      expect(msg.messageType).toBe('unstructured');
      expect(msg.payload).toBeUndefined();
    });

    it('should downgrade to unstructured when JSON is a primitive', async () => {
      const msg = await writeAndParse(
        `Date: x\nFrom: a\nTo: b\nSubject: s\nMessageType: oob\n---\n\n"just a string"`,
      );
      expect(msg.messageType).toBe('unstructured');
      expect(msg.payload).toBeUndefined();
    });

    // --- Backward compat ---

    it('should parse legacy message without MessageType header', async () => {
      const msg = await writeAndParse(
        `Date: 2025-12-20 10:00 UTC\nFrom: smoke-test-mgr_manager\nTo: dev\nSubject: Task 1\nPriority: NORMAL\n\nPlease create hello world`,
      );
      expect(msg.messageType).toBe('unstructured');
      expect(msg.from).toBe('smoke-test-mgr_manager');
      expect(msg.content).toContain('hello world');
    });

    it('should parse legacy message with WORKFLOW_MSG markers as unstructured', async () => {
      const body = `Some text\n<!-- WORKFLOW_MSG:{"type":"workflow","taskId":"t1"}:END_WORKFLOW_MSG -->\nMore text`;
      const msg = await writeAndParse(
        `Date: x\nFrom: a\nTo: b\nSubject: s\n---\n\n${body}`,
      );
      // Without a MessageType header, it stays unstructured -- the old path handles markers
      expect(msg.messageType).toBe('unstructured');
      expect(msg.content).toContain('WORKFLOW_MSG');
    });

    // --- Edge cases ---

    it('should handle empty body gracefully', async () => {
      const msg = await writeAndParse(
        `Date: x\nFrom: a\nTo: b\nSubject: s\nMessageType: unstructured\n---\n`,
      );
      expect(msg.messageType).toBe('unstructured');
      expect(msg.content).toBe('');
    });

    it('should handle file with only headers (no separator)', async () => {
      // If there's no blank line or ---, the header loop runs to the end
      // but contentStart stays at 0, so body includes the header lines.
      const msg = await writeAndParse(
        `Date: x\nFrom: a\nTo: b\nSubject: no separator ever`,
      );
      // Headers are still extracted
      expect(msg.subject).toBe('no separator ever');
      // Body is the full content (contentStart never advanced from 0)
      expect(msg.content).toContain('Date: x');
    });

    it('should handle MessageType header case-insensitively in key', async () => {
      // Our regex lowercases all header keys
      const msg = await writeAndParse(
        `Date: x\nFrom: a\nTo: b\nSubject: s\nmessagetype: workflow\n---\n\n{"type":"workflow"}`,
      );
      // messagetype is lowercased and matched
      expect(msg.messageType).toBe('workflow');
    });
  });

  // =====================================================================
  // createMailboxMessage
  // =====================================================================

  describe('createMailboxMessage', () => {
    it('should create unstructured message with free text body', async () => {
      const filepath = await createMailboxMessage(
        testDir, 'test.md', 'from_id', 'to_id', 'Test Subject', 'Hello world body',
      );
      const content = await fs.readFile(filepath, 'utf-8');

      expect(content).toContain('From: from_id');
      expect(content).toContain('To: to_id');
      expect(content).toContain('Subject: Test Subject');
      expect(content).toContain('MessageType: unstructured');
      expect(content).toContain('Hello world body');
    });

    it('should create workflow message with JSON payload body', async () => {
      const payload = { type: 'workflow', taskId: 't1', taskPrompt: 'Build it' };
      const filepath = await createMailboxMessage(
        testDir, 'wf.md', 'sender', 'recv', 'WF Subject', '',
        undefined, 'workflow', payload,
      );
      const content = await fs.readFile(filepath, 'utf-8');

      expect(content).toContain('MessageType: workflow');
      expect(content).toContain('"type": "workflow"');
      expect(content).toContain('"taskId": "t1"');
      // Should NOT contain the free text content param
      expect(content).not.toContain('undefined');
    });

    it('should create oob message with JSON payload body', async () => {
      const payload = { type: 'oob', priority: 'HIGH', reason: 'outage', content: 'Fix it' };
      const filepath = await createMailboxMessage(
        testDir, 'oob.md', 'sender', 'recv', 'OOB Subject', '',
        undefined, 'oob', payload,
      );
      const content = await fs.readFile(filepath, 'utf-8');

      expect(content).toContain('MessageType: oob');
      expect(content).toContain('"type": "oob"');
      expect(content).toContain('"reason": "outage"');
    });

    it('should include Priority header when provided', async () => {
      const filepath = await createMailboxMessage(
        testDir, 'pri.md', 'a', 'b', 'Urgent', 'Content', 'HIGH',
      );
      const content = await fs.readFile(filepath, 'utf-8');

      expect(content).toContain('Priority: HIGH');
    });

    it('should omit Priority header when not provided', async () => {
      const filepath = await createMailboxMessage(
        testDir, 'nopri.md', 'a', 'b', 'Normal', 'Content',
      );
      const content = await fs.readFile(filepath, 'utf-8');

      expect(content).not.toContain('Priority:');
    });

    it('should default MessageType to unstructured when not specified', async () => {
      const filepath = await createMailboxMessage(
        testDir, 'default.md', 'a', 'b', 'Default', 'Body text',
      );
      const content = await fs.readFile(filepath, 'utf-8');

      expect(content).toContain('MessageType: unstructured');
    });

    it('should use free text body when structured type has no payload', async () => {
      // Edge case: messageType is workflow but no payload provided
      const filepath = await createMailboxMessage(
        testDir, 'edge.md', 'a', 'b', 'S', 'Fallback text',
        undefined, 'workflow',
      );
      const content = await fs.readFile(filepath, 'utf-8');

      expect(content).toContain('MessageType: workflow');
      expect(content).toContain('Fallback text');
    });

    it('should include --- separator between headers and body', async () => {
      const filepath = await createMailboxMessage(
        testDir, 'sep.md', 'a', 'b', 'S', 'Body',
      );
      const content = await fs.readFile(filepath, 'utf-8');

      expect(content).toContain('\n---\n');
    });

    it('should write file to the specified path', async () => {
      const filepath = await createMailboxMessage(
        testDir, 'specific-name.md', 'a', 'b', 'S', 'C',
      );
      expect(filepath).toBe(path.join(testDir, 'specific-name.md'));
      const stat = await fs.stat(filepath);
      expect(stat.isFile()).toBe(true);
    });
  });

  // =====================================================================
  // Round-trip: create -> parse
  // =====================================================================

  describe('round-trip', () => {
    it('should round-trip an unstructured message', async () => {
      const filepath = await createMailboxMessage(
        testDir, 'rt-unstructured.md', 'sender_mgr', 'recv_dev',
        'Round Trip Test', 'This is the body text', 'NORMAL',
      );
      const parsed = await parseMailboxMessage(filepath);

      expect(parsed.from).toBe('sender_mgr');
      expect(parsed.to).toBe('recv_dev');
      expect(parsed.subject).toBe('Round Trip Test');
      expect(parsed.priority).toBe('NORMAL');
      expect(parsed.messageType).toBe('unstructured');
      expect(parsed.content).toBe('This is the body text');
      expect(parsed.payload).toBeUndefined();
    });

    it('should round-trip a workflow message', async () => {
      const payload = {
        type: 'workflow',
        workflowId: 'wf-1',
        taskId: 'task-001',
        targetState: 'IMPLEMENTING',
        targetRole: 'developer',
        taskPrompt: 'Build the feature',
        taskState: {
          taskId: 'task-001',
          currentState: 'IMPLEMENTING',
          retryCount: 0,
        },
      };
      const filepath = await createMailboxMessage(
        testDir, 'rt-workflow.md', 'ra_host_ra', 'dev_host_dev',
        '[Workflow] IMPLEMENTING: task-001', '', 'NORMAL',
        'workflow', payload,
      );
      const parsed = await parseMailboxMessage(filepath);

      expect(parsed.messageType).toBe('workflow');
      expect(parsed.payload).toBeDefined();
      expect(parsed.payload!.type).toBe('workflow');
      expect(parsed.payload!.taskId).toBe('task-001');
      expect(parsed.payload!.targetState).toBe('IMPLEMENTING');
      expect(parsed.payload!.taskPrompt).toBe('Build the feature');
    });

    it('should round-trip an oob message', async () => {
      const payload = {
        type: 'oob',
        priority: 'HIGH',
        reason: 'security-fix',
        content: 'Patch the vulnerability immediately',
      };
      const filepath = await createMailboxMessage(
        testDir, 'rt-oob.md', 'mgr', 'dev',
        'URGENT: Security Fix', '', 'HIGH',
        'oob', payload,
      );
      const parsed = await parseMailboxMessage(filepath);

      expect(parsed.messageType).toBe('oob');
      expect(parsed.payload).toBeDefined();
      expect(parsed.payload!.type).toBe('oob');
      expect(parsed.payload!.reason).toBe('security-fix');
      expect(parsed.payload!.content).toBe('Patch the vulnerability immediately');
    });

    it('should round-trip a workflow message with workItems', async () => {
      const payload = {
        type: 'workflow',
        workflowId: 'wf-1',
        taskId: 'task-002',
        targetState: 'IMPLEMENTING',
        targetRole: 'developer',
        taskPrompt: 'Build three features',
        taskState: { taskId: 'task-002', currentState: 'IMPLEMENTING' },
        workItems: [
          { title: 'Feature A', content: 'Implement feature A' },
          { title: 'Feature B', content: 'Implement feature B' },
          { title: 'Feature C', content: 'Implement feature C' },
        ],
      };
      const filepath = await createMailboxMessage(
        testDir, 'rt-workitems.md', 'ra', 'dev',
        'Workflow with work items', '', undefined,
        'workflow', payload,
      );
      const parsed = await parseMailboxMessage(filepath);

      expect(parsed.messageType).toBe('workflow');
      expect(parsed.payload).toBeDefined();
      const items = parsed.payload!.workItems as Array<{ title: string; content: string }>;
      expect(items).toHaveLength(3);
      expect(items[0].title).toBe('Feature A');
      expect(items[2].content).toBe('Implement feature C');
    });
  });

  // =====================================================================
  // formatMailboxTimestamp
  // =====================================================================

  describe('formatMailboxTimestamp', () => {
    it('should format date as YYYY-MM-DD-HHMM', () => {
      const date = new Date('2026-03-15T14:30:00Z');
      const ts = formatMailboxTimestamp(date);
      // Result depends on local TZ; just check the format
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}$/);
    });

    it('should use current date when no argument', () => {
      const ts = formatMailboxTimestamp();
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}$/);
    });

    it('should pad single-digit months and days', () => {
      const date = new Date(Date.UTC(2026, 0, 5, 8, 3)); // Jan 5, 08:03 UTC
      const ts = formatMailboxTimestamp(date);
      expect(ts).toBe('2026-01-05-0803');
    });
  });
});
