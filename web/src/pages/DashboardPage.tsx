import { useState, useEffect, useCallback } from 'react';
import { agentsApi, mailboxApi, a2aApi, processesApi } from '../lib/api';
import { onFileChange, onAgentDiscovery, onAgentHealth } from '../lib/socket';
import { Activity, CheckCircle, AlertTriangle, Clock, Inbox, XCircle, FolderOpen, X, Mail, ChevronRight, Radio, Rocket, Settings, GitBranch, Search, Wifi, WifiOff, RefreshCw, Send, MessageSquare, Play, Circle, FileText } from 'lucide-react';
import WorkflowVisualization from '../components/WorkflowVisualization';
import TaskProgress from '../components/TaskProgress';

interface DiscoveredAgent {
  agentId: string;
  hostname: string;
  role: string;
  pid: number;
  startedAt: string;
  a2aUrl?: string;
  capabilities?: string[];
  description?: string;
  teamMembers?: Array<{ hostname: string; role: string }>;
  mailboxRepoPath?: string;
  workspacePath?: string;
  configPath?: string;
  // A2A enrichment fields
  reachable?: boolean;
  skills?: Array<{ id: string; name: string; description?: string; tags?: string[] }>;
  version?: string;
  card?: Record<string, unknown>;
  a2aStatus?: Record<string, unknown>;
  // Health monitoring
  health?: 'online' | 'offline' | 'degraded' | 'unknown';
}

function getStoredWorkspace(): string {
  return localStorage.getItem('agent-workspace') || '';
}

