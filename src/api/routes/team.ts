// Team roster CRUD API routes

import { Router, Request, Response } from 'express';
import { readFile, writeFile, readdir } from 'fs/promises';
import path from 'path';

export function createTeamRouter(projectRoot: string): Router {
  const router = Router();

  // GET /api/team — find and return team.json
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const teamPath = await findTeamFile(projectRoot);
      if (!teamPath) {
        res.json({ team: { name: '', description: '' }, agents: [], roles: {} });
        return;
      }
      const raw = await readFile(teamPath, 'utf-8');
      const roster = JSON.parse(raw);
      res.json(roster);
    } catch (err) {
      res.status(500).json({ error: 'Failed to read team roster' });
    }
  });

  // PUT /api/team — update team roster
  router.put('/', async (req: Request, res: Response) => {
    try {
      const teamPath = await findTeamFile(projectRoot) ||
        path.join(projectRoot, 'team.json');
      await writeFile(teamPath, JSON.stringify(req.body, null, 2), 'utf-8');
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to write team roster' });
    }
  });

  // POST /api/team/agents — add an agent
  router.post('/agents', async (req: Request, res: Response) => {
    try {
      const teamPath = await findTeamFile(projectRoot) ||
        path.join(projectRoot, 'team.json');
      let roster;
      try {
        const raw = await readFile(teamPath, 'utf-8');
        roster = JSON.parse(raw);
      } catch {
        roster = { team: { name: 'My Team', description: '' }, agents: [], roles: {} };
      }
      const agent = req.body;
      if (!agent.id || !agent.hostname || !agent.role) {
        res.status(400).json({ error: 'Agent must have id, hostname, and role' });
        return;
      }
      // Prevent duplicate IDs
      if (roster.agents.some((a: { id: string }) => a.id === agent.id)) {
        res.status(409).json({ error: `Agent ${agent.id} already exists` });
        return;
      }
      roster.agents.push(agent);
      // Update roles index
      if (!roster.roles) roster.roles = {};
      if (!roster.roles[agent.role]) {
        roster.roles[agent.role] = { agents: [], description: agent.role };
      }
      if (!roster.roles[agent.role].agents.includes(agent.id)) {
        roster.roles[agent.role].agents.push(agent.id);
      }
      await writeFile(teamPath, JSON.stringify(roster, null, 2), 'utf-8');
      res.json({ success: true, agent });
    } catch (err) {
      res.status(500).json({ error: 'Failed to add agent' });
    }
  });

  // DELETE /api/team/agents/:id — remove an agent
  router.delete('/agents/:id', async (req: Request, res: Response) => {
    try {
      const teamPath = await findTeamFile(projectRoot);
      if (!teamPath) {
        res.status(404).json({ error: 'No team file found' });
        return;
      }
      const raw = await readFile(teamPath, 'utf-8');
      const roster = JSON.parse(raw);
      const agentId = req.params.id;
      roster.agents = roster.agents.filter((a: { id: string }) => a.id !== agentId);
      // Clean up roles index
      for (const role of Object.values(roster.roles || {}) as Array<{ agents: string[] }>) {
        role.agents = role.agents.filter((id: string) => id !== agentId);
      }
      await writeFile(teamPath, JSON.stringify(roster, null, 2), 'utf-8');
      res.json({ success: true, deleted: agentId });
    } catch (err) {
      res.status(500).json({ error: 'Failed to remove agent' });
    }
  });

  return router;
}

async function findTeamFile(projectRoot: string): Promise<string | null> {
  // Check common locations for team.json
  const candidates = [
    path.join(projectRoot, 'team.json'),
    path.join(projectRoot, 'examples', 'sample_mailbox', 'team.json'),
  ];
  for (const candidate of candidates) {
    try {
      await readFile(candidate, 'utf-8');
      return candidate;
    } catch { /* not found */ }
  }
  // Search mailbox dirs
  try {
    const dirs = await readdir(projectRoot);
    for (const dir of dirs) {
      if (dir.includes('mailbox')) {
        const teamPath = path.join(projectRoot, dir, 'team.json');
        try {
          await readFile(teamPath, 'utf-8');
          return teamPath;
        } catch { /* not found */ }
      }
    }
  } catch { /* ignore */ }
  return null;
}
