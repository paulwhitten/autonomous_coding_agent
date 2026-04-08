#!/usr/bin/env tsx
// Show agent status: identity, mailbox counts, config summary.
//
// Usage:
//   npm run agent-status
//   npm run agent-status -- --json
//   npm run agent-status -- --config alt.json

import { parseArgs } from 'node:util';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { loadEffectiveConfig } from './lib/load-config.js';
import { printDim } from '../src/cli-output.js';

const { values } = parseArgs({
  options: {
    json: { type: 'boolean', short: 'j', default: false },
    config: { type: 'string', short: 'c' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: true,
});

if (values.help) {
  process.stdout.write(`
Show agent status: identity, mailbox health, and config summary.

Usage:
  npm run agent-status [options]

Options:
  --json, -j        Output as JSON
  --config, -c      Path to config.json (default: ./config.json)
  --help, -h        Show this help
`);
  process.exit(0);
}

async function countFilesInDir(dir: string): Promise<number> {
  try {
    const entries = await fs.readdir(dir);
    return entries.filter(f => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

const config = await loadEffectiveConfig(values.config);
const agentId = `${config.agent.hostname}_${config.agent.role}`;
const mailboxBase = path.join(config.mailbox.repoPath, 'mailbox', `to_${agentId}`);

const counts = {
  priority: await countFilesInDir(path.join(mailboxBase, 'priority')),
  normal: await countFilesInDir(path.join(mailboxBase, 'normal')),
  background: await countFilesInDir(path.join(mailboxBase, 'background')),
  archive: await countFilesInDir(path.join(mailboxBase, 'archive')),
};
const totalInbox = counts.priority + counts.normal + counts.background;

// Check quota state file if it exists
let quotaUsed: number | null = null;
const quotaStatePath = path.resolve(config.workspace.path, 'quota_state.json');
if (existsSync(quotaStatePath)) {
  try {
    const raw = JSON.parse(await fs.readFile(quotaStatePath, 'utf-8'));
    quotaUsed = raw.used ?? null;
  } catch {
    // ignore malformed quota state
  }
}

const status = {
  agent: {
    id: agentId,
    role: config.agent.role,
    hostname: config.agent.hostname,
  },
  mailbox: {
    path: config.mailbox.repoPath,
    gitSync: config.mailbox.gitSync,
    inbox: totalInbox,
    ...counts,
  },
  quota: {
    enabled: config.quota?.enabled ?? false,
    preset: config.quota?.preset ?? null,
    used: quotaUsed,
  },
};

if (values.json) {
  process.stdout.write(JSON.stringify(status, null, 2) + '\n');
  process.exit(0);
}

// Human-readable output
process.stdout.write(`Agent: ${agentId}\n`);
process.stdout.write(`Role:  ${config.agent.role}\n`);
process.stdout.write(`Host:  ${config.agent.hostname}\n\n`);

process.stdout.write(`Mailbox (${config.mailbox.repoPath}):\n`);
process.stdout.write(`  Git sync: ${config.mailbox.gitSync ? 'enabled' : 'disabled'}\n`);
if (totalInbox === 0) {
  printDim('  Inbox:    (empty)');
} else {
  process.stdout.write(`  Inbox:    ${totalInbox} message(s)`);
  const parts: string[] = [];
  if (counts.priority) parts.push(`${counts.priority} priority`);
  if (counts.normal) parts.push(`${counts.normal} normal`);
  if (counts.background) parts.push(`${counts.background} background`);
  process.stdout.write(` (${parts.join(', ')})\n`);
}
process.stdout.write(`  Archived: ${counts.archive}\n\n`);

if (status.quota.enabled) {
  process.stdout.write(`Quota (${status.quota.preset}):\n`);
  process.stdout.write(`  Used: ${quotaUsed ?? 'unknown'}\n\n`);
} else {
  printDim('Quota: disabled');
}
