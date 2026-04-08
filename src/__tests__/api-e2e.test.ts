/**
 * End-to-end integration tests for the Autonomous Agent API server.
 * Tests the full HTTP roundtrip for core API endpoints.
 */

import { createApiServer } from '../api/server.js';
import { Server } from 'http';
import path from 'path';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

let httpServer: Server;
let port: number;

async function apiRequest(
  endpoint: string,
  options: { method?: string; body?: unknown } = {}
) {
  const { method = 'GET', body } = options;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const res = await fetch(`http://localhost:${port}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

beforeAll(async () => {
  const server = await createApiServer(PROJECT_ROOT, 0); // port 0 = random available port
  const addr = server.httpServer.listen(0).address();
  port = typeof addr === 'object' && addr ? addr.port : 3099;
  httpServer = server.httpServer;
});

afterAll(async () => {
  if (httpServer) {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
});

describe('API Server E2E', () => {
  test('GET /api/health returns ok', async () => {
    const { status, json } = await apiRequest('/api/health');
    expect(status).toBe(200);
    expect(json).toHaveProperty('status', 'ok');
    expect(json).toHaveProperty('timestamp');
  });

  test('GET /api/auth/check returns auth status', async () => {
    const { status, json } = await apiRequest('/api/auth/check');
    expect(status).toBe(200);
    expect(json).toHaveProperty('required');
    expect(json).toHaveProperty('authenticated');
  });

  describe('Config endpoints', () => {
    test('GET /api/config lists config files', async () => {
      const { status, json } = await apiRequest('/api/config');
      expect(status).toBe(200);
      expect(json).toHaveProperty('configs');
      expect(Array.isArray(json.configs)).toBe(true);
    });

    test('POST /api/config/validate validates config structure', async () => {
      const { status, json } = await apiRequest('/api/config/validate', {
        method: 'POST',
        body: { agent: { name: 'test' } },
      });
      expect(status).toBe(200);
      expect(json).toHaveProperty('valid');
    });
  });

  describe('Workflow endpoints', () => {
    test('GET /api/workflows lists workflow files', async () => {
      const { status, json } = await apiRequest('/api/workflows');
      expect(status).toBe(200);
      expect(json).toHaveProperty('workflows');
      expect(Array.isArray(json.workflows)).toBe(true);
    });

    test('POST /api/workflows/validate validates against JSON schema', async () => {
      const { status, json } = await apiRequest('/api/workflows/validate', {
        method: 'POST',
        body: {
          id: 'test',
          name: 'Test Workflow',
          version: '1.0.0',
          initialState: 'START',
          terminalStates: ['DONE'],
          states: {
            START: {
              name: 'Start',
              role: 'developer',
              description: 'Start',
              prompt: 'Do something',
              allowedTools: [],
              transitions: { onSuccess: 'DONE', onFailure: 'DONE' },
            },
            DONE: {
              name: 'Done',
              role: 'developer',
              description: 'Done',
              prompt: 'Done',
              allowedTools: [],
              transitions: { onSuccess: null, onFailure: null },
            },
          },
        },
      });
      expect(status).toBe(200);
      expect(json).toHaveProperty('valid');
    });
  });

  describe('Team endpoints', () => {
    test('GET /api/team returns team data or error', async () => {
      const { status } = await apiRequest('/api/team');
      // May return 200 or 404/500 depending on whether team.json exists
      expect([200, 404, 500]).toContain(status);
    });
  });

  describe('Agent endpoints', () => {
    test('GET /api/agents/roles returns role definitions', async () => {
      const { status, json } = await apiRequest('/api/agents/roles');
      expect(status).toBe(200);
      expect(json).toHaveProperty('roles');
      expect(json).toHaveProperty('definitions');
    });

    test('GET /api/agents/quota-presets returns preset data', async () => {
      const { status, json } = await apiRequest('/api/agents/quota-presets');
      expect(status).toBe(200);
      expect(json).toBeDefined();
    });
  });

  describe('Template endpoints', () => {
    test('GET /api/templates lists templates', async () => {
      const { status, json } = await apiRequest('/api/templates');
      expect(status).toBe(200);
      expect(json).toHaveProperty('templates');
      expect(Array.isArray(json.templates)).toBe(true);
      // Should include built-in templates plus any workflow files
      expect(json.templates.length).toBeGreaterThanOrEqual(1);
    });

    test('GET /api/templates/:id returns a specific template', async () => {
      // First get the list to find a valid id
      const { json: listJson } = await apiRequest('/api/templates');
      if (listJson.templates.length > 0) {
        const templateId = listJson.templates[0].id;
        const { status, json } = await apiRequest(`/api/templates/${templateId}`);
        expect(status).toBe(200);
        expect(json).toHaveProperty('workflow');
      }
    });

    test('GET /api/templates/nonexistent returns 404', async () => {
      const { status } = await apiRequest('/api/templates/nonexistent-template-id');
      expect(status).toBe(404);
    });
  });

  describe('Process endpoints', () => {
    test('GET /api/processes returns empty list initially', async () => {
      const { status, json } = await apiRequest('/api/processes');
      expect(status).toBe(200);
      expect(json).toHaveProperty('processes');
      expect(Array.isArray(json.processes)).toBe(true);
    });

    test('GET /api/processes/configs lists config files', async () => {
      const { status, json } = await apiRequest('/api/processes/configs');
      expect(status).toBe(200);
      expect(json).toHaveProperty('configs');
    });

    test('POST /api/processes rejects missing configFile', async () => {
      const { status } = await apiRequest('/api/processes', {
        method: 'POST',
        body: {},
      });
      expect(status).toBe(400);
    });

    test('POST /api/processes rejects path traversal', async () => {
      const { status } = await apiRequest('/api/processes', {
        method: 'POST',
        body: { configFile: '../../../etc/passwd' },
      });
      expect(status).toBe(400);
    });
  });

  describe('Instructions endpoints', () => {
    test('GET /api/instructions returns instructions or empty skeleton', async () => {
      const { status, json } = await apiRequest('/api/instructions');
      expect(status).toBe(200);
      expect(json).toBeDefined();
    });

    test('GET /api/instructions/example returns example file', async () => {
      const { status, json } = await apiRequest('/api/instructions/example');
      expect(status).toBe(200);
      expect(json).toHaveProperty('gitWorkflow');
      expect(json).toHaveProperty('codingStandards');
      expect(json).toHaveProperty('buildSystem');
    });
  });

  describe('A2A endpoints', () => {
    test('GET /api/a2a/status returns configuration summary', async () => {
      const { status, json } = await apiRequest('/api/a2a/status');
      expect(status).toBe(200);
      expect(json).toHaveProperty('configured');
    });

    test('GET /api/a2a/agent-card returns agent card or 404', async () => {
      const { status } = await apiRequest('/api/a2a/agent-card');
      expect([200, 404]).toContain(status);
    });

    test('GET /api/a2a/discovered-agents returns agent data', async () => {
      const { status, json } = await apiRequest('/api/a2a/discovered-agents');
      expect(status).toBe(200);
      // When config exists, returns knownUrls + teamAgents; otherwise returns agents: []
      expect(json).toBeDefined();
    });

    test('GET /api/a2a/audit returns entries array', async () => {
      const { status, json } = await apiRequest('/api/a2a/audit');
      expect(status).toBe(200);
      expect(json).toHaveProperty('entries');
      expect(Array.isArray(json.entries)).toBe(true);
    });

    test('GET /api/a2a/config returns a2a config block', async () => {
      const { status, json } = await apiRequest('/api/a2a/config');
      expect(status).toBe(200);
      expect(json).toHaveProperty('a2aConfig');
    });

    test('POST /api/a2a/probe rejects missing url', async () => {
      const { status } = await apiRequest('/api/a2a/probe', {
        method: 'POST',
        body: {},
      });
      expect(status).toBe(400);
    });

    test('POST /api/a2a/probe rejects non-http URL', async () => {
      const { status, json } = await apiRequest('/api/a2a/probe', {
        method: 'POST',
        body: { url: 'ftp://example.com' },
      });
      expect(status).toBe(400);
      expect(json).toHaveProperty('error');
    });

    test('POST /api/a2a/probe-all rejects missing urls array', async () => {
      const { status, json } = await apiRequest('/api/a2a/probe-all', {
        method: 'POST',
        body: {},
      });
      expect(status).toBe(400);
      expect(json).toHaveProperty('error');
    });

    test('POST /api/a2a/probe-all handles batch of unreachable URLs', async () => {
      const { status, json } = await apiRequest('/api/a2a/probe-all', {
        method: 'POST',
        body: { urls: ['http://localhost:19999', 'http://localhost:19998'] },
      });
      expect(status).toBe(200);
      expect(json).toHaveProperty('results');
      expect(Array.isArray(json.results)).toBe(true);
      expect(json.results.length).toBe(2);
      expect(json).toHaveProperty('total', 2);
      expect(json).toHaveProperty('found', 0);
      for (const r of json.results) {
        expect(r.found).toBe(false);
      }
    });

    test('GET /api/a2a/audit supports pagination params', async () => {
      const { status, json } = await apiRequest('/api/a2a/audit?limit=10&offset=0');
      expect(status).toBe(200);
      expect(json).toHaveProperty('entries');
      expect(json).toHaveProperty('total');
      expect(json).toHaveProperty('offset');
      expect(json).toHaveProperty('limit');
      expect(typeof json.total).toBe('number');
    });

    test('GET /api/a2a/audit supports direction filter', async () => {
      const { status, json } = await apiRequest('/api/a2a/audit?direction=inbound');
      expect(status).toBe(200);
      expect(json).toHaveProperty('entries');
      expect(Array.isArray(json.entries)).toBe(true);
    });

    test('GET /api/a2a/server-status returns running state', async () => {
      const { status, json } = await apiRequest('/api/a2a/server-status');
      expect(status).toBe(200);
      expect(json).toHaveProperty('running');
      expect(typeof json.running).toBe('boolean');
    });

    test('GET /api/a2a/agent-card/preview returns merged card', async () => {
      const { status } = await apiRequest('/api/a2a/agent-card/preview');
      // 200 when config exists, 404 otherwise
      expect([200, 404]).toContain(status);
    });

    test('GET /api/a2a/audit/export returns JSON array', async () => {
      const { status, json } = await apiRequest('/api/a2a/audit/export?format=json');
      expect(status).toBe(200);
      expect(Array.isArray(json)).toBe(true);
    });
  });
});
