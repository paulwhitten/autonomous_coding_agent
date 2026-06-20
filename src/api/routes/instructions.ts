// Custom instructions CRUD — read and write custom_instructions.json

import { Router, Request, Response } from '../express-compat.js';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';

export function createInstructionsRouter(projectRoot: string): Router {
  const router = Router();

  const defaultPath = path.join(projectRoot, 'custom_instructions.json');

  // GET /api/instructions — read the current custom_instructions.json
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const raw = await readFile(defaultPath, 'utf-8');
      const data = JSON.parse(raw);
      res.json(data);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // No custom instructions yet — return empty skeleton
        res.json({
          gitWorkflow: {},
          codingStandards: {},
          buildSystem: {},
          projectContext: [],
          additionalSections: [],
        });
        return;
      }
      res.status(500).json({ error: 'Failed to read custom instructions' });
    }
  });

  // PUT /api/instructions — write custom_instructions.json
  router.put('/', async (req: Request, res: Response) => {
    try {
      const data = req.body;
      if (!data || typeof data !== 'object') {
        res.status(400).json({ error: 'Request body must be a JSON object' });
        return;
      }
      await writeFile(defaultPath, JSON.stringify(data, null, 2), 'utf-8');
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to write custom instructions' });
    }
  });

  // GET /api/instructions/example — read the example file for reference
  router.get('/example', async (_req: Request, res: Response) => {
    try {
      const examplePath = path.join(projectRoot, 'custom_instructions.example.json');
      const raw = await readFile(examplePath, 'utf-8');
      const data = JSON.parse(raw);
      res.json(data);
    } catch {
      res.status(404).json({ error: 'Example file not found' });
    }
  });

  return router;
}
