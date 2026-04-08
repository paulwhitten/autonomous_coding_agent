#!/usr/bin/env tsx
// List pending and archived tasks in the agent's mailbox.
//
// Usage:
//   npm run list-tasks                     # inbox only
//   npm run list-tasks -- --archived       # include archive
//   npm run list-tasks -- --json           # JSON output
//   npm run list-tasks -- --config alt.json

import { parseArgs } from 'node:util';
import fs from 'fs/promises';
import path from 'path';
import { loadEffectiveConfig } from './lib/load-config.js';
import { parseMailboxMessage } from '../src/utils.js';
import { printDim } from '../src/cli-output.js';

const { values } = parseArgs({
  options: {
    archived: { type: 'boolean', short: 'a', default: false },
    json: { type: 'boolean', short: 'j', default: false },
    config: { type: 'string', short: 'c' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: true,
});

if (values.help) {
  process.stdout.write(`
List tasks in the agent's mailbox.

Usage:
  npm run list-tasks [options]

Options:
  --archived, -a    Include archived (completed) messages
  --json, -j        Output as JSON
  --config, -c      Path to config.json (default: ./config.json)
  --help, -h        Show this help
`);
  process.exit(0);
}

interface TaskSummary {
  file: string;
  from: string;
  subject: string;
  priority: string;
  date: string;
  queue: string;
}

async function readTasksFromDir(dir: string, queue: string): Promise<TaskSummary[]> {
  const tasks: TaskSummary[] = [];
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return tasks;
  }
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const fp = path.join(dir, file);
    const stat = await fs.stat(fp);
    if (stat.isDirectory()) continue;
    try {
      const parsed = await parseMailboxMessage(fp);
      tasks.push({
        file,
        from: parsed.from || '?',
        subject: parsed.subject || file,
        priority: parsed.priority || 'NORMAL',
        date: parsed.date || stat.mtime.toISOString(),
        queue,
      });
    } catch {
      tasks.push({ file, from: '?', subject: file, priority: '?', date: '?', queue });
    }
  }
  return tasks;
}

const config = await loadEffectiveConfig(values.config);
const agentId = `${config.agent.hostname}_${config.agent.role}`;
const mailboxBase = path.join(config.mailbox.repoPath, 'mailbox', `to_${agentId}`);

const inbox: TaskSummary[] = [
  ...await readTasksFromDir(path.join(mailboxBase, 'priority'), 'priority'),
  ...await readTasksFromDir(path.join(mailboxBase, 'normal'), 'normal'),
  ...await readTasksFromDir(path.join(mailboxBase, 'background'), 'background'),
  ...await readTasksFromDir(mailboxBase, 'root'),
];

let archived: TaskSummary[] = [];
if (values.archived) {
  archived = await readTasksFromDir(path.join(mailboxBase, 'archive'), 'archive');
}

if (values.json) {
  process.stdout.write(JSON.stringify({ inbox, archived }, null, 2) + '\n');
  process.exit(0);
}

// Human-readable table
process.stdout.write(`Mailbox: ${agentId}\n\n`);

function printTable(label: string, tasks: TaskSummary[]): void {
  if (tasks.length === 0) {
    printDim(`${label}: (empty)`);
    return;
  }
  process.stdout.write(`${label} (${tasks.length}):\n`);
  const maxSubject = Math.min(50, Math.max(...tasks.map(t => t.subject.length)));
  for (const t of tasks) {
    const subj = t.subject.length > 50 ? t.subject.slice(0, 47) + '...' : t.subject.padEnd(maxSubject);
    const prio = t.priority === 'HIGH' ? '[HIGH]  ' : t.priority === 'LOW' ? '[LOW]   ' : '        ';
    process.stdout.write(`  ${prio}${subj}  from ${t.from}  (${t.queue})\n`);
  }
  process.stdout.write('\n');
}

printTable('Inbox', inbox);
if (values.archived) {
  printTable('Archived', archived);
}
