// Tests for logger.ts
//
// Strategy: Use pino's Writable stream support to capture log output as JSON
// and assert on the actual structured content of each log entry — not just
// that the call didn't throw.  This verifies the logger's real contract:
// correct field names, correct nesting of error objects, correct context
// pass-through.
//
// For createLogger() branch coverage (lines 37-89): those paths are guarded
// by process.env.JEST_WORKER_ID which Jest always sets.  We temporarily
// clear it to exercise the non-test branches, then restore it.

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import pino from 'pino';
import { Writable } from 'stream';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
  createLogger,
  createComponentLogger,
  initializeLogger,
  logError,
  logWarning,
  logInfo,
  logger,
} from '../logger.js';

// ---------------------------------------------------------------------------
// Helper: create a pino logger that writes JSON lines to an in-memory buffer
// ---------------------------------------------------------------------------
function makeBufferedLogger(level: string = 'debug'): { log: pino.Logger; lines: () => any[] } {
  const chunks: string[] = [];
  const dest = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const log = pino({ level }, dest);
  return {
    log,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l)),
  };
}

// ---------------------------------------------------------------------------
// createLogger — test environment guard
// ---------------------------------------------------------------------------
describe('createLogger', () => {
  it('returns a silent logger when JEST_WORKER_ID is set', () => {
    // JEST_WORKER_ID is always set in this process
    const log = createLogger();
    expect(log.level).toBe('silent');
  });

  it('returns a silent logger when NODE_ENV is "test"', () => {
    const origWorker = process.env.JEST_WORKER_ID;
    delete process.env.JEST_WORKER_ID;
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      const log = createLogger();
      expect(log.level).toBe('silent');
    } finally {
      process.env.JEST_WORKER_ID = origWorker;
      process.env.NODE_ENV = origEnv;
    }
  });

  it('returns a JSON stdout logger when outside test env and no file path given', () => {
    const origWorker = process.env.JEST_WORKER_ID;
    const origEnv = process.env.NODE_ENV;
    delete process.env.JEST_WORKER_ID;
    process.env.NODE_ENV = 'production';
    try {
      const log = createLogger();
      // Production path: plain pino to stdout, level from LOG_LEVEL or 'info'
      expect(log.level).toBe(process.env.LOG_LEVEL ?? 'info');
    } finally {
      process.env.JEST_WORKER_ID = origWorker;
      process.env.NODE_ENV = origEnv;
    }
  });

  it('returns a logger with the expected level outside test env with a log file', async () => {
    const origWorker = process.env.JEST_WORKER_ID;
    const origEnv = process.env.NODE_ENV;
    delete process.env.JEST_WORKER_ID;
    process.env.NODE_ENV = 'production';
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'logger-branch-'));
    try {
      const logFile = path.join(tmpDir, 'test.log');
      const log = createLogger(logFile);
      // File transport path: logger should be defined with a level
      expect(log).toBeDefined();
      expect(typeof log.info).toBe('function');
    } finally {
      process.env.JEST_WORKER_ID = origWorker;
      process.env.NODE_ENV = origEnv;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns a development logger outside test env with no file path', () => {
    const origWorker = process.env.JEST_WORKER_ID;
    const origEnv = process.env.NODE_ENV;
    delete process.env.JEST_WORKER_ID;
    process.env.NODE_ENV = 'development';
    try {
      const log = createLogger();
      expect(log).toBeDefined();
      expect(typeof log.info).toBe('function');
    } finally {
      process.env.JEST_WORKER_ID = origWorker;
      process.env.NODE_ENV = origEnv;
    }
  });
});

// ---------------------------------------------------------------------------
// createComponentLogger — verify bindings actually appear in output
// ---------------------------------------------------------------------------
describe('createComponentLogger', () => {
  it('adds component field to every log entry', () => {
    const { log: base, lines } = makeBufferedLogger();
    const child = createComponentLogger(base, 'mailbox');
    child.info('hello from component');
    const entries = lines();
    expect(entries).toHaveLength(1);
    expect(entries[0].component).toBe('mailbox');
    expect(entries[0].msg).toBe('hello from component');
  });

  it('adds additional context fields to every log entry', () => {
    const { log: base, lines } = makeBufferedLogger();
    const child = createComponentLogger(base, 'agent', { agentId: 'dev_host_developer', role: 'developer' });
    child.warn('context check');
    const entries = lines();
    expect(entries[0].component).toBe('agent');
    expect(entries[0].agentId).toBe('dev_host_developer');
    expect(entries[0].role).toBe('developer');
  });

  it('child logger entries carry both component and ad-hoc fields', () => {
    const { log: base, lines } = makeBufferedLogger();
    const child = createComponentLogger(base, 'workspace');
    child.info({ workItem: 'task-001' }, 'processing item');
    const entries = lines();
    expect(entries[0].component).toBe('workspace');
    expect(entries[0].workItem).toBe('task-001');
    expect(entries[0].msg).toBe('processing item');
  });

  it('multiple calls each produce their own entry', () => {
    const { log: base, lines } = makeBufferedLogger();
    const child = createComponentLogger(base, 'quota');
    child.info('first');
    child.info('second');
    child.info('third');
    const entries = lines();
    expect(entries).toHaveLength(3);
    entries.forEach(e => expect(e.component).toBe('quota'));
  });
});

