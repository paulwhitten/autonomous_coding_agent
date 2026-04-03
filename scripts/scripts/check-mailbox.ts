// Quick script to check mailbox manually (for testing)

import { MailboxManager } from '../src/mailbox.js';
import * as os from 'os';

const hostname = process.env.AGENT_HOSTNAME || os.hostname();
const role = process.env.AGENT_ROLE || 'developer';
const mailboxBasePath = process.env.MAILBOX_BASE_PATH || '../2025-12-external-mailbox/mailbox';

const mailbox = new MailboxManager(mailboxBasePath, hostname, role);

console.log('📬 Checking mailbox...');
console.log(`Agent: ${hostname}_${role}`);
console.log(`Path: ${mailbox.getMailboxPath()}\n`);

const messages = await mailbox.checkForNewMessages();

if (messages.length === 0) {
  console.log('✅ No new messages');
} else {
  console.log(`📨 Found ${messages.length} message(s):\n`);
  
  for (const msg of messages) {
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📄 ${msg.filename}`);
    console.log(`From: ${msg.from}`);
    console.log(`Subject: ${msg.subject}`);
    console.log(`Priority: ${msg.priority || 'NORMAL'}`);
    console.log(`Date: ${msg.date.toISOString()}`);
    console.log(`\nContent:\n${msg.content.substring(0, 300)}${msg.content.length > 300 ? '...' : ''}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  }
}
