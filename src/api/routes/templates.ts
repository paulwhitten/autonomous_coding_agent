// Workflow template library — pre-built workflow patterns for one-click creation

import { Router, Request, Response } from 'express';
import { readFile, readdir } from 'fs/promises';
import path from 'path';

interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  workflow: Record<string, unknown>;
}

export function createTemplatesRouter(projectRoot: string): Router {
  const router = Router();

  // GET /api/templates — list all available templates
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const templates = await loadTemplates(projectRoot);
      res.json({
        templates: templates.map(t => ({
          id: t.id,
          name: t.name,
          description: t.description,
          category: t.category,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to list templates' });
    }
  });

  // GET /api/templates/:id — get a full template workflow
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const templates = await loadTemplates(projectRoot);
      const tpl = templates.find(t => t.id === req.params.id);
      if (!tpl) {
        res.status(404).json({ error: 'Template not found' });
        return;
      }
      res.json(tpl);
    } catch (err) {
      res.status(500).json({ error: 'Failed to load template' });
    }
  });

  return router;
}

async function loadTemplates(projectRoot: string): Promise<WorkflowTemplate[]> {
  const templates: WorkflowTemplate[] = [];

  // Load from existing workflow files as templates
  const workflowDir = path.join(projectRoot, 'workflows');
  try {
    const files = await readdir(workflowDir);
    for (const file of files) {
      if (!file.endsWith('.workflow.json')) continue;
      try {
        const raw = await readFile(path.join(workflowDir, file), 'utf-8');
        const wf = JSON.parse(raw);
        templates.push({
          id: wf.id || file.replace('.workflow.json', ''),
          name: wf.name || file,
          description: wf.description || '',
          category: categorize(wf),
          workflow: wf,
        });
      } catch { /* skip unparseable files */ }
    }
  } catch { /* no workflows dir */ }

  // Add built-in starter templates
  templates.push(...BUILT_IN_TEMPLATES);

  return templates;
}

function categorize(wf: Record<string, unknown>): string {
  const id = String(wf.id || '');
  if (id.includes('regulatory') || id.includes('v-model')) return 'Compliance';
  if (id.includes('qa') || id.includes('merge')) return 'Development';
  if (id.includes('hello')) return 'Getting Started';
  return 'General';
}

const BUILT_IN_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'blank-workflow',
    name: 'Blank Workflow',
    description: 'A minimal empty workflow with just START and DONE states. Build your own from scratch.',
    category: 'Getting Started',
    workflow: {
      id: 'custom-workflow',
      name: 'Custom Workflow',
      description: '',
      version: '1.0.0',
      initialState: 'START',
      terminalStates: ['DONE'],
      globalContext: { projectPath: 'workspace/project' },
      states: {
        START: {
          name: 'Start',
          role: 'manager',
          description: 'Entry point',
          prompt: '',
          allowedTools: [],
          transitions: { onSuccess: 'DONE', onFailure: 'DONE' },
        },
        DONE: {
          name: 'Complete',
          role: 'manager',
          description: 'Terminal state',
          prompt: '',
          allowedTools: [],
          transitions: { onSuccess: null, onFailure: null },
        },
      },
    },
  },
  {
    id: 'dev-only',
    name: 'Developer Only',
    description: 'Manager assigns, developer implements. No QA gate. Good for prototyping.',
    category: 'Development',
    workflow: {
      id: 'dev-only',
      name: 'Developer Only',
      description: 'Simple assign-implement-done workflow without QA.',
      version: '1.0.0',
      initialState: 'ASSIGN',
      terminalStates: ['DONE', 'ESCALATED'],
      globalContext: {
        projectPath: 'workspace/project',
        buildCommand: 'npm run build',
        testCommand: 'npm test',
      },
      states: {
        ASSIGN: {
          name: 'Task Assignment',
          role: 'manager',
          description: 'Manager routes task to developer.',
          prompt: '',
          allowedTools: [],
          transitions: { onSuccess: 'IMPLEMENTING', onFailure: 'ESCALATED' },
        },
        IMPLEMENTING: {
          name: 'Implementation',
          role: 'developer',
          description: 'Developer implements the task.',
          prompt: 'Implement the assigned task.\n\n1. cd {{projectPath}}\n2. Create or modify files as needed\n3. Run: {{buildCommand}}\n4. Run: {{testCommand}}\n5. Fix any errors',
          allowedTools: ['terminal', 'file_ops', 'reporting'],
          transitions: { onSuccess: 'DONE', onFailure: 'IMPLEMENTING' },
          maxRetries: 2,
          timeoutMs: 600000,
        },
        DONE: {
          name: 'Complete',
          role: 'manager',
          description: 'Task complete.',
          prompt: '',
          allowedTools: [],
          transitions: { onSuccess: null, onFailure: null },
        },
        ESCALATED: {
          name: 'Escalated',
          role: 'manager',
          description: 'Task escalated.',
          prompt: '',
          allowedTools: [],
          transitions: { onSuccess: null, onFailure: null },
        },
      },
    },
  },
  {
    id: 'research-report',
    name: 'Research & Report',
    description: 'Researcher gathers information, then developer creates a report. Good for documentation tasks.',
    category: 'General',
    workflow: {
      id: 'research-report',
      name: 'Research & Report',
      description: 'Researcher investigates, developer writes report.',
      version: '1.0.0',
      initialState: 'ASSIGN',
      terminalStates: ['DONE'],
      globalContext: { projectPath: 'workspace/project' },
      states: {
        ASSIGN: {
          name: 'Task Assignment',
          role: 'manager',
          description: 'Manager assigns research topic.',
          prompt: '',
          allowedTools: [],
          transitions: { onSuccess: 'RESEARCHING', onFailure: 'DONE' },
        },
        RESEARCHING: {
          name: 'Research',
          role: 'researcher',
          description: 'Researcher gathers information.',
          prompt: 'Research the assigned topic thoroughly.\n\n1. Gather relevant information\n2. Document findings with sources\n3. Summarize key points',
          allowedTools: ['terminal', 'file_ops'],
          transitions: { onSuccess: 'WRITING', onFailure: 'RESEARCHING' },
          maxRetries: 1,
        },
        WRITING: {
          name: 'Report Writing',
          role: 'developer',
          description: 'Developer writes the report.',
          prompt: 'Create a report based on the research findings.\n\n1. cd {{projectPath}}\n2. Create a well-structured report document\n3. Include findings, analysis, and recommendations',
          allowedTools: ['terminal', 'file_ops'],
          transitions: { onSuccess: 'DONE', onFailure: 'WRITING' },
          maxRetries: 1,
        },
        DONE: {
          name: 'Complete',
          role: 'manager',
          description: 'Report complete.',
          prompt: '',
          allowedTools: [],
          transitions: { onSuccess: null, onFailure: null },
        },
      },
    },
  },
];
