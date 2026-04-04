// Tests for a2a-message-mapper.ts - Bidirectional message conversion

import { describe, it, expect } from '@jest/globals';
import {
  agentMessageToA2A,
  a2aMessageToAgent,
  a2aTaskToAgent,
} from '../a2a-message-mapper.js';
import type { AgentMessage, AgentAddress } from '../communication-backend.js';

const localAgent: AgentAddress = { hostname: 'local-host', role: 'developer' };

describe('a2a-message-mapper', () => {
  // ---------------------------------------------------------------
  // agentMessageToA2A (Internal -> A2A)
  // ---------------------------------------------------------------
  describe('agentMessageToA2A', () => {
    it('should convert a basic message to A2A wire format', () => {
      const msg: Omit<AgentMessage, 'id' | 'from' | 'timestamp'> = {
        to: localAgent,
        subject: 'Build REST API',
        content: 'Please implement the user endpoint',
        priority: 'HIGH',
        messageType: 'workflow',
      };

      const result = agentMessageToA2A(msg, 'manager-host_manager');

      expect(result.message.kind).toBe('message');
      expect(result.message.role).toBe('user');
      expect(result.message.parts).toHaveLength(1);
      expect(result.message.parts[0].kind).toBe('text');
      expect(result.message.parts[0].text).toBe('Please implement the user endpoint');
      expect(result.message.metadata).toEqual(
        expect.objectContaining({
          subject: 'Build REST API',
          priority: 'HIGH',
          messageType: 'workflow',
          fromAgent: 'manager-host_manager',
        }),
      );
    });

    it('should include payload as a data part', () => {
      const msg: Omit<AgentMessage, 'id' | 'from' | 'timestamp'> = {
        to: localAgent,
        subject: 'Task',
        content: 'Do something',
        priority: 'NORMAL',
        messageType: 'workflow',
        payload: { key: 'value' },
      };

      const result = agentMessageToA2A(msg, 'sender');
      expect(result.message.parts).toHaveLength(2);
      expect(result.message.parts[1].kind).toBe('data');
      expect(result.message.parts[1].data).toEqual({ key: 'value' });
    });

    it('should generate a unique messageId', () => {
      const msg: Omit<AgentMessage, 'id' | 'from' | 'timestamp'> = {
        to: localAgent,
        subject: 'Test',
        content: 'Content',
        priority: 'NORMAL',
        messageType: 'unstructured',
      };

      const r1 = agentMessageToA2A(msg, 'a');
      const r2 = agentMessageToA2A(msg, 'a');
      expect(r1.message.messageId).not.toBe(r2.message.messageId);
    });

    it('should set blocking configuration by default', () => {
      const msg: Omit<AgentMessage, 'id' | 'from' | 'timestamp'> = {
        to: localAgent,
        subject: 'T',
        content: 'C',
        priority: 'LOW',
        messageType: 'status',
      };
      const result = agentMessageToA2A(msg, 's');
      expect(result.configuration?.blocking).toBe(true);
    });
  });

  // ---------------------------------------------------------------
  // a2aMessageToAgent (A2A -> Internal)
  // ---------------------------------------------------------------
  describe('a2aMessageToAgent', () => {
    it('should convert an A2A wire message to AgentMessage', () => {
      const wire = {
        kind: 'message' as const,
        messageId: 'msg-123',
        role: 'user' as const,
        parts: [{ kind: 'text', text: 'Hello from remote' }],
        metadata: {
          subject: 'Greeting',
          priority: 'HIGH',
          messageType: 'unstructured',
          fromAgent: 'remote-host_manager',
        },
      };

      const result = a2aMessageToAgent(wire, localAgent);

      expect(result.id).toBe('msg-123');
      expect(result.from.hostname).toBe('remote-host');
      expect(result.from.role).toBe('manager');
      expect(result.to).toEqual(localAgent);
      expect(result.subject).toBe('Greeting');
      expect(result.content).toBe('Hello from remote');
      expect(result.priority).toBe('HIGH');
      expect(result.messageType).toBe('unstructured');
    });

    it('should extract payload from data part', () => {
      const wire = {
        kind: 'message' as const,
        messageId: 'msg-456',
        role: 'user' as const,
        parts: [
          { kind: 'text', text: 'See data' },
          { kind: 'data', data: { foo: 'bar' } },
        ],
        metadata: {},
      };

      const result = a2aMessageToAgent(wire, localAgent);
      expect(result.content).toBe('See data');
      expect(result.payload).toEqual({ foo: 'bar' });
    });

    it('should use defaults when metadata is missing', () => {
      const wire = {
        kind: 'message' as const,
        messageId: 'msg-789',
        role: 'user' as const,
        parts: [{ kind: 'text', text: 'bare message' }],
      };

      const result = a2aMessageToAgent(wire, localAgent);
      expect(result.subject).toBe('A2A Message');
      expect(result.priority).toBe('NORMAL');
      expect(result.messageType).toBe('unstructured');
      expect(result.from.hostname).toBe('unknown');
    });

    it('should join multiple text parts', () => {
      const wire = {
        kind: 'message' as const,
        messageId: 'msg-multi',
        role: 'user' as const,
        parts: [
          { kind: 'text', text: 'Line one' },
          { kind: 'text', text: 'Line two' },
        ],
      };
      const result = a2aMessageToAgent(wire, localAgent);
      expect(result.content).toBe('Line one\nLine two');
    });
  });

  // ---------------------------------------------------------------
  // a2aTaskToAgent
  // ---------------------------------------------------------------
  describe('a2aTaskToAgent', () => {
    it('should extract the last agent message from task history', () => {
      const task = {
        kind: 'task' as const,
        id: 'task-1',
        contextId: 'ctx-1',
        status: { state: 'completed', timestamp: '2026-03-10T12:00:00Z' },
        history: [
          {
            kind: 'message' as const,
            messageId: 'h1',
            role: 'user' as const,
            parts: [{ kind: 'text', text: 'User request' }],
          },
          {
            kind: 'message' as const,
            messageId: 'h2',
            role: 'agent' as const,
            parts: [{ kind: 'text', text: 'Agent response' }],
            metadata: { fromAgent: 'remote_qa' },
          },
        ],
      };

      const result = a2aTaskToAgent(task, localAgent);
      expect(result.id).toBe('task-1');
      expect(result.content).toBe('Agent response');
    });

    it('should fall back to artifacts when no agent history', () => {
      const task = {
        kind: 'task' as const,
        id: 'task-2',
        contextId: 'ctx-2',
        status: { state: 'completed', timestamp: '2026-03-10T13:00:00Z' },
        artifacts: [
          {
            artifactId: 'a1',
            name: 'output',
            parts: [{ kind: 'text', text: 'Artifact content' }],
          },
        ],
      };

      const result = a2aTaskToAgent(task, localAgent);
      expect(result.id).toBe('task-2');
      expect(result.content).toBe('Artifact content');
    });

    it('should produce a status message when no history or artifacts', () => {
      const task = {
        kind: 'task' as const,
        id: 'task-3',
        contextId: 'ctx-3',
        status: { state: 'failed', timestamp: '2026-03-10T14:00:00Z' },
      };

      const result = a2aTaskToAgent(task, localAgent);
      expect(result.content).toContain('failed');
    });
  });

  // ---------------------------------------------------------------
  // Round-trip: Internal -> A2A -> Internal
  // ---------------------------------------------------------------
  describe('round-trip', () => {
    it('should preserve core fields through Internal -> A2A -> Internal', () => {
      const original: Omit<AgentMessage, 'id' | 'from' | 'timestamp'> = {
        to: localAgent,
        subject: 'Round-trip test',
        content: 'This is the content body.',
        priority: 'HIGH',
        messageType: 'workflow',
        payload: { step: 1 },
      };

      const a2a = agentMessageToA2A(original, 'sender-host_manager');
      const recovered = a2aMessageToAgent(a2a.message, localAgent);

      expect(recovered.subject).toBe('Round-trip test');
      expect(recovered.content).toBe('This is the content body.');
      expect(recovered.priority).toBe('HIGH');
      expect(recovered.messageType).toBe('workflow');
      expect(recovered.from.hostname).toBe('sender-host');
      expect(recovered.from.role).toBe('manager');
      expect(recovered.payload).toEqual({ step: 1 });
    });
  });
});
