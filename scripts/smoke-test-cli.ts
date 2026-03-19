// Smoke Test CLI
//
// Shell-accessible commands for smoke test scripts, wrapping the
// test-harness library.  All message creation, mailbox setup, and
// log validation goes through the actual agent codebase -- no
// duplicated format knowledge in bash.
//
// Usage:
//   npx tsx scripts/smoke-test-cli.ts <command> [options]
//
// Commands:
//   init-mailbox       Create mailbox directory tree for an agent
//   create-message     Create a plain mailbox message
//   pack-workflow      Create a workflow assignment with WORKFLOW_MSG envelope
//   check-delivery     Count messages in an agent's mailbox queue
//   check-log-event    Check for a named event in a log file
//   check-log-pattern  Check for an arbitrary pattern in a log file
//   list-events        List all known log event names
//   mailbox-path       Print the computed mailbox path for an agent
//
// Exit codes:
//   0  Success / check passed
//   1  Check failed (expected condition not met)
//   2  Usage error or missing arguments

import { parseArgs } from 'node:util';
import process from 'node:process';
import fs from 'fs/promises';
import path from 'path';
import {
  initMailbox,
  createPlainMessage,
  createWorkflowMessage,
  checkDelivery,
  checkLogEvent,
  checkLogPattern,
  LOG_EVENTS,
  mailboxDir,
  queueDir,
  agentIdentity,
  QUEUES,
} from '../src/test-harness.js';

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function die(msg: string, exitCode = 2): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(exitCode);
}

function require(value: string | undefined, name: string): string {
  if (!value) die(`--${name} is required`);
  return value!;
}

/**
 * Resolve a content argument: if it starts with @, read from that file.
 * Otherwise return the string as-is.
 */
async function resolveContent(value: string): Promise<string> {
  if (value.startsWith('@')) {
    const filePath = value.slice(1);
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      die(`Cannot read file "${filePath}": ${err}`);
    }
  }
  return value;
}

/**
 * Resolve the target directory from either --dir or --base/--agent/--role/--queue.
 */
function resolveDir(values: {
  dir?: string;
  base?: string;
  agent?: string;
  role?: string;
  queue?: string;
}): string {
  if (values.dir) return values.dir;
  if (values.base && values.agent && values.role) {
    const queue = values.queue || 'normal';
    return queueDir(values.base, values.agent, values.role, queue as any);
  }
  die('Required: --dir, or --base + --agent + --role [+ --queue]');
}

// -----------------------------------------------------------------------
// Commands
// -----------------------------------------------------------------------

async function cmdInitMailbox(tokens: string[]): Promise<void> {
  const { values } = parseArgs({
    args: tokens,
    options: {
      base: { type: 'string' },
      agent: { type: 'string' },
      role: { type: 'string' },
      'no-priority': { type: 'boolean', default: false },
      broadcast: { type: 'boolean', default: false },
      attachments: { type: 'boolean', default: false },
    },
    strict: true,
  });

  const base = require(values.base, 'base');
  const agent = require(values.agent, 'agent');
  const role = require(values.role, 'role');

  const dir = await initMailbox(base, agent, role, {
    priority: !values['no-priority'],
    broadcast: values.broadcast,
    attachments: values.attachments,
  });

  process.stdout.write(`${dir}\n`);
}

async function cmdCreateMessage(tokens: string[]): Promise<void> {
  const { values } = parseArgs({
    args: tokens,
    options: {
      // Target directory (explicit)
      dir: { type: 'string' },
      // Target directory (computed)
      base: { type: 'string' },
      agent: { type: 'string' },
      role: { type: 'string' },
      queue: { type: 'string' },
      // Message fields
      from: { type: 'string' },
      to: { type: 'string' },
      subject: { type: 'string' },
      body: { type: 'string' },
      priority: { type: 'string' },
      filename: { type: 'string' },
    },
    strict: true,
  });

  const dir = resolveDir(values);
  const from = require(values.from, 'from');
  const to = require(values.to, 'to');
  const subject = require(values.subject, 'subject');
  const bodyRaw = require(values.body, 'body');

  const body = await resolveContent(bodyRaw);

  const filepath = await createPlainMessage({
    dir,
    from,
    to,
    subject,
    body,
    priority: values.priority,
    filename: values.filename,
  });

  process.stdout.write(`${filepath}\n`);
}

