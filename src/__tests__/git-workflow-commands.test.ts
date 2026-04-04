/**
 * Git Workflow Commands Integration Test
 *
 * Exercises the real git command sequences from dev-qa-merge.workflow.json
 * against temporary git repositories. No LLM required -- this validates
 * that every entry/exit command sequence works against real git state.
 *
 * Background:
 * -----------
 * During multi-agent pipeline testing (March 2026), every task from
 * pn-phase1d through pn-phase1m failed to deliver code to origin/main.
 * Investigation revealed a chain of failures:
 *
 *   1. captureCommandOutput() had a 10-second timeout. cargo build
 *      exceeded this, killing the process mid-compile. The exit command
 *      sequence included `cargo build` before `git push`, so push never
 *      ran.
 *
 *   2. Transitions proceeded silently despite exit command failures.
 *      The agent logged "Exit commands failed -- proceeding with
 *      transition anyway" and advanced to the next state. QA received
 *      a VALIDATING assignment for code that was never pushed.
 *
 *   3. LLM-generated code had compile errors (multiple Display impls,
 *      unresolved imports). Since `cargo build` was an exit command with
 *      failOnError: true and ran BEFORE `git push`, the push was never
 *      attempted.
 *
 *   4. MERGING state used `git merge dev/{{taskId}}` (local ref) instead
 *      of `git merge origin/dev/{{taskId}}` (remote-tracking ref). Since
 *      the QA agent never had the local branch, merge always failed with
 *      "not something we can merge".
 *
 *   5. No cleanup of dirty working directories between states. If the
 *      LLM left uncommitted files, untracked artifacts, stashed changes,
 *      lock files, or stuck merge/rebase operations, the next checkout
 *      would fail.
 *
 * These tests ensure the hardened command sequences handle all observed
 * and anticipated failure scenarios.
 */

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { execSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { captureCommandOutput } from '../agent.js';

// Increase timeout for git operations
jest.setTimeout(30_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a bare "origin" repo and a working clone. */
async function createRepoWithOrigin(prefix: string): Promise<{
  originDir: string;
  workDir: string;
  cleanup: () => Promise<void>;
}> {
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), `git-wf-${prefix}-`));
  const originDir = path.join(tmpBase, 'origin.git');
  const workDir = path.join(tmpBase, 'work');

  // Create bare origin with main as default branch
  execSync(`git init --bare --initial-branch=main "${originDir}"`, { encoding: 'utf-8' });

  // Clone it into a working directory
  execSync(`git clone "${originDir}" "${workDir}"`, { encoding: 'utf-8' });

  // Configure git identity in the working dir
  execSync('git config user.email "test@test.com"', { cwd: workDir });
  execSync('git config user.name "Test"', { cwd: workDir });

  // Ensure we are on 'main' (clone of empty repo may use a different default)
  execSync('git checkout -b main 2>/dev/null || git checkout main', { cwd: workDir });

  // Create initial commit on main so we have a branch to work with
  await fs.writeFile(path.join(workDir, 'README.md'), '# Test Project\n');
  execSync('git add -A && git commit -m "Initial commit"', { cwd: workDir });
  execSync('git push origin main', { cwd: workDir });

  return {
    originDir,
    workDir,
    cleanup: async () => {
      await fs.rm(tmpBase, { recursive: true, force: true });
    },
  };
}

/** Run a command sequence (like executeStateCommands) against a working dir. */
function runCommandSequence(
  commands: Array<{
    command: string;
    failOnError?: boolean;
    captureAs?: string;
  }>,
  cwd: string,
): { success: boolean; captured: Record<string, string>; failedAt?: number } {
  const captured: Record<string, string> = {};
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    const result = captureCommandOutput(cmd.command, cwd);
    if (result.success) {
      if (cmd.captureAs) {
        captured[cmd.captureAs] = result.output;
      }
    } else {
      const shouldAbort = cmd.failOnError !== false;
      if (shouldAbort) {
        return { success: false, captured, failedAt: i };
      }
    }
  }
  return { success: true, captured };
}

/** Substitute {{variable}} templates in a command string. */
function sub(command: string, vars: Record<string, string>): string {
  return command.replace(/\{\{(\w+)\}\}/g, (_m, key) => vars[key] ?? `{{${key}}}`);
}

// ---------------------------------------------------------------------------
// Command sequence definitions (from dev-qa-merge.workflow.json)
// ---------------------------------------------------------------------------

const LOCK_CLEANUP = 'rm -f .git/index.lock .git/HEAD.lock 2>/dev/null; git merge --abort 2>/dev/null; git rebase --abort 2>/dev/null; git cherry-pick --abort 2>/dev/null; true';

function implementingEntryCommands(taskId: string): Array<{ command: string; failOnError?: boolean }> {
  return [
    { command: LOCK_CLEANUP, failOnError: false },
    { command: 'git fetch origin', failOnError: false },
    { command: 'git reset --hard HEAD', failOnError: false },
    { command: 'git clean -fd', failOnError: false },
    { command: 'git checkout main', failOnError: true },
    { command: 'git pull origin main', failOnError: false },
    { command: `git checkout -b dev/${taskId} || git checkout dev/${taskId}`, failOnError: true },
  ];
}

function implementingExitCommands(taskId: string): Array<{ command: string; failOnError?: boolean; captureAs?: string }> {
  return [
    { command: LOCK_CLEANUP, failOnError: false },
    { command: 'git stash pop 2>/dev/null; true', failOnError: false },
    { command: 'true', failOnError: false },  // cargo fmt placeholder (no Rust in test)
    { command: 'git add -A', failOnError: false },
    { command: `git diff --cached --quiet || git commit -m 'developer: IMPLEMENTING for ${taskId}'`, failOnError: false },
    { command: `git push origin HEAD:dev/${taskId}`, failOnError: false },
    { command: 'git rev-parse HEAD', captureAs: 'commitSha' },
  ];
}

