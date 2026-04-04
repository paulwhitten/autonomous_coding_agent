// Workflow CRUD API routes

import { Router, Request, Response } from '../express-compat.js';
import { readFile, writeFile, readdir } from 'fs/promises';
import path from 'path';
import { validateWorkflow } from '../validation.js';

export function createWorkflowRouter(projectRoot: string): Router {
  const router = Router();
  const workflowDir = path.join(projectRoot, 'workflows');

  // GET /api/workflows — list all workflow files
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const files = await readdir(workflowDir);
      const workflows = files.filter(f => f.endsWith('.workflow.json'));
      const summaries = await Promise.all(
        workflows.map(async (f) => {
          try {
            const raw = await readFile(path.join(workflowDir, f), 'utf-8');
            const wf = JSON.parse(raw);
            return { file: f, id: wf.id, name: wf.name, description: wf.description, version: wf.version };
          } catch {
            return { file: f, id: null, name: f, description: 'Parse error', version: '?' };
          }
        })
      );
      res.json({ workflows: summaries });
    } catch (err) {
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
      const filePath = path.join(workflowDir, filename);
      const raw = await readFile(filePath, 'utf-8');
      const workflow = JSON.parse(raw);
      res.json(workflow);
    } catch (err) {
      res.status(404).json({ error: 'Workflow file not found' });
    }
  });

  // PUT /api/workflows/:filename — write/update a workflow
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
      const filePath = path.join(workflowDir, filename);
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

  // DELETE /api/workflows/:filename — delete a workflow
  router.delete('/:filename', async (req: Request, res: Response) => {
    try {
      const filename = path.basename(req.params.filename as string);
      const filePath = path.join(workflowDir, filename);
      const { unlink } = await import('fs/promises');
      await unlink(filePath);
      res.json({ success: true, deleted: filename });
    } catch (err) {
      res.status(404).json({ error: 'Workflow file not found' });
    }
  });

  return router;
}
