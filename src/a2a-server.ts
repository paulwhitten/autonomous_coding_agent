// A2A Server Setup
//
// Creates an Express-based HTTP server that serves:
//   - Agent Card at /.well-known/agent-card.json
//   - A2A JSON-RPC endpoint at /a2a/jsonrpc
//   - A2A REST endpoint at /a2a/rest
//
// Requires @a2a-js/sdk and express as peer dependencies.
// This module is loaded when communication.a2a is present in config.

import type pino from 'pino';
import type { A2AAgentExecutorInterface } from './a2a-executor.js';
import type { A2AConfig } from './types.js';

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
): Promise<A2AServer> {
  // Dynamic imports -- only loaded when A2A is active.
  // Use 'any' casts because the @a2a-js/sdk API shape depends on the
  // installed version and is not available at compile time in projects
  // that treat it as an optional peer dependency.
  const express = (await import('express') as any).default;
  const serverMod: any = await import('@a2a-js/sdk/server');
  const expressMod: any = await import('@a2a-js/sdk/server/express');
  const coreMod: any = await import('@a2a-js/sdk');

  const requestedPort = config.serverPort ?? 4000;
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