async function cmdPackWorkflow(tokens: string[]): Promise<void> {
  const { values } = parseArgs({
    args: tokens,
    options: {
      // Target directory (explicit)
      dir: { type: 'string' },
      // Target directory (computed)
      base: { type: 'string' },
      agent: { type: 'string' },
      role: { type: 'string' },
      queue: { type: 'string' },
      // Workflow fields
      'workflow-id': { type: 'string' },
      'task-id': { type: 'string' },
      state: { type: 'string' },
      'target-role': { type: 'string' },
      prompt: { type: 'string' },
      // Message envelope
      from: { type: 'string' },
      to: { type: 'string' },
      subject: { type: 'string' },
      context: { type: 'string' },
      filename: { type: 'string' },
    },
    strict: true,
  });

  const dir = resolveDir(values);
  const workflowId = require(values['workflow-id'], 'workflow-id');
  const taskId = require(values['task-id'], 'task-id');
  const state = require(values.state, 'state');
  const targetRole = require(values['target-role'], 'target-role');
  const promptRaw = require(values.prompt, 'prompt');
  const from = require(values.from, 'from');
  const to = require(values.to, 'to');

  const taskPrompt = await resolveContent(promptRaw);

  let context: Record<string, string> | undefined;
  if (values.context) {
    try {
      context = JSON.parse(values.context);
    } catch {
      die('--context must be valid JSON');
    }
  }

  const filepath = await createWorkflowMessage({
    dir,
    workflowId,
    taskId,
    targetState: state,
    targetRole,
    taskPrompt,
    from,
    to,
    subject: values.subject,
    context,
    filename: values.filename,
  });

  process.stdout.write(`${filepath}\n`);
}

async function cmdCheckDelivery(tokens: string[]): Promise<void> {
  const { values } = parseArgs({
    args: tokens,
    options: {
      base: { type: 'string' },
      agent: { type: 'string' },
      role: { type: 'string' },
      queue: { type: 'string' },
      min: { type: 'string' },
      max: { type: 'string' },
    },
    strict: true,
  });

  const base = require(values.base, 'base');
  const agent = require(values.agent, 'agent');
  const role = require(values.role, 'role');
  const queue = values.queue || 'normal';

  const result = await checkDelivery(base, agent, role, queue as any);

  // Output as JSON for script consumption
  process.stdout.write(JSON.stringify(result) + '\n');

  // Check bounds
  const min = values.min ? parseInt(values.min, 10) : undefined;
  const max = values.max ? parseInt(values.max, 10) : undefined;

  if (min !== undefined && result.count < min) {
    process.stderr.write(
      `FAIL: Expected at least ${min} messages, found ${result.count}\n`,
    );
    process.exit(1);
  }
  if (max !== undefined && result.count > max) {
    process.stderr.write(
      `FAIL: Expected at most ${max} messages, found ${result.count}\n`,
    );
    process.exit(1);
  }
}

async function cmdCheckLogEvent(tokens: string[]): Promise<void> {
  const { values } = parseArgs({
    args: tokens,
    options: {
      file: { type: 'string' },
      event: { type: 'string' },
      required: { type: 'boolean', default: false },
      invert: { type: 'boolean', default: false },
    },
    strict: true,
  });

  const file = require(values.file, 'file');
  const eventName = require(values.event, 'event');

  const result = await checkLogEvent(file, eventName);

  // Output as JSON
  process.stdout.write(JSON.stringify(result) + '\n');

  if (values.required && !result.found) {
    const event = LOG_EVENTS[eventName];
    process.stderr.write(
      `FAIL: Required log event "${eventName}" not found (pattern: ${event.pattern})\n`,
    );
    process.exit(1);
  }
  if (values.invert && result.found) {
    process.stderr.write(
      `FAIL: Unexpected log event "${eventName}" found (${result.count} occurrences)\n`,
    );
    process.exit(1);
  }
}

async function cmdCheckLogPattern(tokens: string[]): Promise<void> {
  const { values } = parseArgs({
    args: tokens,
    options: {
      file: { type: 'string' },
      pattern: { type: 'string' },
      required: { type: 'boolean', default: false },
      invert: { type: 'boolean', default: false },
    },
    strict: true,
  });

  const file = require(values.file, 'file');
  const pattern = require(values.pattern, 'pattern');

  const result = await checkLogPattern(file, pattern);

  process.stdout.write(JSON.stringify(result) + '\n');

  if (values.required && !result.found) {
    process.stderr.write(
      `FAIL: Required log pattern "${pattern}" not found\n`,
    );
    process.exit(1);
  }
  if (values.invert && result.found) {
    process.stderr.write(
      `FAIL: Unexpected log pattern "${pattern}" found (${result.count} occurrences)\n`,
    );
    process.exit(1);
  }
}

