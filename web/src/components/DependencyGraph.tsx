import { useState, useEffect, useCallback } from 'react';
import { tasksApi, TaskManifest } from '../lib/api';
import { onTaskStateChange } from '../lib/socket';
import { GitBranch, RefreshCw } from 'lucide-react';

const STATUS_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  done: { bg: 'bg-green-100 dark:bg-green-900/30', border: 'border-green-400', text: 'text-green-700 dark:text-green-300' },
  ready: { bg: 'bg-blue-100 dark:bg-blue-900/30', border: 'border-blue-400', text: 'text-blue-700 dark:text-blue-300' },
  dispatched: { bg: 'bg-yellow-100 dark:bg-yellow-900/30', border: 'border-yellow-400', text: 'text-yellow-700 dark:text-yellow-300' },
  blocked: { bg: 'bg-red-100 dark:bg-red-900/30', border: 'border-red-400', text: 'text-red-700 dark:text-red-300' },
  pending: { bg: 'bg-gray-100 dark:bg-gray-800/30', border: 'border-gray-300', text: 'text-gray-600 dark:text-gray-400' },
  cancelled: { bg: 'bg-gray-200 dark:bg-gray-700/30', border: 'border-gray-400', text: 'text-gray-500 dark:text-gray-500' },
};

export default function DependencyGraph() {
  const [manifest, setManifest] = useState<TaskManifest | null>(null);
  const [status, setStatus] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await tasksApi.manifest();
      setManifest(data.manifest);
      setStatus(data.status);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const unsub = onTaskStateChange(() => { load(); });
    return unsub;
  }, [load]);

  if (!manifest) {
    if (loading) return <div className="text-gray-500 text-sm p-4">Loading manifest...</div>;
    if (error) return <div className="text-red-500 text-sm p-4">Error: {error}</div>;
    return null; // No manifest available
  }

  // Compute levels (topological layers) for layout
  const taskMap = new Map(manifest.tasks.map(t => [t.taskId, t]));
  const levels = new Map<string, number>();

  function getLevel(taskId: string): number {
    if (levels.has(taskId)) return levels.get(taskId)!;
    const task = taskMap.get(taskId);
    if (!task || !task.dependsOn || task.dependsOn.length === 0) {
      levels.set(taskId, 0);
      return 0;
    }
    const maxDep = Math.max(...task.dependsOn.map(d => getLevel(d)));
    const level = maxDep + 1;
    levels.set(taskId, level);
    return level;
  }
  manifest.tasks.forEach(t => getLevel(t.taskId));

  // Group by level
  const maxLevel = Math.max(...Array.from(levels.values()), 0);
  const rows: Array<typeof manifest.tasks> = [];
  for (let i = 0; i <= maxLevel; i++) {
    rows.push(manifest.tasks.filter(t => levels.get(t.taskId) === i));
  }

  // Count statuses
  const counts = { done: 0, ready: 0, dispatched: 0, blocked: 0, pending: 0, cancelled: 0 };
  for (const t of manifest.tasks) {
    const s = (status[t.taskId] || 'pending') as keyof typeof counts;
    if (s in counts) counts[s]++;
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <GitBranch className="w-4 h-4 text-purple-500" />
          <h3 className="font-semibold text-sm text-gray-900 dark:text-white">
            Dependency Graph
          </h3>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {manifest.name || manifest.workflowId}
          </span>
        </div>
        <button onClick={load} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded" title="Refresh">
          <RefreshCw className={`w-3.5 h-3.5 text-gray-500 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Status summary bar */}
      <div className="flex gap-3 mb-4 text-xs">
        {Object.entries(counts).filter(([, v]) => v > 0).map(([key, val]) => (
          <span key={key} className={`${STATUS_COLORS[key]?.text || ''} font-medium`}>
            {val} {key}
          </span>
        ))}
        {manifest.wipLimit && (
          <span className="text-gray-500 ml-auto">WIP limit: {manifest.wipLimit}</span>
        )}
      </div>

      {/* Graph visualization */}
      <div className="space-y-3">
        {rows.map((row, level) => (
          <div key={level} className="flex items-start gap-2">
            <span className="text-[10px] text-gray-400 w-8 shrink-0 pt-2">L{level}</span>
            <div className="flex flex-wrap gap-2">
              {row.map(task => {
                const taskStatus = status[task.taskId] || 'pending';
                const colors = STATUS_COLORS[taskStatus] || STATUS_COLORS.pending;
                return (
                  <div
                    key={task.taskId}
                    className={`rounded border px-2.5 py-1.5 text-xs ${colors.bg} ${colors.border} ${colors.text}`}
                    title={`${task.taskId}: ${task.description || task.spec}\nStatus: ${taskStatus}\nDepends on: ${task.dependsOn?.join(', ') || 'none'}`}
                  >
                    <div className="font-mono font-semibold">{task.taskId}</div>
                    {task.description && (
                      <div className="text-[10px] opacity-75 max-w-[180px] truncate mt-0.5">
                        {task.description}
                      </div>
                    )}
                    {task.dependsOn && task.dependsOn.length > 0 && (
                      <div className="text-[10px] opacity-60 mt-0.5">
                        ← {task.dependsOn.join(', ')}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
