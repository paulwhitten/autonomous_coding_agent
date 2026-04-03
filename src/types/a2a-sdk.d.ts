// Type declarations for optional A2A SDK peer dependencies.
// These are loaded dynamically only when the A2A backend is selected.

// Express is dynamically imported and used with 'any' types so we only
// need a minimal ambient declaration to suppress TS7016.
declare module 'express' {
  const express: any;
  export default express;
  export = express;
}

declare module '@a2a-js/sdk' {
  export interface AgentCard {
    name: string;
    description?: string;
    url: string;
    version?: string;
    capabilities?: {
      streaming?: boolean;
      pushNotifications?: boolean;
      stateTransitionHistory?: boolean;
    };
    skills?: Array<{
      id: string;
      name: string;
      description?: string;
      tags?: string[];
      examples?: string[];
      inputModes?: string[];
      outputModes?: string[];
    }>;
    defaultInputModes?: string[];
    defaultOutputModes?: string[];
    provider?: {
      organization?: string;
      url?: string;
    };
    securitySchemes?: Record<string, unknown>;
    security?: unknown[];
    supportsAuthenticatedExtendedCard?: boolean;
  }

  export interface Task {
    id: string;
    sessionId?: string;
    status: TaskStatus;
    artifacts?: Artifact[];
    history?: Message[];
    metadata?: Record<string, string>;
  }

  export interface TaskStatus {
    state: 'submitted' | 'working' | 'input-required' | 'completed' | 'canceled' | 'failed' | 'unknown';
    message?: Message;
    timestamp?: string;
  }

  export interface Message {
    role: 'user' | 'agent';
    parts: Part[];
    metadata?: Record<string, string>;
  }

  export interface Part {
    type?: string;
    text?: string;
    data?: unknown;
    metadata?: Record<string, string>;
    [key: string]: unknown;
  }

  export interface Artifact {
    name?: string;
    description?: string;
    parts: Part[];
    index?: number;
    append?: boolean;
    lastChunk?: boolean;
    metadata?: Record<string, string>;
  }

  export interface SendMessageParams {
    id?: string;
    sessionId?: string;
    message: Message;
    configuration?: Record<string, unknown>;
    metadata?: Record<string, string>;
    pushNotification?: {
      url: string;
      token?: string;
    };
  }
}

declare module '@a2a-js/sdk/client' {
  import type { AgentCard, Task, SendMessageParams } from '@a2a-js/sdk';

  export class A2AClient {
    constructor(agentCard: AgentCard);
    sendMessage(params: SendMessageParams): Promise<Task>;
    getTask(taskId: string): Promise<Task>;
    cancelTask(taskId: string): Promise<Task>;
    getAgentCard(): AgentCard;
  }

  export class ClientFactory {
    createFromUrl(url: string): Promise<A2AClient>;
    createFromCard(card: AgentCard): A2AClient;
  }
}

declare module '@a2a-js/sdk/server' {
  import type { AgentCard, Task, Message } from '@a2a-js/sdk';

  export interface AgentExecutor {
    execute(params: {
      task: Task;
      message: Message;
      context: unknown;
    }): Promise<Task>;
  }

  export interface A2AServerOptions {
    card: AgentCard;
    executor: AgentExecutor;
    port?: number;
    basePath?: string;
  }

  export function createAgentCardHandler(card: AgentCard): (req: unknown, res: unknown) => void;
  export function createJsonRpcHandler(executor: AgentExecutor, card: AgentCard): (req: unknown, res: unknown) => void;
  export function createRestHandler(executor: AgentExecutor, card: AgentCard): unknown;
}

declare module '@a2a-js/sdk/server/express' {
  import type { AgentExecutor } from '@a2a-js/sdk/server';
  import type { AgentCard } from '@a2a-js/sdk';

  export function createExpressMiddleware(options: {
    card: AgentCard;
    executor: AgentExecutor;
  }): unknown;
}
