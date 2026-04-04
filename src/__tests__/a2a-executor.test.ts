// Tests for a2a-executor.ts - A2A request bridging

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { A2AAgentExecutor } from '../a2a-executor.js';
import type { A2ARequestContext, A2AEventBus, OnA2AMessageReceived } from '../a2a-executor.js';
import type { AgentAddress } from '../communication-backend.js';
import { createMockLogger } from './test-helpers.js';

describe('A2AAgentExecutor', () => {
  const localAgent: AgentAddress = { hostname: 'test-host', role: 'developer' };
  let logger: ReturnType<typeof createMockLogger>;
  let publishedEvents: unknown[];
  let eventBus: A2AEventBus;

  beforeEach(() => {
    logger = createMockLogger();
    publishedEvents = [];
    eventBus = {
      publish: (event: unknown) => publishedEvents.push(event),
      finished: jest.fn(),
    };
  });

  function makeContext(overrides?: Partial<A2ARequestContext>): A2ARequestContext {
    return {
      taskId: 'task-1',
      contextId: 'ctx-1',
      userMessage: {
        kind: 'message',
        messageId: 'msg-1',
        role: 'user',
        parts: [{ kind: 'text', text: 'Build the API' }],
        metadata: {
          subject: 'Build API',
          priority: 'HIGH',
          messageType: 'workflow',
          fromAgent: 'manager-host_manager',
        },
      },
      ...overrides,
    };
  }

  it('should publish submitted -> working -> completed events on success', async () => {
    const onMessage: OnA2AMessageReceived = async (msg) => {
      return `Processed: ${msg.subject}`;
    };
    const executor = new A2AAgentExecutor(localAgent, onMessage, logger);

    await executor.execute(makeContext(), eventBus);

    // Should have: task (submitted), status-update (working), artifact-update, status-update (completed)
    expect(publishedEvents.length).toBe(4);
    expect((publishedEvents[0] as any).kind).toBe('task');
    expect((publishedEvents[0] as any).status.state).toBe('submitted');
    expect((publishedEvents[1] as any).kind).toBe('status-update');
    expect((publishedEvents[1] as any).status.state).toBe('working');
    expect((publishedEvents[2] as any).kind).toBe('artifact-update');
    expect((publishedEvents[2] as any).artifact.parts[0].text).toBe('Processed: Build API');
    expect((publishedEvents[3] as any).kind).toBe('status-update');
    expect((publishedEvents[3] as any).status.state).toBe('completed');
    expect((publishedEvents[3] as any).final).toBe(true);
  });

  it('should publish failed status when onMessage throws', async () => {
    const onMessage: OnA2AMessageReceived = async () => {
      throw new Error('Handler failed');
    };
    const executor = new A2AAgentExecutor(localAgent, onMessage, logger);

    await executor.execute(makeContext(), eventBus);

    const lastEvent = publishedEvents[publishedEvents.length - 1] as any;
    expect(lastEvent.kind).toBe('status-update');
    expect(lastEvent.status.state).toBe('failed');
    expect(lastEvent.final).toBe(true);
  });

  it('should skip task creation when task already exists', async () => {
    const onMessage: OnA2AMessageReceived = async () => 'ok';
    const executor = new A2AAgentExecutor(localAgent, onMessage, logger);

    const ctx = makeContext({ task: { id: 'existing' } });
    await executor.execute(ctx, eventBus);

    // First event should be working (not submitted), since task already exists
    expect((publishedEvents[0] as any).kind).toBe('status-update');
    expect((publishedEvents[0] as any).status.state).toBe('working');
  });

  it('should pass the converted message to onMessage correctly', async () => {
    let receivedMsg: any = null;
    const onMessage: OnA2AMessageReceived = async (msg) => {
      receivedMsg = msg;
      return 'done';
    };
    const executor = new A2AAgentExecutor(localAgent, onMessage, logger);

    await executor.execute(makeContext(), eventBus);

    expect(receivedMsg).not.toBeNull();
    expect(receivedMsg.subject).toBe('Build API');
    expect(receivedMsg.content).toBe('Build the API');
    expect(receivedMsg.priority).toBe('HIGH');
    expect(receivedMsg.from.hostname).toBe('manager-host');
    expect(receivedMsg.from.role).toBe('manager');
    expect(receivedMsg.to).toEqual(localAgent);
  });
});
