#!/usr/bin/env tsx
// backend-exchange.ts -- Mailbox backend integration smoke test
//
// Exercises the CommunicationBackend interface through the GitMailboxBackend.
// Two backend instances (manager + developer) exchange messages and validate
// the full lifecycle: init, send, receive, acknowledge, escalate, shutdown.
//
// Usage:
//   npx tsx smoke_tests/mailbox-backend/backend-exchange.ts

import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { createBackend } from '../../src/backend-factory.js';
import { CommunicationBackend } from '../../src/communication-backend.js';
import { CompositeBackend } from '../../src/backends/composite-backend.js';
import { createLogger } from '../../src/logger.js';
import type { AgentConfig } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
    console.log(`  [PASS] ${label}`);
  } else {
    failed++;
    console.error(`  [FAIL] ${label}`);
  }
}

function buildConfig(overrides: {
  hostname: string;
  role: string;
  repoPath: string;
  managerHostname?: string;
}): AgentConfig {
  return {
    agent: {
      hostname: overrides.hostname,
      role: overrides.role as 'developer' | 'qa' | 'manager' | 'researcher',
      checkIntervalMs: 5000,
      sdkTimeoutMs: 30000,
      stuckTimeoutMs: 60000,
      roleDefinitionsFile: 'roles.json',
    },
    manager: {
      hostname: overrides.managerHostname || overrides.hostname,
      role: 'manager',
      escalationPriority: 'NORMAL',
    },
    mailbox: {
      repoPath: overrides.repoPath,
      gitSync: false,
      autoCommit: false,
      commitMessage: 'smoke-test',
      supportBroadcast: true,
      supportAttachments: false,
      supportPriority: true,
    },
    copilot: {
      model: 'gpt-4.1',
      allowedTools: 'all',
    },
    workspace: {
      path: path.join(overrides.repoPath, '..', `workspace-${overrides.hostname}`),
      persistContext: false,
    },
    logging: {
      path: path.join(overrides.repoPath, '..', `logs-${overrides.hostname}`, 'test.log'),
      level: 'error',
      maxSizeMB: 1,
    },
  } as AgentConfig;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\nMailbox Backend Integration Smoke Test');
  console.log('='.repeat(60));

  // Create isolated temp directory
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mailbox-smoke-'));
  const repoPath = path.join(tmpRoot, 'shared-mailbox');
  await fs.mkdir(repoPath, { recursive: true });
  await fs.mkdir(path.join(tmpRoot, 'logs-mgr'), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, 'logs-dev'), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, 'workspace-mgr'), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, 'workspace-dev'), { recursive: true });

  // Create team roster -- deliberately NO uri fields to test backward-compatible
  // legacy behavior where missing scheme defaults to mailbox routing.
  const teamJson = {
    team: { name: 'smoke-test-team', description: 'Mailbox smoke test team' },
    agents: [
      { hostname: 'mgr', role: 'manager', capabilities: ['coordination'] },
      { hostname: 'dev', role: 'developer', capabilities: ['coding', 'testing'] },
    ],
  };
  await fs.mkdir(path.join(repoPath, 'mailbox'), { recursive: true });
  await fs.writeFile(
    path.join(repoPath, 'mailbox', 'team.json'),
    JSON.stringify(teamJson, null, 2),
  );

  const mgrConfig = buildConfig({ hostname: 'mgr', role: 'manager', repoPath });
  const devConfig = buildConfig({
    hostname: 'dev',
    role: 'developer',
    repoPath,
    managerHostname: 'mgr',
  });

  const loggerMgr = createLogger(path.join(tmpRoot, 'logs-mgr', 'test.log'));
  const loggerDev = createLogger(path.join(tmpRoot, 'logs-dev', 'test.log'));

  let mgrBackend: CommunicationBackend;
  let devBackend: CommunicationBackend;

  try {
    // ---- Test 1: Backend creation ----
    // Team roster has NO uri fields -- tests backward-compatible legacy routing.
    // CompositeBackend defaults to mailbox when uri is absent.
    console.log('\n1. Backend creation (legacy no-scheme)');
    mgrBackend = await createBackend(mgrConfig, loggerMgr);
    devBackend = await createBackend(devConfig, loggerDev);
    assert(mgrBackend.name === 'composite', `Manager backend is 'composite'`);
    assert(devBackend.name === 'composite', `Developer backend is 'composite'`);
    assert(mgrBackend instanceof CompositeBackend, 'Manager is CompositeBackend instance');
    assert(devBackend instanceof CompositeBackend, 'Developer is CompositeBackend instance');

    // ---- Test 2: Initialization ----
    console.log('\n2. Initialization');
    await mgrBackend.initialize();
    assert(true, 'Manager backend initialized');
    await devBackend.initialize();
    assert(true, 'Developer backend initialized');

    // ---- Test 3: Send message (manager -> developer) ----
    console.log('\n3. Send message');
    const sendResult = await mgrBackend.sendMessage(
      { hostname: 'dev', role: 'developer' },
      {
        to: { hostname: 'dev', role: 'developer' },
        subject: 'Smoke Test Task',
        content: 'Please implement the widget module.',
        priority: 'NORMAL',
        messageType: 'unstructured',
      },
    );
    assert(sendResult.success, `sendMessage succeeded (ref: ${sendResult.ref})`);
    if (!sendResult.success) {
      console.error(`  sendMessage error: ${sendResult.message}`);
    }

    // ---- Test 4: Receive messages ----
    console.log('\n4. Receive messages');
    const messages = await devBackend.receiveMessages();
    assert(messages.length >= 1, `Developer received ${messages.length} message(s)`);
    if (messages.length > 0) {
      const msg = messages[0];
      assert(msg.subject === 'Smoke Test Task', `Subject matches: "${msg.subject}"`);
      assert(msg.content.includes('widget module'), 'Content matches');
      assert(msg.priority === 'NORMAL', `Priority is NORMAL`);
      assert(msg.messageType === 'unstructured', `MessageType is unstructured`);
    }

    // ---- Test 5: Acknowledge message ----
    console.log('\n5. Acknowledge message');
    if (messages.length > 0) {
      await devBackend.acknowledgeMessage(messages[0].id);
      const remaining = await devBackend.receiveMessages();
      assert(
        remaining.length === 0,
        `No messages remain after acknowledge (got ${remaining.length})`,
      );
    }

    // ---- Test 6: Escalation ----
    console.log('\n6. Escalation');
    await devBackend.escalate('Build failure', 'TypeScript compilation error in widget.ts');
    const escalations = await mgrBackend.receiveMessages();
    const esc = escalations.find(m => m.subject.includes('Escalation'));
    assert(!!esc, `Manager received escalation message`);
    if (esc) {
      assert(esc.content.includes('Build failure'), 'Escalation content matches');
    }

    // ---- Test 7: Completion report ----
    console.log('\n7. Completion report');
    await devBackend.sendCompletionReport('Smoke Test Task', 'All tests passing');
    const completions = await mgrBackend.receiveMessages();
    const comp = completions.find(m =>
      m.subject.includes('Completed') || m.subject.includes('Smoke Test Task'),
    );
    assert(!!comp, `Manager received completion report`);

    // ---- Test 8: Discovery ----
    console.log('\n8. Discovery');
    const roster = await mgrBackend.getTeamRoster();
    assert(roster !== null, 'Team roster loaded');
    if (roster) {
      assert(roster.length === 2, `Roster has 2 agents (got ${roster.length})`);
      const dev = roster.find(a => a.role === 'developer');
      assert(!!dev, 'Found developer in roster');
      if (dev) {
        assert(
          Array.isArray(dev.capabilities) && dev.capabilities.includes('coding'),
          'Developer has coding capability',
        );
      }
    }

    // ---- Test 9: Discovery query ----
    console.log('\n9. Discovery query');
    const coders = await mgrBackend.discoverAgents({ capability: 'coding' });
    assert(coders.length === 1, `Found 1 agent with coding capability (got ${coders.length})`);
    if (coders.length > 0) {
      assert(coders[0].hostname === 'dev', `Coder is 'dev'`);
    }

    // ---- Test 10: Sync (no-op for local, verifies interface) ----
    console.log('\n10. Sync');
    const syncResult = await mgrBackend.syncFromRemote();
    assert(typeof syncResult.success === 'boolean', 'syncFromRemote returns { success }');
    const pushResult = await mgrBackend.syncToRemote('smoke test');
    assert(typeof pushResult.success === 'boolean', 'syncToRemote returns { success }');

    // ---- Test 11: Shutdown ----
    console.log('\n11. Shutdown');
    await mgrBackend.shutdown();
    assert(true, 'Manager backend shut down');
    await devBackend.shutdown();
    assert(true, 'Developer backend shut down');
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }

  // ---- Summary ----
  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) {
    console.error('\nSMOKE TEST FAILED');
    process.exit(1);
  } else {
    console.log('\nSMOKE TEST PASSED');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(2);
});
