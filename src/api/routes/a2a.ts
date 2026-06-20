// A2A protocol management API routes
//
// Provides endpoints for viewing the local agent card, discovering
// remote agents, reading audit logs, and managing A2A configuration.

import { Router, Request, Response } from '../express-compat.js';
import { readFile, writeFile, readdir, stat } from 'fs/promises';
import path from 'path';
import { broadcast } from '../websocket.js';

export function createA2ARouter(projectRoot: string): Router {
  const router = Router();

  // --- Helpers -----------------------------------------------------------

  /** Find and parse the active config file. Returns null on failure. */
  async function loadActiveConfig(): Promise<{ config: Record<string, unknown>; configPath: string } | null> {
    const candidates = ['config.json', 'config.local.json'];
    for (const name of candidates) {
      try {
        const filePath = path.join(projectRoot, name);
        const raw = await readFile(filePath, 'utf-8');
        const cleaned = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        return { config: JSON.parse(cleaned), configPath: filePath };
      } catch { /* try next */ }
    }
    return null;
  }

  /** Build the a2a config summary from a parsed config. */
  function getA2AConfig(config: Record<string, unknown>): Record<string, unknown> {
    const comm = config.communication as Record<string, unknown> | undefined;
    return (comm?.a2a as Record<string, unknown>) ?? {};
  }

  /** Build the local agent card from config values. */
  function buildAgentCard(config: Record<string, unknown>): Record<string, unknown> {
    const agent = config.agent as Record<string, unknown> | undefined;
    const a2a = getA2AConfig(config);
    const agentCardOverrides = a2a.agentCard as Record<string, unknown> | undefined;
    const hostname = (agent?.hostname as string) || 'localhost';
    const role = (agent?.role as string) || 'agent';
    const serverPort = (a2a.serverPort as number) || 4000;

    // Build capabilities from config
    const capabilities = (agent?.capabilities as string[]) || [];
    const skills = capabilities.map(cap => ({
      id: cap,
      name: cap.replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
      description: `Capability: ${cap}`,
      tags: [role, cap],
    }));

    // Merge override skills
    const overrideSkills = (agentCardOverrides?.skills as Array<Record<string, unknown>>) || [];
    const existingIds = new Set(skills.map(s => s.id));
    const allSkills = [
      ...skills,
      ...overrideSkills.filter(s => !existingIds.has(s.id as string)),
    ];

    return {
      name: (agentCardOverrides?.name as string) || `${hostname}_${role}`,
      description: (agentCardOverrides?.description as string) || `Autonomous ${role} agent`,
      protocolVersion: '0.3.0',
      version: (agentCardOverrides?.version as string) || '1.0.0',
      url: `http://${hostname}:${serverPort}/a2a/jsonrpc`,
      skills: allSkills,
      capabilities: { pushNotifications: false, streaming: false },
      defaultInputModes: (agentCardOverrides?.inputModes as string[]) || ['text/plain'],
      defaultOutputModes: (agentCardOverrides?.outputModes as string[]) || ['text/plain'],
      provider: (agentCardOverrides?.provider as Record<string, unknown>) || { organization: hostname },
    };
  }

  // --- Routes ------------------------------------------------------------

  // GET /api/a2a/status — A2A configuration summary and implied server status
  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const loaded = await loadActiveConfig();
      if (!loaded) {
        res.json({ configured: false, message: 'No config file found' });
        return;
      }
      const a2a = getA2AConfig(loaded.config);
      const agent = loaded.config.agent as Record<string, unknown> | undefined;

      res.json({
        configured: true,
        serverPort: (a2a.serverPort as number) || 4000,
        transport: (a2a.transport as string) || 'jsonrpc',
        agentCardPath: (a2a.agentCardPath as string) || '/.well-known/agent-card.json',
        tls: (a2a.tls as Record<string, unknown>) || { enabled: false },
        authentication: (a2a.authentication as Record<string, unknown>) || { scheme: 'none' },
        pushNotifications: (a2a.pushNotifications as Record<string, unknown>) || { enabled: false },
        knownAgentUrls: (a2a.knownAgentUrls as string[]) || [],
        registryUrl: (a2a.registryUrl as string) || '',
        auditDir: (a2a.auditDir as string) || 'audit/a2a',
        hostname: (agent?.hostname as string) || 'localhost',
        role: (agent?.role as string) || 'agent',
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to read A2A status' });
    }
  });

  // GET /api/a2a/agent-card — local agent card built from config
  router.get('/agent-card', async (_req: Request, res: Response) => {
    try {
      const loaded = await loadActiveConfig();
      if (!loaded) {
        res.status(404).json({ error: 'No config file found' });
        return;
      }
      const card = buildAgentCard(loaded.config);
      res.json({ agentCard: card });
    } catch (err) {
      res.status(500).json({ error: 'Failed to build agent card' });
    }
  });

  // GET /api/a2a/agent-card/preview — preview merged agent card with current overrides
  router.get('/agent-card/preview', async (_req: Request, res: Response) => {
    try {
      const loaded = await loadActiveConfig();
      if (!loaded) {
        res.status(404).json({ error: 'No config file found' });
        return;
      }
      const card = buildAgentCard(loaded.config);
      // Also return the raw overrides so the UI can show what's custom vs auto
      const a2a = getA2AConfig(loaded.config);
      const overrides = (a2a.agentCard as Record<string, unknown>) || {};
      res.json({ mergedCard: card, overrides });
    } catch (err) {
      res.status(500).json({ error: 'Failed to preview agent card' });
    }
  });

  // POST /api/a2a/probe — probe a remote URL for its agent card
  router.post('/probe', async (req: Request, res: Response) => {
    try {
      const { url } = req.body as { url?: string };
      if (!url || typeof url !== 'string') {
        res.status(400).json({ error: 'url is required' });
        return;
      }

      // Validate URL format
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        res.status(400).json({ error: 'Invalid URL format' });
        return;
      }

      // Only allow http/https
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        res.status(400).json({ error: 'Only http and https URLs are supported' });
        return;
      }

      const wellKnown = url.endsWith('/')
        ? `${url}.well-known/agent-card.json`
        : `${url}/.well-known/agent-card.json`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(wellKnown, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) {
        res.json({ found: false, status: response.status, url: wellKnown });
        return;
      }

      const agentCard = await response.json();
      res.json({ found: true, url: wellKnown, agentCard });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('abort')) {
        res.json({ found: false, error: 'Connection timed out (5s)' });
      } else {
        res.json({ found: false, error: message });
      }
    }
  });

  // GET /api/a2a/discovered-agents — list known agents from config
  router.get('/discovered-agents', async (_req: Request, res: Response) => {
    try {
      const loaded = await loadActiveConfig();
      if (!loaded) {
        res.json({ knownUrls: [], teamAgents: [] });
        return;
      }
      const a2a = getA2AConfig(loaded.config);
      const knownUrls = (a2a.knownAgentUrls as string[]) || [];

      // Also check team.json for agents with a2a:// URIs
      const teamAgents: Array<Record<string, unknown>> = [];
      try {
        const teamFiles = ['team.json', 'roles.json'];
        for (const tf of ['team.json']) {
          const raw = await readFile(path.join(projectRoot, tf), 'utf-8');
          const team = JSON.parse(raw);
          const agents = (team.agents || []) as Array<Record<string, unknown>>;
          for (const agent of agents) {
            const uri = agent.uri as string | undefined;
            if (uri?.startsWith('a2a://')) {
              teamAgents.push({
                hostname: agent.hostname,
                role: agent.role,
                uri,
                url: `http://${uri.slice('a2a://'.length)}`,
                capabilities: agent.capabilities || [],
              });
            }
          }
        }
      } catch { /* team.json may not exist */ }

      res.json({
        knownUrls,
        teamAgents,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to read discovered agents' });
    }
  });

  // GET /api/a2a/audit/export — export audit entries as JSON or CSV
  router.get('/audit/export', async (req: Request, res: Response) => {
    try {
      const loaded = await loadActiveConfig();
      const a2a = loaded ? getA2AConfig(loaded.config) : {};
      const auditDir = path.join(projectRoot, (a2a.auditDir as string) || 'audit/a2a');
      const direction = req.query.direction as string | undefined;
      const remoteAgent = req.query.remoteAgent as string | undefined;
      const startDate = req.query.startDate as string | undefined;
      const endDate = req.query.endDate as string | undefined;
      const format = (req.query.format as string) || 'json';

      let files: string[];
      try {
        files = (await readdir(auditDir)).filter(f => f.endsWith('.jsonl')).sort().reverse();
      } catch {
        if (format === 'csv') {
          res.setHeader('Content-Type', 'text/csv');
          res.setHeader('Content-Disposition', 'attachment; filename="audit-export.csv"');
          res.send('timestamp,direction,remoteAgent,method,status,durationMs\n');
        } else {
          res.json([]);
        }
        return;
      }

      const entries: Array<Record<string, unknown>> = [];
      for (const file of files) {
        try {
          const raw = await readFile(path.join(auditDir, file), 'utf-8');
          const lines = raw.split('\n').filter(Boolean);
          for (const line of lines.reverse()) {
            try {
              const entry = JSON.parse(line);
              if (direction && entry.direction !== direction) continue;
              if (remoteAgent && entry.remoteAgent !== remoteAgent) continue;
              if (startDate && entry.timestamp < startDate) continue;
              if (endDate && entry.timestamp > endDate) continue;
              entries.push(entry);
            } catch { /* skip malformed */ }
          }
        } catch { /* skip unreadable */ }
      }

      if (format === 'csv') {
        const header = 'timestamp,direction,remoteAgent,method,status,durationMs';
        const rows = entries.map(e =>
          [e.timestamp, e.direction, e.remoteAgent, e.method, e.status, e.durationMs]
            .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`)
            .join(',')
        );
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="audit-export.csv"');
        res.send([header, ...rows].join('\n'));
      } else {
        res.json(entries);
      }
    } catch (err) {
      res.status(500).json({ error: 'Failed to export audit log' });
    }
  });

  // GET /api/a2a/audit — read audit log entries with filtering and pagination
  router.get('/audit', async (req: Request, res: Response) => {
    try {
      const loaded = await loadActiveConfig();
      const a2a = loaded ? getA2AConfig(loaded.config) : {};
      const auditDir = path.join(projectRoot, (a2a.auditDir as string) || 'audit/a2a');
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 1000);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
      const direction = req.query.direction as string | undefined;
      const remoteAgent = req.query.remoteAgent as string | undefined;
      const startDate = req.query.startDate as string | undefined;
      const endDate = req.query.endDate as string | undefined;

      // Read all JSONL files in the audit directory
      let files: string[];
      try {
        files = (await readdir(auditDir)).filter(f => f.endsWith('.jsonl')).sort().reverse();
      } catch {
        res.json({ entries: [], total: 0, offset: 0, limit });
        return;
      }

      // Collect all matching entries for accurate total count
      const allMatching: Array<Record<string, unknown>> = [];
      for (const file of files) {
        try {
          const raw = await readFile(path.join(auditDir, file), 'utf-8');
          const lines = raw.split('\n').filter(Boolean);
          for (const line of lines.reverse()) {
            try {
              const entry = JSON.parse(line);
              if (direction && entry.direction !== direction) continue;
              if (remoteAgent && entry.remoteAgent !== remoteAgent) continue;
              if (startDate && entry.timestamp < startDate) continue;
              if (endDate && entry.timestamp > endDate) continue;
              allMatching.push(entry);
            } catch { /* skip malformed lines */ }
          }
        } catch { /* skip unreadable files */ }
      }

      const entries = allMatching.slice(offset, offset + limit);
      res.json({ entries, total: allMatching.length, offset, limit });
    } catch (err) {
      res.status(500).json({ error: 'Failed to read audit log' });
    }
  });

  // POST /api/a2a/probe-all — probe multiple URLs at once
  router.post('/probe-all', async (req: Request, res: Response) => {
    try {
      const { urls } = req.body as { urls?: string[] };
      if (!Array.isArray(urls) || urls.length === 0) {
        res.status(400).json({ error: 'urls array is required' });
        return;
      }

      // Limit to reasonable batch size
      const batch = urls.slice(0, 20);

      const results = await Promise.allSettled(
        batch.map(async (url) => {
          // Validate URL
          let parsed: URL;
          try {
            parsed = new URL(url);
          } catch {
            return { url, found: false, error: 'Invalid URL format' };
          }
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            return { url, found: false, error: 'Only http/https supported' };
          }

          const wellKnown = url.endsWith('/')
            ? `${url}.well-known/agent-card.json`
            : `${url}/.well-known/agent-card.json`;

          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          try {
            const response = await fetch(wellKnown, { signal: controller.signal });
            clearTimeout(timeout);
            if (!response.ok) {
              return { url, found: false, status: response.status };
            }
            const agentCard = await response.json();
            return { url, found: true, agentCard };
          } catch (err) {
            clearTimeout(timeout);
            const msg = err instanceof Error ? err.message : String(err);
            return { url, found: false, error: msg.includes('abort') ? 'Timed out (5s)' : msg };
          }
        })
      );

      const probeResults = results.map((r, i) =>
        r.status === 'fulfilled' ? r.value : { url: batch[i], found: false, error: 'Unexpected error' }
      );

      res.json({
        results: probeResults,
        total: probeResults.length,
        found: probeResults.filter(r => r.found).length,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to probe agents' });
    }
  });

  // POST /api/a2a/health-check — health-check known agents with latency
  router.post('/health-check', async (_req: Request, res: Response) => {
    try {
      const loaded = await loadActiveConfig();
      if (!loaded) {
        res.json({ results: [] });
        return;
      }
      const a2a = getA2AConfig(loaded.config);
      const knownUrls = (a2a.knownAgentUrls as string[]) || [];

      // Also collect team agent URLs
      const teamUrls: string[] = [];
      try {
        const raw = await readFile(path.join(projectRoot, 'team.json'), 'utf-8');
        const team = JSON.parse(raw);
        for (const agent of (team.agents || []) as Array<Record<string, unknown>>) {
          const uri = agent.uri as string | undefined;
          if (uri?.startsWith('a2a://')) {
            teamUrls.push(`http://${uri.slice('a2a://'.length)}`);
          }
        }
      } catch { /* team.json may not exist */ }

      const allUrls = [...new Set([...knownUrls, ...teamUrls])];

      const results = await Promise.allSettled(
        allUrls.map(async (url) => {
          const start = Date.now();
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          try {
            const healthUrl = url.endsWith('/') ? `${url}health` : `${url}/health`;
            const response = await fetch(healthUrl, { signal: controller.signal });
            clearTimeout(timeout);
            const latencyMs = Date.now() - start;
            if (response.ok) {
              return { url, status: 'healthy', latencyMs };
            }
            return { url, status: 'unhealthy', latencyMs, httpStatus: response.status };
          } catch (err) {
            clearTimeout(timeout);
            const latencyMs = Date.now() - start;
            const msg = err instanceof Error ? err.message : String(err);
            return { url, status: 'unreachable', latencyMs, error: msg.includes('abort') ? 'Timed out' : msg };
          }
        })
      );

      const healthResults = results.map((r, i) =>
        r.status === 'fulfilled' ? r.value : { url: allUrls[i], status: 'error', latencyMs: 0, error: 'Unexpected error' }
      );

      broadcast('a2a:health-check', { results: healthResults, timestamp: new Date().toISOString() });

      res.json({
        results: healthResults,
        timestamp: new Date().toISOString(),
        healthy: healthResults.filter(r => r.status === 'healthy').length,
        total: healthResults.length,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to run health check' });
    }
  });

  // GET /api/a2a/config — read A2A config block from active config
  router.get('/config', async (_req: Request, res: Response) => {
    try {
      const loaded = await loadActiveConfig();
      if (!loaded) {
        res.json({ a2aConfig: {}, configFile: null });
        return;
      }
      const a2a = getA2AConfig(loaded.config);
      res.json({ a2aConfig: a2a, configFile: loaded.configPath });
    } catch (err) {
      res.status(500).json({ error: 'Failed to read A2A config' });
    }
  });

  // PUT /api/a2a/config — update the communication.a2a block in the active config
  router.put('/config', async (req: Request, res: Response) => {
    try {
      const { a2aConfig } = req.body as { a2aConfig?: Record<string, unknown> };
      if (!a2aConfig || typeof a2aConfig !== 'object') {
        res.status(400).json({ error: 'a2aConfig object is required' });
        return;
      }

      const loaded = await loadActiveConfig();
      if (!loaded) {
        res.status(404).json({ error: 'No config file found to update' });
        return;
      }

      // Re-read raw to preserve formatting as much as possible
      const raw = await readFile(loaded.configPath, 'utf-8');
      const config = JSON.parse(raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));

      if (!config.communication) {
        config.communication = {};
      }
      config.communication.a2a = a2aConfig;

      await writeFile(loaded.configPath, JSON.stringify(config, null, 2), 'utf-8');
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to update A2A config' });
    }
  });

  // GET /api/a2a/server-status — check if the local A2A server is reachable
  router.get('/server-status', async (_req: Request, res: Response) => {
    try {
      const loaded = await loadActiveConfig();
      if (!loaded) {
        res.json({ running: false, reason: 'no config' });
        return;
      }
      const a2a = getA2AConfig(loaded.config);
      const port = (a2a.serverPort as number) || 4000;

      // Attempt to reach the local A2A health endpoint
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      try {
        const response = await fetch(`http://localhost:${port}/health`, { signal: controller.signal });
        clearTimeout(timeout);
        if (response.ok) {
          const data = await response.json().catch(() => ({}));
          const result = { running: true, port, protocol: data.protocol || 'a2a' };
          broadcast('a2a:server-status', result);
          res.json(result);
        } else {
          const result = { running: false, port, reason: `HTTP ${response.status}` };
          broadcast('a2a:server-status', result);
          res.json(result);
        }
      } catch {
        clearTimeout(timeout);
        const result = { running: false, port, reason: 'Connection refused or timed out' };
        broadcast('a2a:server-status', result);
        res.json(result);
      }
    } catch (err) {
      res.status(500).json({ error: 'Failed to check server status' });
    }
  });

  // POST /api/a2a/send — send an A2A message to a remote agent via JSON-RPC
  router.post('/send', async (req: Request, res: Response) => {
    try {
      const { targetUrl, message } = req.body as {
        targetUrl?: string;
        message?: { subject?: string; content?: string; priority?: string };
      };

      if (!targetUrl || typeof targetUrl !== 'string') {
        res.status(400).json({ error: 'targetUrl is required' });
        return;
      }
      if (!message?.content) {
        res.status(400).json({ error: 'message.content is required' });
        return;
      }

      // Validate URL
      let parsed: URL;
      try {
        parsed = new URL(targetUrl);
      } catch {
        res.status(400).json({ error: 'Invalid targetUrl format' });
        return;
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        res.status(400).json({ error: 'Only http and https URLs are supported' });
        return;
      }

      // Build A2A message payload (JSON-RPC style)
      const a2aPayload = {
        jsonrpc: '2.0',
        method: 'message/send',
        id: `ui-${Date.now()}`,
        params: {
          message: {
            kind: 'message',
            messageId: `ui-msg-${Date.now()}`,
            role: 'user',
            parts: [
              { kind: 'text', text: message.content },
            ],
            metadata: {
              subject: message.subject || 'UI Message',
              priority: message.priority || 'NORMAL',
            },
          },
        },
      };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      // Send to the target's JSON-RPC endpoint
      const rpcUrl = targetUrl.endsWith('/')
        ? `${targetUrl}a2a/jsonrpc`
        : `${targetUrl}/a2a/jsonrpc`;

      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(a2aPayload),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.ok) {
        const responseData = await response.json().catch(() => null);
        broadcast('a2a:message-sent', { targetUrl, success: true, response: responseData });
        res.json({ success: true, response: responseData });
      } else {
        const responseData = await response.json().catch(() => null);
        broadcast('a2a:message-sent', { targetUrl, success: false, status: response.status });
        res.json({ success: false, status: response.status, response: responseData });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('abort')) {
        res.json({ success: false, error: 'Request timed out (10s)' });
      } else {
        res.json({ success: false, error: msg });
      }
    }
  });

  // POST /api/a2a/registry-search — search an A2A registry for agents by role/capability/tag
  router.post('/registry-search', async (req: Request, res: Response) => {
    try {
      const { role, capability, tag } = req.body as { role?: string; capability?: string; tag?: string };
      const loaded = await loadActiveConfig();
      const a2a = loaded ? getA2AConfig(loaded.config) : {};
      const registryUrl = (a2a.registryUrl as string) || '';

      if (!registryUrl) {
        res.json({ agents: [], error: 'No registryUrl configured. Set it in A2A Configuration.' });
        return;
      }

      const params = new URLSearchParams();
      if (role) params.set('role', role);
      if (capability) params.set('capability', capability);
      if (tag) params.set('tag', tag);

      const url = `${registryUrl}/agents?${params.toString()}`;

      // Validate URL
      try { new URL(url); } catch {
        res.status(400).json({ error: 'Invalid registry URL' });
        return;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) {
        res.json({ agents: [], error: `Registry returned HTTP ${response.status}` });
        return;
      }

      const data = await response.json() as { agents?: Record<string, unknown>[] };
      res.json({ agents: data.agents || [], registryUrl });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('abort')) {
        res.json({ agents: [], error: 'Registry request timed out (10s)' });
      } else {
        res.json({ agents: [], error: msg });
      }
    }
  });

  // POST /api/a2a/discover — probe known URLs + team agents and return enriched cards
  router.post('/discover', async (_req: Request, res: Response) => {
    try {
      const loaded = await loadActiveConfig();
      if (!loaded) {
        res.json({ agents: [], probed: 0, found: 0 });
        return;
      }
      const a2a = getA2AConfig(loaded.config);
      const knownUrls = (a2a.knownAgentUrls as string[]) || [];

      // Collect team agent A2A URLs
      const teamUrls: string[] = [];
      try {
        const raw = await readFile(path.join(projectRoot, 'team.json'), 'utf-8');
        const team = JSON.parse(raw);
        for (const agent of (team.agents || []) as Array<Record<string, unknown>>) {
          const uri = agent.uri as string | undefined;
          if (uri?.startsWith('a2a://')) {
            teamUrls.push(`http://${uri.slice('a2a://'.length)}`);
          }
        }
      } catch { /* team.json may not exist */ }

      const allUrls = [...new Set([...knownUrls, ...teamUrls])];

      // Probe each URL for its well-known agent card
      const results = await Promise.allSettled(
        allUrls.map(async (baseUrl) => {
          // Validate URL
          try { new URL(baseUrl); } catch {
            return { url: baseUrl, found: false as const, error: 'Invalid URL' };
          }

          const wellKnown = baseUrl.endsWith('/')
            ? `${baseUrl}.well-known/agent-card.json`
            : `${baseUrl}/.well-known/agent-card.json`;

          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          try {
            const response = await fetch(wellKnown, { signal: controller.signal });
            clearTimeout(timeout);
            if (!response.ok) {
              return { url: baseUrl, found: false as const, status: response.status };
            }
            const card = await response.json() as Record<string, unknown>;
            return {
              url: baseUrl,
              found: true as const,
              card: {
                name: card.name || 'Unknown',
                description: card.description || '',
                version: card.version || '1.0.0',
                protocolVersion: card.protocolVersion || '',
                url: card.url || baseUrl,
                skills: card.skills || [],
                defaultInputModes: card.defaultInputModes || [],
                defaultOutputModes: card.defaultOutputModes || [],
                provider: card.provider || {},
                capabilities: card.capabilities || {},
              },
            };
          } catch (err) {
            clearTimeout(timeout);
            const msg = err instanceof Error ? err.message : String(err);
            return { url: baseUrl, found: false as const, error: msg.includes('abort') ? 'Timed out' : msg };
          }
        })
      );

      const agents = results.map((r, i) =>
        r.status === 'fulfilled' ? r.value : { url: allUrls[i], found: false, error: 'Unexpected error' }
      );

      const found = agents.filter(a => a.found);
      broadcast('a2a:discovery-complete', { total: agents.length, found: found.length });

      res.json({
        agents,
        probed: agents.length,
        found: found.length,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: 'Discovery failed' });
    }
  });

  // POST /api/a2a/query-agents — discover agents and query each for rich status
  // This powers the dashboard: no filesystem path needed, just A2A discovery
  router.post('/query-agents', async (_req: Request, res: Response) => {
    try {
      const loaded = await loadActiveConfig();
      const a2a = loaded ? getA2AConfig(loaded.config) : {};
      const knownUrls = (a2a.knownAgentUrls as string[]) || [];

      // Collect team agent A2A URLs
      const teamUrls: Array<{ url: string; hostname: string; role: string }> = [];
      try {
        const raw = await readFile(path.join(projectRoot, 'team.json'), 'utf-8');
        const team = JSON.parse(raw);
        for (const agent of (team.agents || []) as Array<Record<string, unknown>>) {
          const uri = agent.uri as string | undefined;
          if (uri?.startsWith('a2a://')) {
            teamUrls.push({
              url: `http://${uri.slice('a2a://'.length)}`,
              hostname: (agent.hostname as string) || 'unknown',
              role: (agent.role as string) || 'agent',
            });
          }
        }
      } catch { /* team.json may not exist */ }

      // Build unique URL list with metadata
      const urlMap = new Map<string, { hostname?: string; role?: string; source: string }>();
      for (const t of teamUrls) {
        urlMap.set(t.url, { hostname: t.hostname, role: t.role, source: 'team' });
      }
      for (const url of knownUrls) {
        if (!urlMap.has(url)) {
          urlMap.set(url, { source: 'config' });
        }
      }

      // Query each agent in parallel: fetch agent card + status
      const results = await Promise.allSettled(
        Array.from(urlMap.entries()).map(async ([baseUrl, meta]) => {
          const agent: Record<string, unknown> = {
            url: baseUrl,
            source: meta.source,
            reachable: false,
          };

          // Fetch agent card
          const cardUrl = baseUrl.endsWith('/')
            ? `${baseUrl}.well-known/agent-card.json`
            : `${baseUrl}/.well-known/agent-card.json`;
          const controller1 = new AbortController();
          const timeout1 = setTimeout(() => controller1.abort(), 5000);
          try {
            const cardResp = await fetch(cardUrl, { signal: controller1.signal });
            clearTimeout(timeout1);
            if (cardResp.ok) {
              const card = await cardResp.json() as Record<string, unknown>;
              agent.card = card;
              agent.name = card.name || meta.hostname || 'Unknown';
              agent.description = card.description || '';
              agent.version = card.version;
              agent.skills = card.skills || [];
              agent.reachable = true;
            }
          } catch {
            clearTimeout(timeout1);
          }

          // Fetch rich status from /a2a/status
          const statusUrl = baseUrl.endsWith('/')
            ? `${baseUrl}a2a/status`
            : `${baseUrl}/a2a/status`;
          const controller2 = new AbortController();
          const timeout2 = setTimeout(() => controller2.abort(), 5000);
          try {
            const statusResp = await fetch(statusUrl, { signal: controller2.signal });
            clearTimeout(timeout2);
            if (statusResp.ok) {
              const status = await statusResp.json() as Record<string, unknown>;
              agent.status = status;
              agent.reachable = true;
              // Use status data to fill in any missing fields
              const agentInfo = status.agent as Record<string, unknown> | undefined;
              if (agentInfo && !agent.name) {
                agent.name = agentInfo.name;
                agent.description = agentInfo.description;
              }
            }
          } catch {
            clearTimeout(timeout2);
          }

          // Fallback name from team metadata
          if (!agent.name && meta.hostname) {
            agent.name = meta.hostname;
          }
          if (!agent.name) {
            agent.name = baseUrl;
          }
          if (meta.role) {
            agent.role = meta.role;
          }

          return agent;
        })
      );

      const agents = results.map((r, i) => {
        if (r.status === 'fulfilled') return r.value;
        const url = Array.from(urlMap.keys())[i];
        return { url, reachable: false, name: url, error: 'Query failed' };
      });

      broadcast('a2a:agents-queried', { total: agents.length, reachable: agents.filter(a => a.reachable).length });

      res.json({
        agents,
        total: agents.length,
        reachable: agents.filter(a => a.reachable).length,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to query agents' });
    }
  });

  return router;
}
