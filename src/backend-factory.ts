// Backend Factory
//
// Creates a CompositeBackend that always includes the git mailbox
// and the A2A HTTP server.  Both run side by side with zero
// configuration required -- sensible defaults apply.
//
// To customize A2A behavior (port, TLS, known agents, etc.), add a
// communication.a2a block to config.json.  All fields are optional.

import { CommunicationBackend } from './communication-backend.js';
import { GitMailboxBackend } from './backends/git-mailbox-backend.js';
import { CompositeBackend } from './backends/composite-backend.js';
import { AgentConfig } from './types.js';
import type pino from 'pino';
import { createComponentLogger } from './logger.js';

/**
 * Create a CommunicationBackend from the agent configuration.
 *
 * Always creates both the git mailbox backend and the A2A HTTP
 * backend.  Both are wrapped in a CompositeBackend that merges
 * messages from both sources sorted by timestamp (earliest first
 * -- FIFO).  A2A starts with sensible defaults when no
 * `communication.a2a` block is present in configuration.
 */
export async function createBackend(
  config: AgentConfig,
  baseLogger: pino.Logger,
): Promise<CommunicationBackend> {
  const hostname = config.agent.hostname === 'auto-detect'
    ? (await import('os')).hostname()
    : config.agent.hostname;

  // Mailbox backend -- always created.
  const mailbox = new GitMailboxBackend(
    {
      repoPath: config.mailbox.repoPath,
      hostname,
      role: config.agent.role,
      gitSync: config.mailbox.gitSync,
      autoCommit: config.mailbox.autoCommit,
      commitMessage: config.mailbox.commitMessage,
      supportBroadcast: config.mailbox.supportBroadcast,
      supportAttachments: config.mailbox.supportAttachments,
      supportPriority: config.mailbox.supportPriority ?? true,
      managerHostname: config.manager?.hostname ?? hostname,
    },
    createComponentLogger(baseLogger, 'GitMailboxBackend'),
  );

  // A2A backend -- always created.  Uses sensible defaults when no
  // communication.a2a block is present in the config.
  const a2aConfig = config.communication?.a2a ?? {};
  const { A2ABackend } = await import('./backends/a2a-backend.js');
  const a2a = new A2ABackend(
    {
      hostname,
      role: config.agent.role,
      managerHostname: config.manager?.hostname ?? hostname,
      a2a: a2aConfig,
      repoPath: config.mailbox.repoPath,
      inboxBaseDir: config.workspace.path,
    },
    createComponentLogger(baseLogger, 'A2ABackend'),
  );

  return new CompositeBackend(
    mailbox,
    a2a,
    createComponentLogger(baseLogger, 'CompositeBackend'),
  );
}
