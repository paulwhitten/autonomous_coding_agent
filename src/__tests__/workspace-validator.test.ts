// Tests for workspace-validator.ts

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  validateWorkspaceStructure,
  isInsideProjectRepo,
  getTaskDirectory,
  validateGitCloneSeparation,
  WorkspaceStructure,
} from '../workspace-validator.js';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

describe('workspace-validator', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-validator-test-'));
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('validateWorkspaceStructure', () => {
    it('should return correct structure paths', async () => {
      const structure = await validateWorkspaceStructure(testDir);

      expect(structure.root).toBe(testDir);
      expect(structure.tasksPending).toBe(path.join(testDir, 'tasks', 'pending'));
      expect(structure.tasksCompleted).toBe(path.join(testDir, 'tasks', 'completed'));
      expect(structure.tasksReview).toBe(path.join(testDir, 'tasks', 'review'));
      expect(structure.tasksFailed).toBe(path.join(testDir, 'tasks', 'failed'));
      expect(structure.projectRoot).toBe(path.join(testDir, 'project'));
      expect(structure.githubDir).toBe(path.join(testDir, '.github'));
    });

    it('should create required directories', async () => {
      await validateWorkspaceStructure(testDir);

      const dirsToCheck = [
        path.join(testDir, 'tasks', 'pending'),
        path.join(testDir, 'tasks', 'completed'),
        path.join(testDir, 'tasks', 'review'),
        path.join(testDir, 'tasks', 'failed'),
        path.join(testDir, '.github'),
      ];

      for (const dir of dirsToCheck) {
        const exists = await fs.stat(dir).then(() => true).catch(() => false);
        expect(exists).toBe(true);
      }
    });

    it('should be idempotent (calling twice does not throw)', async () => {
      await validateWorkspaceStructure(testDir);
      await validateWorkspaceStructure(testDir); // should not throw
    });
  });

  describe('isInsideProjectRepo', () => {
    it('should return true for paths inside projectRoot', async () => {
      const structure = await validateWorkspaceStructure(testDir);

      const insidePath = path.join(structure.projectRoot, 'src', 'file.ts');
      expect(isInsideProjectRepo(insidePath, structure)).toBe(true);
    });

    it('should return false for paths outside projectRoot', async () => {
      const structure = await validateWorkspaceStructure(testDir);

      const outsidePath = path.join(testDir, 'tasks', 'pending', 'file.md');
      expect(isInsideProjectRepo(outsidePath, structure)).toBe(false);
    });

    it('should return false for the workspace root itself', async () => {
      const structure = await validateWorkspaceStructure(testDir);
      expect(isInsideProjectRepo(testDir, structure)).toBe(false);
    });

    it('should handle relative paths via resolve', async () => {
      const structure = await validateWorkspaceStructure(testDir);

      // Exact projectRoot should count as inside
      expect(isInsideProjectRepo(structure.projectRoot, structure)).toBe(true);
    });
  });

  describe('getTaskDirectory', () => {
    it('should return pending directory for pending status', async () => {
      const structure = await validateWorkspaceStructure(testDir);
      expect(getTaskDirectory('pending', structure)).toBe(structure.tasksPending);
    });

    it('should return completed directory for completed status', async () => {
      const structure = await validateWorkspaceStructure(testDir);
      expect(getTaskDirectory('completed', structure)).toBe(structure.tasksCompleted);
    });

    it('should return review directory for review status', async () => {
      const structure = await validateWorkspaceStructure(testDir);
      expect(getTaskDirectory('review', structure)).toBe(structure.tasksReview);
    });

    it('should return failed directory for failed status', async () => {
      const structure = await validateWorkspaceStructure(testDir);
      expect(getTaskDirectory('failed', structure)).toBe(structure.tasksFailed);
    });
  });

  describe('validateGitCloneSeparation', () => {
    it('should warn when no .git directory in projectRoot', async () => {
      const structure = await validateWorkspaceStructure(testDir);
      // projectRoot exists but no .git inside -- should not throw
      await fs.mkdir(structure.projectRoot, { recursive: true });
      await expect(validateGitCloneSeparation(structure)).resolves.toBeUndefined();
    });

    it('should pass when .git exists in projectRoot with no tasks/', async () => {
      const structure = await validateWorkspaceStructure(testDir);
      await fs.mkdir(path.join(structure.projectRoot, '.git'), { recursive: true });

      // Should not throw
      await expect(validateGitCloneSeparation(structure)).resolves.toBeUndefined();
    });

    it('should warn when tasks/ directory exists inside projectRoot', async () => {
      const structure = await validateWorkspaceStructure(testDir);
      await fs.mkdir(path.join(structure.projectRoot, '.git'), { recursive: true });
      // Create non-empty tasks/ inside project
      await fs.mkdir(path.join(structure.projectRoot, 'tasks'), { recursive: true });
      await fs.writeFile(
        path.join(structure.projectRoot, 'tasks', 'some_task.md'),
        'content',
        'utf-8'
      );

      // Should not throw even with tasks/ present
      await expect(validateGitCloneSeparation(structure)).resolves.toBeUndefined();
    });
  });
});
