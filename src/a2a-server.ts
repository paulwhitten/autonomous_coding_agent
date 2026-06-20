// A2A Server Setup
//
// Creates an Express-based HTTP server that serves:
//   - Agent Card at /.well-known/agent-card.json
//   - A2A JSON-RPC endpoint at /a2a/jsonrpc
//   - A2A REST endpoint at /a2a/rest
//   - Enriched status at /a2a/status (team, mailbox, work items)
//   - Mailbox query at /a2a/mailbox
//
// Requires @a2a-js/sdk and express as peer dependencies.
// This module is loaded when communication.a2a is present in config.

import type pino from 'pino';
import type { A2AAgentExecutorInterface } from './a2a-executor.js';
import type { A2AConfig } from './types.js';

/** Live data provider for the enriched /a2a/status and /a2a/mailbox endpoints. */
export interface A2AStatusProvider {
  /** Team members configured for this agent. */
  getTeam(): Array<{ hostname: string; role: string; responsibilities?: string }>;
  /** Summary of pending mailbox messages. */
  getMailboxSummary(): Promise<{ unread: number; recent: Array<{ from: string; subject: string; priority: string; date: string }> }>;
  /** Full list of mailbox messages with content. */
  getMailboxMessages(): Promise<Array<{ from: string; subject: string; priority: string; date: string; body: string }>>;
  /** Archived (processed) messages. */
  getArchivedMessages(): Promise<Array<{ from: string; subject: string; priority: string; date: string; body: string }>>;
  /** Work item summary by state. */
  getWorkItems(): Promise<Record<string, string[]>>;
}

/**
 * Minimal interface for the A2A server.
 * Allows starting and stopping without exposing Express internals.
 */
export interface A2AServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly port: number;
  readonly agentCardUrl: string;
}

/**
 * Create and configure an A2A server.
 *
 * This function dynamically imports @a2a-js/sdk and express so that
 * they are only required when the A2A backend is actually used.
 *
 * @param agentCard   - The A2A Agent Card JSON object to serve.
 * @param executor    - AgentExecutor implementation for handling requests.
 * @param config      - A2A configuration from the agent config.
 * @param logger      - Logger instance.
 */
export async function createA2AServer(
  agentCard: Record<string, unknown>,
  executor: A2AAgentExecutorInterface,
  config: A2AConfig,
  logger: pino.Logger,
  statusProvider?: A2AStatusProvider,
): Promise<A2AServer> {
  // Dynamic imports -- only loaded when A2A is active.
  // Use 'any' casts because the @a2a-js/sdk API shape depends on the
  // installed version and is not available at compile time in projects
  // that treat it as an optional peer dependency.
  const express = (await import('express') as any).default;
  const serverMod: any = await import('@a2a-js/sdk/server');
  const expressMod: any = await import('@a2a-js/sdk/server/express');
  const coreMod: any = await import('@a2a-js/sdk');

  const requestedPort = config.serverPort ?? 0;
  const taskStore = new serverMod.InMemoryTaskStore();

  const requestHandler = new serverMod.DefaultRequestHandler(
    agentCard,
    taskStore,
    executor,
  );

  const app = express();

  // Serve agent card
  const agentCardPath = coreMod.AGENT_CARD_PATH || '.well-known/agent-card.json';
  const cardPath = config.agentCardPath || `/${agentCardPath}`;
  app.use(cardPath, expressMod.agentCardHandler({ agentCardProvider: requestHandler }));

  // JSON-RPC endpoint (default)
  app.use(
    '/a2a/jsonrpc',
    expressMod.jsonRpcHandler({ requestHandler, userBuilder: expressMod.UserBuilder.noAuthentication }),
  );

  // REST endpoint
  app.use(
    '/a2a/rest',
    expressMod.restHandler({ requestHandler, userBuilder: expressMod.UserBuilder.noAuthentication }),
  );

  // Health check
  app.get('/health', (_req: any, res: any) => {
    res.json({ status: 'ok', protocol: 'a2a', version: agentCard.protocolVersion });
  });

  // Rich status endpoint — returns agent identity, team, mailbox, work items
  // This is queried by the UI dashboard to populate agent cards without filesystem access
  app.get('/a2a/status', async (_req: any, res: any) => {
    const status: Record<string, unknown> = {
      agent: {
        name: agentCard.name,
        description: agentCard.description,
        version: agentCard.version,
        protocolVersion: agentCard.protocolVersion,
        skills: agentCard.skills || [],
        capabilities: agentCard.capabilities || {},
        provider: agentCard.provider || {},
      },
      server: {
        port: actualPort || requestedPort,
        uptime: process.uptime(),
        startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      },
      timestamp: new Date().toISOString(),
    };

    if (statusProvider) {
      try {
        status.team = statusProvider.getTeam();
      } catch { /* ignore */ }
      try {
        status.mailbox = await statusProvider.getMailboxSummary();
      } catch { /* ignore */ }
      try {
        status.workItems = await statusProvider.getWorkItems();
      } catch { /* ignore */ }
    }

    res.json(status);
  });

  // Mailbox query — returns full message list for the UI mailbox page
  app.get('/a2a/mailbox', async (_req: any, res: any) => {
    if (!statusProvider) {
      res.json({ messages: [] });
      return;
    }
    try {
      const messages = await statusProvider.getMailboxMessages();
      res.json({ messages });
    } catch (err) {
      logger.error({ error: String(err) }, 'Failed to serve mailbox');
      res.status(500).json({ error: 'Failed to read mailbox' });
    }
  });

  // Archive query — returns processed/completed messages for message history
  app.get('/a2a/archive', async (_req: any, res: any) => {
    if (!statusProvider) {
      res.json({ messages: [] });
      return;
    }
    try {
      const messages = await statusProvider.getArchivedMessages();
      res.json({ messages });
    } catch (err) {
      logger.error({ error: String(err) }, 'Failed to serve archive');
      res.status(500).json({ error: 'Failed to read archive' });
    }
  });

  let httpServer: any = null;
  let actualPort = requestedPort;

  return {
    get port() { return actualPort; },
    get agentCardUrl() { return `http://localhost:${actualPort}${cardPath}`; },

    async start() {
      return new Promise<void>((resolve) => {
        httpServer = app.listen(requestedPort, () => {
          actualPort = httpServer.address()?.port ?? requestedPort;
          logger.info({ port: actualPort, cardPath }, 'A2A server started');
          resolve();
        });
      });
    },

    async stop() {
      if (httpServer?.listening) {
        return new Promise<void>((resolve, reject) => {
          httpServer.close((err: Error | undefined) => {
            if (err) {
              logger.error({ error: String(err) }, 'Error stopping A2A server');
              reject(err);
            } else {
              logger.info('A2A server stopped');
              resolve();
            }
          });
        });
      }
    },
  };
}
