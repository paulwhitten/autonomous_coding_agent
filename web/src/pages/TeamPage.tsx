import { useState, useEffect } from 'react';
import { teamApi, agentsApi, fetchA2A, getAgentContext } from '../lib/api';
import { Plus, Trash2, Save, UserCircle, Radio, RefreshCw, Wifi, WifiOff } from 'lucide-react';

interface Agent {
  id: string;
  hostname: string;
  role: string;
  description?: string;
  capabilities?: string[];
  timezone?: string;
}

interface TeamRoster {
  team: { name: string; description?: string };
  agents: Agent[];
  roles?: Record<string, { agents: string[]; description?: string }>;
}

interface A2ATeamMember {
  hostname: string;
  role: string;
  responsibilities?: string;
}

interface A2AStatusData {
  agent?: { name?: string; description?: string; skills?: Array<{ id: string; name: string }> };
  team?: A2ATeamMember[];
  mailbox?: { unread: number };
  workItems?: Record<string, string[]>;
}

const ROLES = ['developer', 'qa', 'manager', 'researcher', 'requirements-analyst'];

export default function TeamPage() {
  const [roster, setRoster] = useState<TeamRoster>({
    team: { name: '', description: '' },
    agents: [],
    roles: {},
  });
  const [showForm, setShowForm] = useState(false);
  const [newAgent, setNewAgent] = useState<Partial<Agent>>({
    hostname: '',
    role: 'developer',
    description: '',
    capabilities: [],
    timezone: '',
  });
  const [status, setStatus] = useState<string | null>(null);

  // A2A team data from attached agent
  const agentContext = getAgentContext();
  const a2aUrl = agentContext?.a2aUrl;
  const [a2aStatus, setA2aStatus] = useState<A2AStatusData | null>(null);
  const [a2aLoading, setA2aLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);

  // Agent health tracking from discovered agents
  const [agentHealth, setAgentHealth] = useState<Record<string, { reachable: boolean; workItems?: Record<string, string[]>; unread?: number }>>({});

  const loadA2AStatus = async () => {
    if (!a2aUrl) return;
    setA2aLoading(true);
    try {
      const data = await fetchA2A<A2AStatusData>(a2aUrl, '/a2a/status');
      setA2aStatus(data);
    } catch { setA2aStatus(null); }
    finally { setA2aLoading(false); }
  };

  useEffect(() => {
    teamApi.get().then(data => setRoster(data as unknown as TeamRoster)).catch(() => {});
    if (a2aUrl) loadA2AStatus();
    loadAgentHealth();
  }, []);

  const loadAgentHealth = async () => {
    try {
      const data = await agentsApi.discovered();
      const healthMap: Record<string, { reachable: boolean; workItems?: Record<string, string[]>; unread?: number }> = {};
      for (const agent of data.agents) {
        const raw = agent as Record<string, unknown>;
        const a2aStatus = raw.a2aStatus as { workItems?: Record<string, string[]>; mailbox?: { unread?: number } } | undefined;
        healthMap[agent.agentId] = {
          reachable: raw.reachable !== false,
          workItems: a2aStatus?.workItems,
          unread: a2aStatus?.mailbox?.unread,
        };
      }
      setAgentHealth(healthMap);
    } catch { /* ignore */ }
  };

  // Auto-refresh A2A status and health
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      if (a2aUrl) loadA2AStatus();
      loadAgentHealth();
    }, 10_000);
    return () => clearInterval(interval);
  }, [autoRefresh, a2aUrl]);

  const addAgent = async () => {
    const agent: Agent = {
      id: `${newAgent.hostname}_${newAgent.role}`,
      hostname: newAgent.hostname || '',
      role: newAgent.role || 'developer',
      description: newAgent.description,
      capabilities: newAgent.capabilities,
      timezone: newAgent.timezone,
    };
    if (!agent.hostname) return;
    try {
      await teamApi.addAgent(agent);
      setRoster(prev => ({
        ...prev,
        agents: [...prev.agents, agent],
      }));
      setNewAgent({ hostname: '', role: 'developer', description: '', capabilities: [], timezone: '' });
      setShowForm(false);
      setStatus('Agent added');
      setTimeout(() => setStatus(null), 3000);
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
    }
  };

  const removeAgent = async (id: string) => {
    try {
      await teamApi.removeAgent(id);
      setRoster(prev => ({
        ...prev,
        agents: prev.agents.filter(a => a.id !== id),
      }));
      setStatus('Agent removed');
      setTimeout(() => setStatus(null), 3000);
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
    }
  };

  const saveTeam = async () => {
    try {
      await teamApi.save(roster);
      setStatus('Team saved');
      setTimeout(() => setStatus(null), 3000);
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
    }
  };

  const roleGroups = ROLES.map(role => ({
    role,
    agents: roster.agents.filter(a => a.role === role),
  }));

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Team Management</h1>
          <p className="text-sm text-gray-500 mt-1">
            {roster.team.name || 'Unnamed Team'} — {roster.agents.length} agents
            {agentContext && (
              <span className="ml-2 text-gray-400">
                · attached to {agentContext.hostname} ({agentContext.role})
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {a2aUrl && (
            <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="rounded"
              />
              Auto-refresh
            </label>
          )}
          {a2aUrl && (
            <button onClick={loadA2AStatus} className="flex items-center gap-1 px-3 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600 text-sm">
              <RefreshCw size={14} /> Refresh A2A
            </button>
          )}
          <button onClick={() => setShowForm(!showForm)} className="flex items-center gap-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm">
            <Plus size={16} /> Add Agent
          </button>
          <button onClick={saveTeam} className="flex items-center gap-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">
            <Save size={16} /> Save
          </button>
        </div>
      </div>

      {status && (
        <div className={`mb-4 p-3 rounded-lg text-sm ${status.startsWith('Error') ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
          {status}
        </div>
      )}

      {/* Workflow-based Team Formation */}
      {/* A2A Agent Status Panel */}
      {a2aUrl && (
        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl p-4 mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Radio size={16} className="text-blue-500" />
            <h2 className="text-sm font-semibold text-blue-700 dark:text-blue-300">Live Agent Team (via A2A)</h2>
            {a2aLoading && <span className="text-xs text-blue-400">loading...</span>}
          </div>
          {a2aStatus?.agent && (
            <div className="mb-3 p-3 bg-white dark:bg-gray-800 rounded-lg">
              <div className="font-medium text-sm text-gray-700 dark:text-gray-200">{a2aStatus.agent.name}</div>
              {a2aStatus.agent.description && (
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{a2aStatus.agent.description}</p>
              )}
              <div className="flex gap-3 mt-2 text-xs text-gray-500 dark:text-gray-400">
                {a2aStatus.mailbox && <span>📬 {a2aStatus.mailbox.unread} unread</span>}
                {a2aStatus.workItems && (
                  <span>📋 {(a2aStatus.workItems.pending || []).length} pending / {(a2aStatus.workItems.completed || []).length} done</span>
                )}
              </div>
            </div>
          )}
          {a2aStatus?.team && a2aStatus.team.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
              {a2aStatus.team.map(member => (
                <div key={`${member.hostname}_${member.role}`} className="bg-white dark:bg-gray-800 rounded-lg p-3 border dark:border-gray-700">
                  <div className="flex items-center gap-2">
                    <UserCircle size={20} className="text-blue-400" />
                    <div>
                      <div className="font-medium text-sm text-gray-700 dark:text-gray-200">
                        {member.hostname}_{member.role}
                      </div>
                      <div className="text-xs text-gray-500">{member.role}</div>
                    </div>
                  </div>
                  {member.responsibilities && (
                    <p className="text-xs text-gray-500 mt-1">{member.responsibilities}</p>
                  )}
                </div>
              ))}
            </div>
          ) : !a2aLoading ? (
            <p className="text-sm text-blue-400">No team members reported by agent</p>
          ) : null}
        </div>
      )}

      {/* Team metadata */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-4 mb-6">
        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-200">Team Name</span>
            <input
              value={roster.team.name}
              onChange={(e) => setRoster(prev => ({ ...prev, team: { ...prev.team, name: e.target.value } }))}
              className="input mt-1"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-200">Description</span>
            <input
              value={roster.team.description || ''}
              onChange={(e) => setRoster(prev => ({ ...prev, team: { ...prev.team, description: e.target.value } }))}
              className="input mt-1"
            />
          </label>
        </div>
      </div>

      {/* Add agent form */}
      {showForm && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-6">
          <h3 className="font-semibold text-sm mb-3">Add New Agent</h3>
          <div className="grid grid-cols-2 gap-3">
            <input value={newAgent.hostname} onChange={(e) => setNewAgent(prev => ({ ...prev, hostname: e.target.value }))} placeholder="Hostname" className="input text-sm" />
            <select value={newAgent.role} onChange={(e) => setNewAgent(prev => ({ ...prev, role: e.target.value }))} className="input text-sm">
              {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <input value={newAgent.description} onChange={(e) => setNewAgent(prev => ({ ...prev, description: e.target.value }))} placeholder="Description" className="input text-sm" />
            <input value={newAgent.timezone} onChange={(e) => setNewAgent(prev => ({ ...prev, timezone: e.target.value }))} placeholder="Timezone (e.g., America/New_York)" className="input text-sm" />
            <input
              value={newAgent.capabilities?.join(', ') || ''}
              onChange={(e) => setNewAgent(prev => ({ ...prev, capabilities: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))}
              placeholder="Capabilities (comma-separated)"
              className="input text-sm col-span-2"
            />
          </div>
          <div className="flex justify-end gap-2 mt-3">
            <button onClick={() => setShowForm(false)} className="px-3 py-1.5 bg-gray-200 rounded text-sm hover:bg-gray-300">Cancel</button>
            <button onClick={addAgent} className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">Add</button>
          </div>
        </div>
      )}

      {/* Agent grid by role */}
      <div className="space-y-6">
        {roleGroups.map(({ role, agents }) => (
          <div key={role}>
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-2">
              {role} ({agents.length})
            </h2>
            {agents.length === 0 ? (
              <p className="text-sm text-gray-400 italic">No agents with this role</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {agents.map(agent => {
                  const health = agentHealth[agent.id];
                  return (
                  <div key={agent.id} className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        <UserCircle size={24} className="text-gray-400" />
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium text-sm">{agent.id}</span>
                            {health ? (
                              health.reachable ? (
                                <span title="Online"><Wifi size={12} className="text-green-500" /></span>
                              ) : (
                                <span title="Offline"><WifiOff size={12} className="text-red-400" /></span>
                              )
                            ) : null}
                          </div>
                          <div className="text-xs text-gray-500">{agent.hostname}</div>
                        </div>
                      </div>
                      <button onClick={() => removeAgent(agent.id)} className="text-red-400 hover:text-red-600">
                        <Trash2 size={14} />
                      </button>
                    </div>
                    {health && health.reachable && (
                      <div className="flex gap-3 mt-2 text-xs text-gray-500">
                        {health.workItems && (
                          <span>📋 {(health.workItems.pending || []).length}p / {(health.workItems.completed || []).length}c</span>
                        )}
                        {health.unread !== undefined && health.unread > 0 && (
                          <span>📬 {health.unread} unread</span>
                        )}
                      </div>
                    )}
                    {agent.description && (
                      <p className="text-xs text-gray-500 mt-2">{agent.description}</p>
                    )}
                    {agent.capabilities && agent.capabilities.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {agent.capabilities.map(cap => (
                          <span key={cap} className="text-xs px-2 py-0.5 bg-gray-100 rounded-full text-gray-600">
                            {cap}
                          </span>
                        ))}
                      </div>
                    )}
                    {agent.timezone && (
                      <div className="text-xs text-gray-400 mt-2">🕐 {agent.timezone}</div>
                    )}
                  </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
