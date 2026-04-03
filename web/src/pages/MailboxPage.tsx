import { useState, useEffect } from 'react';
import { mailboxApi } from '../lib/api';
import { Send, RefreshCw, Mail, ChevronRight } from 'lucide-react';

const PRIORITIES = ['HIGH', 'NORMAL', 'LOW'];
const MSG_TYPES = ['unstructured', 'workflow', 'oob', 'status'];

export default function MailboxPage() {
  const [agents, setAgents] = useState<string[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [messages, setMessages] = useState<Array<{ filename: string; folder: string }>>([]);
  const [messageContent, setMessageContent] = useState<string | null>(null);
  const [showComposer, setShowComposer] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const [newMsg, setNewMsg] = useState({
    from: '',
    subject: '',
    priority: 'NORMAL',
    messageType: 'unstructured',
    body: '',
    to: '',
  });

  useEffect(() => {
    loadAgents();
  }, []);

  const loadAgents = async () => {
    try {
      const data = await mailboxApi.listAgents();
      setAgents(data.agents);
    } catch { /* ignore */ }
  };

  const loadMessages = async (agentId: string) => {
    setSelectedAgent(agentId);
    setMessageContent(null);
    try {
      const data = await mailboxApi.listMessages(agentId);
      setMessages(data.messages);
    } catch { setMessages([]); }
  };

  const readMessage = async (agentId: string, filename: string) => {
    try {
      const data = await mailboxApi.readMessage(agentId, filename);
      setMessageContent(data.content);
    } catch {
      setMessageContent('(Failed to read message)');
    }
  };

  const sendMessage = async () => {
    if (!newMsg.to || !newMsg.from || !newMsg.subject || !newMsg.body) {
      setStatus('All fields required');
      return;
    }
    try {
      await mailboxApi.sendMessage(newMsg.to, {
        from: newMsg.from,
        subject: newMsg.subject,
        priority: newMsg.priority,
        messageType: newMsg.messageType,
        body: newMsg.body,
      });
      setStatus('Message sent!');
      setShowComposer(false);
      setNewMsg({ from: '', subject: '', priority: 'NORMAL', messageType: 'unstructured', body: '', to: '' });
      if (selectedAgent === newMsg.to) loadMessages(newMsg.to);
      setTimeout(() => setStatus(null), 3000);
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Mailbox</h1>
        <div className="flex gap-2">
          <button onClick={loadAgents} className="flex items-center gap-1 px-3 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600 text-sm">
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
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-6">
          <h3 className="font-semibold text-sm mb-3">Compose Message</h3>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <input value={newMsg.to} onChange={(e) => setNewMsg(prev => ({ ...prev, to: e.target.value }))} placeholder="To (agent ID, e.g. dev-server-1_developer)" className="input text-sm" />
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
        </div>
      )}

      <div className="flex gap-4" style={{ minHeight: '60vh' }}>
        {/* Agent list */}
        <div className="w-64 bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 overflow-auto">
          <div className="p-3 border-b bg-gray-50">
            <span className="text-sm font-medium text-gray-600">Agent Mailboxes</span>
          </div>
          {agents.length === 0 ? (
            <p className="p-3 text-sm text-gray-400">No mailboxes found</p>
          ) : (
            agents.map(a => (
              <button
                key={a}
                onClick={() => loadMessages(a)}
                className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-gray-50 ${
                  selectedAgent === a ? 'bg-blue-50 text-blue-700' : 'text-gray-700'
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
              {selectedAgent ? `Messages for ${selectedAgent}` : 'Select an agent'}
            </span>
          </div>
          {messages.length === 0 ? (
            <p className="p-3 text-sm text-gray-400">
              {selectedAgent ? 'No messages' : 'Select an agent to view messages'}
            </p>
          ) : (
            messages.map(m => (
              <button
                key={m.filename}
                onClick={() => selectedAgent && readMessage(selectedAgent, m.filename)}
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
          {messageContent ? (
            <pre className="p-4 text-sm font-mono whitespace-pre-wrap text-gray-700">
              {messageContent}
            </pre>
          ) : (
            <p className="p-4 text-sm text-gray-400">Select a message to view</p>
          )}
        </div>
      </div>
    </div>
  );
}
