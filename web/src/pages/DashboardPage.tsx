import { useState, useEffect, useCallback } from 'react';
import { agentsApi, mailboxApi } from '../lib/api';
import { onFileChange } from '../lib/socket';
import { Activity, CheckCircle, AlertTriangle, Clock, Inbox, XCircle, FolderOpen, X, Mail, ChevronRight } from 'lucide-react';

function getStoredWorkspace(): string {
  return localStorage.getItem('agent-workspace') || '';
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
  const [showAttach, setShowAttach] = useState(false);
  const [pathInput, setPathInput] = useState(workspacePath);
  const [mailboxRepoPath, setMailboxRepoPath] = useState<string>('');
  const [mailboxAgents, setMailboxAgents] = useState<string[]>([]);
  const [mailboxMessages, setMailboxMessages] = useState<Record<string, Array<{ filename: string; folder: string }>>>({});
  const [agentConfig, setAgentConfig] = useState<Record<string, unknown> | null>(null);

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
    } catch { /* ignore */ }
  }, [workspacePath]);

  useEffect(() => {
    loadData();
    const unsub = onFileChange((data) => {
      setRecentEvents(prev => [
        { ...data, time: new Date().toLocaleTimeString() },
        ...prev.slice(0, 49),
      ]);
      if (data.type === 'task' || data.type === 'mailbox') {
        loadData();
      }
    });
    const interval = setInterval(loadData, 30000);
    return () => {
      unsub();
      clearInterval(interval);
    };
  }, [loadData]);

  const attachWorkspace = () => {
    const path = pathInput.trim();
    setWorkspacePath(path);
    if (path) {
      localStorage.setItem('agent-workspace', path);
    } else {
      localStorage.removeItem('agent-workspace');
    }
    setShowAttach(false);
  };

  const detachWorkspace = () => {
    setWorkspacePath('');
    setPathInput('');
    localStorage.removeItem('agent-workspace');
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
              {workspacePath.split('/').slice(-2).join('/')}
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
        {/* Agent Status */}
        <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-4">
          <h2 className="font-semibold text-gray-700 dark:text-gray-200 mb-3 flex items-center gap-2">
            <Activity size={16} /> Agent Status
          </h2>
          {agents.length === 0 ? (
            <div className="text-center py-8 text-gray-400">
              <p className="text-sm">No active agents detected</p>
              <p className="text-xs mt-1">Start an agent to see status here</p>
            </div>
          ) : (
            <div className="space-y-2">
              {agents.map((agent: any, i) => (
                <div key={i} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                  <div>
                    <div className="font-medium text-sm">{agent.agentId}</div>
                    <div className="text-xs text-gray-500">
                      Processed: {agent.messagesProcessed} messages
                    </div>
                  </div>
                  <StatusBadge status={agent.status} />
                </div>
              ))}
            </div>
          )}
        </div>

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
    </div>
  );
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
    unknown: 'bg-gray-100 text-gray-500',
  };
  return (
    <span className={`px-2 py-1 rounded-full text-xs font-medium ${colors[status] || colors.unknown}`}>
      {status}
    </span>
  );
}
