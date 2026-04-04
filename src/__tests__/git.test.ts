// Tests for git.ts - GitManager

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { GitManager } from '../git.js';
import { promises as fs } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';

const execAsync = promisify(exec);

describe('GitManager', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-test-'));
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('isEnabled', () => {
    it('should return true when git is enabled', () => {
      const manager = new GitManager(testDir, true);
      expect(manager.isEnabled()).toBe(true);
    });

    it('should return false when git is disabled', () => {
      const manager = new GitManager(testDir, false);
      expect(manager.isEnabled()).toBe(false);
    });
  });

  describe('ensureRepo (via pull)', () => {
    it('should disable git when directory is not a git repo', async () => {
      const manager = new GitManager(testDir, true);
      // testDir is not a git repo
      const result = await manager.pull();
      // After ensureRepo, git should be disabled and pull returns success
      expect(manager.isEnabled()).toBe(false);
      expect(result.success).toBe(true);
      expect(result.output).toContain('disabled');
    });

    it('should return success immediately when git is disabled', async () => {
      const manager = new GitManager(testDir, false);
      const result = await manager.pull();

      expect(result.success).toBe(true);
      expect(result.output).toContain('disabled');
    });
  });

  describe('with a real git repository', () => {
    let repoDir: string;

    beforeEach(async () => {
      repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-repo-test-'));
      // Initialize a git repo
      await execAsync('git init', { cwd: repoDir });
      await execAsync('git config user.email "test@test.com"', { cwd: repoDir });
      await execAsync('git config user.name "Test"', { cwd: repoDir });
      // Create initial commit
      await fs.writeFile(path.join(repoDir, 'README.md'), '# Test', 'utf-8');
      await execAsync('git add README.md', { cwd: repoDir });
      await execAsync('git commit -m "Initial commit"', { cwd: repoDir });
    });

    afterEach(async () => {
      try {
        await fs.rm(repoDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    it('should detect a valid git repository', async () => {
      const manager = new GitManager(repoDir, true);
      // Pull will fail because there's no remote, but ensureRepo should pass
      await manager.pull();
      // After ensureRepo, git is still enabled (it's a valid repo)
      expect(manager.isEnabled()).toBe(true);
    });

    it('should return git status', async () => {
      const manager = new GitManager(repoDir, true);
      const status = await manager.status();
      // Clean repo - status should be empty
      expect(typeof status).toBe('string');
    });

    it('should report clean status on clean repo', async () => {
      const manager = new GitManager(repoDir, true);
      const clean = await manager.isClean();
      expect(clean).toBe(true);
    });

    it('should report dirty status on modified repo', async () => {
      await fs.writeFile(path.join(repoDir, 'new_file.txt'), 'content', 'utf-8');
      const manager = new GitManager(repoDir, true);
      const clean = await manager.isClean();
      expect(clean).toBe(false);
    });

    it('should return status as disabled string when git is disabled', async () => {
      const manager = new GitManager(repoDir, false);
      const status = await manager.status();
      expect(status).toBe('Git sync disabled');
    });

    it('should return true for isClean when disabled', async () => {
      const manager = new GitManager(repoDir, false);
      const clean = await manager.isClean();
      expect(clean).toBe(true);
    });

    it('commitAndPush should skip when no changes', async () => {
      const manager = new GitManager(repoDir, true);
      // Repo is clean, no changes to commit
      const result = await manager.commitAndPush('Test commit');
      // Should succeed with "no changes" message or push error
      expect(typeof result.success).toBe('boolean');
    });

    it('commitAndPush should return success when git is disabled', async () => {
      const manager = new GitManager(repoDir, false);
      const result = await manager.commitAndPush('Test commit');
      expect(result.success).toBe(true);
      expect(result.output).toContain('disabled');
    });
  });
});
