// Config CRUD API routes

import { Router, Request, Response } from 'express';
import { readFile, writeFile, readdir, unlink } from 'fs/promises';
import path from 'path';
import { validateConfig } from '../validation.js';

export function createConfigRouter(projectRoot: string): Router {
  const router = Router();

  // GET /api/config — list available config files
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const files = await readdir(projectRoot);
      const configFiles = files.filter(f => f.endsWith('.json') && f.startsWith('config'));
      res.json({ configs: configFiles });
    } catch (err) {
      res.status(500).json({ error: 'Failed to list configs' });
    }
  });

  // GET /api/config/:filename — read a specific config
  router.get('/:filename', async (req: Request, res: Response) => {
    try {
      const filename = path.basename(req.params.filename as string);
      if (!filename.endsWith('.json')) {
        res.status(400).json({ error: 'File must be .json' });
        return;
      }
      const filePath = path.join(projectRoot, filename);
      const raw = await readFile(filePath, 'utf-8');
      // Strip JS-style comments before parsing
      const cleaned = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const config = JSON.parse(cleaned);
      res.json(config);
    } catch (err) {
      res.status(404).json({ error: 'Config file not found' });
    }
  });

  // PUT /api/config/:filename — write/update a config file
  router.put('/:filename', async (req: Request, res: Response) => {
    try {
      const filename = path.basename(req.params.filename as string);
      if (!filename.endsWith('.json')) {
        res.status(400).json({ error: 'File must be .json' });
        return;
      }
      const validation = validateConfig(req.body);
      if (!validation.valid) {
        res.status(400).json({ error: 'Validation failed', details: validation.errors });
        return;
      }
      const filePath = path.join(projectRoot, filename);
      await writeFile(filePath, JSON.stringify(req.body, null, 2), 'utf-8');
      res.json({ success: true, file: filename });
    } catch (err) {
      res.status(500).json({ error: 'Failed to write config' });
    }
  });

  // POST /api/config/validate — validate a config without saving
  router.post('/validate', async (req: Request, res: Response) => {
    const validation = validateConfig(req.body);
    res.json(validation);
  });

  // DELETE /api/config/:filename — delete a config file
  router.delete('/:filename', async (req: Request, res: Response) => {
    try {
      const filename = path.basename(req.params.filename as string);
      if (!filename.endsWith('.json')) {
        res.status(400).json({ error: 'File must be .json' });
        return;
      }
      // Prevent deleting the example file
      if (filename === 'config.example.json') {
        res.status(400).json({ error: 'Cannot delete the example config' });
        return;
      }
      const filePath = path.join(projectRoot, filename);
      await unlink(filePath);
      res.json({ success: true });
    } catch (err) {
      res.status(404).json({ error: 'Config file not found' });
    }
  });

  return router;
}
