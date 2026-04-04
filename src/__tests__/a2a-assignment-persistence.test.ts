// Tests for A2A assignment file persistence (inbox/archive)

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

// Import the function/class that will handle A2A assignment file persistence
// (Assume A2AAssignmentPersistence is the abstraction for this logic)
import { persistA2AAssignment, readA2AAssignments, archiveA2AAssignment } from '../backends/a2a-backend.js';

describe('A2A Assignment File Persistence', () => {
  let testDir: string;
  let inboxDir: string;
  let archiveDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'a2a-inbox-test-'));
    inboxDir = path.join(testDir, 'a2a_inbox');
    archiveDir = path.join(testDir, 'a2a_archive');
    await fs.mkdir(inboxDir, { recursive: true });
    await fs.mkdir(archiveDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it('should persist incoming assignments as timestamped files', async () => {
    const assignment = { id: 'msg-1', subject: 'Test', content: 'Do work' };
    const filePath = await persistA2AAssignment(inboxDir, assignment);
    expect(filePath.startsWith(inboxDir)).toBe(true);
    expect(filePath.endsWith('.json')).toBe(true);
    const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    expect(content.id).toBe('msg-1');
    expect(content.subject).toBe('Test');
  });

  it('should process assignments FIFO by timestamp', async () => {
    // Write three assignments with different timestamps
    const a1 = { id: 'a', subject: 'A', content: '1' };
    const a2 = { id: 'b', subject: 'B', content: '2' };
    const a3 = { id: 'c', subject: 'C', content: '3' };
    await persistA2AAssignment(inboxDir, a1, '20260402T100000Z');
    await persistA2AAssignment(inboxDir, a2, '20260402T110000Z');
    await persistA2AAssignment(inboxDir, a3, '20260402T120000Z');
    const assignments = await readA2AAssignments(inboxDir);
    expect(assignments.map((a: Record<string, unknown>) => a.id)).toEqual(['a', 'b', 'c']);
  });

  it('should archive processed assignments', async () => {
    const assignment = { id: 'msg-archive', subject: 'Archive', content: 'Done' };
    const filePath = await persistA2AAssignment(inboxDir, assignment);
    await archiveA2AAssignment(filePath, archiveDir);
    const archived = path.join(archiveDir, path.basename(filePath));
    expect(await fs.stat(archived).then(() => true).catch(() => false)).toBe(true);
    expect(await fs.stat(filePath).then(() => true).catch(() => false)).toBe(false);
  });

  it('should deduplicate assignments by message ID', async () => {
    const assignment = { id: 'dedup', subject: 'Dedup', content: 'X' };
    await persistA2AAssignment(inboxDir, assignment);
    // Try to persist again with same ID
    await expect(persistA2AAssignment(inboxDir, assignment)).rejects.toThrow(/duplicate/i);
  });
});
