// Git operations for mailbox synchronization

import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

export class GitManager {
  private repoPath: string;
  private enabled: boolean;
  private validated: boolean = false;
  
  constructor(repoPath: string, enabled: boolean = true) {
    this.repoPath = path.resolve(repoPath);
    this.enabled = enabled;
  }

  /**
   * Verify repoPath is actually a git repository.
   * Called once on first operation; disables git if the path is not a repo.
   */
  private async ensureRepo(): Promise<boolean> {
    if (this.validated) return this.enabled;
    this.validated = true;
    if (!this.enabled) return false;
    try {
      await execAsync('git rev-parse --git-dir', { cwd: this.repoPath });
      return true;
    } catch {
      this.enabled = false;
      return false;
    }
  }
  
  /**
   * Check if git is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }
  
  /**
   * Pull latest changes from remote
   */
  async pull(): Promise<{ success: boolean; output: string; error?: string }> {
    if (!(await this.ensureRepo())) {
      return { success: true, output: 'Git sync disabled' };
    }
    
    try {
      // Stash any local changes first (ignore error if nothing to stash)
      try {
        await execAsync('git stash', { cwd: this.repoPath });
      } catch {
        // Nothing to stash -- that's fine
      }
      
      // Detect the current branch name
      let branch = 'main';
      try {
        const { stdout: branchOut } = await execAsync(
          'git rev-parse --abbrev-ref HEAD',
          { cwd: this.repoPath }
        );
        const detected = branchOut.trim();
        if (detected && detected !== 'HEAD') {
          branch = detected;
        }
      } catch {
        // Default to 'main'
      }
      
      // Pull with rebase from the current branch's upstream
      const { stdout, stderr } = await execAsync(
        `git pull --rebase origin ${branch}`, 
        { cwd: this.repoPath }
      );
      
      // Pop stash if needed
      try {
        await execAsync('git stash pop', { cwd: this.repoPath });
      } catch (error) {
        // Stash might be empty, that's ok
      }
      
      return {
        success: true,
        output: stdout + stderr
      };
    } catch (error: any) {
      // Attempt to abort any stuck rebase
      try {
        await execAsync('git rebase --abort', { cwd: this.repoPath });
      } catch {
        // Not in rebase state, that's ok
      }
      // Try to restore stash if we stashed earlier
      try {
        await execAsync('git stash pop', { cwd: this.repoPath });
      } catch {
        // No stash to pop
      }
      return {
        success: false,
        output: '',
        error: error.message
      };
    }
  }
  
  /**
   * Add, commit, and push changes
   */
  async commitAndPush(message: string): Promise<{ success: boolean; output: string; error?: string }> {
    if (!(await this.ensureRepo())) {
      return { success: true, output: 'Git sync disabled' };
    }
    
    try {
      // Add all changes in mailbox directory
      await execAsync('git add mailbox/ attachments/ 2>/dev/null || true', { 
        cwd: this.repoPath 
      });
      
      // Check if there are changes to commit
      const { stdout: statusOutput } = await execAsync('git status --porcelain', {
        cwd: this.repoPath
      });
      
      if (!statusOutput.trim()) {
        return {
          success: true,
          output: 'No changes to commit'
        };
      }
      
      // Commit changes
      const { stdout: commitOutput } = await execAsync(`git commit -m "${message}"`, {
        cwd: this.repoPath
      });
      
      // Push to remote
      const { stdout: pushOutput, stderr: pushError } = await execAsync('git push', {
        cwd: this.repoPath
      });
      
      return {
        success: true,
        output: commitOutput + '\n' + pushOutput + '\n' + pushError
      };
    } catch (error: any) {
      return {
        success: false,
        output: '',
        error: error.message
      };
    }
  }
  
  /**
   * Get current git status
   */
  async status(): Promise<string> {
    if (!(await this.ensureRepo())) {
      return 'Git sync disabled';
    }
    
    try {
      const { stdout } = await execAsync('git status --short', {
        cwd: this.repoPath
      });
      return stdout;
    } catch (error: any) {
      return `Error: ${error.message}`;
    }
  }
  
  /**
   * Check if repo is clean (no uncommitted changes)
   */
  async isClean(): Promise<boolean> {
    if (!(await this.ensureRepo())) {
      return true;
    }
    
    try {
      const { stdout } = await execAsync('git status --porcelain', {
        cwd: this.repoPath
      });
      return stdout.trim() === '';
    } catch (error) {
      return false;
    }
  }
}
