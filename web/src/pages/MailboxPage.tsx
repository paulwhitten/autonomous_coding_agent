import { useState, useEffect, useCallback } from 'react';
import { mailboxApi, a2aApi, workflowApi, fetchA2A, getAgentContext, agentsApi } from '../lib/api';
import { Send, RefreshCw, Mail, ChevronRight, Radio, Archive, Users, Workflow } from 'lucide-react';

const PRIORITIES = ['HIGH', 'NORMAL', 'LOW'];
const MSG_TYPES = ['unstructured', 'workflow', 'oob', 'status'];

interface A2AMessage {
  from: string;
  subject: string;
  priority: string;
  date: string;
  body: string;
}

export default function MailboxPage() {
  const [messages, setMessages] = useState<A2AMessage[]>([]);
  const [archivedMessages, setArchivedMessages] = useState<A2AMessage[]>([]);
  const [selectedMessage, setSelectedMessage] = useState<A2AMessage | null>(null);
  const [showComposer, setShowComposer] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dataSource, setDataSource] = useState<'a2a' | 'filesystem' | null>(null);
  const [mailboxTab, setMailboxTab] = useState<'inbox' | 'archive'>('inbox');
  const [autoRefresh, setAutoRefresh] = useState(false);

  // Discovered agents for recipient picker
  interface DiscoveredTarget { agentId: string; hostname: string; role: string; a2aUrl?: string }
  const [discoveredTargets, setDiscoveredTargets] = useState<DiscoveredTarget[]>([]);

  // --- Legacy filesystem state (fallback when no A2A URL) ---
  const [legacyAgents, setLegacyAgents] = useState<string[]>([]);
  const [selectedLegacyAgent, setSelectedLegacyAgent] = useState<string | null>(null);
  const [legacyMessages, setLegacyMessages] = useState<Array<{ filename: string; folder: string }>>([]);
  const [legacyContent, setLegacyContent] = useState<string | null>(null);

  const agentContext = getAgentContext();
  const a2aUrl = agentContext?.a2aUrl;
  const repoPath = agentContext?.mailboxRepoPath;

  const [newMsg, setNewMsg] = useState({
    from: agentContext?.agentId || '',
    subject: '',
    priority: 'NORMAL',
    messageType: 'unstructured',
    body: '',
    to: '',
  });

  // Workflow composer state
  const [composerMode, setComposerMode] = useState<'message' | 'workflow'>('message');
  interface WorkflowOption { file: string; id: string; name: string; description: string }
  const [workflows, setWorkflows] = useState<WorkflowOption[]>([]);
  const [workflowTask, setWorkflowTask] = useState({
    workflowFile: '',
    targetAgent: '',
    taskId: '',
    taskTitle: '',
    taskDescription: '',
    acceptanceCriteria: '',
  });

  useEffect(() => {
    if (a2aUrl) {
      setDataSource('a2a');
      loadA2AMessages();
    } else {
      setDataSource('filesystem');
      loadLegacyAgents();
    }
    // Load discovered agents for the recipient picker
    agentsApi.discovered().then(data => {
      setDiscoveredTargets(data.agents.map(a => ({ agentId: a.agentId, hostname: a.hostname, role: a.role, a2aUrl: a.a2aUrl })));
    }).catch(() => {});
    // Load workflows for the workflow composer
    workflowApi.list().then(data => setWorkflows(data.workflows as unknown as WorkflowOption[])).catch(() => {});
  }, []);

  // Auto-refresh effect (A2A only)
  useEffect(() => {
    if (!autoRefresh || dataSource !== 'a2a') return;
    const interval = setInterval(loadA2AMessages, 10_000);
    return () => clearInterval(interval);
  }, [autoRefresh, dataSource]);

  // --- A2A-based data loading ---
  const loadA2AMessages = async () => {
    if (!a2aUrl) return;
    setLoading(true);
    try {
      const [inboxData, archiveData] = await Promise.all([
        fetchA2A<{ messages: A2AMessage[] }>(a2aUrl, '/a2a/mailbox'),
        fetchA2A<{ messages: A2AMessage[] }>(a2aUrl, '/a2a/archive').catch(() => ({ messages: [] })),
      ]);
      setMessages(inboxData.messages || []);
      setArchivedMessages(archiveData.messages || []);
    } catch {
      setMessages([]);
      setArchivedMessages([]);
    } finally {
      setLoading(false);
    }
  };

  // --- Legacy filesystem loading ---
  const loadLegacyAgents = async () => {
    try {
      const data = await mailboxApi.listAgents(repoPath);
      setLegacyAgents(data.agents);
    } catch { /* ignore */ }
  };

  const loadLegacyMessages = async (agentId: string) => {
    setSelectedLegacyAgent(agentId);
    setLegacyContent(null);
    try {
      const data = await mailboxApi.listMessages(agentId, repoPath);
      setLegacyMessages(data.messages);
    } catch { setLegacyMessages([]); }
  };

  const readLegacyMessage = async (agentId: string, filename: string) => {
    try {
      const data = await mailboxApi.readMessage(agentId, filename, repoPath);
      setLegacyContent(data.content);
    } catch {
      setLegacyContent('(Failed to read message)');
    }
  };

  // --- Send message (A2A or filesystem) ---
  const sendMessage = async () => {
    if (!newMsg.to || !newMsg.from || !newMsg.subject || !newMsg.body) {
      setStatus('All fields required');
      return;
    }
    try {
      if (a2aUrl) {
        // Send via A2A JSON-RPC through the local API proxy
        await a2aApi.send(a2aUrl, {
          subject: newMsg.subject,
          content: newMsg.body,
          priority: newMsg.priority,
        });
      } else {
        await mailboxApi.sendMessage(newMsg.to, {
          from: newMsg.from,
          subject: newMsg.subject,
          priority: newMsg.priority,
          messageType: newMsg.messageType,
          body: newMsg.body,
        }, repoPath);
      }
      setStatus('Message sent!');
      setShowComposer(false);
      setNewMsg({ from: agentContext?.agentId || '', subject: '', priority: 'NORMAL', messageType: 'unstructured', body: '', to: '' });
      if (a2aUrl) loadA2AMessages();
      setTimeout(() => setStatus(null), 3000);
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
    }
  };

  const sendWorkflowTask = async () => {
    const { workflowFile, targetAgent, taskId, taskTitle } = workflowTask;
    if (!workflowFile || !targetAgent || !taskId || !taskTitle) {
      setStatus('Required: workflow, target agent, task ID, task title');
      return;
    }
    try {
      const result = await workflowApi.startTask(workflowFile, {
        targetAgent,
        taskId,
        taskTitle,
        taskDescription: workflowTask.taskDescription || undefined,
        acceptanceCriteria: workflowTask.acceptanceCriteria || undefined,
        from: agentContext?.agentId || 'ui-orchestrator',
        repoPath: agentContext?.mailboxRepoPath || undefined,
      });
      setStatus(`Workflow task sent! ${result.assignment.workflowId}/${result.assignment.taskId} → ${result.assignment.targetAgent} (${result.assignment.targetState})`);
      setShowComposer(false);
      setWorkflowTask({ workflowFile: '', targetAgent: '', taskId: '', taskTitle: '', taskDescription: '', acceptanceCriteria: '' });
      if (a2aUrl) loadA2AMessages();
      setTimeout(() => setStatus(null), 5000);
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
    }
  };

  const refresh = () => {
    if (dataSource === 'a2a') loadA2AMessages();
    else loadLegacyAgents();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Mailbox</h1>
          {agentContext ? (
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
              {agentContext.hostname} ({agentContext.role})
              {dataSource === 'a2a' && (
                <span className="ml-2 inline-flex items-center gap-1 text-blue-500">
                  <Radio size={12} /> A2A
                </span>
              )}
            </p>
          ) : (
            <p className="text-sm text-amber-600 dark:text-amber-400 mt-0.5">
              No agent attached — select an agent on the Dashboard first
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {dataSource === 'a2a' && (
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
          <button onClick={refresh} className="flex items-center gap-1 px-3 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600 text-sm">
            <RefreshCw size={14} /> Refresh
          </button>
          <button onClick={() => setShowComposer(!showComposer)} className="flex items-center gap-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">
            <Send size={14} /> Compose
          </button>
        </div>
      </div>

      {status && (
        <div className={`mb-4 p-3 rounded-lg text-sm ${status.startsWith('Error') ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
          {status}
        </div>
      )}

      {/* Composer */}
      {showComposer && (
        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl p-4 mb-6">
          {/* Mode tabs */}
          <div className="flex gap-1 mb-3">
            <button
              onClick={() => setComposerMode('message')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium ${composerMode === 'message' ? 'bg-blue-600 text-white' : 'bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300'}`}
            >
              <Mail size={12} className="inline mr-1" /> Message
            </button>
            <button
              onClick={() => setComposerMode('workflow')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium ${composerMode === 'workflow' ? 'bg-purple-600 text-white' : 'bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300'}`}
            >
              <Workflow size={12} className="inline mr-1" /> Workflow Task
            </button>
          </div>

          {composerMode === 'message' && (
            <>
              <h3 className="font-semibold text-sm mb-3">Compose Message</h3>
          <div className="grid grid-cols-2 gap-3 mb-3">
            {/* Recipient picker: dropdown of discovered agents + manual fallback */}
            <div className="relative">
              {discoveredTargets.length > 0 ? (
                <select
                  value={newMsg.to}
                  onChange={(e) => setNewMsg(prev => ({ ...prev, to: e.target.value }))}
                  className="input text-sm w-full"
                >
                  <option value="">Select recipient…</option>
                  {discoveredTargets.map(a => (
                    <option key={a.agentId} value={a.agentId}>
                      {a.hostname} ({a.role})
                    </option>
                  ))}
                  <option value="__manual__">Manual entry…</option>
                </select>
              ) : (
                <input value={newMsg.to} onChange={(e) => setNewMsg(prev => ({ ...prev, to: e.target.value }))} placeholder="To (agent ID)" className="input text-sm w-full" />
              )}
              {newMsg.to === '__manual__' && (
                <input
                  value=""
                  onChange={(e) => setNewMsg(prev => ({ ...prev, to: e.target.value }))}
                  placeholder="Enter agent ID manually"
                  className="input text-sm w-full mt-1"
                  autoFocus
                />
              )}
            </div>
            <input value={newMsg.from} onChange={(e) => setNewMsg(prev => ({ ...prev, from: e.target.value }))} placeholder="From (your agent ID)" className="input text-sm" />
            <input value={newMsg.subject} onChange={(e) => setNewMsg(prev => ({ ...prev, subject: e.target.value }))} placeholder="Subject" className="input text-sm" />
            <div className="flex gap-2">
              <select value={newMsg.priority} onChange={(e) => setNewMsg(prev => ({ ...prev, priority: e.target.value }))} className="input text-sm">
                {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
              <select value={newMsg.messageType} onChange={(e) => setNewMsg(prev => ({ ...prev, messageType: e.target.value }))} className="input text-sm">
                {MSG_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <textarea
            value={newMsg.body}
            onChange={(e) => setNewMsg(prev => ({ ...prev, body: e.target.value }))}
            placeholder="Message body..."
            className="input text-sm h-32 w-full font-mono"
          />
          <div className="flex justify-end gap-2 mt-3">
            <button onClick={() => setShowComposer(false)} className="px-3 py-1.5 bg-gray-200 rounded text-sm hover:bg-gray-300">Cancel</button>
            <button onClick={sendMessage} className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">Send</button>
          </div>
            </>
          )}

          {composerMode === 'workflow' && (
            <>
              <h3 className="font-semibold text-sm mb-3 text-purple-700 dark:text-purple-300">Send Workflow Task</h3>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Workflow</label>
                  <select
                    value={workflowTask.workflowFile}
                    onChange={(e) => setWorkflowTask(prev => ({ ...prev, workflowFile: e.target.value }))}
                    className="input text-sm w-full"
                  >
                    <option value="">Select workflow...</option>
                    {workflows.map(w => (
                      <option key={w.file} value={w.file}>{w.name || w.file}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Target Agent</label>
                  {discoveredTargets.length > 0 ? (
                    <select
                      value={workflowTask.targetAgent}
                      onChange={(e) => setWorkflowTask(prev => ({ ...prev, targetAgent: e.target.value }))}
                      className="input text-sm w-full"
                    >
                      <option value="">Select agent...</option>
                      {discoveredTargets.map(a => (
                        <option key={a.agentId} value={a.agentId}>{a.hostname} ({a.role})</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={workflowTask.targetAgent}
                      onChange={(e) => setWorkflowTask(prev => ({ ...prev, targetAgent: e.target.value }))}
                      placeholder="agent_hostname_role"
                      className="input text-sm w-full"
                    />
                  )}
                </div>
                <div>
                  <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Task ID</label>
                  <input
                    value={workflowTask.taskId}
                    onChange={(e) => setWorkflowTask(prev => ({ ...prev, taskId: e.target.value }))}
                    placeholder="e.g. TASK-001"
                    className="input text-sm w-full"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Task Title</label>
                  <input
                    value={workflowTask.taskTitle}
                    onChange={(e) => setWorkflowTask(prev => ({ ...prev, taskTitle: e.target.value }))}
                    placeholder="Short task title"
                    className="input text-sm w-full"
                  />
                </div>
              </div>
              <div className="space-y-3 mb-3">
                <div>
                  <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Task Description</label>
                  <textarea
                    value={workflowTask.taskDescription}
                    onChange={(e) => setWorkflowTask(prev => ({ ...prev, taskDescription: e.target.value }))}
                    placeholder="Detailed task description..."
                    className="input text-sm h-20 w-full font-mono"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Acceptance Criteria</label>
                  <textarea
                    value={workflowTask.acceptanceCriteria}
                    onChange={(e) => setWorkflowTask(prev => ({ ...prev, acceptanceCriteria: e.target.value }))}
                    placeholder="- Criterion 1&#10;- Criterion 2"
                    className="input text-sm h-20 w-full font-mono"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => setShowComposer(false)} className="px-3 py-1.5 bg-gray-200 rounded text-sm hover:bg-gray-300 dark:bg-gray-600 dark:text-gray-200">Cancel</button>
                <button onClick={sendWorkflowTask} className="px-3 py-1.5 bg-purple-600 text-white rounded text-sm hover:bg-purple-700">Send Workflow Task</button>
              </div>
            </>
          )}
        </div>
      )}

      {/* A2A message view */}
      {dataSource === 'a2a' && (
        <div className="flex gap-4" style={{ minHeight: '60vh' }}>
          {/* Message list */}
          <div className="w-80 bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 overflow-auto">
            {/* Inbox / Archive tabs */}
            <div className="flex border-b dark:border-gray-700">
              <button
                onClick={() => { setMailboxTab('inbox'); setSelectedMessage(null); }}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors ${
                  mailboxTab === 'inbox'
                    ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400 bg-gray-50 dark:bg-gray-700'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700'
                }`}
              >
                <Mail size={12} /> Inbox ({messages.length})
              </button>
              <button
                onClick={() => { setMailboxTab('archive'); setSelectedMessage(null); }}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors ${
                  mailboxTab === 'archive'
                    ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400 bg-gray-50 dark:bg-gray-700'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700'
                }`}
              >
                <Archive size={12} /> Processed ({archivedMessages.length})
              </button>
            </div>
            {(() => {
              const displayMessages = mailboxTab === 'inbox' ? messages : archivedMessages;
              if (loading) return <p className="p-3 text-sm text-gray-400">Loading...</p>;
              if (displayMessages.length === 0) return <p className="p-3 text-sm text-gray-400">{mailboxTab === 'inbox' ? 'No pending messages' : 'No processed messages'}</p>;
              return displayMessages.map((m, i) => (
                <button
                  key={`${m.date}-${i}`}
                  onClick={() => setSelectedMessage(m)}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-700 border-b dark:border-gray-700 ${
                    selectedMessage === m ? 'bg-blue-50 dark:bg-blue-900/30' : ''
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-gray-700 dark:text-gray-200 truncate" style={{ maxWidth: '200px' }}>
                      {m.subject || '(no subject)'}
                    </span>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      m.priority === 'HIGH' ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400' :
                      m.priority === 'LOW' ? 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400' :
                      'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400'
                    }`}>
                      {m.priority}
                    </span>
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    from {m.from} · {new Date(m.date).toLocaleString()}
                  </div>
                </button>
              ));
            })()}
          </div>

          {/* Message content */}
          <div className="flex-1 bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 overflow-auto">
            <div className="p-3 border-b bg-gray-50 dark:bg-gray-700">
              <span className="text-sm font-medium text-gray-600 dark:text-gray-300">
                {selectedMessage ? selectedMessage.subject : 'Message Content'}
              </span>
            </div>
            {selectedMessage ? (
              <div className="p-4">
                <div className="flex gap-4 text-xs text-gray-500 dark:text-gray-400 mb-3 pb-3 border-b dark:border-gray-700">
                  <span>From: <strong>{selectedMessage.from}</strong></span>
                  <span>Priority: <strong>{selectedMessage.priority}</strong></span>
                  <span>{new Date(selectedMessage.date).toLocaleString()}</span>
                  {mailboxTab === 'archive' && (
                    <span className="text-green-500">✓ Processed</span>
                  )}
                </div>
                <pre className="text-sm font-mono whitespace-pre-wrap text-gray-700 dark:text-gray-300">
                  {selectedMessage.body}
                </pre>
              </div>
            ) : (
              <p className="p-4 text-sm text-gray-400">Select a message to view</p>
            )}
          </div>
        </div>
      )}

      {/* Legacy filesystem view */}
      {dataSource === 'filesystem' && (
        <div className="flex gap-4" style={{ minHeight: '60vh' }}>
          {/* Agent list */}
          <div className="w-64 bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 overflow-auto">
            <div className="p-3 border-b bg-gray-50">
              <span className="text-sm font-medium text-gray-600">Agent Mailboxes</span>
            </div>
            {legacyAgents.length === 0 ? (
              <p className="p-3 text-sm text-gray-400">No mailboxes found</p>
            ) : (
              legacyAgents.map(a => (
                <button
                  key={a}
                  onClick={() => loadLegacyMessages(a)}
                  className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-gray-50 ${
                    selectedLegacyAgent === a ? 'bg-blue-50 text-blue-700' : 'text-gray-700'
                  }`}
                >
                  <Mail size={14} /> {a}
                </button>
              ))
            )}
          </div>

          {/* Message list */}
          <div className="w-72 bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 overflow-auto">
            <div className="p-3 border-b bg-gray-50">
              <span className="text-sm font-medium text-gray-600">
                {selectedLegacyAgent ? `Messages for ${selectedLegacyAgent}` : 'Select an agent'}
              </span>
            </div>
            {legacyMessages.length === 0 ? (
              <p className="p-3 text-sm text-gray-400">
                {selectedLegacyAgent ? 'No messages' : 'Select an agent to view messages'}
              </p>
            ) : (
              legacyMessages.map(m => (
                <button
                  key={m.filename}
                  onClick={() => selectedLegacyAgent && readLegacyMessage(selectedLegacyAgent, m.filename)}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 border-b flex items-center justify-between"
                >
                  <div>
                    <div className="text-gray-700 truncate" style={{ maxWidth: '200px' }}>{m.filename}</div>
                    <div className="text-xs text-gray-400">{m.folder}</div>
                  </div>
                  <ChevronRight size={14} className="text-gray-300" />
                </button>
              ))
            )}
          </div>

          {/* Message content */}
          <div className="flex-1 bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 overflow-auto">
            <div className="p-3 border-b bg-gray-50">
              <span className="text-sm font-medium text-gray-600">Message Content</span>
            </div>
            {legacyContent ? (
              <pre className="p-4 text-sm font-mono whitespace-pre-wrap text-gray-700">
                {legacyContent}
              </pre>
            ) : (
              <p className="p-4 text-sm text-gray-400">Select a message to view</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
