#!/usr/bin/env tsx
// backend-exchange.ts -- A2A backend integration smoke test
//
// Exercises the CommunicationBackend interface through the A2ABackend.
// Two backend instances (manager + developer) exchange messages and validate
// the full lifecycle: init, send, receive, acknowledge, escalate, shutdown.
// Inbox/archive persistence is verified after receive and acknowledge.
//
// Usage:
//   npx tsx smoke_tests/a2a/backend-exchange.ts

import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { createBackend } from '../../src/backend-factory.js';
import { CommunicationBackend } from '../../src/communication-backend.js';
import { CompositeBackend } from '../../src/backends/composite-backend.js';
import { A2ABackend } from '../../src/backends/a2a-backend.js';
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
    communication: {
      a2a: {
        serverPort: 0,
        knownAgentUrls: [],
      },
    },
  } as AgentConfig;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\nA2A Backend Integration Smoke Test');
  console.log('='.repeat(60));

  // Create isolated temp directory
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'a2a-smoke-'));
  const repoPath = path.join(tmpRoot, 'shared-mailbox');
  await fs.mkdir(repoPath, { recursive: true });
  await fs.mkdir(path.join(tmpRoot, 'logs-mgr'), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, 'logs-dev'), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, 'workspace-mgr'), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, 'workspace-dev'), { recursive: true });

  // Create team roster -- URIs will be updated after init when ports are known
  const teamJson = {
    team: { name: 'smoke-test-team', description: 'A2A smoke test team' },
    agents: [
      { hostname: 'mgr', role: 'manager', capabilities: ['coordination'], uri: 'a2a://localhost:0' },
      { hostname: 'dev', role: 'developer', capabilities: ['coding', 'testing'], uri: 'a2a://localhost:0' },
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
    console.log('\n1. Backend creation');
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

    // Cross-register each backend's actual URL so they can reach each
    // other over HTTP (ports are OS-assigned via serverPort: 0).
    const mgrA2A = (mgrBackend as CompositeBackend).getA2ABackend()!;
    const devA2A = (devBackend as CompositeBackend).getA2ABackend()!;
    mgrA2A.registerKnownAgent('dev_developer', `http://localhost:${devA2A.serverPort}`);
    devA2A.registerKnownAgent('mgr_manager', `http://localhost:${mgrA2A.serverPort}`);

    // Rewrite team.json with actual OS-assigned ports so hot-reload picks them up
    teamJson.agents[0].uri = `a2a://localhost:${mgrA2A.serverPort}`;
    teamJson.agents[1].uri = `a2a://localhost:${devA2A.serverPort}`;
    await fs.writeFile(
      path.join(repoPath, 'mailbox', 'team.json'),
      JSON.stringify(teamJson, null, 2),
    );

    // ---- Test 3: Send message (manager -> developer) ----
    // Use the a2a:// URI scheme to route through the A2A backend.
    console.log('\n3. Send message');
    const devUri = `a2a://localhost:${devA2A.serverPort}`;
    const sendResult = await mgrBackend.sendMessage(
      { hostname: 'dev', role: 'developer', uri: devUri },
      {
        to: { hostname: 'dev', role: 'developer', uri: devUri },
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

      // Verify assignment was persisted to inbox file
      const devWorkspace = path.join(tmpRoot, 'workspace-dev');
      const inboxDir = path.join(devWorkspace, 'a2a_inbox');
      const inboxFiles = await fs.readdir(inboxDir).catch(() => [] as string[]);
      const inboxJson = inboxFiles.filter(f => f.endsWith('.json'));
      assert(inboxJson.length >= 1, `A2A inbox has ${inboxJson.length} persisted assignment(s)`);
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

      // Verify inbox is empty and archive has the acknowledged file
      const devWorkspace2 = path.join(tmpRoot, 'workspace-dev');
      const inboxDir2 = path.join(devWorkspace2, 'a2a_inbox');
      const archiveDir = path.join(devWorkspace2, 'a2a_archive');
      const inboxFilesAfter = await fs.readdir(inboxDir2).catch(() => [] as string[]);
      const archiveFiles = await fs.readdir(archiveDir).catch(() => [] as string[]);
      assert(
        inboxFilesAfter.filter(f => f.endsWith('.json')).length === 0,
        'A2A inbox is empty after acknowledge',
      );
      assert(
        archiveFiles.filter(f => f.endsWith('.json')).length >= 1,
        `A2A archive has ${archiveFiles.filter(f => f.endsWith('.json')).length} archived assignment(s)`,
      );
    }

    // ---- Test 6: Escalation ----
    console.log('\n6. Escalation');
    await devBackend.escalate('Build failure', 'TypeScript compilation error in widget.ts');
    // Manager should receive the escalation
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
    // Clean up temp directory
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
