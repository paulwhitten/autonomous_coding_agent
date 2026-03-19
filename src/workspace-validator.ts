// Workspace structure validation - enforce correct paths via code, not instructions

import { access, mkdir, readdir } from 'fs/promises';
import path from 'path';
import { logger } from './logger.js';

export interface WorkspaceStructure {
  root: string;
  tasksPending: string;
  tasksCompleted: string;
  tasksReview: string;
  tasksFailed: string;
  projectRoot: string;
  githubDir: string;
}

/**
 * Validate and create standard workspace structure
 * Enforces separation between git clone and agent workspace
 */
export async function validateWorkspaceStructure(workspaceRoot: string): Promise<WorkspaceStructure> {
  const structure: WorkspaceStructure = {
    root: workspaceRoot,
    tasksPending: path.join(workspaceRoot, 'tasks', 'pending'),
    tasksCompleted: path.join(workspaceRoot, 'tasks', 'completed'),
    tasksReview: path.join(workspaceRoot, 'tasks', 'review'),
    tasksFailed: path.join(workspaceRoot, 'tasks', 'failed'),
    projectRoot: path.join(workspaceRoot, 'project'),
    githubDir: path.join(workspaceRoot, '.github')
  };
  
  // Create required directories
  const requiredDirs = [
    structure.tasksPending,
    structure.tasksCompleted,
    structure.tasksReview,
    structure.tasksFailed,
    structure.githubDir
  ];
  
  for (const dir of requiredDirs) {
    try {
      await mkdir(dir, { recursive: true });
    } catch (error) {
      // Ignore if already exists
    }
  }
  
  logger.info({ workspace: workspaceRoot, message: 'Workspace structure validated' });
  return structure;
}

/**
 * Check if a path is inside the git project directory
 * Prevents agents from creating task files in the git repo
 */
export function isInsideProjectRepo(filepath: string, structure: WorkspaceStructure): boolean {
  const normalized = path.resolve(filepath);
  return normalized.startsWith(structure.projectRoot);
}

/**
 * Get the correct task directory path for a given status
 */
export function getTaskDirectory(status: 'pending' | 'completed' | 'review' | 'failed', structure: WorkspaceStructure): string {
  switch (status) {
    case 'pending': return structure.tasksPending;
    case 'completed': return structure.tasksCompleted;
    case 'review': return structure.tasksReview;
    case 'failed': return structure.tasksFailed;
  }
}

/**
 * Validate that git clone exists and is separate from workspace
 */
export async function validateGitCloneSeparation(structure: WorkspaceStructure): Promise<void> {
  try {
    const gitDir = path.join(structure.projectRoot, '.git');
    await access(gitDir);
    
    // Verify no tasks/ directory inside project/
    const tasksInProject = path.join(structure.projectRoot, 'tasks');
    try {
      const entries = await readdir(tasksInProject);
      if (entries.length > 0) {
        logger.warn({
          message: 'Found tasks/ directory inside project git clone - this should be cleaned up',
          location: tasksInProject,
          count: entries.length
        });
      }
    } catch {
      // Good - no tasks/ in project/
    }
  } catch {
    logger.warn({ message: 'Git clone not found in project/ directory', projectRoot: structure.projectRoot });
  }
}