async function cmdListEvents(): Promise<void> {
  const maxName = Math.max(...Object.keys(LOG_EVENTS).map(k => k.length));
  const maxSrc = Math.max(...Object.values(LOG_EVENTS).map(e => e.source.length));

  process.stdout.write('\nKnown log events:\n\n');
  process.stdout.write(
    `${'EVENT'.padEnd(maxName + 2)}${'SOURCE'.padEnd(maxSrc + 2)}DESCRIPTION\n`,
  );
  process.stdout.write(`${'─'.repeat(maxName + 2)}${'─'.repeat(maxSrc + 2)}${'─'.repeat(50)}\n`);

  for (const [name, def] of Object.entries(LOG_EVENTS)) {
    process.stdout.write(
      `${name.padEnd(maxName + 2)}${def.source.padEnd(maxSrc + 2)}${def.description}\n`,
    );
  }
  process.stdout.write('\n');
}

async function cmdMailboxPath(tokens: string[]): Promise<void> {
  const { values } = parseArgs({
    args: tokens,
    options: {
      base: { type: 'string' },
      agent: { type: 'string' },
      role: { type: 'string' },
      queue: { type: 'string' },
    },
    strict: true,
  });

  const base = require(values.base, 'base');
  const agent = require(values.agent, 'agent');
  const role = require(values.role, 'role');

  if (values.queue) {
    process.stdout.write(queueDir(base, agent, role, values.queue as any) + '\n');
  } else {
    process.stdout.write(mailboxDir(base, agent, role) + '\n');
  }
}

// -----------------------------------------------------------------------
// Usage
// -----------------------------------------------------------------------

const USAGE = `
Smoke Test CLI -- test harness for agent smoke tests

Usage: npx tsx scripts/smoke-test-cli.ts <command> [options]

Commands:
  init-mailbox       Create mailbox directory tree for an agent
    --base <path>       Base path for mailbox tree
    --agent <hostname>  Agent hostname
    --role <role>       Agent role
    --no-priority       Skip priority queue subfolders
    --broadcast         Create broadcast directory
    --attachments       Create attachments directory

  create-message     Create a plain mailbox message
    --dir <path>        Target directory (explicit)
    --base/--agent/--role/--queue  Target directory (computed)
    --from <id>         Sender agent identity
    --to <id>           Recipient agent identity
    --subject <text>    Message subject
    --body <text|@file> Message body (inline or @filepath to read)
    --priority <level>  Priority level (optional)
    --filename <name>   Explicit filename (optional)

  pack-workflow      Create a workflow assignment message
    --dir <path>        Target directory (explicit)
    --base/--agent/--role/--queue  Target directory (computed)
    --workflow-id <id>  Workflow identifier
    --task-id <id>      Task identifier
    --state <name>      Target state name
    --target-role <r>   Role that handles this state
    --prompt <text|@f>  Task prompt (inline or @filepath)
    --from <id>         Sender agent identity
    --to <id>           Recipient agent identity
    --subject <text>    Subject override (optional)
    --context <json>    Context JSON object (optional)
    --filename <name>   Explicit filename (optional)

  check-delivery     Count messages in a mailbox queue
    --base <path>       Base path for mailbox tree
    --agent <hostname>  Agent hostname
    --role <role>       Agent role
    --queue <name>      Queue name (default: normal)
    --min <n>           Minimum expected count (exit 1 if fewer)
    --max <n>           Maximum expected count (exit 1 if more)

  check-log-event    Check for a named event in a log file
    --file <path>       Path to log file
    --event <name>      Event name from registry (see list-events)
    --required          Exit 1 if event not found
    --invert            Exit 1 if event IS found

  check-log-pattern  Check for an arbitrary regex in a log file
    --file <path>       Path to log file
    --pattern <regex>   Pattern to search for
    --required          Exit 1 if not found
    --invert            Exit 1 if found

  list-events        List all known log event names

  mailbox-path       Print computed mailbox path for an agent
    --base <path>       Base path
    --agent <hostname>  Agent hostname
    --role <role>       Agent role
    --queue <name>      Specific queue (optional)

Exit codes:
  0  Success / check passed
  1  Check failed
  2  Usage error
`.trim();

// -----------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------

async function main(): Promise<void> {
  const command = process.argv[2];
  const tokens = process.argv.slice(3);

  switch (command) {
    case 'init-mailbox':
      return cmdInitMailbox(tokens);
    case 'create-message':
      return cmdCreateMessage(tokens);
    case 'pack-workflow':
      return cmdPackWorkflow(tokens);
    case 'check-delivery':
      return cmdCheckDelivery(tokens);
    case 'check-log-event':
      return cmdCheckLogEvent(tokens);
    case 'check-log-pattern':
      return cmdCheckLogPattern(tokens);
    case 'list-events':
      return cmdListEvents();
    case 'mailbox-path':
      return cmdMailboxPath(tokens);
    case '--help':
    case '-h':
    case 'help':
    case undefined:
      process.stdout.write(USAGE + '\n');
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n`);
      process.stdout.write(USAGE + '\n');
      process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message || err}\n`);
  process.exit(2);
});
