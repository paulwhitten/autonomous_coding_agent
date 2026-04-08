import { useState, useEffect, useCallback, useRef } from 'react';
import { Play, Square, Trash2, RefreshCw, Terminal } from 'lucide-react';
import { getSocket } from '../lib/socket';

const API_BASE = '/api';

interface AgentProcess {
  id: string;
  configFile: string;
  pid: number;
  startedAt: string;
  status: 'running' | 'stopped' | 'error';
  exitCode: number | null;
  recentOutput: string[];
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const apiKey = localStorage.getItem('agent-api-key');
  if (apiKey) headers['X-API-Key'] = apiKey;
  const res = await fetch(`${API_BASE}${path}`, { headers, ...options });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export default function ProcessesPage() {
  const [processes, setProcesses] = useState<AgentProcess[]>([]);
  const [configs, setConfigs] = useState<string[]>([]);
  const [selectedConfig, setSelectedConfig] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [output, setOutput] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await request<{ processes: AgentProcess[] }>('/processes');
      setProcesses(data.processes);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
    request<{ configs: string[] }>('/processes/configs').then(d => setConfigs(d.configs)).catch(() => {});

    // Real-time streaming via Socket.io
    const socket = getSocket();
    const onOutput = (data: { id: string; line: string }) => {
      setExpandedId(prev => {
        if (prev === data.id) {
          setOutput(o => [...o.slice(-199), data.line]);
        }
        return prev;
      });
      // Update recentOutput in process list
      setProcesses(procs => procs.map(p =>
        p.id === data.id
          ? { ...p, recentOutput: [...p.recentOutput.slice(-19), data.line] }
          : p
      ));
    };
    const onExit = (data: { id: string; code: number; status: string }) => {
      setProcesses(procs => procs.map(p =>
        p.id === data.id
          ? { ...p, status: data.status as AgentProcess['status'], exitCode: data.code }
          : p
      ));
    };
    const onError = (data: { id: string; error: string }) => {
      setProcesses(procs => procs.map(p =>
        p.id === data.id ? { ...p, status: 'error' as const } : p
      ));
      setOutput(o => [...o, `[error] ${data.error}`]);
    };

    socket.on('process:output', onOutput);
    socket.on('process:exit', onExit);
    socket.on('process:error', onError);

    // Fallback poll every 30s (in case of reconnection)
    const interval = setInterval(refresh, 30000);

    return () => {
      socket.off('process:output', onOutput);
      socket.off('process:exit', onExit);
      socket.off('process:error', onError);
      clearInterval(interval);
    };
  }, [refresh]);

  // Auto-scroll output to bottom
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  const startProcess = async () => {
    if (!selectedConfig) return;
    try {
      setError(null);
      await request('/processes', {
        method: 'POST',
        body: JSON.stringify({ configFile: selectedConfig }),
      });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const stopProcess = async (id: string) => {
    try {
      setError(null);
      await request(`/processes/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const clearStopped = async () => {
    try {
      await request('/processes', { method: 'DELETE' });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const toggleOutput = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      setOutput([]);
      return;
    }
    try {
      const data = await request<{ output: string[] }>(`/processes/${id}/output?lines=100`);
      setOutput(data.output);
      setExpandedId(id);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const statusColor = (status: string) => {
    switch (status) {
      case 'running': return 'bg-green-100 text-green-700';
      case 'stopped': return 'bg-gray-100 text-gray-600';
      case 'error': return 'bg-red-100 text-red-700';
      default: return 'bg-gray-100 text-gray-600';
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Agent Processes</h1>
          <p className="text-xs text-gray-400 mt-0.5">Local UI server · manages processes on this host</p>
        </div>
        <div className="flex gap-2">
          <button onClick={refresh} className="flex items-center gap-1 px-3 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600 text-sm">
            <RefreshCw size={14} /> Refresh
          </button>
          <button onClick={clearStopped} className="flex items-center gap-1 px-3 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600 text-sm">
            <Trash2 size={14} /> Clear Stopped
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-100 text-red-700 rounded-lg text-sm">{error}</div>
      )}

      {/* Start new process */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-4 mb-6">
        <h2 className="font-semibold text-sm mb-3">Start Agent</h2>
        <div className="flex gap-3">
          <select
            value={selectedConfig}
            onChange={(e) => setSelectedConfig(e.target.value)}
            className="input text-sm flex-1"
          >
            <option value="">Select config file...</option>
            {configs.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <button
            onClick={startProcess}
            disabled={!selectedConfig}
            className="flex items-center gap-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
          >
            <Play size={14} /> Start
          </button>
        </div>
      </div>

      {/* Process list */}
      {processes.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <Play size={48} className="mx-auto mb-3 opacity-30" />
          <p>No agent processes running.</p>
          <p className="text-sm mt-1">Select a config file above to start an agent.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {processes.map(p => (
            <div key={p.id} className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 overflow-hidden">
              <div className="flex items-center justify-between p-4">
                <div className="flex items-center gap-3">
                  <span className={`px-2 py-1 rounded text-xs font-medium ${statusColor(p.status)}`}>
                    {p.status}
                  </span>
                  <div>
                    <span className="font-medium text-sm">{p.configFile}</span>
                    <span className="text-xs text-gray-400 ml-2">PID: {p.pid} · ID: {p.id}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-400">
                    {new Date(p.startedAt).toLocaleTimeString()}
                  </span>
                  <button
                    onClick={() => toggleOutput(p.id)}
                    className={`p-2 rounded hover:bg-gray-100 ${expandedId === p.id ? 'text-blue-600' : 'text-gray-400'}`}
                    title="View output"
                  >
                    <Terminal size={14} />
                  </button>
                  {p.status === 'running' && (
                    <button
                      onClick={() => stopProcess(p.id)}
                      className="p-2 rounded text-red-500 hover:bg-red-50"
                      title="Stop process"
                    >
                      <Square size={14} />
                    </button>
                  )}
                </div>
              </div>
              {expandedId === p.id && (
                <div ref={outputRef} className="border-t bg-gray-900 text-green-400 p-4 font-mono text-xs max-h-64 overflow-auto">
                  {output.length === 0 ? (
                    <span className="text-gray-500">No output yet...</span>
                  ) : (
                    output.map((line, i) => (
                      <div key={i} className={line.startsWith('[stderr]') ? 'text-red-400' : ''}>
                        {line}
                      </div>
                    ))
                  )}
                </div>
              )}
              {p.exitCode !== null && (
                <div className="border-t px-4 py-2 text-xs text-gray-500">
                  Exit code: {p.exitCode}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
