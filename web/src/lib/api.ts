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

/**
 * Fetch JSON directly from a remote agent's A2A endpoint.
 * Used by pages that need to talk to a discovered agent rather than the local API server.
 */
export async function fetchA2A<T>(a2aBaseUrl: string, path: string): Promise<T> {
  const base = a2aBaseUrl.endsWith('/') ? a2aBaseUrl.slice(0, -1) : a2aBaseUrl;
  const res = await fetch(`${base}${path}`, {
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`A2A request failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * Get the stored agent context from localStorage (set by the dashboard on agent attach).
 */
export function getAgentContext(): { hostname: string; role: string; agentId: string; a2aUrl?: string; mailboxRepoPath?: string } | null {
  try {
    const raw = localStorage.getItem('agent-context');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
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
  list: () => request<{ workflows: Array<{ file: string; id: string; name: string; description: string; version: string; source?: string }> }>('/workflows'),
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
  teamConfigs: (filename: string) =>
    request<{ workflow: { id: string; name: string; description: string }; roles: string[]; configs: Array<{ role: string; config: Record<string, unknown> }> }>(
      `/workflows/${filename}/team-configs`,
      { method: 'POST' }
    ),
  startTask: (filename: string, task: { targetAgent: string; taskId: string; taskTitle: string; taskDescription?: string; acceptanceCriteria?: string; from: string; repoPath?: string }) =>
    request<{ success: boolean; filename: string; assignment: { workflowId: string; taskId: string; targetState: string; targetRole: string; targetAgent: string } }>(
      `/workflows/${filename}/start-task`,
      { method: 'POST', body: JSON.stringify(task) }
    ),
  states: (filename: string) =>
    request<{ workflow: { id: string; name: string; description: string }; states: Array<{ id: string; name: string; role: string; description: string; transitions: Record<string, string>; isInitial: boolean; isTerminal: boolean }>; initialState: string; terminalStates: string[] }>(
      `/workflows/${filename}/states`
    ),
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
  discovered: (timeout?: number) => request<{ agents: Array<{ agentId: string; hostname: string; role: string; pid: number; startedAt: string; a2aUrl?: string; capabilities?: string[]; description?: string; teamMembers?: Array<{ hostname: string; role: string }>; mailboxRepoPath?: string; workspacePath?: string; configPath?: string }>; total: number; timestamp: string }>(`/agents/discovered${timeout ? `?timeout=${timeout}` : ''}`),
  healthHistory: () => request<{ history: Record<string, Array<{ time: string; health: string }>>; timestamp: string }>('/agents/health-history'),
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
  batch: (configFiles: string[]) => request<{ launched: number; results: Array<{ configFile: string; id?: string; pid?: number; error?: string }> }>('/processes/batch', { method: 'POST', body: JSON.stringify({ configFiles }) }),
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

// Projects API
export interface ProjectDefinition {
  id: string;
  name: string;
  description: string;
  repoUrl?: string;
  language?: string;
  techStack?: string[];
  projectContext: string[];
  buildSystem: {
    buildCommand?: string;
    testCommand?: string;
    lintCommand?: string;
    formatCommand?: string;
  };
  codingStandards?: {
    language?: string;
    description?: string;
    preCommitChecklist?: string[];
    sections?: Record<string, string[]>;
  };
  workflow?: string;
  additionalSections?: Array<{ title: string; items: string[] }>;
  createdAt: string;
  updatedAt: string;
}

export const projectsApi = {
  list: () => request<{ projects: ProjectDefinition[] }>('/projects'),
  get: (id: string) => request<ProjectDefinition>(`/projects/${encodeURIComponent(id)}`),
  create: (data: Partial<ProjectDefinition>) =>
    request<ProjectDefinition>('/projects', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<ProjectDefinition>) =>
    request<ProjectDefinition>(`/projects/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id: string) =>
    request<{ success: boolean }>(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  apply: (id: string) =>
    request<{ success: boolean; filesWritten: string[]; teamConfigs: Array<{ role: string; configFile: string }>; customInstructionsPath: string }>(
      `/projects/${encodeURIComponent(id)}/apply`,
      { method: 'POST' }
    ),
};

// A2A Protocol API
export const a2aApi = {
  status: () => request<Record<string, unknown>>('/a2a/status'),
  agentCard: () => request<Record<string, unknown>>('/a2a/agent-card'),
  agentCardPreview: () => request<Record<string, unknown>>('/a2a/agent-card/preview'),
  discoveredAgents: () => request<Record<string, unknown>>('/a2a/discovered-agents'),
  probe: (url: string) => request<Record<string, unknown>>('/a2a/probe', { method: 'POST', body: JSON.stringify({ url }) }),
  probeAll: (urls: string[]) => request<Record<string, unknown>>('/a2a/probe-all', { method: 'POST', body: JSON.stringify({ urls }) }),
  healthCheck: () => request<Record<string, unknown>>('/a2a/health-check', { method: 'POST' }),
  audit: (params?: { limit?: number; offset?: number; direction?: string; remoteAgent?: string; startDate?: string; endDate?: string }) => {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.offset) qs.set('offset', String(params.offset));
    if (params?.direction) qs.set('direction', params.direction);
    if (params?.remoteAgent) qs.set('remoteAgent', params.remoteAgent);
    if (params?.startDate) qs.set('startDate', params.startDate);
    if (params?.endDate) qs.set('endDate', params.endDate);
    return request<Record<string, unknown>>(`/a2a/audit?${qs.toString()}`);
  },
  auditExport: (params?: { format?: string; direction?: string; remoteAgent?: string; startDate?: string; endDate?: string }) => {
    const qs = new URLSearchParams();
    if (params?.format) qs.set('format', params.format);
    if (params?.direction) qs.set('direction', params.direction);
    if (params?.remoteAgent) qs.set('remoteAgent', params.remoteAgent);
    if (params?.startDate) qs.set('startDate', params.startDate);
    if (params?.endDate) qs.set('endDate', params.endDate);
    return `/api/a2a/audit/export?${qs.toString()}`;
  },
  config: () => request<Record<string, unknown>>('/a2a/config'),
  saveConfig: (a2aConfig: unknown) => request<{ success: boolean }>('/a2a/config', { method: 'PUT', body: JSON.stringify({ a2aConfig }) }),
  serverStatus: () => request<Record<string, unknown>>('/a2a/server-status'),
  send: (targetUrl: string, message: { subject?: string; content: string; priority?: string }) =>
    request<Record<string, unknown>>('/a2a/send', { method: 'POST', body: JSON.stringify({ targetUrl, message }) }),
  registrySearch: (params: { role?: string; capability?: string; tag?: string }) =>
    request<Record<string, unknown>>('/a2a/registry-search', { method: 'POST', body: JSON.stringify(params) }),
  discover: () =>
    request<Record<string, unknown>>('/a2a/discover', { method: 'POST' }),
  queryAgents: () =>
    request<{ agents: Array<Record<string, unknown>>; total: number; reachable: number; timestamp: string }>('/a2a/query-agents', { method: 'POST' }),
};
