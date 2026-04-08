// Express API server for the Autonomous Coding Agent web UI

import express from 'express';
import type { Request, Response, NextFunction } from './express-compat.js';
import cors from 'cors';
import { createServer } from 'http';
import path from 'path';
// @ts-expect-error — no type declarations available
import swaggerJsdoc from 'swagger-jsdoc';
// @ts-expect-error — no type declarations available
import swaggerUi from 'swagger-ui-express';
import { createConfigRouter } from './routes/config.js';
import { createWorkflowRouter } from './routes/workflows.js';
import { createTeamRouter } from './routes/team.js';
import { createMailboxRouter } from './routes/mailbox.js';
import { createAgentsRouter } from './routes/agents.js';
import { createTemplatesRouter } from './routes/templates.js';
import { createProcessesRouter } from './routes/processes.js';
import { createInstructionsRouter } from './routes/instructions.js';
import { createA2ARouter } from './routes/a2a.js';
import { createProjectsRouter } from './routes/projects.js';
import { initWebSocket, broadcast } from './websocket.js';
import { startFileWatcher } from './file-watcher.js';
import { loadWorkflowSchema } from './validation.js';
import { authMiddleware, createAuthCheckRoute } from './auth.js';
import { startAgentBrowser, stopAgentBrowser } from './agent-browser.js';

