// Task status and intervention API routes
// Provides visibility into workflow task states (especially BLOCKED)
// and allows human intervention (unblock with notes/context).

import { Router, Request, Response } from '../express-compat.js';
import { broadcast } from '../websocket.js';
import { readFile, readdir, writeFile, mkdir } from 'fs/promises';
import path from 'path';

interface TaskMessage {
  filename: string;
  folder: string;
  taskId: string;
  workflowId: string;
  currentState: string;
  subject: string;
  date: string;
  notes: Array<{ state: string; role: string; content: string; timestamp: string }>;
  context: Record<string, string>;
}

export function createTasksRouter(projectRoot: string): Router {
  const router = Router();

  /**
   * Resolve mailbox root from query param or default.
   */
  function resolveMailboxRoot(repoPath?: string): string {
    if (repoPath) return path.resolve(projectRoot, repoPath);
    return projectRoot;
  }

  /**
   * Scan all mailbox messages and extract workflow task state from their bodies.
   */
  async function scanWorkflowTasks(mailboxRoot: string): Promise<TaskMessage[]> {
    const tasks: TaskMessage[] = [];
    const mailboxDir = path.join(mailboxRoot, 'mailbox');

    let agents: string[];
    try {
      agents = (await readdir(mailboxDir)).filter(e => e.startsWith('to_'));
    } catch {
      return tasks;
    }

    for (const agentFolder of agents) {
      const agentDir = path.join(mailboxDir, agentFolder);
      for (const folder of ['priority', 'normal', 'background']) {
        const folderPath = path.join(agentDir, folder);
        let files: string[];
        try {
          files = (await readdir(folderPath)).filter(f => f.endsWith('.md'));
        } catch {
          continue;
        }

        for (const file of files) {
          try {
            const raw = await readFile(path.join(folderPath, file), 'utf-8');
            const task = parseWorkflowMessage(raw, file, folder);
            if (task) tasks.push(task);
          } catch { /* skip unreadable files */ }
        }
      }
    }

    return tasks;
  }

  /**
   * Parse a mailbox message file and extract workflow task state if present.
   */
  function parseWorkflowMessage(raw: string, filename: string, folder: string): TaskMessage | null {
    // Split header from body at ---
    const sepIdx = raw.indexOf('\n---\n');
    if (sepIdx === -1) return null;

    const header = raw.slice(0, sepIdx);
    const body = raw.slice(sepIdx + 5).trim();

    // Check if it's a workflow message
    if (!header.includes('MessageType: workflow') && !header.includes('MessageType:workflow')) {
      return null;
    }

    // Extract date and subject from header
    const dateMatch = header.match(/^Date:\s*(.+)$/m);
    const subjectMatch = header.match(/^Subject:\s*(.+)$/m);

    // Parse JSON body
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body);
    } catch {
      return null;
    }

    if (payload.type !== 'workflow') return null;

    const taskState = payload.taskState as Record<string, unknown> | undefined;
    if (!taskState) return null;

    return {
      filename,
      folder,
      taskId: (payload.taskId as string) || (taskState.taskId as string) || '',
      workflowId: (payload.workflowId as string) || (taskState.workflowId as string) || '',
      currentState: (taskState.currentState as string) || '',
      subject: subjectMatch?.[1] || '',
      date: dateMatch?.[1] || '',
      notes: Array.isArray(taskState.notes) ? taskState.notes as TaskMessage['notes'] : [],
      context: (taskState.context as Record<string, string>) || {},
    };
  }

  // GET /api/tasks — list all workflow tasks with their current state
  router.get('/', async (req: Request, res: Response) => {
    try {
      const mailboxRoot = resolveMailboxRoot(req.query.repoPath as string);
      const tasks = await scanWorkflowTasks(mailboxRoot);
      res.json({ tasks });
    } catch (err) {
      res.status(500).json({ error: `Failed to scan tasks: ${(err as Error).message}` });
    }
  });

  // GET /api/tasks/blocked — list only BLOCKED tasks
  router.get('/blocked', async (req: Request, res: Response) => {
    try {
      const mailboxRoot = resolveMailboxRoot(req.query.repoPath as string);
      const tasks = await scanWorkflowTasks(mailboxRoot);
      const blocked = tasks.filter(t => t.currentState === 'BLOCKED');
      res.json({ tasks: blocked, total: blocked.length });
    } catch (err) {
      res.status(500).json({ error: `Failed to scan blocked tasks: ${(err as Error).message}` });
    }
  });

  // GET /api/tasks/manifest — return the task manifest with dependency graph and status
  router.get('/manifest', async (req: Request, res: Response) => {
    try {
      // Look for .task-manifest.json files in projects/ and rust-port-package/
      const searchDirs = [
        path.join(projectRoot, 'projects'),
        path.join(projectRoot, 'rust-port-package'),
      ];

      for (const dir of searchDirs) {
        let files: string[];
        try {
          files = await readdir(dir);
        } catch {
          continue;
        }
        for (const file of files) {
          if (file.endsWith('.task-manifest.json')) {
            const manifestPath = path.join(dir, file);
            const raw = await readFile(manifestPath, 'utf-8');
            const manifest = JSON.parse(raw);

            // Try to load the status file alongside it
            const statusPath = manifestPath.replace(/\.json$/, '.status.json');
            let status: Record<string, string> = {};
            try {
              status = JSON.parse(await readFile(statusPath, 'utf-8'));
            } catch {
              // No status file yet
            }

            res.json({ manifest, status });
            return;
          }
        }
      }

      res.json({ manifest: null, status: {} });
    } catch (err) {
      res.status(500).json({ error: `Failed to load manifest: ${(err as Error).message}` });
    }
  });

  // POST /api/tasks/:taskId/unblock — unblock a task with optional note and context
  router.post('/:taskId/unblock', async (req: Request, res: Response) => {
    try {
      const { taskId } = req.params;
      const { note, context: additionalContext, repoPath, targetAgent } = req.body as {
        note?: string;
        context?: Record<string, string>;
        repoPath?: string;
        targetAgent?: string;
      };

      if (!targetAgent) {
        res.status(400).json({ error: 'Required: targetAgent (the manager agent ID to send the unblock message to)' });
        return;
      }

      const mailboxRoot = resolveMailboxRoot(repoPath);

      // Build the unblock message with updated task state
      const now = new Date();
      const ts = now.toISOString();

      // Build notes array for the message
      const notes: Array<{ state: string; role: string; content: string; timestamp: string }> = [];
      if (note) {
        notes.push({
          state: 'BLOCKED',
          role: 'human',
          content: note,
          timestamp: ts,
        });
      }

      // Build context with any additional metadata
      const taskContext: Record<string, string> = {
        unblockBy: 'human',
        unblockedAt: ts,
        ...(additionalContext || {}),
      };

      const assignment = {
        type: 'workflow',
        workflowId: 'rust-port',
        taskId,
        targetState: 'ASSIGN',
        targetRole: 'manager',
        taskPrompt: `Task ${taskId} has been manually unblocked by a human operator.${note ? `\n\nResolution note: ${note}` : ''}\n\nRe-evaluate dependencies and dispatch this task if ready.`,
        taskState: {
          taskId,
          workflowId: 'rust-port',
          currentState: 'ASSIGN',
          context: taskContext,
          retryCount: 0,
          history: [
            {
              fromState: 'BLOCKED',
              toState: 'ASSIGN',
              result: 'success',
              role: 'human',
              timestamp: ts,
              reason: note || 'Manually unblocked via UI',
            },
          ],
          notes,
          createdAt: ts,
          updatedAt: ts,
        },
      };

      // Write to the target agent's priority mailbox (unblocks are high priority)
      const targetDir = path.join(mailboxRoot, 'mailbox', `to_${targetAgent}`, 'priority');
      await mkdir(targetDir, { recursive: true });

      const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const fileTs = ts.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
      const filename = `${fileTs}_unblock_${safeTaskId}.md`;
      const filePath = path.join(targetDir, filename);

      const content = [
        `Date: ${ts}`,
        `From: human`,
        `To: ${targetAgent}`,
        `Subject: [Unblock] ${taskId}`,
        `Priority: HIGH`,
        `MessageType: workflow`,
        '---',
        JSON.stringify(assignment, null, 2),
      ].join('\n');

      await writeFile(filePath, content, 'utf-8');

      // Broadcast task state change for real-time UI updates
      broadcast('task:stateChange', {
        taskId,
        previousState: 'BLOCKED',
        newState: 'ASSIGN',
        trigger: 'manual-unblock',
        timestamp: ts,
      });

      res.json({
        success: true,
        taskId,
        filename,
        message: `Task ${taskId} unblock message sent to ${targetAgent} priority queue`,
        note: note || null,
        context: taskContext,
      });
    } catch (err) {
      res.status(500).json({ error: `Failed to unblock task: ${(err as Error).message}` });
    }
  });

  return router;
}
