const API_BASE = '/api';

let apiKey: string | null = localStorage.getItem('agent-api-key');

export function setApiKey(key: string) {
  apiKey = key;
  localStorage.setItem('agent-api-key', key);
}

export function getApiKey(): string | null {
  return apiKey;
}

export function clearApiKey() {
  apiKey = null;
  localStorage.removeItem('agent-api-key');
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }
  const res = await fetch(`${API_BASE}${path}`, {
    headers,
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

// Config API
export const configApi = {
  list: () => request<{ configs: string[] }>('/config'),
  get: (filename: string) => request<Record<string, unknown>>(`/config/${filename}`),
  save: (filename: string, data: unknown) =>
    request<{ success: boolean }>(`/config/${filename}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  validate: (data: unknown) =>
    request<{ valid: boolean; errors: string[] }>('/config/validate', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  delete: (filename: string) =>
    request<{ success: boolean }>(`/config/${filename}`, { method: 'DELETE' }),
};

// Workflow API
export const workflowApi = {
  list: () => request<{ workflows: Array<{ file: string; id: string; name: string; description: string; version: string }> }>('/workflows'),
  get: (filename: string) => request<Record<string, unknown>>(`/workflows/${filename}`),
  save: (filename: string, data: unknown) =>
    request<{ success: boolean }>(`/workflows/${filename}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  validate: (data: unknown) =>
    request<{ valid: boolean; errors: string[] }>('/workflows/validate', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  delete: (filename: string) =>
    request<{ success: boolean }>(`/workflows/${filename}`, { method: 'DELETE' }),
};

// Team API
export const teamApi = {
  get: () => request<Record<string, unknown>>('/team'),
  save: (data: unknown) =>
    request<{ success: boolean }>('/team', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  addAgent: (agent: unknown) =>
    request<{ success: boolean }>('/team/agents', {
      method: 'POST',
      body: JSON.stringify(agent),
    }),
  removeAgent: (id: string) =>
    request<{ success: boolean }>(`/team/agents/${id}`, { method: 'DELETE' }),
};

// Mailbox API
export const mailboxApi = {
  listAgents: (repoPath?: string) => request<{ agents: string[] }>(`/mailbox${repoPath ? `?repoPath=${encodeURIComponent(repoPath)}` : ''}`),
  listMessages: (agentId: string, repoPath?: string) =>
    request<{ agentId: string; messages: Array<{ filename: string; folder: string }> }>(`/mailbox/${agentId}${repoPath ? `?repoPath=${encodeURIComponent(repoPath)}` : ''}`),
  readMessage: (agentId: string, filename: string, repoPath?: string) =>
    request<{ content: string }>(`/mailbox/${agentId}/${filename}${repoPath ? `?repoPath=${encodeURIComponent(repoPath)}` : ''}`),
  sendMessage: (agentId: string, msg: { from: string; subject: string; priority: string; messageType: string; body: string }, repoPath?: string) =>
    request<{ success: boolean }>(`/mailbox/${agentId}${repoPath ? `?repoPath=${encodeURIComponent(repoPath)}` : ''}`, {
      method: 'POST',
      body: JSON.stringify(msg),
    }),
};

// Agents API
export const agentsApi = {
  status: (workspace?: string) => request<{ agents: unknown[] }>(`/agents/status${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''}`),
  logs: (lines = 100, logPath?: string) => request<{ lines: string[]; total: number }>(`/agents/logs?lines=${lines}${logPath ? `&path=${encodeURIComponent(logPath)}` : ''}`),
  logSources: () => request<{ sources: Array<{ name: string; path: string }> }>('/agents/log-sources'),
  workItems: (workspace?: string) => request<Record<string, string[]>>(`/agents/work-items${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''}`),
  workspaceConfig: (workspace: string) => request<{ config: Record<string, unknown>; configPath: string }>(`/agents/workspace-config?workspace=${encodeURIComponent(workspace)}`),
  roles: () => request<{ roles: string[]; definitions: Record<string, unknown> }>('/agents/roles'),
  quotaPresets: () => request<Record<string, unknown>>('/agents/quota-presets'),
};

// Auth API
export const authApi = {
  check: () => request<{ required: boolean; authenticated: boolean }>('/auth/check'),
};

// Templates API
export const templatesApi = {
  list: () => request<{ templates: Array<{ id: string; name: string; description: string; category: string }> }>('/templates'),
  get: (id: string) => request<{ id: string; name: string; description: string; category: string; workflow: Record<string, unknown> }>(`/templates/${id}`),
};

// Processes API
export const processesApi = {
  list: () => request<{ processes: Array<{ id: string; configFile: string; pid: number; startedAt: string; status: string; exitCode: number | null; recentOutput: string[] }> }>('/processes'),
  configs: () => request<{ configs: string[] }>('/processes/configs'),
  start: (configFile: string) => request<{ id: string; pid: number }>('/processes', { method: 'POST', body: JSON.stringify({ configFile }) }),
  get: (id: string) => request<Record<string, unknown>>(`/processes/${id}`),
  output: (id: string, lines = 50) => request<{ output: string[] }>(`/processes/${id}/output?lines=${lines}`),
  stop: (id: string) => request<{ success: boolean }>(`/processes/${id}`, { method: 'DELETE' }),
  clearStopped: () => request<{ cleared: number }>('/processes', { method: 'DELETE' }),
};

// Instructions API
export const instructionsApi = {
  get: () => request<Record<string, unknown>>('/instructions'),
  save: (data: unknown) => request<{ success: boolean }>('/instructions', { method: 'PUT', body: JSON.stringify(data) }),
  getExample: () => request<Record<string, unknown>>('/instructions/example'),
};
