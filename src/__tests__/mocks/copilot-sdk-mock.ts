// Test mock for @github/copilot-sdk
// Avoids import.meta.resolve() issue in client.js during Jest tests

export default {};

export const defineTool = (name: string, opts: any) => ({
  name,
  description: opts.description ?? '',
  parameters: opts.parameters,
  handler: opts.handler,
});

export const mockSessionInstance = {
  sessionId: 'mock-session-id',
  send: () => Promise.resolve('mock-msg-id'),
  sendAndWait: () => Promise.resolve(undefined),
  on: () => () => {},
  abort: () => Promise.resolve(undefined),
  getEvents: () => Promise.resolve([]),
  disconnect: () => Promise.resolve(undefined),
};

export class CopilotSession {
  sessionId = 'mock-session-id';
}

export class CopilotClient {
  constructor(_options?: any) {}

  async createSession(_config?: any): Promise<typeof mockSessionInstance> {
    return { ...mockSessionInstance };
  }

  async resumeSession(_sessionId?: string, _config?: any): Promise<typeof mockSessionInstance> {
    return { ...mockSessionInstance };
  }

  async ping(_message?: string): Promise<{ message: string; timestamp: number }> {
    return { message: _message ?? 'pong', timestamp: Date.now() };
  }

  async listSessions(_filter?: any): Promise<Array<{ sessionId: string }>> {
    return [{ sessionId: 'mock-session-id' }];
  }
}

export const approveAll = () => {};

export const RuntimeConnection = {
  forStdio: (opts?: any) => ({ kind: 'stdio', ...opts }),
  forTcp: (opts?: any) => ({ kind: 'tcp', ...opts }),
  forUri: (url: string, opts?: any) => ({ kind: 'uri', url, ...opts }),
};
