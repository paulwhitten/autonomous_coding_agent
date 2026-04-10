// Agent process management — start, stop, and monitor agent sessions

import { ChildProcess, spawn } from 'child_process';
import { readdir } from 'fs/promises';
import path from 'path';
import { Request, Response, Router } from '../express-compat.js';
import { broadcast } from '../websocket.js';

interface AgentProcess {
  id: string;
  configFile: string;
  pid: number;
  startedAt: string;
  status: 'running' | 'stopped' | 'error';
  exitCode: number | null;
  recentOutput: string[];
}

const MAX_OUTPUT_LINES = 200;
const processes = new Map<string, { proc: ChildProcess; info: AgentProcess }>();
let nextId = 1;

export function createProcessesRouter(projectRoot: string): Router {
  const router = Router();

  // GET /api/processes — list all tracked processes
  router.get('/', (_req: Request, res: Response) => {
    const list = Array.from(processes.values()).map(({ info }) => ({
      ...info,
      recentOutput: info.recentOutput.slice(-20),
    }));
    res.json({ processes: list });
  });

  // GET /api/processes/configs — list available config files that can be started
  router.get('/configs', async (_req: Request, res: Response) => {
    try {
      const configs: string[] = [];

      // Scan root for legacy config-*.json files
      const rootFiles = await readdir(projectRoot);
      configs.push(...rootFiles.filter(f => f.endsWith('.json') && f.startsWith('config')));

      // Scan projects/<id>/ subdirectories for config-*.json files
      const projectsDir = path.join(projectRoot, 'projects');
      try {
        const projectDirs = await readdir(projectsDir, { withFileTypes: true });
        for (const entry of projectDirs) {
          if (entry.isDirectory()) {
            const subFiles = await readdir(path.join(projectsDir, entry.name));
            const projectConfigs = subFiles
              .filter(f => f.endsWith('.json') && f.startsWith('config'))
              .map(f => path.join('projects', entry.name, f));
            configs.push(...projectConfigs);
          }
        }
      } catch { /* projects dir may not exist yet */ }

      res.json({ configs });
    } catch {
      res.json({ configs: [] });
    }
  });

  // POST /api/processes — start a new agent process
  router.post('/', (req: Request, res: Response) => {
    const { configFile } = req.body;
    if (!configFile || typeof configFile !== 'string') {
      res.status(400).json({ error: 'configFile is required' });
      return;
    }

    // Sanitize — allow relative paths under projectRoot but block traversal
    const normalized = path.normalize(configFile);
    if (normalized.includes('..') || path.isAbsolute(normalized)) {
      res.status(400).json({ error: 'Invalid config path' });
      return;
    }

    const id = `agent-${nextId++}`;
    const configPath = path.join(projectRoot, normalized);

    const proc = spawn('npx', ['tsx', path.join(projectRoot, 'src', 'index.ts'), configPath], {
      cwd: projectRoot,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    // Let the agent survive API server restarts
    proc.unref();

    const info: AgentProcess = {
      id,
      configFile: normalized,
      pid: proc.pid || 0,
      startedAt: new Date().toISOString(),
      status: 'running',
      exitCode: null,
      recentOutput: [],
    };

    const appendOutput = (line: string) => {
      info.recentOutput.push(line);
      if (info.recentOutput.length > MAX_OUTPUT_LINES) {
        info.recentOutput = info.recentOutput.slice(-MAX_OUTPUT_LINES);
      }
      broadcast('process:output', { id, line });
    };

    proc.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      lines.forEach(appendOutput);
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      lines.forEach(l => appendOutput(`[stderr] ${l}`));
    });

    proc.on('exit', (code, signal) => {
      // SIGTERM (143) / SIGKILL (137) are intentional stops, not errors
      info.status = (code === 0 || signal === 'SIGTERM' || signal === 'SIGKILL') ? 'stopped' : 'error';
      info.exitCode = code;
      broadcast('process:exit', { id, code, status: info.status });
    });

    proc.on('error', (err) => {
      info.status = 'error';
      appendOutput(`[error] ${err.message}`);
      broadcast('process:error', { id, error: err.message });
    });

    processes.set(id, { proc, info });

    res.json({ id, pid: proc.pid, configFile: normalized });
  });

  // POST /api/processes/batch — start multiple agents at once
  router.post('/batch', (req: Request, res: Response) => {
    const { configFiles: files } = req.body;
    if (!Array.isArray(files) || files.length === 0) {
      res.status(400).json({ error: 'configFiles array is required' });
      return;
    }
    if (files.length > 20) {
      res.status(400).json({ error: 'Maximum 20 agents per batch' });
      return;
    }

    const results: Array<{ configFile: string; id?: string; pid?: number; error?: string }> = [];

    for (const configFile of files) {
      if (typeof configFile !== 'string') {
        results.push({ configFile: String(configFile), error: 'Invalid config filename' });
        continue;
      }
      const normalized = path.normalize(configFile);
      if (normalized.includes('..') || path.isAbsolute(normalized)) {
        results.push({ configFile, error: 'Invalid config path' });
        continue;
      }

      const id = `agent-${nextId++}`;
      const configPath = path.join(projectRoot, normalized);

      const proc = spawn('npx', ['tsx', path.join(projectRoot, 'src', 'index.ts'), configPath], {
        cwd: projectRoot,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });

      // Let the agent survive API server restarts
      proc.unref();

      const info: AgentProcess = {
        id,
        configFile: normalized,
        pid: proc.pid || 0,
        startedAt: new Date().toISOString(),
        status: 'running',
        exitCode: null,
        recentOutput: [],
      };

      const appendOutput = (line: string) => {
        info.recentOutput.push(line);
        if (info.recentOutput.length > MAX_OUTPUT_LINES) {
          info.recentOutput = info.recentOutput.slice(-MAX_OUTPUT_LINES);
        }
        broadcast('process:output', { id, line });
      };

      proc.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        lines.forEach(appendOutput);
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        lines.forEach(l => appendOutput(`[stderr] ${l}`));
      });

      proc.on('exit', (code, signal) => {
        info.status = (code === 0 || signal === 'SIGTERM' || signal === 'SIGKILL') ? 'stopped' : 'error';
        info.exitCode = code;
        broadcast('process:exit', { id, code, status: info.status });
      });

      proc.on('error', (err) => {
        info.status = 'error';
        appendOutput(`[error] ${err.message}`);
        broadcast('process:error', { id, error: err.message });
      });

      processes.set(id, { proc, info });
      results.push({ configFile: normalized, id, pid: proc.pid });
    }

    res.json({ launched: results.filter(r => r.id).length, results });
  });

  // GET /api/processes/:id — get details of a process
  router.get('/:id', (req: Request, res: Response) => {
    const entry = processes.get(req.params.id as string);
    if (!entry) {
      res.status(404).json({ error: 'Process not found' });
      return;
    }
    res.json(entry.info);
  });

  // GET /api/processes/:id/output — get recent output
  router.get('/:id/output', (req: Request, res: Response) => {
    const entry = processes.get(req.params.id as string);
    if (!entry) {
      res.status(404).json({ error: 'Process not found' });
      return;
    }
    const lines = parseInt(req.query.lines as string) || 50;
    res.json({ output: entry.info.recentOutput.slice(-lines) });
  });

  // DELETE /api/processes/:id — stop (kill) a process
  router.delete('/:id', (req: Request, res: Response) => {
    const entry = processes.get(req.params.id as string);
    if (!entry) {
      res.status(404).json({ error: 'Process not found' });
      return;
    }
    if (entry.info.status === 'running') {
      entry.proc.kill('SIGTERM');
      // Give a grace period, then SIGKILL
      setTimeout(() => {
        if (entry.info.status === 'running') {
          entry.proc.kill('SIGKILL');
        }
      }, 5000);
    }
    res.json({ success: true, status: entry.info.status });
  });

  // DELETE /api/processes — clear completed/stopped processes from tracking
  router.delete('/', (_req: Request, res: Response) => {
    let cleared = 0;
    for (const [id, entry] of processes) {
      if (entry.info.status !== 'running') {
        processes.delete(id);
        cleared++;
      }
    }
    res.json({ cleared });
  });

  return router;
}
