// Workflow CRUD API routes

import { Router, Request, Response } from '../express-compat.js';
import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import path from 'path';
import { validateWorkflow } from '../validation.js';

export function createWorkflowRouter(projectRoot: string): Router {
  const router = Router();
  const builtinDir = path.join(projectRoot, 'workflows');
  const userDir = path.join(projectRoot, 'projects', 'workflows');

  /** Resolve a workflow filename to its absolute path, checking user dir first. */
  async function resolveWorkflowPath(filename: string): Promise<string> {
    const userPath = path.join(userDir, filename);
    try {
      await readFile(userPath, 'utf-8');
      return userPath;
    } catch { /* not in user dir */ }
    return path.join(builtinDir, filename);
  }

  /** Read summaries from a single directory (returns empty array if missing). */
  async function readSummaries(dir: string, source: string) {
    try {
      const files = await readdir(dir);
      return Promise.all(
        files
          .filter(f => f.endsWith('.workflow.json'))
          .map(async (f) => {
            try {
              const raw = await readFile(path.join(dir, f), 'utf-8');
              const wf = JSON.parse(raw);
              return { file: f, id: wf.id, name: wf.name, description: wf.description, version: wf.version, source };
            } catch {
              return { file: f, id: null, name: f, description: 'Parse error', version: '?', source };
            }
          })
      );
    } catch { return []; }
  }

  // GET /api/workflows — list all workflow files from both directories
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const [builtin, user] = await Promise.all([
        readSummaries(builtinDir, 'builtin'),
        readSummaries(userDir, 'user'),
      ]);
      // User workflows override builtin with same filename
      const byFile = new Map<string, typeof builtin[0]>();
      for (const w of builtin) byFile.set(w.file, w);
      for (const w of user) byFile.set(w.file, w);
      res.json({ workflows: Array.from(byFile.values()) });
    } catch {
      res.status(500).json({ error: 'Failed to list workflows' });
    }
  });

  // GET /api/workflows/:filename — read a specific workflow
  router.get('/:filename', async (req: Request, res: Response) => {
    try {
      const filename = path.basename(req.params.filename as string);
      if (!filename.endsWith('.workflow.json') && !filename.endsWith('.json')) {
        res.status(400).json({ error: 'File must be .workflow.json' });
        return;
      }
      const filePath = await resolveWorkflowPath(filename);
      const raw = await readFile(filePath, 'utf-8');
      const workflow = JSON.parse(raw);
      res.json(workflow);
    } catch (err) {
      res.status(404).json({ error: 'Workflow file not found' });
    }
  });

  // PUT /api/workflows/:filename — write/update a workflow (saves to projects/workflows/)
  router.put('/:filename', async (req: Request, res: Response) => {
    try {
      const filename = path.basename(req.params.filename as string);
      if (!filename.endsWith('.workflow.json')) {
        res.status(400).json({ error: 'File must be .workflow.json' });
        return;
      }
      const validation = validateWorkflow(req.body);
      if (!validation.valid) {
        res.status(400).json({ error: 'Schema validation failed', details: validation.errors });
        return;
      }
      await mkdir(userDir, { recursive: true });
      const filePath = path.join(userDir, filename);
      await writeFile(filePath, JSON.stringify(req.body, null, 2), 'utf-8');
      res.json({ success: true, file: filename });
    } catch (err) {
      res.status(500).json({ error: 'Failed to write workflow' });
    }
  });

  // POST /api/workflows/validate — validate without saving
  router.post('/validate', async (req: Request, res: Response) => {
    const validation = validateWorkflow(req.body);
    res.json(validation);
  });

  // GET /api/workflows/:filename/states — return workflow state graph for visualization
  router.get('/:filename/states', async (req: Request, res: Response) => {
    try {
      const filename = path.basename(req.params.filename as string);
      const filePath = await resolveWorkflowPath(filename);
      const raw = await readFile(filePath, 'utf-8');
      const workflow = JSON.parse(raw);

      if (!workflow.states || typeof workflow.states !== 'object') {
        res.status(400).json({ error: 'Workflow has no states' });
        return;
      }

      const states = Object.entries(workflow.states).map(([id, s]) => {
        const state = s as Record<string, unknown>;
        return {
          id,
          name: state.name || id,
          role: state.role || 'unknown',
          description: state.description || '',
          transitions: state.transitions || {},
          isInitial: id === workflow.initialState,
          isTerminal: Array.isArray(workflow.terminalStates) && workflow.terminalStates.includes(id),
        };
      });

      res.json({
        workflow: { id: workflow.id, name: workflow.name, description: workflow.description },
        states,
        initialState: workflow.initialState,
        terminalStates: workflow.terminalStates || [],
      });
    } catch {
      res.status(404).json({ error: 'Workflow file not found or invalid' });
    }
  });

  // POST /api/workflows/:filename/team-configs — extract roles and generate config templates
  router.post('/:filename/team-configs', async (req: Request, res: Response) => {
    try {
      const filename = path.basename(req.params.filename as string);
      const filePath = await resolveWorkflowPath(filename);
      const raw = await readFile(filePath, 'utf-8');
      const workflow = JSON.parse(raw);

      if (!workflow.states || typeof workflow.states !== 'object') {
        res.status(400).json({ error: 'Workflow has no states' });
        return;
      }

      // Extract unique roles from states
      const roleSet = new Set<string>();
      for (const state of Object.values(workflow.states) as Array<{ role?: string }>) {
        if (state.role) roleSet.add(state.role);
      }

      const roles = Array.from(roleSet);
      const configs = roles.map(role => ({
        role,
        config: {
          agent: {
            hostname: `${role}-agent`,
            role,
            checkIntervalMs: 60000,
            stuckTimeoutMs: 2700000,
            sdkTimeoutMs: 300000,
            taskRetryCount: 3,
            minWorkItems: 5,
            maxWorkItems: 20,
            decompositionPrompt: '',
            wipLimit: role === 'manager' ? 3 : 0,
            workflowFile: filename,
            allowedTools: ['all'],
            timeoutStrategy: {
              enabled: true,
              tier1_multiplier: 1.5,
              tier2_backgroundThreshold: 2,
              tier3_decomposeThreshold: 3,
              tier4_adaptiveWindow: 3600000,
              tier4_adaptiveThreshold: 5,
            },
            validation: {
              mode: 'spot_check',
              reviewEveryNthItem: 5,
            },
          },
          mailbox: {
            repoPath: '../mailbox_repo',
            gitSync: true,
            autoCommit: true,
            commitMessage: `Auto-sync: ${role}-agent_${role} at {timestamp}`,
            supportBroadcast: true,
            supportAttachments: true,
            supportPriority: true,
          },
          copilot: {
            model: 'gpt-4.1',
            allowedTools: ['all'],
            permissions: {
              shell: 'allowlist',
              write: 'allow',
              read: 'allow',
              url: 'deny',
              mcp: 'deny',
            },
          },
          workspace: {
            path: `./workspace-${role}`,
            tasksFolder: 'tasks',
            workingFolder: 'project',
            persistContext: true,
          },
          logging: {
            level: 'info',
            path: `./logs/${role}-agent.log`,
            maxSizeMB: 100,
          },
          manager: {
            hostname: '',
            role: 'manager',
            escalationPriority: 'HIGH',
          },
          quota: {
            enabled: true,
            preset: 'adaptive',
          },
          communication: {
            a2a: { serverPort: 0 },
          },
        },
      }));

      res.json({
        workflow: { id: workflow.id, name: workflow.name, description: workflow.description },
        roles,
        configs,
      });
    } catch {
      res.status(404).json({ error: 'Workflow file not found or invalid' });
    }
  });

  // POST /api/workflows/:filename/start-task — create and send a workflow assignment message
  router.post('/:filename/start-task', async (req: Request, res: Response) => {
    try {
      const filename = path.basename(req.params.filename as string);
      const filePath = await resolveWorkflowPath(filename);
      const raw = await readFile(filePath, 'utf-8');
      const workflow = JSON.parse(raw);

      const { targetAgent, taskId, taskTitle, taskDescription, acceptanceCriteria, from, repoPath } = req.body;
      if (!targetAgent || !taskId || !taskTitle || !from) {
        res.status(400).json({ error: 'Required: targetAgent, taskId, taskTitle, from' });
        return;
      }

      const initialState = workflow.initialState;
      const initialStateDef = workflow.states?.[initialState];
      if (!initialStateDef) {
        res.status(400).json({ error: `Workflow has no initial state '${initialState}'` });
        return;
      }

      // Build the workflow assignment payload
      const assignment = {
        type: 'workflow' as const,
        workflowId: workflow.id,
        taskId: String(taskId),
        targetState: initialState,
        targetRole: initialStateDef.role,
        taskPrompt: initialStateDef.prompt || '',
        taskState: {
          taskId: String(taskId),
          workflowId: workflow.id,
          currentState: initialState,
          context: {
            taskTitle,
            taskDescription: taskDescription || '',
            acceptanceCriteria: acceptanceCriteria || '',
            ...(workflow.globalContext || {}),
          },
          retryCount: 0,
          history: [`${new Date().toISOString()}: Task created and assigned to ${initialState} (${initialStateDef.role})`],
          notes: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };

      // Write to the target agent's mailbox.
      // Resolve the mailbox path: use explicit repoPath if provided,
      // otherwise find the project whose workflow matches this file and
      // read mailbox.repoPath from its first config.
      let mailboxRoot: string;
      if (repoPath) {
        mailboxRoot = path.resolve(projectRoot, repoPath);
      } else {
        // Look for a project that uses this workflow
        let foundMailbox: string | null = null;
        const projectsDir = path.join(projectRoot, 'projects');
        try {
          const projectFiles = await readdir(projectsDir);
          for (const pf of projectFiles) {
            if (!pf.endsWith('.json')) continue;
            try {
              const proj = JSON.parse(await readFile(path.join(projectsDir, pf), 'utf-8'));
              if (proj.workflow === filename) {
                // Found the project — read the first config to get mailbox.repoPath
                const projDir = path.join(projectsDir, proj.id);
                const configs = (await readdir(projDir).catch(() => [] as string[]))
                  .filter((f: string) => f.startsWith('config-') && f.endsWith('.json'));
                if (configs.length > 0) {
                  const cfg = JSON.parse(await readFile(path.join(projDir, configs[0]), 'utf-8'));
                  if (cfg.mailbox?.repoPath) {
                    foundMailbox = cfg.mailbox.repoPath;
                    break;
                  }
                }
              }
            } catch { /* skip unparseable files */ }
          }
        } catch { /* projects dir missing */ }
        mailboxRoot = foundMailbox || path.resolve(projectRoot, '..', 'mailbox_repo');
      }
      const targetDir = path.join(mailboxRoot, 'mailbox', `to_${targetAgent}`, 'normal');
      await mkdir(targetDir, { recursive: true });

      const now = new Date();
      const ts = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
      const safeFrom = from.replace(/[^a-zA-Z0-9_-]/g, '_');
      const msgFilename = `${ts}_from_${safeFrom}.md`;
      const msgPath = path.join(targetDir, msgFilename);

      const content = [
        `Date: ${now.toISOString()}`,
        `From: ${from}`,
        `To: ${targetAgent}`,
        `Subject: [Workflow] ${taskTitle}`,
        `Priority: NORMAL`,
        `MessageType: workflow`,
        '---',
        JSON.stringify(assignment, null, 2),
      ].join('\n');

      await writeFile(msgPath, content, 'utf-8');

      res.json({
        success: true,
        filename: msgFilename,
        assignment: {
          workflowId: workflow.id,
          taskId: assignment.taskId,
          targetState: initialState,
          targetRole: initialStateDef.role,
          targetAgent,
        },
      });
    } catch (err) {
      res.status(500).json({ error: `Failed to start task: ${(err as Error).message}` });
    }
  });

  // DELETE /api/workflows/:filename — delete a workflow (only from projects/workflows/)
  router.delete('/:filename', async (req: Request, res: Response) => {
    try {
      const filename = path.basename(req.params.filename as string);
      const filePath = path.join(userDir, filename);
      const { unlink } = await import('fs/promises');
      await unlink(filePath);
      res.json({ success: true, deleted: filename });
    } catch (err) {
      res.status(404).json({ error: 'Workflow file not found (only user-uploaded workflows can be deleted)' });
    }
  });

  return router;
}
