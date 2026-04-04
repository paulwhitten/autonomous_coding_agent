// Agent status and management API routes

import { Router, Request, Response } from '../express-compat.js';
import { readFile, readdir, stat } from 'fs/promises';
import path from 'path';

export function createAgentsRouter(projectRoot: string): Router {
  const router = Router();

  // GET /api/agents/status — get agent status from workspace
  router.get('/status', async (req: Request, res: Response) => {
    try {
      const workspacePath = (req.query.workspace as string) || path.join(projectRoot, 'workspace');
      const agents = await discoverAgentStatus(workspacePath, projectRoot);
      res.json({ agents });
    } catch (err) {
      res.status(500).json({ error: 'Failed to get agent status' });
    }
  });

  // GET /api/agents/logs — read recent log entries
  router.get('/logs', async (req: Request, res: Response) => {
    try {
      const logPath = (req.query.path as string) || path.join(projectRoot, 'logs', 'agent.log');
      const lines = parseInt(req.query.lines as string) || 100;
      const raw = await readFile(logPath, 'utf-8').catch(() => '');
      const allLines = raw.split('\n').filter(Boolean);
      const recent = allLines.slice(-lines);
      res.json({ lines: recent, total: allLines.length });
    } catch (err) {
      res.status(500).json({ error: 'Failed to read logs' });
    }
  });

  // GET /api/agents/work-items — list work items from workspace
  router.get('/work-items', async (req: Request, res: Response) => {
    try {
      const workspacePath = (req.query.workspace as string) || path.join(projectRoot, 'workspace');
      const tasksDir = path.join(workspacePath, 'tasks');
      const items = await collectWorkItems(tasksDir);
      res.json(items);
    } catch (err) {
      res.status(500).json({ error: 'Failed to read work items' });
    }
  });

  // GET /api/agents/workspace-config — read config.json from a workspace's agent directory
  router.get('/workspace-config', async (req: Request, res: Response) => {
    try {
      const workspace = req.query.workspace as string;
      if (!workspace) {
        res.status(400).json({ error: 'workspace query param required' });
        return;
      }
      const wsPath = path.resolve(projectRoot, workspace);
      // Look for config.json in the workspace itself, then one level up (agent dir)
      const candidates = [
        path.join(wsPath, 'config.json'),
        path.join(wsPath, '..', 'config.json'),
      ];
      for (const configPath of candidates) {
        try {
          const raw = await readFile(configPath, 'utf-8');
          const cleaned = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
          const config = JSON.parse(cleaned);
          res.json({ config, configPath: path.dirname(configPath) });
          return;
        } catch { /* try next candidate */ }
      }
      res.status(404).json({ error: 'No config.json found in workspace' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to read workspace config' });
    }
  });

  // GET /api/agents/log-sources — discover available log files
  router.get('/log-sources', async (req: Request, res: Response) => {
    try {
      const logsDir = path.join(projectRoot, 'logs');
      const files = await readdir(logsDir).catch(() => [] as string[]);
      const logFiles = files.filter(f => f.endsWith('.log'));
      const sources = logFiles.map(f => ({
        name: f.replace('.log', ''),
        path: path.join(logsDir, f),
      }));
      res.json({ sources });
    } catch (err) {
      res.status(500).json({ error: 'Failed to discover log sources' });
    }
  });

  // GET /api/agents/roles — get available role definitions
  router.get('/roles', async (req: Request, res: Response) => {
    try {
      const rolesPath = path.join(projectRoot, 'roles.json');
      const raw = await readFile(rolesPath, 'utf-8');
      const roles = JSON.parse(raw);
      const roleNames = Object.keys(roles).filter(k => k !== '$schema' && k !== 'teamAwareness');
      res.json({ roles: roleNames, definitions: roles });
    } catch (err) {
      res.status(500).json({ error: 'Failed to read roles' });
    }
  });

  // GET /api/agents/quota-presets — get quota preset definitions
  router.get('/quota-presets', async (req: Request, res: Response) => {
    try {
      const presetsPath = path.join(projectRoot, 'quota-presets.json');
      const raw = await readFile(presetsPath, 'utf-8');
      const presets = JSON.parse(raw);
      res.json(presets);
    } catch (err) {
      res.status(500).json({ error: 'Failed to read quota presets' });
    }
  });

  return router;
}

async function discoverAgentStatus(workspacePath: string, projectRoot: string): Promise<unknown[]> {
  const agents: unknown[] = [];
  // Try to read session context files
  try {
    const contextPath = path.join(workspacePath, 'session-context.json');
    const raw = await readFile(contextPath, 'utf-8');
    const ctx = JSON.parse(raw);
    agents.push({
      agentId: ctx.agentId,
      status: ctx.status || 'unknown',
      lastMailboxCheck: ctx.lastMailboxCheck,
      messagesProcessed: ctx.messagesProcessed || 0,
    });
  } catch {
    // No active session context found
  }
  return agents;
}

async function collectWorkItems(tasksDir: string): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {
    pending: [],
    completed: [],
    review: [],
    failed: [],
  };
  for (const folder of Object.keys(result)) {
    const dir = path.join(tasksDir, folder);
    try {
      const files = await readdir(dir);
      result[folder] = files.filter(f => f.endsWith('.md') || f.endsWith('.txt'));
    } catch { /* folder doesn't exist */ }
  }
  return result;
}