function getStoredAgentContext(): { hostname: string; role: string; agentId: string; mailboxRepoPath?: string } | null {
  try {
    const raw = localStorage.getItem('agent-context');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function storeAgentContext(agent: { hostname: string; role: string; agentId: string; a2aUrl?: string; mailboxRepoPath?: string }) {
  localStorage.setItem('agent-context', JSON.stringify(agent));
}

function clearAgentContext() {
  localStorage.removeItem('agent-context');
}

export default function DashboardPage() {
  const [agents, setAgents] = useState<unknown[]>([]);
  const [workItems, setWorkItems] = useState<Record<string, string[]>>({
    pending: [],
    completed: [],
    review: [],
    failed: [],
  });
  const [recentEvents, setRecentEvents] = useState<Array<{ path: string; type: string; time: string }>>([]);
  const [workspacePath, setWorkspacePath] = useState(getStoredWorkspace);
  const [agentContext, setAgentContext] = useState(getStoredAgentContext);
  const [showAttach, setShowAttach] = useState(false);
  const [pathInput, setPathInput] = useState(workspacePath);
  const [mailboxRepoPath, setMailboxRepoPath] = useState<string>('');
  const [mailboxAgents, setMailboxAgents] = useState<string[]>([]);
  const [mailboxMessages, setMailboxMessages] = useState<Record<string, Array<{ filename: string; folder: string }>>>({});
  const [agentConfig, setAgentConfig] = useState<Record<string, unknown> | null>(null);
  const [a2aServerStatus, setA2aServerStatus] = useState<{ running: boolean; port?: number } | null>(null);
  const [a2aDiscoveredCount, setA2aDiscoveredCount] = useState(0);
  const [a2aRecentAudit, setA2aRecentAudit] = useState(0);
  const [a2aRecentEntries, setA2aRecentEntries] = useState<Array<{ direction: string; method: string; timestamp: string }>>([]);
  const [discoveredAgents, setDiscoveredAgents] = useState<DiscoveredAgent[]>([]);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryTimestamp, setDiscoveryTimestamp] = useState<string | null>(null);
  const [messagingAgent, setMessagingAgent] = useState<DiscoveredAgent | null>(null);
  const [messageContent, setMessageContent] = useState('');
  const [messageSubject, setMessageSubject] = useState('');
  const [messageSending, setMessageSending] = useState(false);
  const [messageSent, setMessageSent] = useState<string | null>(null);
  const [messageHistory, setMessageHistory] = useState<Array<{ to: string; subject: string; content: string; time: string; status: 'sent' | 'failed' }>>([]);
  const [launchRole, setLaunchRole] = useState('');
  const [launchConfigs, setLaunchConfigs] = useState<string[]>([]);
  const [launching, setLaunching] = useState(false);
  const [slideoutTab, setSlideoutTab] = useState<'message' | 'logs'>('message');
  const [agentLogs, setAgentLogs] = useState<string[]>([]);
  const [agentLogsLoading, setAgentLogsLoading] = useState(false);
  const [healthHistoryMap, setHealthHistoryMap] = useState<Record<string, Array<{ time: string; health: string }>>>({});

  const loadData = useCallback(async () => {
    try {
      const ws = workspacePath || undefined;
      const [statusData, itemsData] = await Promise.all([
        agentsApi.status(ws),
        agentsApi.workItems(ws),
      ]);
      setAgents(statusData.agents);
      setWorkItems(itemsData);

      // Load config and mailbox when attached to a workspace
      if (workspacePath) {
        try {
          const { config, configPath } = await agentsApi.workspaceConfig(workspacePath);
          setAgentConfig(config);
          const mailbox = config.mailbox as { repoPath?: string } | undefined;
          if (mailbox?.repoPath) {
            // Resolve repoPath relative to the config's directory
            const resolvedRepo = mailbox.repoPath.startsWith('/')
              ? mailbox.repoPath
              : `${configPath}/${mailbox.repoPath}`;
            setMailboxRepoPath(resolvedRepo);
            try {
              const agentsData = await mailboxApi.listAgents(resolvedRepo);
              setMailboxAgents(agentsData.agents);
              // Load messages for each agent
              const msgMap: Record<string, Array<{ filename: string; folder: string }>> = {};
              await Promise.all(
                agentsData.agents.map(async (agentId) => {
                  try {
                    const data = await mailboxApi.listMessages(agentId, resolvedRepo);
                    msgMap[agentId] = data.messages;
                  } catch { msgMap[agentId] = []; }
                })
              );
              setMailboxMessages(msgMap);
            } catch {
              setMailboxAgents([]);
              setMailboxMessages({});
            }
          }
        } catch {
          setAgentConfig(null);
          setMailboxRepoPath('');
        }
      } else {
        setAgentConfig(null);
        setMailboxRepoPath('');
        setMailboxAgents([]);
        setMailboxMessages({});
      }

      // Load A2A summary data
      try {
        const [serverStatus, discovered, audit] = await Promise.all([
          a2aApi.serverStatus(),
          a2aApi.discoveredAgents(),
          a2aApi.audit({ limit: 5 }),
        ]);
        setA2aServerStatus(serverStatus as { running: boolean; port?: number });
        const disc = discovered as { knownUrls?: string[]; teamAgents?: unknown[] };
        setA2aDiscoveredCount((disc.knownUrls?.length || 0) + (disc.teamAgents?.length || 0));
        const auditData = audit as { total?: number; entries?: Array<{ direction: string; method: string; timestamp: string }> };
        setA2aRecentAudit(auditData.total || 0);
        setA2aRecentEntries((auditData.entries || []).slice(0, 5));
      } catch {
        setA2aServerStatus(null);
      }
    } catch { /* ignore */ }
  }, [workspacePath]);

  const loadDiscoveredAgents = useCallback(async () => {
    setDiscoveryLoading(true);
    try {
      const data = await agentsApi.discovered();
      const agents = data.agents;

      // Enrich each agent that has an A2A URL with live status data
      const enriched = await Promise.all(agents.map(async (agent) => {
        if (!agent.a2aUrl) return agent;
        try {
          const base = agent.a2aUrl.endsWith('/') ? agent.a2aUrl.slice(0, -1) : agent.a2aUrl;
          const res = await fetch(`${base}/a2a/status`, { headers: { 'Accept': 'application/json' } });
          if (res.ok) {
            const status = await res.json();
            return { ...agent, a2aStatus: status };
          }
        } catch { /* enrich silently fails */ }
        return agent;
      }));

      setDiscoveredAgents(enriched as DiscoveredAgent[]);
      setDiscoveryTimestamp(data.timestamp);
    } catch {
      // Don't clear existing agents on error
    } finally {
      setDiscoveryLoading(false);
    }
  }, []);

  const loadAgentLogs = useCallback(async (agent: DiscoveredAgent) => {
    setAgentLogsLoading(true);
    setAgentLogs([]);
    try {
      // Try to find a matching process by PID (works when process Map is populated)
      const procs = await processesApi.list();
      const match = procs.processes.find(p => p.pid === agent.pid);
      if (match) {
        const data = await processesApi.output(match.id, 100);
        if (data.output.length > 0) {
          setAgentLogs(data.output);
          return;
        }
      }
      // Try workspace-specific log file, then per-role log, then global
      if (agent.workspacePath) {
        // Try workspace-adjacent log: {projectDir}/logs/{role}.log
        const roleLogPath = `${agent.workspacePath}/../logs/${agent.role}.log`;
        const roleData = await agentsApi.logs(100, roleLogPath);
        if (roleData.lines.length > 0) {
          setAgentLogs(roleData.lines);
          return;
        }
        // Try legacy workspace-adjacent: {projectDir}/logs/agent.log
        const data = await agentsApi.logs(100, `${agent.workspacePath}/../logs/agent.log`);
        if (data.lines.length > 0) {
          setAgentLogs(data.lines);
          return;
        }
      }
      // Fall back to global log (default path on server: {projectRoot}/logs/agent.log)
      const data = await agentsApi.logs(100);
      setAgentLogs(data.lines);
    } catch { /* ignore */ }
    finally { setAgentLogsLoading(false); }
  }, []);

  useEffect(() => {
    loadData();
    loadDiscoveredAgents();
    // Load available config files for agent launching
    processesApi.configs().then(d => setLaunchConfigs(d.configs)).catch(() => {});
    // Load initial health history
    agentsApi.healthHistory().then(d => setHealthHistoryMap(d.history)).catch(() => {});
    const unsub = onFileChange((data) => {
      setRecentEvents(prev => [
        { ...data, time: new Date().toLocaleTimeString() },
        ...prev.slice(0, 49),
      ]);
      if (data.type === 'task' || data.type === 'mailbox') {
        loadData();
      }
    });
    // Subscribe to real-time agent discovery via mDNS/Socket.io
    const unsubAgents = onAgentDiscovery((data) => {
      setDiscoveredAgents(data.agents as DiscoveredAgent[]);
      setDiscoveryTimestamp(new Date().toISOString());
    });
    // Subscribe to real-time health events with history
    const unsubHealth = onAgentHealth((data) => {
      if (data.history) {
        setHealthHistoryMap(prev => ({ ...prev, [data.agentId]: data.history! }));
      }
    });
    const interval = setInterval(loadData, 30000);
    // Fallback polling for enriched discovery (card data) — less frequent since Socket.io handles the fast path
    const discoveryInterval = setInterval(loadDiscoveredAgents, 120000);
    return () => {
      unsub();
      unsubAgents();
      unsubHealth();
      clearInterval(interval);
      clearInterval(discoveryInterval);
    };
  }, [loadData, loadDiscoveredAgents]);

  const attachWorkspace = () => {
    const path = pathInput.trim();
    setWorkspacePath(path);
    if (path) {
      localStorage.setItem('agent-workspace', path);
    } else {
      localStorage.removeItem('agent-workspace');
    }
    // Manual path entry clears agent context since we don't know the agent
    clearAgentContext();
    setAgentContext(null);
    setShowAttach(false);
  };

  const detachWorkspace = () => {
    setWorkspacePath('');
    setPathInput('');
    localStorage.removeItem('agent-workspace');
    clearAgentContext();
    setAgentContext(null);
  };

  const totalItems = Object.values(workItems).reduce((sum, arr) => sum + arr.length, 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Dashboard</h1>
        <div className="flex items-center gap-2">
          {workspacePath && (
            <span className="flex items-center gap-1 px-2 py-1 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded-lg text-xs">
              <FolderOpen size={12} />
              {agentContext
                ? <span className="font-medium">{agentContext.hostname} <span className="opacity-70">({agentContext.role})</span></span>
                : workspacePath.split('/').slice(-2).join('/')}
              <button onClick={detachWorkspace} className="ml-1 hover:text-green-900 dark:hover:text-green-200">
                <X size={10} />
              </button>
            </span>
          )}
          <button
            onClick={() => { setShowAttach(!showAttach); setPathInput(workspacePath); }}
            className="flex items-center gap-1 px-3 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600 text-sm"
          >
            <FolderOpen size={14} /> {workspacePath ? 'Change' : 'Attach'} Workspace
          </button>
        </div>
      </div>

      {/* Attach workspace panel */}
      {showAttach && (
        <div className="mb-4 bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl p-4">
          <h3 className="font-semibold text-sm mb-2">Attach to Agent Workspace</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            Enter the absolute path to an agent's workspace folder (e.g. <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">smoke_tests/basic/workspace</code>).
            The dashboard will show that agent's status, work items, and logs.
          </p>
          <div className="flex gap-2">
            <input
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && attachWorkspace()}
              placeholder="/absolute/path/to/workspace or relative/path"
              className="input text-sm flex-1 font-mono"
              autoFocus
            />
            <button onClick={attachWorkspace} className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">
              Attach
            </button>
            {workspacePath && (
              <button onClick={detachWorkspace} className="px-4 py-2 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 text-sm">
                Detach
              </button>
            )}
          </div>
        </div>
      )}

      {/* Quick Start — shown when no workspace attached and no agents running */}
      {!workspacePath && agents.length === 0 && !showAttach && (
        <div className="mb-6 bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 border border-blue-200 dark:border-blue-800 rounded-xl p-6">
          <div className="flex items-start gap-4">
            <div className="bg-blue-100 dark:bg-blue-800/50 rounded-lg p-2.5">
              <Rocket size={24} className="text-blue-600 dark:text-blue-400" />
            </div>
            <div className="flex-1">
              <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-1">Get Started</h2>
              <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
                Attach a workspace to monitor agents, or explore the configuration pages to set up your environment.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <button
                  onClick={() => { setShowAttach(true); setPathInput(''); }}
                  className="flex items-center gap-2 px-3 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
                >
                  <FolderOpen size={16} /> Attach Workspace
                </button>
                <a
                  href="/config"
                  className="flex items-center gap-2 px-3 py-2.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 text-sm font-medium"
                >
                  <Settings size={16} /> Configuration
                </a>
                <a
                  href="/workflows"
                  className="flex items-center gap-2 px-3 py-2.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 text-sm font-medium"
                >
                  <GitBranch size={16} /> Workflows
                </a>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Stats cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard
          icon={<Inbox className="text-blue-500" size={20} />}
          label="Pending"
          value={workItems.pending?.length || 0}
          color="blue"
        />
        <StatCard
          icon={<Clock className="text-yellow-500" size={20} />}
          label="In Review"
          value={workItems.review?.length || 0}
          color="yellow"
        />
        <StatCard
          icon={<CheckCircle className="text-green-500" size={20} />}
          label="Completed"
          value={workItems.completed?.length || 0}
          color="green"
        />
        <StatCard
          icon={<XCircle className="text-red-500" size={20} />}
          label="Failed"
          value={workItems.failed?.length || 0}
          color="red"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Discovered Agents via mDNS */}
        <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-4 lg:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-gray-700 dark:text-gray-200 flex items-center gap-2">
              <Radio size={16} /> Discovered Agents
              {discoveredAgents.length > 0 && (
                <span className="text-xs font-normal text-gray-400">
                  ({discoveredAgents.length} on network)
                </span>
              )}
            </h2>
            <div className="flex items-center gap-2">
              {discoveryTimestamp && (
                <span className="text-xs text-gray-400">
                  {new Date(discoveryTimestamp).toLocaleTimeString()}
                </span>
              )}
              <button
                onClick={loadDiscoveredAgents}
                disabled={discoveryLoading}
                className="flex items-center gap-1 px-2 py-1 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 rounded text-xs disabled:opacity-50"
              >
                <RefreshCw size={12} className={discoveryLoading ? 'animate-spin' : ''} />
                {discoveryLoading ? 'Scanning…' : 'Refresh'}
              </button>
              {/* Launch agent dropdown */}
              {launchConfigs.length > 0 && (
                <div className="flex items-center gap-1">
                  <select
                    value={launchRole}
                    onChange={(e) => setLaunchRole(e.target.value)}
                    className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-none rounded px-1 py-1"
                  >
                    <option value="">Config…</option>
                    {launchConfigs.map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  <button
                    onClick={async () => {
                      if (!launchRole) return;
                      setLaunching(true);
                      try {
                        await processesApi.start(launchRole);
                        setLaunchRole('');
                        // Discovery will pick up the new agent via mDNS
                      } catch { /* ignore */ }
                      finally { setLaunching(false); }
                    }}
                    disabled={!launchRole || launching}
                    className="flex items-center gap-1 px-2 py-1 bg-green-600 text-white hover:bg-green-700 rounded text-xs disabled:opacity-50"
                  >
                    <Play size={10} />
                    {launching ? 'Starting…' : 'Launch'}
                  </button>
                </div>
              )}
            </div>
          </div>
          {discoveredAgents.length === 0 ? (
            <div className="text-center py-6 text-gray-400">
              {discoveryLoading ? (
                <>
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600 mx-auto mb-2" />
                  <p className="text-sm">Scanning for agents…</p>
                </>
              ) : (
                <>
                  <p className="text-sm">No agents discovered on the network</p>
                  <p className="text-xs mt-1">
                    Agents advertise themselves automatically via mDNS when they start.
                    Make sure agents are running on this network.
                  </p>
                </>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {[...discoveredAgents].sort((a, b) => a.agentId.localeCompare(b.agentId)).map((agent) => (
                <div
                  key={agent.agentId}
                  className="rounded-lg border p-3 bg-gray-50 dark:bg-gray-700/50 border-gray-200 dark:border-gray-600 cursor-pointer hover:border-blue-400 dark:hover:border-blue-500 transition-colors"
                  onClick={() => { setMessagingAgent(agent); setMessageSent(null); }}
                >
                  <div className="flex items-start justify-between mb-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <HealthIndicator health={agent.health} />
                      <span className="font-medium text-sm text-gray-900 dark:text-gray-100 truncate">
                        {agent.hostname}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
                      <span className="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded">
                        {agent.role}
                      </span>
                      {agent.a2aUrl && (
                        <span title="Click to message">
                          <MessageSquare size={12} className="text-gray-400" />
                        </span>
                      )}
                    </div>
                  </div>
                  {agent.description && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-1 line-clamp-2">{agent.description}</p>
                  )}
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-gray-500 dark:text-gray-400 mt-1">
                    <span>PID {agent.pid}</span>
                    <span>Up {formatUptime((Date.now() - new Date(agent.startedAt).getTime()) / 1000)}</span>
                    {agent.a2aUrl && <span className="text-blue-500">{agent.a2aUrl}</span>}
                  </div>
                  {/* A2A enrichment badges */}
                  {agent.a2aStatus && (
                    <div className="flex flex-wrap gap-2 text-xs mt-1">
                      {(agent.a2aStatus as any).mailbox && (
                        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded ${
                          ((agent.a2aStatus as any).mailbox.unread || 0) > 0
                            ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
                            : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'
                        }`}>
                          📬 {(agent.a2aStatus as any).mailbox.unread || 0} unread
                        </span>
                      )}
                      {(agent.a2aStatus as any).workItems && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
                          📋 {((agent.a2aStatus as any).workItems.pending || []).length} pending
                          {((agent.a2aStatus as any).workItems.completed || []).length > 0 && (
                            <span className="text-green-500">· {((agent.a2aStatus as any).workItems.completed || []).length} done</span>
                          )}
                        </span>
                      )}
                    </div>
                  )}
                  {agent.workspacePath && (
                    <div className="flex items-center gap-1 text-xs text-gray-400 mt-0.5 truncate" title={agent.workspacePath}>
                      <FolderOpen size={10} className="flex-shrink-0" />
                      <span className="truncate font-mono">{agent.workspacePath.split('/').slice(-2).join('/')}</span>
                      {agent.workspacePath === workspacePath && (
                        <span className="text-green-500 flex-shrink-0">✓</span>
                      )}
                    </div>
                  )}
                  {/* Health sparkline */}
                  {healthHistoryMap[agent.agentId] && healthHistoryMap[agent.agentId].length > 1 && (
                    <HealthSparkline points={healthHistoryMap[agent.agentId]} />
                  )}
                  {/* Show A2A skills when enriched, otherwise fall back to capabilities */}
                  {agent.skills && agent.skills.length > 0 ? (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {agent.skills.slice(0, 4).map((s) => (
                        <span key={s.id} className="bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 text-xs px-1.5 py-0.5 rounded" title={s.description}>
                          {s.name}
                        </span>
                      ))}
                      {agent.skills.length > 4 && (
                        <span className="text-xs text-gray-400">+{agent.skills.length - 4}</span>
                      )}
                    </div>
                  ) : agent.capabilities && agent.capabilities.length > 0 ? (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {agent.capabilities.slice(0, 4).map((cap) => (
                        <span key={cap} className="bg-gray-200 dark:bg-gray-600 text-gray-600 dark:text-gray-300 text-xs px-1.5 py-0.5 rounded">
                          {cap}
                        </span>
                      ))}
                      {agent.capabilities.length > 4 && (
                        <span className="text-xs text-gray-400">+{agent.capabilities.length - 4}</span>
                      )}
                    </div>
                  ) : null}
                  {agent.teamMembers && agent.teamMembers.length > 0 && (
                    <div className="mt-1.5 text-xs text-gray-400">
                      Team: {agent.teamMembers.map(m => `${m.hostname} (${m.role})`).join(', ')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Team Topology — shows agent relationships from teamMembers */}
        {discoveredAgents.length >= 2 && (
          <TeamTopologyPanel
            agents={discoveredAgents}
            onSelectAgent={(agent) => { setMessagingAgent(agent); setMessageSent(null); }}
          />
        )}

        {/* Workspace Agent Status (filesystem-based, shown when attached) */}
        {(agents.length > 0 || workspacePath) && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-4">
          <h2 className="font-semibold text-gray-700 dark:text-gray-200 mb-3 flex items-center gap-2">
            <Activity size={16} /> Workspace Agent Status
          </h2>
          {agents.length === 0 ? (
            <div className="text-center py-8 text-gray-400">
              <p className="text-sm">No active agents detected</p>
              <p className="text-xs mt-1">Start an agent to see status here</p>
            </div>
          ) : (
            <div className="space-y-2">
              {agents.map((agent: any, i) => (
                <div key={i} className={`flex items-center justify-between p-3 rounded-lg ${agent.stale ? 'bg-gray-50 dark:bg-gray-700/50 opacity-60' : 'bg-gray-50 dark:bg-gray-700'}`}>
                  <div>
                    <div className="flex items-center gap-2">
                      <div className="font-medium text-sm">{agent.agentId}</div>
                      {agent.stale && (
                        <span className="text-xs bg-red-50 dark:bg-red-900/20 text-red-400 px-1.5 py-0.5 rounded-full flex items-center gap-1">
                          <WifiOff size={10} /> Not running
                        </span>
                      )}
                      {agent.active && agent.reachable && (
                        <span className="text-xs bg-green-50 dark:bg-green-900/20 text-green-500 px-1.5 py-0.5 rounded-full flex items-center gap-1">
                          <Wifi size={10} /> Connected
                        </span>
                      )}
                      {agent.active && !agent.reachable && (
                        <span className="text-xs bg-yellow-50 dark:bg-yellow-900/20 text-yellow-600 px-1.5 py-0.5 rounded-full">Active (no A2A)</span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500">
                      Processed: {agent.messagesProcessed} messages
                      {agent.lastMailboxCheck && (
                        <span className="ml-2">· Last seen: {new Date(agent.lastMailboxCheck).toLocaleTimeString()}</span>
                      )}
                    </div>
                  </div>
                  <StatusBadge status={agent.status} />
                </div>
              ))}
            </div>
          )}
        </div>
        )}

        {/* Work Item Pipeline */}
        <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-4">
          <h2 className="font-semibold text-gray-700 dark:text-gray-200 mb-3">Work Item Pipeline</h2>
          {totalItems === 0 ? (
            <div className="text-center py-8 text-gray-400">
              <p className="text-sm">No work items yet</p>
              <p className="text-xs mt-1">Submit work via the Mailbox page</p>
            </div>
          ) : (
            <div className="space-y-3">
              {(['pending', 'review', 'completed', 'failed'] as const).map(folder => (
                <div key={folder}>
                  <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
                    <span className="uppercase font-medium">{folder}</span>
                    <span>{workItems[folder]?.length || 0}</span>
                  </div>
                  <div className="w-full bg-gray-100 dark:bg-gray-700 rounded-full h-2">
                    <div
                      className={`h-2 rounded-full ${
                        folder === 'completed'
                          ? 'bg-green-500'
                          : folder === 'failed'
                          ? 'bg-red-500'
                          : folder === 'review'
                          ? 'bg-yellow-500'
                          : 'bg-blue-500'
                      }`}
                      style={{
                        width: totalItems > 0
                          ? `${((workItems[folder]?.length || 0) / totalItems) * 100}%`
                          : '0%',
                      }}
                    />
                  </div>
                  {(workItems[folder]?.length || 0) > 0 && (
                    <div className="mt-1 space-y-0.5">
                      {workItems[folder]?.slice(0, 5).map(item => (
                        <div key={item} className="text-xs text-gray-500 truncate pl-2">
                          {item}
                        </div>
                      ))}
                      {(workItems[folder]?.length || 0) > 5 && (
                        <div className="text-xs text-gray-400 pl-2">
                          +{(workItems[folder]?.length || 0) - 5} more
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Workflow State Visualization */}
        <WorkflowVisualization />

        {/* Task Progress Tracking */}
        <TaskProgress workItems={workItems} />

        {/* Mailbox (shown when attached to workspace with mailbox config) */}
        {workspacePath && mailboxRepoPath && (
          <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-4 lg:col-span-2">
            <h2 className="font-semibold text-gray-700 dark:text-gray-200 mb-3 flex items-center gap-2">
              <Mail size={16} /> Agent Mailbox
              <span className="text-xs font-normal text-gray-400 dark:text-gray-500 ml-2 font-mono truncate">
                {mailboxRepoPath.split('/').slice(-2).join('/')}
              </span>
            </h2>
            {mailboxAgents.length === 0 ? (
              <div className="text-center py-6 text-gray-400">
                <p className="text-sm">No mailboxes found</p>
                <p className="text-xs mt-1">Mailbox repo path: {mailboxRepoPath}</p>
              </div>
            ) : (
              <div className="space-y-3">
                {mailboxAgents.map(agentId => {
                  const msgs = mailboxMessages[agentId] || [];
                  const byFolder: Record<string, Array<{ filename: string; folder: string }>> = {};
                  for (const m of msgs) {
                    const f = m.folder || 'normal';
                    if (!byFolder[f]) byFolder[f] = [];
                    byFolder[f].push(m);
                  }
                  return (
                    <div key={agentId} className="bg-gray-50 dark:bg-gray-700 rounded-lg p-3">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <Mail size={14} className="text-blue-500" />
                          <span className="font-medium text-sm">to_{agentId}</span>
                        </div>
                        <span className="text-xs text-gray-500">{msgs.length} message{msgs.length !== 1 ? 's' : ''}</span>
                      </div>
                      {msgs.length === 0 ? (
                        <p className="text-xs text-gray-400 italic">Empty mailbox</p>
                      ) : (
                        <div className="space-y-1">
                          {Object.entries(byFolder).map(([folder, folderMsgs]) => (
                            <div key={folder}>
                              <div className="text-xs text-gray-500 uppercase font-medium mb-0.5">{folder}</div>
                              {folderMsgs.slice(0, 3).map(m => (
                                <div key={m.filename} className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300 pl-2">
                                  <ChevronRight size={10} className="text-gray-400" />
                                  <span className="truncate">{m.filename}</span>
                                </div>
                              ))}
                              {folderMsgs.length > 3 && (
                                <div className="text-xs text-gray-400 pl-4">+{folderMsgs.length - 3} more</div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* A2A Protocol Status */}
        <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-4">
          <h2 className="font-semibold text-gray-700 dark:text-gray-200 mb-3 flex items-center gap-2">
            <Radio size={16} /> A2A Protocol
          </h2>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500 dark:text-gray-400">Server Status</span>
              {a2aServerStatus ? (
                <span className={`flex items-center gap-1.5 text-xs font-medium ${
                  a2aServerStatus.running
                    ? 'text-green-700 dark:text-green-400'
                    : 'text-gray-500 dark:text-gray-400'
                }`}>
                  <span className={`inline-block w-2 h-2 rounded-full ${a2aServerStatus.running ? 'bg-green-500' : 'bg-gray-400'}`} />
                  {a2aServerStatus.running ? `Running on :${a2aServerStatus.port}` : 'Not running'}
                </span>
              ) : (
                <span className="text-xs text-gray-400">Unknown</span>
              )}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500 dark:text-gray-400">Known Agents</span>
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{a2aDiscoveredCount}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500 dark:text-gray-400">Audit Entries</span>
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{a2aRecentAudit}</span>
            </div>
            {a2aRecentEntries.length > 0 && (
              <div className="border-t border-gray-100 dark:border-gray-700 pt-2">
                <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">Recent Activity</p>
                <div className="space-y-1">
                  {a2aRecentEntries.map((entry, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <span className={`px-1 py-0.5 rounded font-medium ${
                        entry.direction === 'inbound'
                          ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                          : 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'
                      }`}>
                        {entry.direction === 'inbound' ? '← In' : '→ Out'}
                      </span>
                      <span className="text-gray-600 dark:text-gray-300 font-mono truncate">{entry.method}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <a href="/a2a" className="block text-center text-xs text-blue-600 dark:text-blue-400 hover:underline mt-2">
              View A2A Protocol →
            </a>
          </div>
        </div>

        {/* Real-time Events */}
        <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-4 lg:col-span-2">
          <h2 className="font-semibold text-gray-700 dark:text-gray-200 mb-3">Real-time Events</h2>
          {recentEvents.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-4">
              Listening for file system changes...
            </p>
          ) : (
            <div className="max-h-60 overflow-auto space-y-1">
              {recentEvents.map((event, i) => (
                <div key={i} className="flex items-center gap-2 text-xs p-1.5 hover:bg-gray-50 dark:hover:bg-gray-700 rounded">
                  <span className="text-gray-400 w-20 flex-shrink-0">{event.time}</span>
                  <span className={`px-1.5 py-0.5 rounded text-xs ${
                    event.type === 'mailbox'
                      ? 'bg-blue-100 text-blue-700'
                      : event.type === 'task'
                      ? 'bg-green-100 text-green-700'
                      : event.type === 'log'
                      ? 'bg-gray-100 text-gray-700'
                      : 'bg-yellow-100 text-yellow-700'
                  }`}>
                    {event.type}
                  </span>
                  <span className="text-gray-600 truncate">{event.path.split('/').slice(-2).join('/')}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Agent Slide-out Panel */}
      {messagingAgent && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-black/30" onClick={() => setMessagingAgent(null)} />
          <div className="relative w-full max-w-md bg-white dark:bg-gray-800 shadow-xl border-l dark:border-gray-700 flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b dark:border-gray-700">
              <div>
                <h3 className="font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                  {slideoutTab === 'logs' ? <FileText size={16} /> : <MessageSquare size={16} />}
                  {messagingAgent.hostname}
                </h3>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {messagingAgent.role} · {messagingAgent.agentId}
                </p>
              </div>
              <button
                onClick={() => setMessagingAgent(null)}
                className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
              >
                <X size={18} className="text-gray-500" />
              </button>
            </div>

            {/* Tabs */}
            <div className="flex border-b dark:border-gray-700">
              <button
                onClick={() => setSlideoutTab('message')}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors ${
                  slideoutTab === 'message'
                    ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                <MessageSquare size={12} /> Message
              </button>
              <button
                onClick={() => { setSlideoutTab('logs'); loadAgentLogs(messagingAgent); }}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors ${
                  slideoutTab === 'logs'
                    ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                <FileText size={12} /> Logs
              </button>
            </div>

            {/* Agent Info */}
            <div className="p-4 border-b dark:border-gray-700 bg-gray-50 dark:bg-gray-900/30 text-xs space-y-1">
              {messagingAgent.description && (
                <p className="text-gray-600 dark:text-gray-400">{messagingAgent.description}</p>
              )}
              {messagingAgent.a2aUrl ? (
                <p className="text-blue-600 dark:text-blue-400 font-mono">{messagingAgent.a2aUrl}</p>
              ) : (
                <p className="text-gray-500 dark:text-gray-400">No A2A endpoint configured on this agent</p>
              )}
              {messagingAgent.workspacePath && (
                <div className="flex items-center gap-2 mt-1.5">
                  <p className="text-gray-500 dark:text-gray-400 font-mono truncate flex-1" title={messagingAgent.workspacePath}>
                    {messagingAgent.workspacePath}
                  </p>
                  {messagingAgent.workspacePath !== workspacePath && (
                    <button
                      onClick={() => {
                        setPathInput(messagingAgent.workspacePath!);
                        setWorkspacePath(messagingAgent.workspacePath!);
                        localStorage.setItem('agent-workspace', messagingAgent.workspacePath!);
                        const ctx = {
                          hostname: messagingAgent.hostname,
                          role: messagingAgent.role,
                          agentId: messagingAgent.agentId,
                          a2aUrl: messagingAgent.a2aUrl,
                          mailboxRepoPath: messagingAgent.mailboxRepoPath,
                        };
                        storeAgentContext(ctx);
                        setAgentContext(ctx);
                        setMessagingAgent(null);
                      }}
                      className="flex-shrink-0 px-2 py-1 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors"
                    >
                      Attach Workspace
                    </button>
                  )}
                  {messagingAgent.workspacePath === workspacePath && (
                    <span className="flex-shrink-0 text-xs text-green-600 dark:text-green-400">✓ attached</span>
                  )}
                </div>
              )}
              {messagingAgent.skills && messagingAgent.skills.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {messagingAgent.skills.map((s) => (
                    <span key={s.id} className="bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 px-1.5 py-0.5 rounded" title={s.description}>
                      {s.name}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {slideoutTab === 'message' && (
            <>
            {/* Message form + history */}
            <div className="flex-1 p-4 space-y-3 overflow-auto">
              {/* History for this agent */}
              {messageHistory.filter(m => m.to === messagingAgent.agentId).length > 0 && (
                <div className="space-y-1.5 mb-3 pb-3 border-b dark:border-gray-700">
                  <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Message History</p>
                  {messageHistory.filter(m => m.to === messagingAgent.agentId).slice(-5).map((msg, i) => (
                    <div key={i} className={`text-xs p-2 rounded ${
                      msg.status === 'sent'
                        ? 'bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800'
                        : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800'
                    }`}>
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="font-medium text-gray-700 dark:text-gray-300">{msg.subject}</span>
                        <span className="text-gray-400">{msg.time}</span>
                      </div>
                      <p className="text-gray-500 dark:text-gray-400 line-clamp-2">{msg.content}</p>
                    </div>
                  ))}
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Subject</label>
                <input
                  value={messageSubject}
                  onChange={(e) => setMessageSubject(e.target.value)}
                  placeholder="e.g. Work assignment"
                  className="input text-sm w-full"
                />
              </div>
              <div className="flex-1">
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Message</label>
                <textarea
                  value={messageContent}
                  onChange={(e) => setMessageContent(e.target.value)}
                  placeholder="Enter message content..."
                  rows={6}
                  className="input text-sm w-full resize-none"
                />
              </div>

              {messageSent && (
                <div className={`text-xs p-2 rounded ${
                  messageSent === 'success'
                    ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                    : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
                }`}>
                  {messageSent === 'success' ? 'Message sent successfully' : `Send failed: ${messageSent}`}
                </div>
              )}
            </div>

            {/* Send button */}
            <div className="p-4 border-t dark:border-gray-700">
              <button
                onClick={async () => {
                  if (!messagingAgent.a2aUrl || !messageContent.trim()) return;
                  setMessageSending(true);
                  setMessageSent(null);
                  const subject = messageSubject || 'Dashboard Message';
                  const content = messageContent;
                  try {
                    const result = await a2aApi.send(messagingAgent.a2aUrl, {
                      subject,
                      content,
                    });
                    const r = result as { success?: boolean };
                    const status = r.success ? 'sent' as const : 'failed' as const;
                    setMessageSent(r.success ? 'success' : 'Failed');
                    setMessageHistory(prev => [...prev, {
                      to: messagingAgent.agentId,
                      subject,
                      content,
                      time: new Date().toLocaleTimeString(),
                      status,
                    }]);
                    if (r.success) {
                      setMessageContent('');
                      setMessageSubject('');
                    }
                  } catch (err) {
                    setMessageSent(String(err));
                    setMessageHistory(prev => [...prev, {
                      to: messagingAgent.agentId,
                      subject,
                      content,
                      time: new Date().toLocaleTimeString(),
                      status: 'failed',
                    }]);
                  } finally {
                    setMessageSending(false);
                  }
                }}
                disabled={!messagingAgent.a2aUrl || !messageContent.trim() || messageSending}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
              >
                <Send size={14} />
                {messageSending ? 'Sending...' : 'Send Message'}
              </button>
            </div>
            </>
            )}

            {slideoutTab === 'logs' && (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2 border-b dark:border-gray-700 bg-gray-50 dark:bg-gray-900/30">
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {agentLogs.length > 0 ? `${agentLogs.length} lines` : 'No logs available'}
                </span>
                <button
                  onClick={() => loadAgentLogs(messagingAgent)}
                  disabled={agentLogsLoading}
                  className="flex items-center gap-1 px-2 py-1 text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 rounded disabled:opacity-50"
                >
                  <RefreshCw size={10} className={agentLogsLoading ? 'animate-spin' : ''} />
                  Refresh
                </button>
              </div>
              <div className="flex-1 overflow-auto p-2 font-mono text-xs leading-relaxed bg-gray-950 text-gray-300">
                {agentLogsLoading ? (
                  <div className="flex items-center justify-center py-8 text-gray-500">
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-500 mr-2" />
                    Loading logs…
                  </div>
                ) : agentLogs.length === 0 ? (
                  <div className="text-center py-8 text-gray-500">
                    <FileText size={24} className="mx-auto mb-2 opacity-50" />
                    <p>No logs found for this agent.</p>
                    <p className="text-gray-600 mt-1">Logs are available for locally-launched agents.</p>
                  </div>
                ) : (
                  agentLogs.map((line, i) => {
                    const isError = line.includes('[stderr]') || line.includes('ERROR') || line.includes('"level":50');
                    const isWarn = line.includes('WARN') || line.includes('"level":40');
                    return (
                      <div
                        key={i}
                        className={`whitespace-pre-wrap break-all py-0.5 px-1 rounded ${
                          isError ? 'text-red-400 bg-red-950/30' :
                          isWarn ? 'text-yellow-400 bg-yellow-950/20' :
                          ''
                        }`}
                      >
                        {line}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

function StatCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: number; color: string }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-4 flex items-center gap-3">
      {icon}
      <div>
        <div className="text-2xl font-bold text-gray-900 dark:text-white">{value}</div>
        <div className="text-xs text-gray-500">{label}</div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    idle: 'bg-gray-100 text-gray-700',
    working: 'bg-green-100 text-green-700',
    stuck: 'bg-yellow-100 text-yellow-700',
    escalated: 'bg-red-100 text-red-700',
    stopped: 'bg-red-50 text-red-400',
    unknown: 'bg-gray-100 text-gray-500',
  };
  return (
    <span className={`px-2 py-1 rounded-full text-xs font-medium ${colors[status] || colors.unknown}`}>
      {status}
    </span>
  );
}

function HealthIndicator({ health }: { health?: string }) {
  const config: Record<string, { color: string; label: string }> = {
    online: { color: 'text-green-500', label: 'Online' },
    degraded: { color: 'text-yellow-500', label: 'Degraded' },
    offline: { color: 'text-red-500', label: 'Offline' },
    unknown: { color: 'text-gray-400', label: 'Unknown' },
  };
  const { color, label } = config[health || 'unknown'] || config.unknown;
  return (
    <span title={label} className="flex-shrink-0">
      <Circle size={10} className={`${color} fill-current`} />
    </span>
  );
}

function TeamTopologyPanel({ agents, onSelectAgent }: { agents: DiscoveredAgent[]; onSelectAgent?: (agent: DiscoveredAgent) => void }) {
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  // Build nodes and edges from discovered agents and their teamMembers
  const nodeMap = new Map<string, { id: string; hostname: string; role: string; health?: string; isDiscovered: boolean }>();
  const edges: Array<{ from: string; to: string }> = [];

  for (const agent of agents) {
    nodeMap.set(agent.agentId, {
      id: agent.agentId,
      hostname: agent.hostname,
      role: agent.role,
      health: agent.health,
      isDiscovered: true,
    });
    if (agent.teamMembers) {
      for (const member of agent.teamMembers) {
        // member.hostname is already the agentId (e.g. "pcw5860_developer")
        const memberId = member.hostname;
        if (!nodeMap.has(memberId)) {
          nodeMap.set(memberId, { id: memberId, hostname: member.hostname, role: member.role, isDiscovered: false });
        }
        // Add edge: this agent knows about member
        edges.push({ from: agent.agentId, to: memberId });
      }
    }
  }

  const nodes = Array.from(nodeMap.values());
  if (nodes.length < 2) return null;

  // Layout: circular arrangement
  const width = 500;
  const height = 280;
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(cx, cy) - 50;
  const positions = new Map<string, { x: number; y: number }>();

  nodes.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
    positions.set(node.id, {
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
    });
  });

  const healthColors: Record<string, string> = {
    online: '#22c55e',
    degraded: '#eab308',
    offline: '#ef4444',
    unknown: '#9ca3af',
  };

  const roleColors: Record<string, string> = {
    developer: '#3b82f6',
    qa: '#8b5cf6',
    manager: '#f59e0b',
    'requirements-analyst': '#06b6d4',
    researcher: '#10b981',
  };

  // Deduplicate edges
  const edgeSet = new Set(edges.map(e => [e.from, e.to].sort().join('|')));
  const uniqueEdges = Array.from(edgeSet).map(key => {
    const [from, to] = key.split('|');
    return { from, to };
  });

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-4 lg:col-span-2">
      <h2 className="font-semibold text-gray-700 dark:text-gray-200 mb-3 flex items-center gap-2">
        <GitBranch size={16} /> Team Topology
        <span className="text-xs font-normal text-gray-400">({nodes.length} agents)</span>
      </h2>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ maxHeight: '300px' }}>
        {/* Edges */}
        {uniqueEdges.map((edge, i) => {
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          if (!from || !to) return null;
          const isHighlighted = hoveredNode === edge.from || hoveredNode === edge.to
            || selectedNode === edge.from || selectedNode === edge.to;
          return (
            <line
              key={i}
              x1={from.x} y1={from.y}
              x2={to.x} y2={to.y}
              stroke={isHighlighted ? '#3b82f6' : 'currentColor'}
              className={isHighlighted ? '' : 'text-gray-300 dark:text-gray-600'}
              strokeWidth={isHighlighted ? 2.5 : 1.5}
              strokeDasharray={isHighlighted ? undefined : '4,3'}
              style={{ transition: 'stroke-width 0.15s, stroke 0.15s' }}
            />
          );
        })}
        {/* Nodes */}
        {nodes.map((node) => {
          const pos = positions.get(node.id);
          if (!pos) return null;
          const fill = roleColors[node.role] || '#6b7280';
          const healthColor = healthColors[node.health || 'unknown'];
          const isHovered = hoveredNode === node.id;
          const isSelected = selectedNode === node.id;
          const isActive = isHovered || isSelected;
          const scale = isActive ? 1.15 : 1;
          const discoveredAgent = node.isDiscovered ? agents.find(a => a.agentId === node.id) : undefined;
          return (
            <g
              key={node.id}
              style={{ cursor: node.isDiscovered ? 'pointer' : 'default', transition: 'transform 0.15s' }}
              transform={`translate(${pos.x},${pos.y}) scale(${scale}) translate(${-pos.x},${-pos.y})`}
              onMouseEnter={() => setHoveredNode(node.id)}
              onMouseLeave={() => setHoveredNode(null)}
              onClick={() => {
                setSelectedNode(prev => prev === node.id ? null : node.id);
                if (discoveredAgent && onSelectAgent) {
                  onSelectAgent(discoveredAgent);
                }
              }}
            >
              <circle cx={pos.x} cy={pos.y} r={22} fill={fill} opacity={isActive ? 0.25 : 0.15} />
              <circle cx={pos.x} cy={pos.y} r={18} fill={fill} opacity={0.9}
                      stroke={isSelected ? '#fff' : 'none'} strokeWidth={isSelected ? 2 : 0} />
              <text x={pos.x} y={pos.y + 1} textAnchor="middle" dominantBaseline="middle"
                    fill="white" fontSize={9} fontWeight="bold" style={{ pointerEvents: 'none' }}>
                {node.role.slice(0, 3).toUpperCase()}
              </text>
              {/* Health dot */}
              <circle cx={pos.x + 14} cy={pos.y - 14} r={5} fill={healthColor} stroke="white" strokeWidth={1.5} />
              {/* Label */}
              <text x={pos.x} y={pos.y + 34} textAnchor="middle" fontSize={10}
                    className="fill-gray-600 dark:fill-gray-400" style={{ pointerEvents: 'none' }}>
                {node.hostname}
              </text>
              {/* Tooltip on hover */}
              {isHovered && (
                <g>
                  <rect
                    x={pos.x - 80} y={pos.y - 62} width={160} height={40} rx={6}
                    fill="rgba(0,0,0,0.85)" stroke="none"
                  />
                  <text x={pos.x} y={pos.y - 48} textAnchor="middle" fill="white" fontSize={10} fontWeight="600">
                    {node.hostname} ({node.role})
                  </text>
                  <text x={pos.x} y={pos.y - 34} textAnchor="middle" fill="#9ca3af" fontSize={9}>
                    {node.health || 'unknown'}{node.isDiscovered ? '' : ' · indirect'}
                    {discoveredAgent?.a2aUrl ? ' · click to message' : ''}
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function HealthSparkline({ points }: { points: Array<{ time: string; health: string }> }) {
  // Render a compact SVG sparkline showing health over time
  const width = 120;
  const height = 16;
  const barWidth = Math.max(1, Math.min(3, width / points.length));
  const healthColorMap: Record<string, string> = {
    online: '#22c55e',
    degraded: '#eab308',
    offline: '#ef4444',
    unknown: '#d1d5db',
  };

  return (
    <div className="mt-1.5 flex items-center gap-1.5" title={`Health history: ${points.length} checks`}>
      <svg width={width} height={height} className="flex-shrink-0">
        {points.map((p, i) => (
          <rect
            key={i}
            x={i * (width / points.length)}
            y={0}
            width={barWidth}
            height={height}
            fill={healthColorMap[p.health] || healthColorMap.unknown}
            rx={1}
          />
        ))}
      </svg>
      <span className="text-xs text-gray-400 flex-shrink-0">
        {points.filter(p => p.health === 'online').length}/{points.length}
      </span>
    </div>
  );
}