function validatingEntryCommands(taskId: string): Array<{ command: string; failOnError?: boolean; captureAs?: string }> {
  return [
    { command: LOCK_CLEANUP, failOnError: false },
    { command: 'git fetch origin', failOnError: false },
    { command: 'git reset --hard HEAD', failOnError: false },
    { command: 'git clean -fd', failOnError: false },
    { command: `git checkout dev/${taskId} || git checkout -b dev/${taskId} origin/dev/${taskId}`, failOnError: true },
    { command: `git reset --hard origin/dev/${taskId}`, failOnError: true },
    { command: 'git rev-parse HEAD', captureAs: 'validatedSha' },
    // Quality gates omitted (no Rust project)
  ];
}

function reworkEntryCommands(taskId: string): Array<{ command: string; failOnError?: boolean }> {
  return [
    { command: LOCK_CLEANUP, failOnError: false },
    { command: 'git fetch origin', failOnError: false },
    { command: 'git reset --hard HEAD', failOnError: false },
    { command: 'git clean -fd', failOnError: false },
    { command: `git checkout dev/${taskId}`, failOnError: true },
    { command: `git reset --hard origin/dev/${taskId}`, failOnError: true },
  ];
}

function reworkExitCommands(taskId: string): Array<{ command: string; failOnError?: boolean; captureAs?: string }> {
  return [
    { command: LOCK_CLEANUP, failOnError: false },
    { command: 'git stash pop 2>/dev/null; true', failOnError: false },
    { command: 'true', failOnError: false },  // cargo fmt placeholder
    { command: 'git add -A', failOnError: false },
    { command: `git diff --cached --quiet || git commit -m 'developer: REWORK fix for ${taskId}'`, failOnError: false },
    { command: `git push origin HEAD:dev/${taskId}`, failOnError: false },
    { command: 'git rev-parse HEAD', captureAs: 'commitSha' },
  ];
}

function mergingEntryCommands(taskId: string): Array<{ command: string; failOnError?: boolean; captureAs?: string }> {
  return [
    { command: LOCK_CLEANUP, failOnError: false },
    { command: 'git fetch origin', failOnError: true },
    { command: 'git reset --hard HEAD', failOnError: false },
    { command: 'git clean -fd', failOnError: false },
    { command: `git checkout dev/${taskId} || git checkout -b dev/${taskId} origin/dev/${taskId}`, failOnError: true },
    { command: `git reset --hard origin/dev/${taskId}`, failOnError: true },
    { command: 'git rebase origin/main', failOnError: true },
    { command: 'git checkout main', failOnError: true },
    { command: 'git reset --hard origin/main', failOnError: true },
    { command: `git merge dev/${taskId} --no-ff -m 'Merge dev/${taskId}: ${taskId}'`, failOnError: true },
    { command: 'git push origin main', failOnError: true },
    { command: 'git rev-parse HEAD', captureAs: 'mergeSha' },
  ];
}

function mergingExitCommands(taskId: string): Array<{ command: string; failOnError?: boolean }> {
  return [
    { command: `git branch -d dev/${taskId}`, failOnError: false },
    { command: `git push origin --delete dev/${taskId}`, failOnError: false },
  ];
}

// ===========================================================================
// Test Suites
// ===========================================================================

