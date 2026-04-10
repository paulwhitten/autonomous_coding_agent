// Projects API — CRUD for project definitions that drive team formation

import { Router, Request, Response } from '../express-compat.js';
import { readFile, writeFile, readdir, mkdir, unlink, rm } from 'fs/promises';
import os from 'os';
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

  // POST /api/projects/:id/reset-state — wipe agent runtime state while preserving project config
  router.post('/:id/reset-state', async (req: Request, res: Response) => {
    try {
      const id = sanitizeFilename(req.params.id);
      const projectDir = path.join(projectRoot, 'projects', id);
      const projectFile = path.join(projectsDir, `${id}.json`);

      // Verify project exists
      try {
        await readFile(projectFile, 'utf-8');
      } catch {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      const cleaned: string[] = [];

      // Discover role directories (manager/, developer/, qa/, etc.)
      let entries: string[] = [];
      try {
        entries = await readdir(projectDir);
      } catch {
        res.json({ success: true, cleaned: [] });
        return;
      }

      for (const entry of entries) {
        const entryPath = path.join(projectDir, entry);

        // Skip non-role items: config files, custom_instructions, mailbox, logs (handled separately)
        if (entry.endsWith('.json') || entry === 'mailbox' || entry === 'workflows' || entry === 'logs') continue;

        // Reset session context
        const contextFile = path.join(entryPath, `session_context_${entry}.json`);
        try {
          const freshContext = {
            agentId: `${os.hostname()}_${entry}`,
            lastMailboxCheck: null,
            messagesProcessed: 0,
            status: 'idle',
            workingDirectory: path.join(entryPath, 'project'),
            nextMessageSequence: 1,
            messageTracking: {},
            reworkTracking: {},
            sessionId: null,
            currentTask: null,
          };
          await writeFile(contextFile, JSON.stringify(freshContext, null, 2), 'utf-8');
          cleaned.push(`${entry}/session_context`);
        } catch { /* may not exist yet */ }

        // Clear task folders
        for (const taskDir of ['pending', 'completed', 'in-progress', 'review']) {
          const p = path.join(entryPath, 'tasks', taskDir);
          try {
            const files = await readdir(p);
            for (const f of files) await unlink(path.join(p, f));
            if (files.length > 0) cleaned.push(`${entry}/tasks/${taskDir} (${files.length} files)`);
          } catch { /* dir may not exist */ }
        }

        // Clear A2A archive and inbox
        for (const a2aDir of ['a2a_archive', 'a2a_inbox']) {
          const p = path.join(entryPath, a2aDir);
          try {
            const files = await readdir(p);
            for (const f of files) await unlink(path.join(p, f));
            if (files.length > 0) cleaned.push(`${entry}/${a2aDir} (${files.length} files)`);
          } catch { /* dir may not exist */ }
        }
      }

      // Clear shared mailbox messages (all agent inboxes: priority, normal, archive)
      const mailboxDir = path.join(projectDir, 'mailbox', 'mailbox');
      try {
        const agents = await readdir(mailboxDir);
        for (const agent of agents) {
          const agentDir = path.join(mailboxDir, agent);
          for (const queue of ['priority', 'normal', 'background', 'archive']) {
            const queueDir = path.join(agentDir, queue);
            try {
              const files = await readdir(queueDir);
              for (const f of files) await unlink(path.join(queueDir, f));
              if (files.length > 0) cleaned.push(`mailbox/${agent}/${queue} (${files.length} files)`);
            } catch { /* queue may not exist */ }
          }
        }
      } catch { /* mailbox may not exist yet */ }

      // Clear mailbox attachments
      const attachDir = path.join(projectDir, 'mailbox', 'attachments');
      try {
        const files = await readdir(attachDir);
        for (const f of files) await unlink(path.join(attachDir, f));
        if (files.length > 0) cleaned.push(`mailbox/attachments (${files.length} files)`);
      } catch { /* may not exist */ }

      // Clear audit logs
      const auditDir = path.join(projectDir, 'mailbox', 'audit', 'a2a');
      try {
        const files = await readdir(auditDir);
        for (const f of files) await unlink(path.join(auditDir, f));
        if (files.length > 0) cleaned.push(`audit/a2a (${files.length} files)`);
      } catch { /* may not exist */ }

      res.json({ success: true, cleaned });
    } catch (err) {
      res.status(500).json({ error: `Failed to reset project state: ${(err as Error).message}` });
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

      // 1. Build custom_instructions from project data (written per-role below)
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

      // Write custom_instructions.json into the project-specific directory
      const projectDir = path.join(projectRoot, 'projects', project.id);
      await mkdir(projectDir, { recursive: true });
      const ciPath = path.join(projectDir, 'custom_instructions.json');
      await writeFile(ciPath, JSON.stringify(customInstructions, null, 2), 'utf-8');
      results.push('custom_instructions.json');

      // 2. Generate team configs from workflow (if workflow selected)
      let teamConfigs: Array<{ role: string; configFile: string }> = [];
      if (project.workflow) {
        try {
          // Try user-uploaded workflows first, then fall back to built-in
          let wfRaw: string;
          const userWfPath = path.join(projectRoot, 'projects', 'workflows', project.workflow);
          const builtinWfPath = path.join(projectRoot, 'workflows', project.workflow);
          try {
            wfRaw = await readFile(userWfPath, 'utf-8');
          } catch {
            wfRaw = await readFile(builtinWfPath, 'utf-8');
          }
          const workflow = JSON.parse(wfRaw);

          // Extract unique roles from workflow states
          const roles = new Set<string>();
          if (workflow.states) {
            for (const state of Object.values(workflow.states) as Array<{ role?: string }>) {
              if (state.role) roles.add(state.role);
            }
          }

          // Generate a config for each role with isolated workspaces
          const sharedMailbox = path.join(projectDir, 'mailbox');
          await mkdir(sharedMailbox, { recursive: true });

          // Ensure role workspace and log dirs exist before writing configs
          for (const role of roles) {
            await mkdir(path.join(projectDir, role), { recursive: true });
          }
          const roleLogsDir = path.join(projectDir, 'logs');
          await mkdir(roleLogsDir, { recursive: true });

          // Build teamMembers array so each agent can route to peers
          const hostname = os.hostname();
          const allTeamMembers = [...roles].map(r => ({
            hostname: `${hostname}_${r}`,
            role: r,
            responsibilities: r,
          }));

          for (const role of roles) {
            const roleWorkspace = path.join(projectDir, role);

            const config: Record<string, unknown> = {
              agent: {
                role,
                workflowFile: `../workflows/${project.workflow}`,
              },
              mailbox: { repoPath: sharedMailbox },
              workspace: {
                path: roleWorkspace,
                ...(project.repoUrl ? { projectRepo: project.repoUrl } : {}),
              },
              logging: {
                path: path.join(roleLogsDir, `${role}.log`),
              },
              teamMembers: allTeamMembers.filter(m => m.role !== role),
            };
            const configFile = `config-${role}.json`;
            const configPath = path.join(projectDir, configFile);
            await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');

            // Copy custom_instructions.json into each role's workspace
            // so the agent picks it up regardless of CWD
            const roleCiDest = path.join(roleWorkspace, 'custom_instructions.json');
            await writeFile(roleCiDest, JSON.stringify(customInstructions, null, 2), 'utf-8');

            teamConfigs.push({ role, configFile: path.join('projects', project.id, configFile) });
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
