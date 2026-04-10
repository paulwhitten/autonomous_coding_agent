#!/usr/bin/env tsx
// Project scaffold for the Autonomous Copilot Agent.
// Creates config.json, mailbox folder, and a hello-world task.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline/promises';

const KNOWN_ROLES = ['developer', 'qa', 'manager', 'researcher', 'requirements-analyst'];

const nonInteractive = process.argv.includes('--non-interactive');
const projectRoot = process.cwd();

interface InitOptions {
  role: string;
  mailboxPath: string;
  hostname: string;
}

function printBanner(): void {
  console.log('');
  console.log('Autonomous Copilot Agent -- Project Setup');
  console.log('==========================================');
  console.log('');
}

async function promptUser(): Promise<InitOptions> {
  const hostname = os.hostname();
  const defaults: InitOptions = {
    role: 'developer',
    mailboxPath: './shared-mailbox',
    hostname,
  };

  if (nonInteractive) {
    console.log('Running in non-interactive mode (all defaults)');
    console.log('');
    return defaults;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const roleAnswer = await rl.question(
      `Agent role [${defaults.role}] (${KNOWN_ROLES.join(', ')}): `,
    );
    const role = roleAnswer.trim() || defaults.role;

    const pathAnswer = await rl.question(
      `Mailbox path [${defaults.mailboxPath}]: `,
    );
    const mailboxPath = pathAnswer.trim() || defaults.mailboxPath;

    return { role, mailboxPath, hostname };
  } finally {
    rl.close();
  }
}

function createMailboxFolder(mailboxPath: string, hostname: string, role: string): void {
  const resolved = path.resolve(projectRoot, mailboxPath);
  const agentFolder = `to_${hostname}_${role}`;
  const inboxPath = path.join(resolved, 'mailbox', agentFolder);

  if (fs.existsSync(inboxPath)) {
    console.log(`  Mailbox folder exists: ${inboxPath}`);
  } else {
    // Create priority queue subfolders matching MailboxManager.initialize()
    for (const sub of ['priority', 'normal', 'background', 'archive']) {
      fs.mkdirSync(path.join(inboxPath, sub), { recursive: true });
    }
    console.log(`  Created mailbox:       ${inboxPath}`);
  }

  return;
}

function writeConfig(role: string, mailboxPath: string): void {
  const configPath = path.join(projectRoot, 'config.json');
  if (fs.existsSync(configPath)) {
    console.log('  config.json exists:    skipped (will not overwrite)');
    return;
  }

  const config = {
    agent: { role },
    mailbox: { repoPath: mailboxPath },
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log('  Wrote config.json:     2 fields, all defaults applied');
}

function copyRoles(): void {
  const src = path.join(projectRoot, 'roles.json');
  if (!fs.existsSync(src)) {
    console.log('  roles.json:            not found in project root, skipped');
    return;
  }
  console.log('  roles.json:            already present');
}

function seedHelloWorld(mailboxPath: string, hostname: string, role: string): void {
  const resolved = path.resolve(projectRoot, mailboxPath);
  const agentFolder = `to_${hostname}_${role}`;
  const normalPath = path.join(resolved, 'mailbox', agentFolder, 'normal');

  if (!fs.existsSync(normalPath)) {
    fs.mkdirSync(normalPath, { recursive: true });
  }

  const existingFiles = fs.readdirSync(normalPath).filter(f => f.endsWith('.md'));
  if (existingFiles.length > 0) {
    console.log('  Hello-world task:      inbox already has messages, skipped');
    return;
  }

  const now = new Date();
  const ts = now.toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
  const filename = `${ts}_hello_world.md`;

  const content = `Date: ${now.toISOString()}
From: init_scaffold
To: ${hostname}_${role}
Subject: Hello World -- Your First Task
Priority: NORMAL

Welcome to the Autonomous Copilot Agent.

Your assignment:
- Create a file called hello.py in the workspace that prints "Hello, World!"
- Create a simple test file called test_hello.py that verifies the output
- Send a completion report when done

This task was seeded by 'npm run init' to give you something to process
on your first run. Delete this message or let the agent archive it.
`;

  fs.writeFileSync(path.join(normalPath, filename), content);
  console.log(`  Seeded hello-world:    ${filename}`);
}

async function main(): Promise<void> {
  printBanner();

  const options = await promptUser();

  console.log('Scaffolding project...');
  console.log('');

  createMailboxFolder(options.mailboxPath, options.hostname, options.role);
  writeConfig(options.role, options.mailboxPath);
  copyRoles();
  seedHelloWorld(options.mailboxPath, options.hostname, options.role);

  console.log('');
  console.log('Done. Run "npm start" to process your first task.');
  console.log('');
}

main().catch((err) => {
  console.error('Init failed:', err.message);
  process.exit(1);
});
