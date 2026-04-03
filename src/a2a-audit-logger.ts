// A2A Audit Logger
//
// Captures all A2A protocol interactions (inbound and outbound) into
// structured, append-only log files suitable for regulatory evidence.
// Logs can optionally be committed to git for tamper-evidence.

import type pino from 'pino';
import path from 'path';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import type { AuditEntry, AuditFilter } from './communication-backend.js';

/**
 * Raw audit log entry before persistence.
 */
export interface A2AAuditRawEntry {
  direction: 'inbound' | 'outbound';
  remoteAgent: string;
  method: string;
  request: unknown;
  response: unknown;
  durationMs: number;
  status: 'success' | 'error';
  error?: string;
}

/**
 * Persisted audit entry with metadata.
 */
interface PersistedEntry {
  id: string;
  timestamp: string;
  agentId: string;
  direction: 'inbound' | 'outbound';
  remoteAgent: string;
  method: string;
  status: 'success' | 'error';
  durationMs: number;
  error?: string;
  request: unknown;
  response: unknown;
}

/**
 * Git-backed A2A audit logger.
 *
 * Each agent writes to its own JSONL file within the configured audit
 * directory. Entries are append-only and timestamped. The `commitAuditLog`
 * method commits uncommitted log entries to git for tamper-evidence.
 */
export class A2AAuditLogger {
  private auditDir: string;
  private agentId: string;
  private logger: pino.Logger;
  private logFilePath: string;
  private initialized = false;

  constructor(auditDir: string, agentId: string, logger: pino.Logger) {
    this.auditDir = auditDir;
    this.agentId = agentId;
    this.logger = logger;
    this.logFilePath = path.join(auditDir, `${agentId}-audit.jsonl`);
  }

  /**
   * Ensure the audit directory exists.
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.auditDir, { recursive: true });
    this.initialized = true;
    this.logger.info({ auditDir: this.auditDir, logFile: this.logFilePath }, 'Audit logger initialized');
  }

  /**
   * Append an audit entry to the log file.
   */
  async logEntry(raw: A2AAuditRawEntry): Promise<string> {
    if (!this.initialized) {
      this.logger.warn('Audit logger not initialized -- skipping entry');
      return '';
    }

    const entry: PersistedEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      agentId: this.agentId,
      direction: raw.direction,
      remoteAgent: raw.remoteAgent,
      method: raw.method,
      status: raw.status,
      durationMs: raw.durationMs,
      error: raw.error,
      request: sanitizePayload(raw.request),
      response: sanitizePayload(raw.response),
    };

    const line = JSON.stringify(entry) + '\n';
    await fs.appendFile(this.logFilePath, line, 'utf-8');

    this.logger.debug(
      { entryId: entry.id, direction: entry.direction, method: entry.method },
      'Audit entry logged',
    );

    return entry.id;
  }

  /**
   * Query persisted audit entries with optional filtering.
   */
  async queryEntries(filter?: AuditFilter): Promise<AuditEntry[]> {
    try {
      const content = await fs.readFile(this.logFilePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      let entries: PersistedEntry[] = lines.map(line => JSON.parse(line));

      // Apply filters
      if (filter) {
        if (filter.after) {
          const afterTime = new Date(filter.after).getTime();
          entries = entries.filter(e => new Date(e.timestamp).getTime() >= afterTime);
        }
        if (filter.before) {
          const beforeTime = new Date(filter.before).getTime();
          entries = entries.filter(e => new Date(e.timestamp).getTime() <= beforeTime);
        }
        if (filter.direction) {
          entries = entries.filter(e => e.direction === filter.direction);
        }
        if (filter.remoteAgent) {
          entries = entries.filter(e => e.remoteAgent === filter.remoteAgent);
        }
        if (filter.limit && filter.limit > 0) {
          entries = entries.slice(-filter.limit);
        }
      }

      return entries.map(toAuditEntry);
    } catch {
      // File does not exist or is empty
      return [];
    }
  }

  /**
   * Commit uncommitted audit log entries to git.
   */
  async commitAuditLog(): Promise<void> {
    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);

      // Stage audit logs
      await execFileAsync('git', ['add', this.auditDir], { cwd: path.dirname(this.auditDir) });

      // Check if there are staged changes
      const { stdout } = await execFileAsync('git', ['diff', '--cached', '--name-only'], {
        cwd: path.dirname(this.auditDir),
      });

      if (stdout.trim()) {
        await execFileAsync(
          'git',
          ['commit', '-m', `audit(a2a): ${this.agentId} interaction log update`],
          { cwd: path.dirname(this.auditDir) },
        );
        this.logger.info('Audit log committed to git');
      }
    } catch (err) {
      this.logger.warn({ error: String(err) }, 'Failed to commit audit log -- entries are still on disk');
    }
  }
}

// -- Helpers ----------------------------------------------------------------

/**
 * Convert a persisted entry to the common AuditEntry interface.
 */
function toAuditEntry(entry: PersistedEntry): AuditEntry {
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    direction: entry.direction,
    localAgent: entry.agentId,
    remoteAgent: entry.remoteAgent,
    protocol: 'a2a',
    method: entry.method,
    summary: `${entry.direction}:${entry.method} ${entry.status} (${entry.durationMs}ms)`,
    evidenceRef: entry.error,
  };
}

/**
 * Sanitize potentially large or sensitive payloads for audit logging.
 * Truncates very large strings and removes binary data.
 */
function sanitizePayload(payload: unknown): unknown {
  if (payload === null || payload === undefined) return payload;
  if (typeof payload === 'string') {
    return payload.length > 10000 ? payload.slice(0, 10000) + '... [truncated]' : payload;
  }
  if (typeof payload !== 'object') return payload;

  try {
    const json = JSON.stringify(payload);
    if (json.length > 50000) {
      return { _truncated: true, summary: json.slice(0, 5000) + '...' };
    }
    return payload;
  } catch {
    return { _serialization_error: true };
  }
}
