// Agent status and management API routes

import { Router, Request, Response } from '../express-compat.js';
import { readFile, readdir, stat } from 'fs/promises';
import { discoverAgents } from '../../agent-registry.js';
import { getHealthHistory } from '../agent-browser.js';
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

  // GET /api/agents/discovered — discover agents on the local network via mDNS
  // Enriches results with A2A agent cards when agents expose an a2aUrl
  router.get('/discovered', async (req: Request, res: Response) => {
    try {
      const timeout = Math.min(parseInt(req.query.timeout as string) || 3000, 10000);
      const agents = await discoverAgents(timeout);

      // Enrich agents that have an A2A URL with their agent card
      const enriched = await Promise.all(
        agents.map(async (agent) => {
          if (!agent.a2aUrl) return agent;
          const enrichedAgent: Record<string, unknown> = { ...agent };
          // Fetch agent card
          const cardUrl = agent.a2aUrl.endsWith('/')
            ? `${agent.a2aUrl}.well-known/agent-card.json`
            : `${agent.a2aUrl}/.well-known/agent-card.json`;
          const controller = new AbortController();
          const cardTimeout = setTimeout(() => controller.abort(), 3000);
          try {
            const resp = await fetch(cardUrl, { signal: controller.signal });
            clearTimeout(cardTimeout);
            if (resp.ok) {
              const card = await resp.json() as Record<string, unknown>;
              enrichedAgent.card = card;
              enrichedAgent.skills = card.skills || [];
              enrichedAgent.version = card.version;
              if (card.description) enrichedAgent.description = card.description;
              enrichedAgent.reachable = true;
            }
          } catch {
            clearTimeout(cardTimeout);
            enrichedAgent.reachable = false;
          }
          // Fetch rich status from /a2a/status
          const statusUrl = agent.a2aUrl.endsWith('/')
            ? `${agent.a2aUrl}a2a/status`
            : `${agent.a2aUrl}/a2a/status`;
          const controller2 = new AbortController();
          const statusTimeout = setTimeout(() => controller2.abort(), 3000);
          try {
            const resp = await fetch(statusUrl, { signal: controller2.signal });
            clearTimeout(statusTimeout);
            if (resp.ok) {
              const status = await resp.json() as Record<string, unknown>;
              enrichedAgent.a2aStatus = status;
              enrichedAgent.reachable = true;
            }
          } catch {
            clearTimeout(statusTimeout);
          }
          return enrichedAgent;
        })
      );

      res.json({
        agents: enriched,
        total: enriched.length,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to discover agents via mDNS' });
    }
  });

  // GET /api/agents/health-history — get health check history for all agents
  router.get('/health-history', (_req: Request, res: Response) => {
    const history = getHealthHistory();
    const result: Record<string, Array<{ time: string; health: string }>> = {};
    for (const [id, points] of history) {
      result[id] = points;
    }
    res.json({ history: result, timestamp: new Date().toISOString() });
  });

  return router;
}

async function discoverAgentStatus(workspacePath: string, projectRoot: string): Promise<unknown[]> {
  const agents: unknown[] = [];
  // Try to read session context files
  try {
    const contextPath = path.join(workspacePath, 'session_context.json');
    const raw = await readFile(contextPath, 'utf-8');
    const ctx = JSON.parse(raw);

    // Determine if the agent is actually running by cross-referencing
    // with mDNS-discovered agents and checking staleness
    let active = false;
    let reachable = false;

    // Check 1: Is this agent in the discovered agents list?
    try {
      const discovered = await discoverAgents(2000); // 2s timeout
      const match = discovered.find(a => a.agentId === ctx.agentId);
      if (match) {
        active = true;
        reachable = true;
      }
    } catch { /* discovery not available */ }

    // Check 2: Staleness heuristic — if lastMailboxCheck is older than
    // 5 minutes, the agent is likely not running (agents poll every ~30s)
    if (!active && ctx.lastMailboxCheck) {
      const lastCheck = new Date(ctx.lastMailboxCheck).getTime();
      const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
      if (lastCheck > fiveMinutesAgo) {
        active = true; // Recent activity, likely still running
      }
    }

    agents.push({
      agentId: ctx.agentId,
      status: active ? (ctx.status || 'unknown') : 'stopped',
      active,
      reachable,
      lastMailboxCheck: ctx.lastMailboxCheck,
      messagesProcessed: ctx.messagesProcessed || 0,
      stale: !active,
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
      result[folder] = files
        .filter(f => f.endsWith('.md') || f.endsWith('.txt'))
        .map(f => {
          // Extract human-readable title from work item filename
          // Formats: 001_001_task_title.md or 001_task_title.md
          const hier = f.match(/^\d{3,}_\d{3,}_(.+)\.(md|txt)$/);
          if (hier) return hier[1].replace(/_/g, ' ');
          const simple = f.match(/^\d{3,}_(.+)\.(md|txt)$/);
          if (simple) return simple[1].replace(/_/g, ' ');
          return f;
        });
    } catch { /* folder doesn't exist */ }
  }
  return result;
}
