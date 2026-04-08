#!/usr/bin/env tsx
// Send a message to an agent's mailbox.
//
// Usage:
//   npm run send-message -- --to <hostname_role> --subject "Task title" --body "Task body"
//   npm run send-message -- --to dev1_developer --subject "Fix bug" --body "Fix the login bug"
//   npm run send-message -- --to dev1_developer --subject "Urgent" --priority HIGH
//
// Reads config.json to determine the mailbox path and sender identity.

import { parseArgs } from 'node:util';
import { loadEffectiveConfig } from './lib/load-config.js';
import { MailboxManager } from '../src/mailbox.js';
import { printError, printSuccess } from '../src/cli-output.js';

const { values } = parseArgs({
  options: {
    to: { type: 'string' },
    subject: { type: 'string', short: 's' },
    body: { type: 'string', short: 'b' },
    priority: { type: 'string', short: 'p', default: 'NORMAL' },
    config: { type: 'string', short: 'c' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: true,
});

if (values.help || !values.to || !values.subject) {
  const usage = `
Send a message to an agent's mailbox.

Usage:
  npm run send-message -- --to <hostname_role> --subject "Subject" [options]

Required:
  --to <hostname_role>    Recipient (e.g., dev1_developer)
  --subject, -s           Message subject

Options:
  --body, -b              Message body (reads stdin if omitted)
  --priority, -p          HIGH, NORMAL (default), or LOW
  --config, -c            Path to config.json (default: ./config.json)
  --help, -h              Show this help
`;
  process.stdout.write(usage);
  process.exit(values.help ? 0 : 1);
}

const config = await loadEffectiveConfig(values.config);

// Parse recipient: "hostname_role" -> hostname, role
const lastUnderscore = values.to.lastIndexOf('_');
if (lastUnderscore < 1) {
  printError('Invalid Recipient', [
    `  Got: ${values.to}`,
    '  Expected format: hostname_role (e.g., dev1_developer)',
  ].join('\n'));
  process.exit(1);
}
const toHostname = values.to.slice(0, lastUnderscore);
const toRole = values.to.slice(lastUnderscore + 1);

const body = values.body || values.subject;
const priority = (values.priority?.toUpperCase() || 'NORMAL') as 'HIGH' | 'NORMAL' | 'LOW';

const mailbox = new MailboxManager(
  config.mailbox.repoPath,
  config.agent.hostname,
  config.agent.role,
  config.mailbox.gitSync,
  config.mailbox.autoCommit,
  config.mailbox.commitMessage,
  config.mailbox.supportBroadcast,
  config.mailbox.supportAttachments,
  config.mailbox.supportPriority,
);

const filepath = await mailbox.sendMessage(toHostname, toRole, values.subject, body, priority);
printSuccess(`Message sent: ${filepath}`);
