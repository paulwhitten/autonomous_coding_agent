// A2A Agent Executor
//
// Implements the A2A AgentExecutor interface, bridging incoming A2A
// requests to the internal work item processing pipeline.
//
// This module depends on @a2a-js/sdk types at the type level but is
// designed to work with the runtime SDK when it is installed.

import { AgentMessage, AgentAddress } from './communication-backend.js';
import { a2aMessageToAgent } from './a2a-message-mapper.js';
import type pino from 'pino';

/**
 * Callback invoked when an A2A message is received.
 * The host agent processes it through the normal work item pipeline.
 */
export type OnA2AMessageReceived = (message: AgentMessage) => Promise<string>;

/**
 * Minimal interface matching @a2a-js/sdk AgentExecutor.
 * We define it here to avoid a hard compile-time dependency.
 */
export interface A2AAgentExecutorInterface {
  execute(requestContext: A2ARequestContext, eventBus: A2AEventBus): Promise<void>;
  cancelTask?(taskId: string, eventBus: A2AEventBus): Promise<void>;
}

/** Minimal RequestContext shape from @a2a-js/sdk. */
export interface A2ARequestContext {
  taskId: string;
  contextId: string;
  userMessage: {
    kind: 'message';
    messageId: string;
    role: 'user' | 'agent';
    parts: Array<{ kind: string; text?: string; data?: unknown; mediaType?: string }>;
    metadata?: Record<string, unknown>;
  };
  task?: unknown;
}

/** Minimal EventBus shape from @a2a-js/sdk. */
export interface A2AEventBus {
  publish(event: unknown): void;
  finished(): void;
}

/**
 * A2A AgentExecutor that bridges incoming A2A requests into the
 * internal agent message processing pipeline.
 */
export class A2AAgentExecutor implements A2AAgentExecutorInterface {
  private localAgent: AgentAddress;
  private onMessage: OnA2AMessageReceived;
  private logger: pino.Logger;

  constructor(
    localAgent: AgentAddress,
    onMessage: OnA2AMessageReceived,
    logger: pino.Logger,
  ) {
    this.localAgent = localAgent;
    this.onMessage = onMessage;
    this.logger = logger;
  }

  async execute(requestContext: A2ARequestContext, eventBus: A2AEventBus): Promise<void> {
    const { taskId, contextId, userMessage, task } = requestContext;

    this.logger.info(
      { taskId, contextId, messageId: userMessage.messageId },
      'A2A executor received request',
    );

    // Publish the initial task if it does not exist yet
    if (!task) {
      eventBus.publish({
        kind: 'task',
        id: taskId,
        contextId,
        status: { state: 'submitted', timestamp: new Date().toISOString() },
        history: [userMessage],
      });
    }

    // Mark as working
    eventBus.publish({
      kind: 'status-update',
      taskId,
      contextId,
      status: { state: 'working', timestamp: new Date().toISOString() },
      final: false,
    });

    try {
      // Convert the A2A message to internal format and hand off
      const internalMsg = a2aMessageToAgent(userMessage, this.localAgent);
      const result = await this.onMessage(internalMsg);

      // Publish result as an artifact
      eventBus.publish({
        kind: 'artifact-update',
        taskId,
        contextId,
        artifact: {
          artifactId: `result-${taskId}`,
          name: 'response',
          parts: [{ kind: 'text', text: result }],
        },
      });

      // Mark complete
      eventBus.publish({
        kind: 'status-update',
        taskId,
        contextId,
        status: { state: 'completed', timestamp: new Date().toISOString() },
        final: true,
      });
    } catch (error) {
      this.logger.error({ taskId, error: String(error) }, 'A2A executor failed');

      eventBus.publish({
        kind: 'status-update',
        taskId,
        contextId,
        status: {
          state: 'failed',
          timestamp: new Date().toISOString(),
          message: { role: 'agent', parts: [{ kind: 'text', text: String(error) }] },
        },
        final: true,
      });
    }

    eventBus.finished();
  }

  async cancelTask(taskId: string, eventBus: A2AEventBus): Promise<void> {
    this.logger.info({ taskId }, 'A2A task cancellation requested');
    eventBus.publish({
      kind: 'status-update',
      taskId,
      contextId: '',
      status: { state: 'canceled', timestamp: new Date().toISOString() },
      final: true,
    });
    eventBus.finished();
  }
}