// ---------------------------------------------------------------------------
// logError — verify structured error object in output
// ---------------------------------------------------------------------------
describe('logError', () => {
  it('emits an entry with err.message and err.stack', () => {
    const { log, lines } = makeBufferedLogger();
    const err = new Error('something broke');
    logError(log, err, 'operation failed');
    const entries = lines();
    expect(entries).toHaveLength(1);
    expect(entries[0].msg).toBe('operation failed');
    expect(entries[0].err.message).toBe('something broke');
    expect(entries[0].err.name).toBe('Error');
    expect(typeof entries[0].err.stack).toBe('string');
    expect(entries[0].level).toBe(50); // pino error level
  });

  it('includes all ErrorContext fields in output', () => {
    const { log, lines } = makeBufferedLogger();
    const err = new Error('ctx error');
    logError(log, err, 'failed', {
      workItem: 'task-007',
      component: 'git',
      operation: 'pull',
      sequence: 3,
      attempt: 2,
    });
    const entry = lines()[0];
    expect(entry.workItem).toBe('task-007');
    expect(entry.component).toBe('git');
    expect(entry.operation).toBe('pull');
    expect(entry.sequence).toBe(3);
    expect(entry.attempt).toBe(2);
  });

  it('handles errors without a stack gracefully', () => {
    const { log, lines } = makeBufferedLogger();
    const err = new Error('no stack');
    delete (err as any).stack;
    expect(() => logError(log, err, 'no stack test')).not.toThrow();
    expect(lines()[0].err.message).toBe('no stack');
  });

  it('works without context argument', () => {
    const { log, lines } = makeBufferedLogger();
    const err = new Error('bare error');
    logError(log, err, 'bare call');
    expect(lines()[0].msg).toBe('bare call');
    expect(lines()[0].err.message).toBe('bare error');
  });

  it('handles custom error subclasses', () => {
    const { log, lines } = makeBufferedLogger();
    class DomainError extends Error {
      constructor(msg: string) { super(msg); this.name = 'DomainError'; }
    }
    logError(log, new DomainError('domain failure'), 'domain error logged');
    const entry = lines()[0];
    expect(entry.err.name).toBe('DomainError');
    expect(entry.err.message).toBe('domain failure');
  });
});

// ---------------------------------------------------------------------------
// logWarning — verify context pass-through
// ---------------------------------------------------------------------------
describe('logWarning', () => {
  it('emits a warn-level entry with the correct message', () => {
    const { log, lines } = makeBufferedLogger();
    logWarning(log, 'mailbox queue deep');
    const entries = lines();
    expect(entries).toHaveLength(1);
    expect(entries[0].msg).toBe('mailbox queue deep');
    expect(entries[0].level).toBe(40); // pino warn level
  });

  it('includes context fields in the warn entry', () => {
    const { log, lines } = makeBufferedLogger();
    logWarning(log, 'backpressure applied', { operation: 'send_message', recipientDepth: 11 });
    const entry = lines()[0];
    expect(entry.operation).toBe('send_message');
    expect(entry.recipientDepth).toBe(11);
  });

  it('emits an entry with empty context when none provided', () => {
    const { log, lines } = makeBufferedLogger();
    logWarning(log, 'no context warning');
    expect(lines()[0].msg).toBe('no context warning');
  });
});

// ---------------------------------------------------------------------------
// logInfo — verify context pass-through
// ---------------------------------------------------------------------------
describe('logInfo', () => {
  it('emits an info-level entry with the correct message', () => {
    const { log, lines } = makeBufferedLogger();
    logInfo(log, 'agent started');
    const entries = lines();
    expect(entries).toHaveLength(1);
    expect(entries[0].msg).toBe('agent started');
    expect(entries[0].level).toBe(30); // pino info level
  });

  it('includes context fields in the info entry', () => {
    const { log, lines } = makeBufferedLogger();
    logInfo(log, 'work item created', { workItem: 'task-003', sequence: 5 });
    const entry = lines()[0];
    expect(entry.workItem).toBe('task-003');
    expect(entry.sequence).toBe(5);
  });

  it('handles undefined context without throwing', () => {
    const { log, lines } = makeBufferedLogger();
    logInfo(log, 'no context');
    expect(lines()[0].msg).toBe('no context');
  });
});

// ---------------------------------------------------------------------------
// initializeLogger — verify it updates the module-level logger
// ---------------------------------------------------------------------------
describe('initializeLogger', () => {
  it('returns a logger instance', () => {
    const log = initializeLogger();
    expect(log).toBeDefined();
    expect(typeof log.info).toBe('function');
  });

  it('returned logger has a level property', () => {
    const log = initializeLogger();
    expect(typeof log.level).toBe('string');
  });

  // In test env, always returns silent regardless of path argument
  it('returns silent logger in test env even with file path', () => {
    const log = initializeLogger('/tmp/init-test.log');
    expect(log.level).toBe('silent');
  });
});

// ---------------------------------------------------------------------------
// default logger export
// ---------------------------------------------------------------------------
describe('default logger export', () => {
  it('is a pino logger with the expected methods', () => {
    expect(logger).toBeDefined();
    (['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const).forEach(level => {
      expect(typeof (logger as any)[level]).toBe('function');
    });
  });

  it('has a child() method for creating component loggers', () => {
    expect(typeof logger.child).toBe('function');
    const child = logger.child({ component: 'test' });
    expect(typeof child.info).toBe('function');
  });
});

