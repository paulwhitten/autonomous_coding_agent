// A2A Message Mapper
//
// Bidirectional mapping between the internal AgentMessage format
// and A2A protocol Message/Task objects from @a2a-js/sdk.
//
// This module has NO runtime dependency on @a2a-js/sdk -- it works
// with plain JSON objects that conform to the A2A wire format.

import { AgentMessage, AgentAddress } from './communication-backend.js';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// A2A Wire Format Types (subset -- avoids requiring @a2a-js/sdk at import)
// ---------------------------------------------------------------------------

/** A2A Message (wire format). */
export interface A2AWireMessage {
  kind: 'message';
  messageId: string;
  role: 'user' | 'agent';
  parts: Array<{ kind: string; text?: string; data?: unknown; mediaType?: string }>;
  contextId?: string;
  metadata?: Record<string, unknown>;
}

/** A2A Task (wire format). */
export interface A2AWireTask {
  kind: 'task';
  id: string;
  contextId: string;
  status: { state: string; timestamp: string };
  history?: A2AWireMessage[];
  artifacts?: Array<{
    artifactId: string;
    name?: string;
    parts: Array<{ kind: string; text?: string; data?: unknown }>;
  }>;
}

/** A2A MessageSendParams (client request body). */
export interface A2ASendParams {
  message: A2AWireMessage;
  configuration?: {
    blocking?: boolean;
    acceptedOutputModes?: string[];
    pushNotificationConfig?: {
      id?: string;
      url: string;
      token?: string;
    };
  };
}

// ---------------------------------------------------------------------------
// Internal -> A2A
// ---------------------------------------------------------------------------

/**
 * Convert an internal AgentMessage to an A2A MessageSendParams payload.
 */
export function agentMessageToA2A(
  msg: Omit<AgentMessage, 'id' | 'from' | 'timestamp'>,
  fromAgent: string,
): A2ASendParams {
  const parts: A2AWireMessage['parts'] = [];

  // Primary text content
  parts.push({ kind: 'text', text: msg.content });

  // If there is a structured payload, add it as a data part
  if (msg.payload) {
    parts.push({
      kind: 'data',
      data: msg.payload,
      mediaType: 'application/json',
    });
  }

  const metadata: Record<string, unknown> = {
    subject: msg.subject,
    priority: msg.priority,
    messageType: msg.messageType,
    fromAgent,
  };

  return {
    message: {
      kind: 'message',
      messageId: randomUUID(),
      role: 'user',
      parts,
      metadata,
    },
    configuration: {
      blocking: true,
      acceptedOutputModes: ['text/plain', 'application/json'],
    },
  };
}

// ---------------------------------------------------------------------------
// A2A -> Internal
// ---------------------------------------------------------------------------

/**
 * Convert an A2A wire Message to an internal AgentMessage.
 */
export function a2aMessageToAgent(
  wire: A2AWireMessage,
  localAgent: AgentAddress,
): AgentMessage {
  // Extract text from parts
  const textParts = wire.parts
    .filter(p => p.kind === 'text' && p.text)
    .map(p => p.text as string);
  const content = textParts.join('\n');

  // Extract structured data payload if present
  const dataPart = wire.parts.find(p => p.kind === 'data');
  const payload = dataPart?.data as Record<string, unknown> | undefined;

  // Extract metadata
  const meta = wire.metadata || {};
  const subject = (meta.subject as string) || 'A2A Message';
  const priority = (meta.priority as 'HIGH' | 'NORMAL' | 'LOW') || 'NORMAL';
  const messageType = (meta.messageType as AgentMessage['messageType']) || 'unstructured';

  // Infer sender from metadata or use generic
  const fromAgent = (meta.fromAgent as string) || 'unknown_agent';
  const [fromHost, ...fromRoleParts] = fromAgent.split('_');

  return {
    id: wire.messageId,
    from: {
      hostname: fromHost || 'unknown',
      role: fromRoleParts.join('_') || 'agent',
    },
    to: localAgent,
    subject,
    content,
    priority,
    timestamp: new Date().toISOString(),
    messageType,
    payload,
  };
}

/**
 * Convert an A2A wire Task response to an internal AgentMessage.
 * Extracts the last agent message from history and any artifacts.
 */
export function a2aTaskToAgent(
  task: A2AWireTask,
  localAgent: AgentAddress,
): AgentMessage {
  // Get the last agent message from history
  const lastAgentMsg = task.history
    ?.filter(m => m.role === 'agent')
    .pop();

  if (lastAgentMsg) {
    const msg = a2aMessageToAgent(lastAgentMsg, localAgent);
    msg.id = task.id;
    return msg;
  }

  // Fall back: build a message from artifacts
  const artifactTexts = (task.artifacts || [])
    .flatMap(a => a.parts.filter(p => p.text).map(p => p.text as string));

  return {
    id: task.id,
    from: { hostname: 'unknown', role: 'agent' },
    to: localAgent,
    subject: `Task ${task.id} - ${task.status.state}`,
    content: artifactTexts.join('\n') || `Task completed with status: ${task.status.state}`,
    priority: 'NORMAL',
    timestamp: task.status.timestamp,
    messageType: 'status',
  };
}
