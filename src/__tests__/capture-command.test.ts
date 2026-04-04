// Tests for the captureAs feature in state commands.
// Validates that captureCommandOutput executes commands directly and
// returns trimmed stdout, and that the StateCommand interface accepts
// the captureAs field.

import { describe, it, expect, beforeEach } from '@jest/globals';
import { captureCommandOutput } from '../agent.js';
import { StateCommand } from '../workflow-types.js';
import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { realpathSync } from 'fs';

describe('captureCommandOutput', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-cmd-test-'));
  });

  it('should capture trimmed stdout from a successful command', () => {
    const result = captureCommandOutput('echo hello', testDir);
    expect(result.success).toBe(true);
    expect(result.output).toBe('hello');
    expect(result.error).toBeUndefined();
  });

  it('should trim whitespace and newlines from output', () => {
    const result = captureCommandOutput('echo "  spaced  "', testDir);
    expect(result.success).toBe(true);
    expect(result.output).toBe('spaced');
  });

  it('should capture multi-line output trimmed to full content', () => {
    const result = captureCommandOutput('printf "line1\\nline2"', testDir);
    expect(result.success).toBe(true);
    expect(result.output).toContain('line1');
    expect(result.output).toContain('line2');
  });

  it('should return failure for a non-existent command', () => {
    const result = captureCommandOutput(
      'nonexistent_command_xyz_12345',
      testDir,
    );
    expect(result.success).toBe(false);
    expect(result.output).toBe('');
    expect(result.error).toBeDefined();
  });

  it('should return failure for a command that exits non-zero', () => {
    const result = captureCommandOutput('bash -c "exit 1"', testDir);
    expect(result.success).toBe(false);
    expect(result.output).toBe('');
    expect(result.error).toBeDefined();
  });

  it('should execute in the specified working directory', () => {
    const result = captureCommandOutput('pwd', testDir);
    expect(result.success).toBe(true);
    // Resolve symlinks (macOS /tmp -> /private/tmp, Linux tmpfs mounts)
    const resolvedTestDir = realpathSync(testDir);
    expect(result.output).toBe(resolvedTestDir);
  });

  it('should capture git rev-parse HEAD in a git repo', () => {
    // Initialize a temp git repo
    execSync('git init && git commit --allow-empty -m "init"', {
      cwd: testDir,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@test.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@test.com',
      },
    });

    const result = captureCommandOutput('git rev-parse HEAD', testDir);
    expect(result.success).toBe(true);
    // SHA should be 40 hex characters
    expect(result.output).toMatch(/^[0-9a-f]{40}$/);
  });

  it('should return empty output string on failure', () => {
    const result = captureCommandOutput('bash -c "echo oops; exit 1"', testDir);
    expect(result.success).toBe(false);
    expect(result.output).toBe('');
  });
});

describe('StateCommand captureAs typing', () => {
  it('should accept captureAs as an optional field', () => {
    const cmd: StateCommand = {
      command: 'git rev-parse HEAD',
      reason: 'Capture commit SHA',
      captureAs: 'commitSha',
    };
    expect(cmd.captureAs).toBe('commitSha');
  });

  it('should work without captureAs (backward compat)', () => {
    const cmd: StateCommand = {
      command: 'git add -A',
      reason: 'Stage files',
    };
    expect(cmd.captureAs).toBeUndefined();
  });

  it('should accept captureAs with failOnError', () => {
    const cmd: StateCommand = {
      command: 'git rev-parse HEAD',
      reason: 'Capture SHA',
      failOnError: false,
      captureAs: 'commitSha',
    };
    expect(cmd.captureAs).toBe('commitSha');
    expect(cmd.failOnError).toBe(false);
  });
});
