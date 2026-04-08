#!/usr/bin/env tsx
// Reset agent runtime state: workspace, mailbox, logs, and session files.
// Prompts for confirmation unless --yes is passed.
//
// Usage:
//   npm run reset                  # interactive confirmation
//   npm run reset -- --yes         # skip prompt (CI/scripting)
//   npm run reset -- --full        # also remove config.json (full re-init)

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline/promises';
import { loadEffectiveConfig } from './lib/load-config.js';
import { printError, printSuccess, printWarning, printDim } from '../src/cli-output.js';

const skipPrompt = process.argv.includes('--yes') || process.argv.includes('-y');
const full = process.argv.includes('--full');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(`
Reset agent runtime state.

Removes workspace output, mailbox messages, logs, and session files
so you can start fresh. Config.json is preserved unless --full is used.

Usage:
  npm run reset [options]

Options:
  --yes, -y       Skip confirmation prompt
  --full          Also remove config.json (allows fresh npm run init)
  --help, -h      Show this help
`);
  process.exit(0);
}

const projectRoot = process.cwd();

// Try to load config for paths; fall back to defaults if missing
let mailboxRepoPath = './mailbox';
let workspacePath = './workspace';
let logsPath = './logs';

try {
  const config = await loadEffectiveConfig();
  mailboxRepoPath = config.mailbox.repoPath;
  workspacePath = config.workspace.path;
  logsPath = path.dirname(config.logging.path);
} catch {
  // config.json may not exist; use defaults
}

interface Target {
  label: string;
  absPath: string;
  kind: 'dir' | 'file';
}

function resolveTargets(): Target[] {
  const targets: Target[] = [];

  const dirs = [
    { label: 'Workspace', rel: workspacePath },
    { label: 'Mailbox',   rel: mailboxRepoPath },
    { label: 'Logs',      rel: logsPath },
  ];

  for (const d of dirs) {
    const abs = path.resolve(projectRoot, d.rel);
    if (fs.existsSync(abs)) {
      targets.push({ label: `${d.label} (${d.rel})`, absPath: abs, kind: 'dir' });
    }
  }

  const stateFiles = ['session_context.json', 'mailbox_state.json'];
  for (const f of stateFiles) {
    const abs = path.resolve(projectRoot, workspacePath, f);
    if (fs.existsSync(abs)) {
      targets.push({ label: f, absPath: abs, kind: 'file' });
    }
  }

  const quotaState = path.resolve(projectRoot, workspacePath, 'quota_state.json');
  if (fs.existsSync(quotaState)) {
    targets.push({ label: 'quota_state.json', absPath: quotaState, kind: 'file' });
  }

  if (full) {
    const configPath = path.resolve(projectRoot, 'config.json');
    if (fs.existsSync(configPath)) {
      targets.push({ label: 'config.json (--full)', absPath: configPath, kind: 'file' });
    }
  }

  return targets;
}

function removeTarget(t: Target): void {
  if (t.kind === 'dir') {
    fs.rmSync(t.absPath, { recursive: true, force: true });
  } else {
    fs.unlinkSync(t.absPath);
  }
}

const targets = resolveTargets();

if (targets.length === 0) {
  printDim('Nothing to reset -- no runtime artifacts found.');
  process.exit(0);
}

process.stdout.write('\nThe following will be removed:\n\n');
for (const t of targets) {
  process.stdout.write(`  - ${t.label}\n`);
}
process.stdout.write('\n');

if (!skipPrompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Proceed? [y/N] ');
    if (answer.trim().toLowerCase() !== 'y') {
      printWarning('Aborted.');
      process.exit(1);
    }
  } finally {
    rl.close();
  }
}

for (const t of targets) {
  removeTarget(t);
  process.stdout.write(`  Removed: ${t.label}\n`);
}

process.stdout.write('\n');
printSuccess('Reset complete. Run "npm run init" to scaffold again.');
