import { useState, useEffect, useRef, useCallback } from 'react';
import { agentsApi } from '../lib/api';
import { RefreshCw, Search, Download, FileText } from 'lucide-react';

interface LogSource {
  name: string;
  path: string;
}

type LogLevel = 'all' | 'error' | 'warn' | 'info' | 'debug';

function parseLogLine(line: string): { level?: string; component?: string; agentId?: string; msg?: string } {
  try {
    const obj = JSON.parse(line);
    return {
      level: typeof obj.level === 'number'
        ? obj.level >= 50 ? 'error' : obj.level >= 40 ? 'warn' : obj.level >= 30 ? 'info' : 'debug'
        : obj.level,
      component: obj.component,
      agentId: obj.agentId,
      msg: obj.msg,
    };
  } catch {
    // plain text log
    if (line.includes('ERROR')) return { level: 'error' };
    if (line.includes('WARN')) return { level: 'warn' };
    if (line.includes('DEBUG')) return { level: 'debug' };
    return { level: 'info' };
  }
}

export default function MonitorPage() {
  const [logs, setLogs] = useState<string[]>([]);
  const [totalLines, setTotalLines] = useState(0);
  const [filter, setFilter] = useState('');
  const [lineCount, setLineCount] = useState(200);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [logSources, setLogSources] = useState<LogSource[]>([]);
  const [activeSource, setActiveSource] = useState<string>('');
  const [levelFilter, setLevelFilter] = useState<LogLevel>('all');
  const [agents, setAgents] = useState<string[]>([]);
  const [activeAgent, setActiveAgent] = useState<string>('all');
  const logEndRef = useRef<HTMLDivElement>(null);

  // Discover log sources on mount
  useEffect(() => {
    agentsApi.logSources().then(data => {
      setLogSources(data.sources);
    }).catch(() => {});
  }, []);

  const loadLogs = useCallback(async () => {
    try {
      const source = logSources.find(s => s.name === activeSource);
      const logPath = source?.path;
      const data = await agentsApi.logs(lineCount, logPath);
      setLogs(data.lines);
      setTotalLines(data.total);

      // Extract unique agent IDs from structured logs
      const agentIds = new Set<string>();
      for (const line of data.lines) {
        const parsed = parseLogLine(line);
        if (parsed.agentId) agentIds.add(parsed.agentId);
        else if (parsed.component) agentIds.add(parsed.component);
      }
      setAgents(Array.from(agentIds).sort());

      setTimeout(() => logEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    } catch { /* ignore */ }
  }, [lineCount, activeSource, logSources]);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(loadLogs, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, loadLogs]);

  const filteredLogs = logs.filter(line => {
    // Text search filter
    if (filter && !line.toLowerCase().includes(filter.toLowerCase())) return false;

    const parsed = parseLogLine(line);

    // Level filter
    if (levelFilter !== 'all') {
      const levelPriority: Record<string, number> = { error: 4, warn: 3, info: 2, debug: 1 };
      const linePriority = levelPriority[parsed.level || 'info'] || 2;
      const filterPriority = levelPriority[levelFilter] || 2;
      if (linePriority < filterPriority) return false;
    }

    // Agent/component filter
    if (activeAgent !== 'all') {
      const lineAgent = parsed.agentId || parsed.component || '';
      if (lineAgent !== activeAgent) return false;
    }

    return true;
  });

  const exportLogs = () => {
    const blob = new Blob([filteredLogs.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `agent-logs-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const getLogLevel = (line: string): string => {
    return parseLogLine(line).level || 'info';
  };

  const levelColors: Record<string, string> = {
    error: 'text-red-400',
    warn: 'text-yellow-400',
    debug: 'text-gray-500',
    info: 'text-green-400',
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Monitor</h1>
        <div className="flex gap-2 items-center">
          <label className="flex items-center gap-1 text-sm text-gray-600 dark:text-gray-300">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="w-4 h-4"
            />
            Auto-refresh
          </label>
          <select
            value={lineCount}
            onChange={(e) => setLineCount(parseInt(e.target.value))}
            className="input text-sm w-24"
          >
            <option value={100}>100</option>
            <option value={200}>200</option>
            <option value={500}>500</option>
            <option value={1000}>1000</option>
          </select>
          <button onClick={loadLogs} className="flex items-center gap-1 px-3 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600 text-sm">
            <RefreshCw size={14} /> Refresh
          </button>
          <button onClick={exportLogs} className="flex items-center gap-1 px-3 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600 text-sm">
            <Download size={14} /> Export
          </button>
        </div>
      </div>

      {/* Log source tabs + filters */}
      <div className="flex items-center gap-4 mb-4">
        {/* Source selector */}
        {logSources.length > 0 && (
          <div className="flex items-center gap-1">
            <FileText size={14} className="text-gray-400" />
            <div className="flex rounded-lg border dark:border-gray-700 overflow-hidden">
              <button
                onClick={() => setActiveSource('')}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  activeSource === ''
                    ? 'bg-blue-600 text-white'
                    : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                }`}
              >
                Default
              </button>
              {logSources.map(source => (
                <button
                  key={source.name}
                  onClick={() => setActiveSource(source.name)}
                  className={`px-3 py-1.5 text-xs font-medium border-l dark:border-gray-700 transition-colors ${
                    activeSource === source.name
                      ? 'bg-blue-600 text-white'
                      : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                  }`}
                >
                  {source.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Level filter */}
        <select
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value as LogLevel)}
          className="input text-sm w-28"
        >
          <option value="all">All Levels</option>
          <option value="error">Error+</option>
          <option value="warn">Warn+</option>
          <option value="info">Info+</option>
          <option value="debug">Debug+</option>
        </select>

        {/* Agent filter */}
        {agents.length > 0 && (
          <select
            value={activeAgent}
            onChange={(e) => setActiveAgent(e.target.value)}
            className="input text-sm w-40"
          >
            <option value="all">All Agents</option>
            {agents.map(a => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        )}
      </div>

      {/* Text filter */}
      <div className="relative mb-4">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter logs..."
          className="input text-sm pl-9 w-full"
        />
      </div>

      <div className="text-xs text-gray-400 dark:text-gray-500 mb-2">
        Showing {filteredLogs.length} of {totalLines} total lines
        {levelFilter !== 'all' && <span className="ml-2">· Level: {levelFilter}+</span>}
        {activeAgent !== 'all' && <span className="ml-2">· Agent: {activeAgent}</span>}
      </div>

      {/* Log viewer */}
      <div className="bg-gray-900 rounded-xl p-4 overflow-auto font-mono text-xs" style={{ maxHeight: '70vh' }}>
        {filteredLogs.length === 0 ? (
          <p className="text-gray-500 text-center py-8">
            {logs.length === 0 ? 'No log entries found' : 'No matches for current filters'}
          </p>
        ) : (
          filteredLogs.map((line, i) => {
            const level = getLogLevel(line);
            return (
              <div key={i} className={`${levelColors[level]} py-0.5 hover:bg-gray-800 px-1 rounded`}>
                {line}
              </div>
            );
          })
        )}
        <div ref={logEndRef} />
      </div>
    </div>
  );
}