export async function createApiServer(projectRoot: string, port: number = 3001) {
  const app = express();
  const httpServer = createServer(app);

  // Middleware
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  // Authentication — requires API_KEY env var to be set
  app.use('/api', authMiddleware);
  app.get('/api/auth/check', createAuthCheckRoute());

  // Load workflow schema for validation
  await loadWorkflowSchema(projectRoot).catch(err => {
    console.warn('[api] Could not load workflow schema:', err.message);
  });

  // Swagger setup
  const swaggerSpec = swaggerJsdoc({
    definition: {
      openapi: '3.0.0',
      info: {
        title: 'Autonomous Coding Agent API',
        version: '1.0.0',
        description: 'REST API for configuring, monitoring, and interacting with autonomous coding agents',
      },
      servers: [{ url: `http://localhost:${port}` }],
    },
    apis: [], // We define routes inline below
  });

  // Manual swagger paths
  swaggerSpec.paths = {
    '/api/config': {
      get: { summary: 'List config files', tags: ['Config'], responses: { '200': { description: 'List of config filenames' } } },
    },
    '/api/config/{filename}': {
      get: { summary: 'Read a config file', tags: ['Config'], parameters: [{ name: 'filename', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Config JSON' } } },
      put: { summary: 'Write a config file', tags: ['Config'], parameters: [{ name: 'filename', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Success' } } },
    },
    '/api/workflows': {
      get: { summary: 'List all workflows', tags: ['Workflows'], responses: { '200': { description: 'List of workflow summaries' } } },
    },
    '/api/workflows/{filename}': {
      get: { summary: 'Read a workflow', tags: ['Workflows'], parameters: [{ name: 'filename', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Workflow JSON' } } },
      put: { summary: 'Write a workflow', tags: ['Workflows'], parameters: [{ name: 'filename', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Success' } } },
      delete: { summary: 'Delete a workflow', tags: ['Workflows'], parameters: [{ name: 'filename', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Success' } } },
    },
    '/api/team': {
      get: { summary: 'Get team roster', tags: ['Team'], responses: { '200': { description: 'Team roster JSON' } } },
      put: { summary: 'Update team roster', tags: ['Team'], responses: { '200': { description: 'Success' } } },
    },
    '/api/mailbox': {
      get: { summary: 'List agent mailboxes', tags: ['Mailbox'], responses: { '200': { description: 'Agent mailbox list' } } },
    },
    '/api/mailbox/{agentId}': {
      get: { summary: 'List messages for an agent', tags: ['Mailbox'], parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Message list' } } },
      post: { summary: 'Send a message to an agent', tags: ['Mailbox'], parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Success' } } },
    },
    '/api/agents/status': {
      get: { summary: 'Get agent status', tags: ['Agents'], responses: { '200': { description: 'Agent status' } } },
    },
    '/api/agents/work-items': {
      get: { summary: 'List work items', tags: ['Agents'], responses: { '200': { description: 'Work items by status' } } },
    },
    '/api/agents/roles': {
      get: { summary: 'Get role definitions', tags: ['Agents'], responses: { '200': { description: 'Role definitions' } } },
    },
    '/api/agents/logs': {
      get: { summary: 'Read agent logs', tags: ['Agents'], responses: { '200': { description: 'Recent log lines' } } },
    },
    '/api/processes': {
      get: { summary: 'List tracked processes', tags: ['Processes'], responses: { '200': { description: 'Process list' } } },
      post: { summary: 'Start an agent process', tags: ['Processes'], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { configFile: { type: 'string' } } } } } }, responses: { '200': { description: 'Process started' } } },
    },
    '/api/processes/{id}': {
      get: { summary: 'Get process details', tags: ['Processes'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Process details' } } },
      delete: { summary: 'Stop a process', tags: ['Processes'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Process stopped' } } },
    },
    '/api/instructions': {
      get: { summary: 'Read custom instructions', tags: ['Instructions'], responses: { '200': { description: 'Custom instructions JSON' } } },
      put: { summary: 'Write custom instructions', tags: ['Instructions'], responses: { '200': { description: 'Success' } } },
    },
    '/api/projects': {
      get: { summary: 'List all projects', tags: ['Projects'], responses: { '200': { description: 'Project list' } } },
      post: { summary: 'Create a new project', tags: ['Projects'], responses: { '200': { description: 'Created project' } } },
    },
    '/api/projects/{id}': {
      get: { summary: 'Read a project', tags: ['Projects'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Project JSON' } } },
      put: { summary: 'Update a project', tags: ['Projects'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Updated project' } } },
      delete: { summary: 'Delete a project', tags: ['Projects'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Success' } } },
    },
    '/api/projects/{id}/apply': {
      post: { summary: 'Apply project — generate configs and custom_instructions', tags: ['Projects'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Apply results' } } },
    },
  };

  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

  // API routes
  app.use('/api/config', createConfigRouter(projectRoot));
  app.use('/api/workflows', createWorkflowRouter(projectRoot));
  app.use('/api/team', createTeamRouter(projectRoot));
  app.use('/api/mailbox', createMailboxRouter(projectRoot));
  app.use('/api/agents', createAgentsRouter(projectRoot));
  app.use('/api/templates', createTemplatesRouter(projectRoot));
  app.use('/api/processes', createProcessesRouter(projectRoot));
  app.use('/api/instructions', createInstructionsRouter(projectRoot));
  app.use('/api/a2a', createA2ARouter(projectRoot));
  app.use('/api/projects', createProjectsRouter(projectRoot));

  // Health check
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Serve static frontend in production
  const webDist = path.join(projectRoot, 'web', 'dist');
  app.use(express.static(webDist));
  // SPA fallback — serve index.html for non-API routes
  app.use((_req: Request, res: Response, next: NextFunction) => {
    if (_req.path.startsWith('/api') || _req.path.startsWith('/socket.io')) {
      next();
      return;
    }
    res.sendFile(path.join(webDist, 'index.html'), (err: Error | undefined) => {
      if (err) next();
    });
  });

  // WebSocket
  const io = initWebSocket(httpServer);

  // File watcher for real-time updates
  const watchPaths = [
    path.join(projectRoot, 'workflows'),
    path.join(projectRoot, 'logs'),
  ];
  startFileWatcher(watchPaths);

  // Persistent mDNS browser for real-time agent discovery
  startAgentBrowser();

  return { app, httpServer, io, port };
}
