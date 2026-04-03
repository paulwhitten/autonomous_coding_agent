import { useState, useEffect } from 'react';
import { teamApi } from '../lib/api';
import { Plus, Trash2, Save, UserCircle } from 'lucide-react';

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

const ROLES = ['developer', 'qa', 'manager', 'researcher'];

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

  useEffect(() => {
    teamApi.get().then(data => setRoster(data as unknown as TeamRoster)).catch(() => {});
  }, []);

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
          </p>
        </div>
        <div className="flex gap-2">
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
                {agents.map(agent => (
                  <div key={agent.id} className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        <UserCircle size={24} className="text-gray-400" />
                        <div>
                          <div className="font-medium text-sm">{agent.id}</div>
                          <div className="text-xs text-gray-500">{agent.hostname}</div>
                        </div>
                      </div>
                      <button onClick={() => removeAgent(agent.id)} className="text-red-400 hover:text-red-600">
                        <Trash2 size={14} />
                      </button>
                    </div>
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
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
