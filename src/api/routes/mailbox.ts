// Mailbox read/write API routes

import { Router, Request, Response } from '../express-compat.js';
import { readFile, writeFile, readdir, mkdir, stat } from 'fs/promises';
import path from 'path';

export function createMailboxRouter(projectRoot: string): Router {
  const router = Router();

  // GET /api/mailbox — list all agent mailboxes
  router.get('/', async (req: Request, res: Response) => {
    try {
      const mailboxRoot = resolveMailboxRoot(projectRoot, req.query.repoPath as string);
      const mailboxDir = path.join(mailboxRoot, 'mailbox');
      const entries = await readdir(mailboxDir).catch(() => []);
      const agents = entries.filter(e => e.startsWith('to_'));
      res.json({ agents: agents.map(a => a.replace('to_', '')) });
    } catch (err) {
      res.status(500).json({ error: 'Failed to list mailboxes' });
    }
  });

  // GET /api/mailbox/:agentId — list messages for an agent
  router.get('/:agentId', async (req: Request, res: Response) => {
    try {
      const mailboxRoot = resolveMailboxRoot(projectRoot, req.query.repoPath as string);
      const agentDir = path.join(mailboxRoot, 'mailbox', `to_${req.params.agentId}`);
      const messages = await collectMessages(agentDir);
      res.json({ agentId: req.params.agentId, messages });
    } catch (err) {
      res.status(500).json({ error: 'Failed to read mailbox' });
    }
  });

  // GET /api/mailbox/:agentId/:filename — read a specific message
  router.get('/:agentId/:filename', async (req: Request, res: Response) => {
    try {
      const mailboxRoot = resolveMailboxRoot(projectRoot, req.query.repoPath as string);
      const agentDir = path.join(mailboxRoot, 'mailbox', `to_${req.params.agentId}`);
      const msgPath = findMessage(agentDir, req.params.filename as string);
      if (!msgPath) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }
      const raw = await readFile(msgPath, 'utf-8');
      res.json({ filename: req.params.filename, content: raw, path: msgPath });
    } catch (err) {
      res.status(500).json({ error: 'Failed to read message' });
    }
  });

  // POST /api/mailbox/:agentId — send a message to an agent
  router.post('/:agentId', async (req: Request, res: Response) => {
    try {
      const mailboxRoot = resolveMailboxRoot(projectRoot, req.query.repoPath as string);
      const { from, subject, priority, messageType, body } = req.body;
      if (!from || !subject || !body) {
        res.status(400).json({ error: 'Required: from, subject, body' });
        return;
      }
      const agentId = req.params.agentId;
      const prio = priority || 'NORMAL';
      const msgType = messageType || 'unstructured';

      // Determine target folder
      let folder = 'normal';
      if (prio === 'HIGH') folder = 'priority';
      else if (prio === 'LOW') folder = 'background';

      const targetDir = path.join(mailboxRoot, 'mailbox', `to_${agentId}`, folder);
      await mkdir(targetDir, { recursive: true });

      // Generate filename with timestamp
      const now = new Date();
      const ts = formatTimestamp(now);
      const filename = `${ts}_from_${sanitize(from)}.md`;
      const filePath = path.join(targetDir, filename);

      // Format message
      const content = [
        `Date: ${now.toISOString()}`,
        `From: ${from}`,
        `To: ${agentId}`,
        `Subject: ${subject}`,
        `Priority: ${prio}`,
        `MessageType: ${msgType}`,
        '---',
        body,
      ].join('\n');

      await writeFile(filePath, content, 'utf-8');
      res.json({ success: true, filename, path: filePath });
    } catch (err) {
      res.status(500).json({ error: 'Failed to send message' });
    }
  });

  return router;
}

function resolveMailboxRoot(projectRoot: string, repoPath?: string): string {
  if (repoPath) {
    return path.resolve(projectRoot, repoPath);
  }
  return projectRoot;
}

async function collectMessages(agentDir: string): Promise<Array<{ filename: string; folder: string; path: string }>> {
  const messages: Array<{ filename: string; folder: string; path: string }> = [];
  const folders = ['priority', 'normal', 'background', ''];
  for (const folder of folders) {
    const dir = folder ? path.join(agentDir, folder) : agentDir;
    try {
      const files = await readdir(dir);
      for (const f of files) {
        if (f.endsWith('.md') || f.endsWith('.txt')) {
          const fullPath = path.join(dir, f);
          const s = await stat(fullPath);
          if (s.isFile()) {
            messages.push({ filename: f, folder: folder || 'root', path: fullPath });
          }
        }
      }
    } catch { /* folder doesn't exist */ }
  }
  return messages;
}

function findMessage(agentDir: string, filename: string): string | null {
  // Check for path traversal
  const safe = path.basename(filename);
  const folders = ['priority', 'normal', 'background', ''];
  for (const folder of folders) {
    const candidate = folder
      ? path.join(agentDir, folder, safe)
      : path.join(agentDir, safe);
    try {
      // Synchronous existence check for simplicity in route handler
      require('fs').accessSync(candidate);
      return candidate;
    } catch { /* not found */ }
  }
  return null;
}

function formatTimestamp(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const h = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  return `${y}-${m}-${d}-${h}${min}`;
}

function sanitize(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, '_');
}