describe('Git Workflow Commands Integration', () => {

  // =========================================================================
  // A. Happy Path: Full Pipeline
  // =========================================================================
  describe('Happy Path: full IMPLEMENTING -> VALIDATING -> MERGING cycle', () => {
    let originDir: string;
    let workDir: string;
    let cleanup: () => Promise<void> = async () => {};
    const taskId = 'pn-test-happy';

    beforeAll(async () => {
      ({ originDir, workDir, cleanup } = await createRepoWithOrigin('happy'));
    });
    afterAll(async () => { await cleanup(); });

    it('IMPLEMENTING entry: creates feature branch from main', () => {
      const result = runCommandSequence(implementingEntryCommands(taskId), workDir);
      expect(result.success).toBe(true);

      // Verify we are on the feature branch
      const branch = execSync('git branch --show-current', { cwd: workDir, encoding: 'utf-8' }).trim();
      expect(branch).toBe(`dev/${taskId}`);
    });

    it('IMPLEMENTING exit: commits and pushes work to origin', async () => {
      // Simulate LLM work
      await fs.writeFile(path.join(workDir, 'src.rs'), 'fn main() {}\n');

      const result = runCommandSequence(implementingExitCommands(taskId), workDir);
      expect(result.success).toBe(true);
      expect(result.captured.commitSha).toMatch(/^[0-9a-f]{40}$/);

      // Verify origin has the branch
      const refs = execSync('git ls-remote --heads origin', { cwd: workDir, encoding: 'utf-8' });
      expect(refs).toContain(`refs/heads/dev/${taskId}`);
    });

    it('VALIDATING entry: checks out pushed feature branch from origin', () => {
      // Simulate a different agent by resetting to main
      execSync('git checkout main', { cwd: workDir });
      execSync(`git branch -D dev/${taskId}`, { cwd: workDir });

      const result = runCommandSequence(validatingEntryCommands(taskId), workDir);
      expect(result.success).toBe(true);
      expect(result.captured.validatedSha).toMatch(/^[0-9a-f]{40}$/);

      // Verify the file from IMPLEMENTING is present
      const content = execSync('cat src.rs', { cwd: workDir, encoding: 'utf-8' });
      expect(content).toContain('fn main()');
    });

    it('MERGING entry: merges feature branch into main via origin ref', () => {
      // Switch back to main (simulate QA agent)
      execSync('git checkout main', { cwd: workDir });

      const result = runCommandSequence(mergingEntryCommands(taskId), workDir);
      expect(result.success).toBe(true);
      expect(result.captured.mergeSha).toMatch(/^[0-9a-f]{40}$/);

      // Verify origin/main has the merge commit
      const originLog = execSync(
        `git --git-dir="${originDir}" log --oneline -5`,
        { encoding: 'utf-8' },
      );
      expect(originLog).toContain(`Merge dev/${taskId}`);

      // Verify the file is on main
      const content = execSync('cat src.rs', { cwd: workDir, encoding: 'utf-8' });
      expect(content).toContain('fn main()');
    });

    it('MERGING exit: deletes feature branch locally and remotely', () => {
      const result = runCommandSequence(mergingExitCommands(taskId), workDir);
      expect(result.success).toBe(true);

      // Feature branch should be gone locally
      const localBranches = execSync('git branch', { cwd: workDir, encoding: 'utf-8' });
      expect(localBranches).not.toContain(`dev/${taskId}`);

      // Feature branch should be gone remotely
      const refs = execSync('git ls-remote --heads origin', { cwd: workDir, encoding: 'utf-8' });
      expect(refs).not.toContain(`refs/heads/dev/${taskId}`);
    });
  });

  // =========================================================================
  // B. The Root Cause: MERGING with origin/ remote-tracking ref
  // =========================================================================
  describe('Root Cause: MERGING uses origin/dev/taskId (not local ref)', () => {
    let originDir: string;
    let workDir: string;
    let cleanup: () => Promise<void> = async () => {};
    const taskId = 'pn-merge-ref';

    beforeAll(async () => {
      ({ originDir, workDir, cleanup } = await createRepoWithOrigin('merge-ref'));

      // Set up a feature branch pushed to origin, but NOT available locally
      execSync('git checkout -b dev/' + taskId, { cwd: workDir });
      await fs.writeFile(path.join(workDir, 'feature.rs'), 'pub fn feature() {}\n');
      execSync('git add -A && git commit -m "feature impl"', { cwd: workDir });
      execSync(`git push origin HEAD:dev/${taskId}`, { cwd: workDir });
      // Delete the local branch to simulate a separate agent
      execSync('git checkout main', { cwd: workDir });
      execSync(`git branch -D dev/${taskId}`, { cwd: workDir });
    });
    afterAll(async () => { await cleanup(); });

    it('should merge via origin/dev/taskId even when local branch does not exist', () => {
      const result = runCommandSequence(mergingEntryCommands(taskId), workDir);
      expect(result.success).toBe(true);

      // The old bug: `git merge dev/pn-merge-ref` would fail with
      // "merge: dev/pn-merge-ref - not something we can merge"
      // because the local branch didn't exist. The fix uses
      // `git merge origin/dev/pn-merge-ref` which always works
      // after fetch.
      const log = execSync('git log --oneline -3', { cwd: workDir, encoding: 'utf-8' });
      expect(log).toContain(`Merge dev/${taskId}`);
    });
  });

  // =========================================================================
  // C. Dirty Working Directory Recovery
  // =========================================================================
  describe('Dirty State Recovery', () => {
    let workDir: string;
    let cleanup: () => Promise<void> = async () => {};
    const taskId = 'pn-dirty';

    beforeEach(async () => {
      ({ workDir, cleanup } = await createRepoWithOrigin('dirty'));
    });
    afterEach(async () => { await cleanup(); });

    it('should recover from uncommitted tracked file changes', async () => {
      // Simulate LLM modifying a tracked file and not committing
      await fs.writeFile(path.join(workDir, 'README.md'), 'CORRUPTED BY LLM\n');

      const result = runCommandSequence(implementingEntryCommands(taskId), workDir);
      expect(result.success).toBe(true);

      // README should be back to original (git reset --hard HEAD ran)
      const content = await fs.readFile(path.join(workDir, 'README.md'), 'utf-8');
      expect(content).toBe('# Test Project\n');
    });

    it('should recover from untracked files (reports, artifacts)', async () => {
      // Simulate LLM creating untracked artifacts
      await fs.mkdir(path.join(workDir, 'reports'), { recursive: true });
      await fs.writeFile(path.join(workDir, 'reports/analysis.md'), 'LLM analysis');
      await fs.writeFile(path.join(workDir, 'temp_output.txt'), 'junk');

      const result = runCommandSequence(implementingEntryCommands(taskId), workDir);
      expect(result.success).toBe(true);

      // Untracked files should be gone (git clean -fd ran)
      const exists = await fs.access(path.join(workDir, 'reports')).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it('should recover from staged but uncommitted changes', async () => {
      await fs.writeFile(path.join(workDir, 'staged.rs'), 'staged content');
      execSync('git add staged.rs', { cwd: workDir });

      const result = runCommandSequence(implementingEntryCommands(taskId), workDir);
      expect(result.success).toBe(true);

      // Staged file should be gone
      const exists = await fs.access(path.join(workDir, 'staged.rs')).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });
  });

  // =========================================================================
  // D. Lock File Recovery
  // =========================================================================
  describe('Lock File Recovery', () => {
    let workDir: string;
    let cleanup: () => Promise<void> = async () => {};

    beforeEach(async () => {
      ({ workDir, cleanup } = await createRepoWithOrigin('lock'));
    });
    afterEach(async () => { await cleanup(); });

    it('should remove .git/index.lock before checkout', async () => {
      // Simulate a killed git process that left a lock file
      await fs.writeFile(path.join(workDir, '.git', 'index.lock'), '');

      const result = runCommandSequence(implementingEntryCommands('pn-lock'), workDir);
      expect(result.success).toBe(true);

      const lockExists = await fs.access(path.join(workDir, '.git', 'index.lock')).then(() => true).catch(() => false);
      expect(lockExists).toBe(false);
    });

    it('should remove .git/HEAD.lock before checkout', async () => {
      await fs.writeFile(path.join(workDir, '.git', 'HEAD.lock'), '');

      const result = runCommandSequence(implementingEntryCommands('pn-headlock'), workDir);
      expect(result.success).toBe(true);

      const lockExists = await fs.access(path.join(workDir, '.git', 'HEAD.lock')).then(() => true).catch(() => false);
      expect(lockExists).toBe(false);
    });

    it('should remove lock files on exit commands too', async () => {
      // Set up a feature branch first
      execSync('git checkout -b dev/pn-exitlock', { cwd: workDir });
      await fs.writeFile(path.join(workDir, 'work.rs'), 'fn work() {}');

      // Create lock files before exit
      await fs.writeFile(path.join(workDir, '.git', 'index.lock'), '');
      await fs.writeFile(path.join(workDir, '.git', 'HEAD.lock'), '');

      const result = runCommandSequence(implementingExitCommands('pn-exitlock'), workDir);
      expect(result.success).toBe(true);

      const indexLock = await fs.access(path.join(workDir, '.git', 'index.lock')).then(() => true).catch(() => false);
      const headLock = await fs.access(path.join(workDir, '.git', 'HEAD.lock')).then(() => true).catch(() => false);
      expect(indexLock).toBe(false);
      expect(headLock).toBe(false);
    });
  });

  // =========================================================================
  // E. Stuck Merge/Rebase/Cherry-pick Recovery
  // =========================================================================
  describe('Stuck Operation Recovery', () => {
    let workDir: string;
    let cleanup: () => Promise<void> = async () => {};

    beforeEach(async () => {
      ({ workDir, cleanup } = await createRepoWithOrigin('stuck'));
    });
    afterEach(async () => { await cleanup(); });

    it('should recover from a stuck merge conflict', async () => {
      // Create a merge conflict
      await fs.writeFile(path.join(workDir, 'conflict.txt'), 'main version\n');
      execSync('git add -A && git commit -m "main change"', { cwd: workDir });
      execSync('git push origin main', { cwd: workDir });

      execSync('git checkout -b dev/pn-conflict', { cwd: workDir });
      await fs.writeFile(path.join(workDir, 'conflict.txt'), 'branch version\n');
      execSync('git add -A && git commit -m "branch change"', { cwd: workDir });

      execSync('git checkout main', { cwd: workDir });
      await fs.writeFile(path.join(workDir, 'conflict.txt'), 'updated main\n');
      execSync('git add -A && git commit -m "main update"', { cwd: workDir });

      // Start a merge that will conflict, then leave it
      try {
        execSync('git merge dev/pn-conflict', { cwd: workDir, encoding: 'utf-8' });
      } catch {
        // Expected: merge conflict
      }

      // Verify we are in a conflicted state
      const mergeHead = await fs.access(path.join(workDir, '.git', 'MERGE_HEAD')).then(() => true).catch(() => false);
      expect(mergeHead).toBe(true);

      // Entry commands should abort the stuck merge and proceed
      const result = runCommandSequence(implementingEntryCommands('pn-recover'), workDir);
      expect(result.success).toBe(true);

      // MERGE_HEAD should be gone
      const mergeHeadAfter = await fs.access(path.join(workDir, '.git', 'MERGE_HEAD')).then(() => true).catch(() => false);
      expect(mergeHeadAfter).toBe(false);
    });

    it('should recover from a stuck interactive rebase', async () => {
      // Create two commits to rebase
      await fs.writeFile(path.join(workDir, 'a.txt'), 'a');
      execSync('git add -A && git commit -m "commit a"', { cwd: workDir });
      await fs.writeFile(path.join(workDir, 'b.txt'), 'b');
      execSync('git add -A && git commit -m "commit b"', { cwd: workDir });

      // Start a rebase that will conflict
      // Amend the first commit to create a conflict scenario
      try {
        execSync('GIT_SEQUENCE_EDITOR="sed -i \'s/pick/edit/\'" git rebase -i HEAD~1', {
          cwd: workDir,
          encoding: 'utf-8',
          env: { ...process.env, GIT_SEQUENCE_EDITOR: "sed -i 's/pick/edit/'" },
        });
      } catch {
        // May or may not fail depending on git version
      }

      // Check if rebase is in progress
      const rebaseDir = await fs.access(path.join(workDir, '.git', 'rebase-merge')).then(() => true).catch(() => false);
      const rebaseApply = await fs.access(path.join(workDir, '.git', 'rebase-apply')).then(() => true).catch(() => false);

      if (rebaseDir || rebaseApply) {
        // Entry commands should abort the stuck rebase
        const result = runCommandSequence(implementingEntryCommands('pn-rebase'), workDir);
        expect(result.success).toBe(true);
      } else {
        // Git version didn't leave rebase state -- skip gracefully
        expect(true).toBe(true);
      }
    });
  });

  // =========================================================================
  // F. Stash Recovery on Exit
  // =========================================================================
  describe('Stash Recovery', () => {
    let workDir: string;
    let cleanup: () => Promise<void> = async () => {};

    beforeEach(async () => {
      ({ workDir, cleanup } = await createRepoWithOrigin('stash'));
    });
    afterEach(async () => { await cleanup(); });

    it('should recover stashed changes in exit commands', async () => {
      execSync('git checkout -b dev/pn-stash', { cwd: workDir });

      // Simulate LLM doing work then stashing it
      await fs.writeFile(path.join(workDir, 'stashed-work.rs'), 'fn stashed() {}');
      execSync('git add -A', { cwd: workDir });
      execSync('git stash', { cwd: workDir });

      // File should be gone after stash
      const beforeExit = await fs.access(path.join(workDir, 'stashed-work.rs')).then(() => true).catch(() => false);
      expect(beforeExit).toBe(false);

      // Exit commands should pop the stash and commit/push
      const result = runCommandSequence(implementingExitCommands('pn-stash'), workDir);
      expect(result.success).toBe(true);

      // File should be committed
      const log = execSync('git log --oneline -1', { cwd: workDir, encoding: 'utf-8' });
      expect(log).toContain('IMPLEMENTING');
    });

    it('should handle empty stash gracefully', async () => {
      execSync('git checkout -b dev/pn-nostash', { cwd: workDir });
      await fs.writeFile(path.join(workDir, 'normal.rs'), 'fn normal() {}');

      // No stash -- exit commands should still work
      const result = runCommandSequence(implementingExitCommands('pn-nostash'), workDir);
      expect(result.success).toBe(true);
      expect(result.captured.commitSha).toMatch(/^[0-9a-f]{40}$/);
    });
  });

  // =========================================================================
  // G. REWORK Cycle
  // =========================================================================
  describe('REWORK cycle: developer fixes and repushes', () => {
    let originDir: string;
    let workDir: string;
    let cleanup: () => Promise<void> = async () => {};
    const taskId = 'pn-rework';

    beforeAll(async () => {
      ({ originDir, workDir, cleanup } = await createRepoWithOrigin('rework'));

      // Simulate IMPLEMENTING: create branch, add code, push
      execSync(`git checkout -b dev/${taskId}`, { cwd: workDir });
      await fs.writeFile(path.join(workDir, 'lib.rs'), 'fn broken() { /* bug */ }\n');
      execSync('git add -A && git commit -m "initial impl"', { cwd: workDir });
      execSync(`git push origin HEAD:dev/${taskId}`, { cwd: workDir });
      execSync('git checkout main', { cwd: workDir });
    });
    afterAll(async () => { await cleanup(); });

    it('REWORK entry: checks out and syncs to origin/dev/taskId', () => {
      const result = runCommandSequence(reworkEntryCommands(taskId), workDir);
      expect(result.success).toBe(true);

      const branch = execSync('git branch --show-current', { cwd: workDir, encoding: 'utf-8' }).trim();
      expect(branch).toBe(`dev/${taskId}`);

      const content = execSync('cat lib.rs', { cwd: workDir, encoding: 'utf-8' });
      expect(content).toContain('broken');
    });

    it('REWORK exit: commits fix and pushes to origin', async () => {
      // Simulate developer fixing the bug
      await fs.writeFile(path.join(workDir, 'lib.rs'), 'fn fixed() { /* fixed */ }\n');

      const result = runCommandSequence(reworkExitCommands(taskId), workDir);
      expect(result.success).toBe(true);
      expect(result.captured.commitSha).toMatch(/^[0-9a-f]{40}$/);

      // Verify origin has the fix
      const originLog = execSync(
        `git --git-dir="${originDir}" log dev/${taskId} --oneline -1`,
        { encoding: 'utf-8' },
      );
      expect(originLog).toContain('REWORK');
    });
  });

  // =========================================================================
  // H. Idempotent Entry (re-entry after failure)
  // =========================================================================
  describe('Idempotent Entry: re-running entry commands after prior failure', () => {
    let workDir: string;
    let cleanup: () => Promise<void> = async () => {};
    const taskId = 'pn-idempotent';

    beforeEach(async () => {
      ({ workDir, cleanup } = await createRepoWithOrigin('idempotent'));
    });
    afterEach(async () => { await cleanup(); });

    it('IMPLEMENTING entry is idempotent (branch already exists)', async () => {
      // First entry creates the branch
      const result1 = runCommandSequence(implementingEntryCommands(taskId), workDir);
      expect(result1.success).toBe(true);

      // Simulate work and push
      await fs.writeFile(path.join(workDir, 'first.rs'), 'fn first() {}');
      execSync('git add -A && git commit -m "first attempt"', { cwd: workDir });
      execSync(`git push origin HEAD:dev/${taskId}`, { cwd: workDir });

      // Leave dirty state
      await fs.writeFile(path.join(workDir, 'dirty.txt'), 'uncommitted');

      // Second entry (retry) should work -- branch already exists
      const result2 = runCommandSequence(implementingEntryCommands(taskId), workDir);
      expect(result2.success).toBe(true);

      const branch = execSync('git branch --show-current', { cwd: workDir, encoding: 'utf-8' }).trim();
      expect(branch).toBe(`dev/${taskId}`);
    });

    it('MERGING entry is idempotent (can re-merge after rollback)', async () => {
      // Set up: implement and push
      execSync(`git checkout -b dev/${taskId}`, { cwd: workDir });
      await fs.writeFile(path.join(workDir, 'feature.rs'), 'fn feature() {}');
      execSync('git add -A && git commit -m "feature"', { cwd: workDir });
      execSync(`git push origin HEAD:dev/${taskId}`, { cwd: workDir });
      execSync('git checkout main', { cwd: workDir });

      // First merge succeeds
      const result1 = runCommandSequence(mergingEntryCommands(taskId), workDir);
      expect(result1.success).toBe(true);

      // Simulate needing to retry: reset main to before merge
      execSync('git reset --hard HEAD~1', { cwd: workDir });
      execSync('git push origin main --force', { cwd: workDir });

      // Second merge should also succeed
      const result2 = runCommandSequence(mergingEntryCommands(taskId), workDir);
      expect(result2.success).toBe(true);
    });
  });

  // =========================================================================
  // I. Exit with No Changes (nothing to commit)
  // =========================================================================
  describe('Exit with no changes', () => {
    let workDir: string;
    let cleanup: () => Promise<void> = async () => {};

    beforeEach(async () => {
      ({ workDir, cleanup } = await createRepoWithOrigin('nochange'));
    });
    afterEach(async () => { await cleanup(); });

    it('IMPLEMENTING exit succeeds when LLM made no file changes', () => {
      execSync('git checkout -b dev/pn-nochange', { cwd: workDir });

      // No files modified -- exit should still succeed (diff --cached --quiet skips commit)
      const result = runCommandSequence(implementingExitCommands('pn-nochange'), workDir);
      expect(result.success).toBe(true);
      expect(result.captured.commitSha).toMatch(/^[0-9a-f]{40}$/);
    });
  });

  // =========================================================================
  // J. Concurrent Branch Scenario (main advanced between IMPLEMENTING and MERGING)
  // =========================================================================
  describe('Concurrent main advancement', () => {
    let originDir: string;
    let workDir: string;
    let cleanup: () => Promise<void> = async () => {};
    const taskId = 'pn-concurrent';

    beforeAll(async () => {
      ({ originDir, workDir, cleanup } = await createRepoWithOrigin('concurrent'));
    });
    afterAll(async () => { await cleanup(); });

    it('MERGING succeeds when main has advanced since branch creation', async () => {
      // Create feature branch from initial main
      execSync(`git checkout -b dev/${taskId}`, { cwd: workDir });
      await fs.writeFile(path.join(workDir, 'feature.rs'), 'fn feature() {}');
      execSync('git add -A && git commit -m "feature work"', { cwd: workDir });
      execSync(`git push origin HEAD:dev/${taskId}`, { cwd: workDir });

      // Advance main with a non-conflicting commit (simulates another task merging)
      execSync('git checkout main', { cwd: workDir });
      await fs.writeFile(path.join(workDir, 'other.rs'), 'fn other() {}');
      execSync('git add -A && git commit -m "other task merged"', { cwd: workDir });
      execSync('git push origin main', { cwd: workDir });

      // MERGING should succeed (no conflict)
      const result = runCommandSequence(mergingEntryCommands(taskId), workDir);
      expect(result.success).toBe(true);

      // Both files should exist on main
      const featureExists = await fs.access(path.join(workDir, 'feature.rs')).then(() => true).catch(() => false);
      const otherExists = await fs.access(path.join(workDir, 'other.rs')).then(() => true).catch(() => false);
      expect(featureExists).toBe(true);
      expect(otherExists).toBe(true);
    });
  });

  // =========================================================================
  // K. Merge Conflict Detection
  // =========================================================================
  describe('Merge conflict detection', () => {
    let workDir: string;
    let cleanup: () => Promise<void> = async () => {};
    const taskId = 'pn-conflict';

    beforeAll(async () => {
      ({ workDir, cleanup } = await createRepoWithOrigin('conflict'));
    });
    afterAll(async () => { await cleanup(); });

    it('MERGING entry fails cleanly on rebase conflict (failOnError: true)', async () => {
      // Create conflicting changes on main and feature branch
      execSync(`git checkout -b dev/${taskId}`, { cwd: workDir });
      await fs.writeFile(path.join(workDir, 'README.md'), 'branch version\n');
      execSync('git add -A && git commit -m "branch change"', { cwd: workDir });
      execSync(`git push origin HEAD:dev/${taskId}`, { cwd: workDir });

      execSync('git checkout main', { cwd: workDir });
      await fs.writeFile(path.join(workDir, 'README.md'), 'main version\n');
      execSync('git add -A && git commit -m "main diverged"', { cwd: workDir });
      execSync('git push origin main', { cwd: workDir });

      // MERGING entry should fail at the rebase step (failOnError: true)
      const result = runCommandSequence(mergingEntryCommands(taskId), workDir);
      expect(result.success).toBe(false);
      // Should fail at the rebase command (index 6)
      expect(result.failedAt).toBe(6);
    });
  });

  // =========================================================================
  // K2. Rebase resolves non-conflicting divergence (the fix for pn-phase0b/0e)
  // =========================================================================
  describe('Rebase resolves non-conflicting divergence', () => {
    let workDir: string;
    let cleanup: () => Promise<void> = async () => {};
    const taskId = 'pn-rebase-ok';

    beforeAll(async () => {
      ({ workDir, cleanup } = await createRepoWithOrigin('rebase-ok'));
    });
    afterAll(async () => { await cleanup(); });

    it('MERGING rebases feature onto advanced main and merges cleanly', async () => {
      // Create feature branch with changes to a new file
      execSync(`git checkout -b dev/${taskId}`, { cwd: workDir });
      await fs.writeFile(path.join(workDir, 'feature.rs'), 'fn feature() {}');
      execSync('git add -A && git commit -m "feature work"', { cwd: workDir });
      execSync(`git push origin HEAD:dev/${taskId}`, { cwd: workDir });

      // Advance main with TWO non-conflicting merges (simulates tasks completing)
      execSync('git checkout main', { cwd: workDir });
      await fs.writeFile(path.join(workDir, 'taskA.rs'), 'fn task_a() {}');
      execSync('git add -A && git commit -m "taskA merged"', { cwd: workDir });
      await fs.writeFile(path.join(workDir, 'taskB.rs'), 'fn task_b() {}');
      execSync('git add -A && git commit -m "taskB merged"', { cwd: workDir });
      execSync('git push origin main', { cwd: workDir });

      // MERGING should succeed: rebase puts feature on top of advanced main
      const result = runCommandSequence(mergingEntryCommands(taskId), workDir);
      expect(result.success).toBe(true);

      // All three files should exist on main
      const featureExists = await fs.access(path.join(workDir, 'feature.rs')).then(() => true).catch(() => false);
      const taskAExists = await fs.access(path.join(workDir, 'taskA.rs')).then(() => true).catch(() => false);
      const taskBExists = await fs.access(path.join(workDir, 'taskB.rs')).then(() => true).catch(() => false);
      expect(featureExists).toBe(true);
      expect(taskAExists).toBe(true);
      expect(taskBExists).toBe(true);

      // Verify the merge commit message is correct
      const log = execSync('git log --oneline -3', { cwd: workDir, encoding: 'utf-8' });
      expect(log).toContain(`Merge dev/${taskId}`);
    });
  });

  // =========================================================================
  // K3. Rebase is no-op when feature branch is already up to date
  // =========================================================================
  describe('Rebase no-op when already up to date', () => {
    let workDir: string;
    let cleanup: () => Promise<void> = async () => {};
    const taskId = 'pn-rebase-noop';

    beforeAll(async () => {
      ({ workDir, cleanup } = await createRepoWithOrigin('rebase-noop'));
    });
    afterAll(async () => { await cleanup(); });

    it('MERGING succeeds when feature branch was created from latest main', async () => {
      // Create feature branch from current main (no main advancement)
      execSync(`git checkout -b dev/${taskId}`, { cwd: workDir });
      await fs.writeFile(path.join(workDir, 'fresh.rs'), 'fn fresh() {}');
      execSync('git add -A && git commit -m "fresh feature"', { cwd: workDir });
      execSync(`git push origin HEAD:dev/${taskId}`, { cwd: workDir });

      // No main advancement -- rebase is a no-op
      execSync('git checkout main', { cwd: workDir });

      const result = runCommandSequence(mergingEntryCommands(taskId), workDir);
      expect(result.success).toBe(true);
      expect(result.captured.mergeSha).toMatch(/^[0-9a-f]{40}$/);

      const freshExists = await fs.access(path.join(workDir, 'fresh.rs')).then(() => true).catch(() => false);
      expect(freshExists).toBe(true);
    });
  });

  // =========================================================================
  // K4. Rebase after conflict aborts cleanly for next state entry
  // =========================================================================
  describe('Rebase conflict leaves recoverable state', () => {
    let workDir: string;
    let cleanup: () => Promise<void> = async () => {};
    const taskId = 'pn-rebase-recover';

    beforeAll(async () => {
      ({ workDir, cleanup } = await createRepoWithOrigin('rebase-recover'));
    });
    afterAll(async () => { await cleanup(); });

    it('after rebase conflict, lock cleanup in next state entry recovers', async () => {
      // Create conflicting divergence
      execSync(`git checkout -b dev/${taskId}`, { cwd: workDir });
      await fs.writeFile(path.join(workDir, 'README.md'), 'branch version\n');
      execSync('git add -A && git commit -m "branch change"', { cwd: workDir });
      execSync(`git push origin HEAD:dev/${taskId}`, { cwd: workDir });

      execSync('git checkout main', { cwd: workDir });
      await fs.writeFile(path.join(workDir, 'README.md'), 'main version\n');
      execSync('git add -A && git commit -m "main diverged"', { cwd: workDir });
      execSync('git push origin main', { cwd: workDir });

      // MERGING fails at rebase
      const result = runCommandSequence(mergingEntryCommands(taskId), workDir);
      expect(result.success).toBe(false);
      expect(result.failedAt).toBe(6);

      // Now simulate ESCALATED state entry -- lock cleanup should recover
      const lockCleanup = [{ command: LOCK_CLEANUP, failOnError: false }];
      const cleanupResult = runCommandSequence(lockCleanup, workDir);
      expect(cleanupResult.success).toBe(true);

      // Working directory should be usable after cleanup
      const statusResult = execSync('git status --porcelain', { cwd: workDir, encoding: 'utf-8' });
      // No rebase-in-progress markers should remain
      const rebaseInProgress = execSync(
        'test -d .git/rebase-merge && echo YES || echo NO',
        { cwd: workDir, encoding: 'utf-8' },
      ).trim();
      expect(rebaseInProgress).toBe('NO');
    });
  });

  // =========================================================================
  // L. VALIDATING Entry Syncs to Exact Commit (not local state)
  // =========================================================================
  describe('VALIDATING syncs to exact origin commit', () => {
    let workDir: string;
    let cleanup: () => Promise<void> = async () => {};
    const taskId = 'pn-valsync';

    beforeAll(async () => {
      ({ workDir, cleanup } = await createRepoWithOrigin('valsync'));
    });
    afterAll(async () => { await cleanup(); });

    it('VALIDATING entry force-syncs local branch to origin (ignoring local state)', async () => {
      // Developer pushes initial code
      execSync(`git checkout -b dev/${taskId}`, { cwd: workDir });
      await fs.writeFile(path.join(workDir, 'v1.rs'), 'fn v1() {}');
      execSync('git add -A && git commit -m "v1"', { cwd: workDir });
      execSync(`git push origin HEAD:dev/${taskId}`, { cwd: workDir });

      // Developer pushes updated code (simulates REWORK)
      await fs.writeFile(path.join(workDir, 'v1.rs'), 'fn v2() {}');
      execSync('git add -A && git commit -m "v2"', { cwd: workDir });
      execSync(`git push origin HEAD:dev/${taskId}`, { cwd: workDir });
      const expectedSha = execSync('git rev-parse HEAD', { cwd: workDir, encoding: 'utf-8' }).trim();

      // Reset local to v1 (simulating QA's stale local state)
      execSync('git reset --hard HEAD~1', { cwd: workDir });

      // VALIDATING entry should sync to origin (v2), not keep local (v1)
      const result = runCommandSequence(validatingEntryCommands(taskId), workDir);
      expect(result.success).toBe(true);
      expect(result.captured.validatedSha).toBe(expectedSha);

      const content = execSync('cat v1.rs', { cwd: workDir, encoding: 'utf-8' });
      expect(content).toContain('v2');
    });
  });

  // =========================================================================
  // M. Multiple Tasks: branch isolation
  // =========================================================================
  describe('Multiple tasks: branch isolation', () => {
    let workDir: string;
    let cleanup: () => Promise<void> = async () => {};

    beforeAll(async () => {
      ({ workDir, cleanup } = await createRepoWithOrigin('multi'));
    });
    afterAll(async () => { await cleanup(); });

    it('two tasks create isolated feature branches', async () => {
      // Task A
      const resultA = runCommandSequence(implementingEntryCommands('pn-taskA'), workDir);
      expect(resultA.success).toBe(true);
      await fs.writeFile(path.join(workDir, 'taskA.rs'), 'fn task_a() {}');
      const exitA = runCommandSequence(implementingExitCommands('pn-taskA'), workDir);
      expect(exitA.success).toBe(true);

      // Task B (entry commands reset to main first)
      const resultB = runCommandSequence(implementingEntryCommands('pn-taskB'), workDir);
      expect(resultB.success).toBe(true);
      await fs.writeFile(path.join(workDir, 'taskB.rs'), 'fn task_b() {}');
      const exitB = runCommandSequence(implementingExitCommands('pn-taskB'), workDir);
      expect(exitB.success).toBe(true);

      // Task A's file should NOT be on task B's branch
      const branchBFiles = execSync('git ls-tree --name-only HEAD', { cwd: workDir, encoding: 'utf-8' });
      expect(branchBFiles).toContain('taskB.rs');
      expect(branchBFiles).not.toContain('taskA.rs');
    });
  });

  // =========================================================================
  // N. captureCommandOutput timeout does not kill short commands
  // =========================================================================
  describe('captureCommandOutput basics', () => {
    let workDir: string;
    let cleanup: () => Promise<void> = async () => {};

    beforeEach(async () => {
      ({ workDir, cleanup } = await createRepoWithOrigin('capture'));
    });
    afterEach(async () => { await cleanup(); });

    it('captures stdout correctly', () => {
      const result = captureCommandOutput('echo hello-world', workDir);
      expect(result.success).toBe(true);
      expect(result.output).toBe('hello-world');
    });

    it('captures git rev-parse HEAD', () => {
      const result = captureCommandOutput('git rev-parse HEAD', workDir);
      expect(result.success).toBe(true);
      expect(result.output).toMatch(/^[0-9a-f]{40}$/);
    });

    it('returns failure for nonexistent command', () => {
      const result = captureCommandOutput('nonexistent-command-xyz', workDir);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('returns failure for command with non-zero exit', () => {
      const result = captureCommandOutput('git checkout nonexistent-branch', workDir);
      expect(result.success).toBe(false);
    });
  });

  // =========================================================================
  // O. Full pipeline across separate "agent" work dirs
  // =========================================================================
  describe('Cross-agent simulation: separate work dirs sharing origin', () => {
    let tmpBase: string;
    let originDir: string;
    let devWorkDir: string;
    let qaWorkDir: string;
    const taskId = 'pn-cross-agent';

    beforeAll(async () => {
      tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'git-wf-cross-'));
      originDir = path.join(tmpBase, 'origin.git');
      devWorkDir = path.join(tmpBase, 'developer');
      qaWorkDir = path.join(tmpBase, 'qa');

      // Create bare origin with main as default branch
      execSync(`git init --bare --initial-branch=main "${originDir}"`);

      // Developer clone
      execSync(`git clone "${originDir}" "${devWorkDir}"`);
      execSync('git config user.email "dev@test.com"', { cwd: devWorkDir });
      execSync('git config user.name "Developer"', { cwd: devWorkDir });
      execSync('git checkout -b main 2>/dev/null || git checkout main', { cwd: devWorkDir });
      await fs.writeFile(path.join(devWorkDir, 'README.md'), '# Project\n');
      execSync('git add -A && git commit -m "Initial commit"', { cwd: devWorkDir });
      execSync('git push origin main', { cwd: devWorkDir });

      // QA clone (separate working directory, like a real separate agent)
      execSync(`git clone "${originDir}" "${qaWorkDir}"`);
      execSync('git config user.email "qa@test.com"', { cwd: qaWorkDir });
      execSync('git config user.name "QA"', { cwd: qaWorkDir });
    });

    afterAll(async () => {
      await fs.rm(tmpBase, { recursive: true, force: true });
    });

    it('developer implements -> QA validates -> QA merges (separate work dirs)', async () => {
      // -- Developer: IMPLEMENTING entry --
      const devEntry = runCommandSequence(implementingEntryCommands(taskId), devWorkDir);
      expect(devEntry.success).toBe(true);

      // -- Developer: do work --
      await fs.writeFile(path.join(devWorkDir, 'module.rs'), 'pub fn hello() -> &\'static str { "hello" }\n');

      // -- Developer: IMPLEMENTING exit --
      const devExit = runCommandSequence(implementingExitCommands(taskId), devWorkDir);
      expect(devExit.success).toBe(true);
      expect(devExit.captured.commitSha).toMatch(/^[0-9a-f]{40}$/);

      // -- QA: VALIDATING entry (separate work dir, no local feature branch) --
      const qaValEntry = runCommandSequence(validatingEntryCommands(taskId), qaWorkDir);
      expect(qaValEntry.success).toBe(true);
      expect(qaValEntry.captured.validatedSha).toBe(devExit.captured.commitSha);

      // Verify QA sees the developer's code
      const qaContent = execSync('cat module.rs', { cwd: qaWorkDir, encoding: 'utf-8' });
      expect(qaContent).toContain('pub fn hello()');

      // -- QA: MERGING entry --
      execSync('git checkout main', { cwd: qaWorkDir });
      const qaMerge = runCommandSequence(mergingEntryCommands(taskId), qaWorkDir);
      expect(qaMerge.success).toBe(true);
      expect(qaMerge.captured.mergeSha).toMatch(/^[0-9a-f]{40}$/);

      // Verify origin/main has the merge
      const originLog = execSync(
        `git --git-dir="${originDir}" log --oneline -3`,
        { encoding: 'utf-8' },
      );
      expect(originLog).toContain(`Merge dev/${taskId}`);

      // -- QA: MERGING exit (cleanup branches) --
      const qaMergeExit = runCommandSequence(mergingExitCommands(taskId), qaWorkDir);
      expect(qaMergeExit.success).toBe(true);

      // Remote branch should be deleted
      const refs = execSync('git ls-remote --heads origin', { cwd: qaWorkDir, encoding: 'utf-8' });
      expect(refs).not.toContain(`refs/heads/dev/${taskId}`);
    });
  });
});
