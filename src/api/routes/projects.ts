// Projects API — CRUD for project definitions that drive team formation

import { Router, Request, Response } from '../express-compat.js';
import { readFile, writeFile, readdir, mkdir, unlink } from 'fs/promises';
import path from 'path';

export interface ProjectDefinition {
  id: string;
  name: string;
  description: string;
  repoUrl?: string;
  language?: string;
  techStack?: string[];
  projectContext: string[];
  buildSystem: {
    buildCommand?: string;
    testCommand?: string;
    lintCommand?: string;
    formatCommand?: string;
  };
  codingStandards?: {
    language?: string;
    description?: string;
    preCommitChecklist?: string[];
    sections?: Record<string, string[]>;
  };
  workflow?: string; // workflow filename
  additionalSections?: Array<{ title: string; items: string[] }>;
  createdAt: string;
  updatedAt: string;
}

export function createProjectsRouter(projectRoot: string): Router {
  const router = Router();
  const projectsDir = path.join(projectRoot, 'projects');

  async function ensureDir() {
    await mkdir(projectsDir, { recursive: true });
  }

  function sanitizeFilename(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  }

  // GET /api/projects — list all projects
  router.get('/', async (_req: Request, res: Response) => {
    try {
      await ensureDir();
      const files = await readdir(projectsDir);
      const projects: ProjectDefinition[] = [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const raw = await readFile(path.join(projectsDir, f), 'utf-8');
          projects.push(JSON.parse(raw));
        } catch { /* skip corrupt files */ }
      }
      projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      res.json({ projects });
    } catch (err) {
      res.status(500).json({ error: 'Failed to list projects' });
    }
  });

  // GET /api/projects/:id — read a project
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const filePath = path.join(projectsDir, `${sanitizeFilename(req.params.id)}.json`);
      const raw = await readFile(filePath, 'utf-8');
      res.json(JSON.parse(raw));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      res.status(500).json({ error: 'Failed to read project' });
    }
  });

  // POST /api/projects — create a new project
  router.post('/', async (req: Request, res: Response) => {
    try {
      const body = req.body;
      if (!body || !body.name) {
        res.status(400).json({ error: 'Project name is required' });
        return;
      }

      await ensureDir();
      const id = sanitizeFilename(body.name);
      const filePath = path.join(projectsDir, `${id}.json`);

      // Check for duplicate
      try {
        await readFile(filePath, 'utf-8');
        res.status(409).json({ error: `Project "${body.name}" already exists` });
        return;
      } catch { /* expected — file doesn't exist */ }

      const now = new Date().toISOString();
      const project: ProjectDefinition = {
        id,
        name: body.name,
        description: body.description || '',
        repoUrl: body.repoUrl || undefined,
        language: body.language || undefined,
        techStack: body.techStack || [],
        projectContext: body.projectContext || [],
        buildSystem: body.buildSystem || {},
        codingStandards: body.codingStandards || undefined,
        workflow: body.workflow || undefined,
        additionalSections: body.additionalSections || [],
        createdAt: now,
        updatedAt: now,
      };

      await writeFile(filePath, JSON.stringify(project, null, 2), 'utf-8');
      res.json(project);
    } catch (err) {
      res.status(500).json({ error: 'Failed to create project' });
    }
  });

  // PUT /api/projects/:id — update a project
  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const id = sanitizeFilename(req.params.id);
      const filePath = path.join(projectsDir, `${id}.json`);

      let existing: ProjectDefinition;
      try {
        const raw = await readFile(filePath, 'utf-8');
        existing = JSON.parse(raw);
      } catch {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      const body = req.body;
      const updated: ProjectDefinition = {
        ...existing,
        name: body.name ?? existing.name,
        description: body.description ?? existing.description,
        repoUrl: body.repoUrl ?? existing.repoUrl,
        language: body.language ?? existing.language,
        techStack: body.techStack ?? existing.techStack,
        projectContext: body.projectContext ?? existing.projectContext,
        buildSystem: body.buildSystem ?? existing.buildSystem,
        codingStandards: body.codingStandards ?? existing.codingStandards,
        workflow: body.workflow ?? existing.workflow,
        additionalSections: body.additionalSections ?? existing.additionalSections,
        updatedAt: new Date().toISOString(),
      };

      await writeFile(filePath, JSON.stringify(updated, null, 2), 'utf-8');
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: 'Failed to update project' });
    }
  });

  // DELETE /api/projects/:id — delete a project
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const filePath = path.join(projectsDir, `${sanitizeFilename(req.params.id)}.json`);
      await unlink(filePath);
      res.json({ success: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      res.status(500).json({ error: 'Failed to delete project' });
    }
  });

  // POST /api/projects/:id/apply — generate custom_instructions.json + team configs from project
  router.post('/:id/apply', async (req: Request, res: Response) => {
    try {
      const id = sanitizeFilename(req.params.id);
      const filePath = path.join(projectsDir, `${id}.json`);

      let project: ProjectDefinition;
      try {
        const raw = await readFile(filePath, 'utf-8');
        project = JSON.parse(raw);
      } catch {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      const results: string[] = [];

      // 1. Write custom_instructions.json from project data
      const customInstructions: Record<string, unknown> = {
        projectContext: project.projectContext,
        buildSystem: project.buildSystem,
      };
      if (project.codingStandards) {
        customInstructions.codingStandards = project.codingStandards;
      }
      if (project.additionalSections && project.additionalSections.length > 0) {
        customInstructions.additionalSections = project.additionalSections;
      }
      const ciPath = path.join(projectRoot, 'custom_instructions.json');
      await writeFile(ciPath, JSON.stringify(customInstructions, null, 2), 'utf-8');
      results.push('custom_instructions.json');

      // 2. Generate team configs from workflow (if workflow selected)
      let teamConfigs: Array<{ role: string; configFile: string }> = [];
      if (project.workflow) {
        try {
          const wfPath = path.join(projectRoot, 'workflows', project.workflow);
          const wfRaw = await readFile(wfPath, 'utf-8');
          const workflow = JSON.parse(wfRaw);

          // Extract unique roles from workflow states
          const roles = new Set<string>();
          if (workflow.states) {
            for (const state of Object.values(workflow.states) as Array<{ role?: string }>) {
              if (state.role) roles.add(state.role);
            }
          }

          // Generate a config for each role
          for (const role of roles) {
            const config: Record<string, unknown> = {
              agent: { role },
              mailbox: { repoPath: './mailbox' },
            };
            if (project.repoUrl) {
              config.workspace = { projectRepo: project.repoUrl };
            }
            const configFile = `config-${role}.json`;
            const configPath = path.join(projectRoot, configFile);
            await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
            teamConfigs.push({ role, configFile });
            results.push(configFile);
          }
        } catch (err) {
          results.push(`workflow error: ${(err as Error).message}`);
        }
      }

      res.json({
        success: true,
        filesWritten: results,
        teamConfigs,
        customInstructionsPath: 'custom_instructions.json',
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to apply project' });
    }
  });

  return router;
}
