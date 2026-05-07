import { useState, useEffect, useCallback } from 'react';
import { tasksApi, WorkflowTask } from '../lib/api';
import { onTaskStateChange } from '../lib/socket';
import { AlertOctagon, Unlock, RefreshCw, MessageSquare, Plus, X, ChevronDown, ChevronUp } from 'lucide-react';

interface BlockedTasksProps {
  repoPath?: string;
  targetAgent?: string;
}

interface UnblockForm {
  note: string;
  contextEntries: Array<{ key: string; value: string }>;
}

const SUGGESTED_CONTEXT_KEYS = [
  { key: 'resolutionCommit', label: 'Resolution commit SHA' },
  { key: 'retryHint', label: 'Retry hint for the agent' },
  { key: 'modifiedFiles', label: 'Files modified manually' },
];

export default function BlockedTasks({ repoPath, targetAgent }: BlockedTasksProps) {
  const [tasks, setTasks] = useState<WorkflowTask[]>([]);
  const [allTasks, setAllTasks] = useState<WorkflowTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [unblockForm, setUnblockForm] = useState<UnblockForm>({ note: '', contextEntries: [] });
  const [submitting, setSubmitting] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [showAllTasks, setShowAllTasks] = useState(false);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [blockedData, allData] = await Promise.all([
        tasksApi.blocked(repoPath),
        tasksApi.list(repoPath),
      ]);
      setTasks(blockedData.tasks);
      setAllTasks(allData.tasks);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [repoPath]);

  useEffect(() => {
    loadTasks();
    // Auto-refresh when task state changes arrive via WebSocket
    const unsub = onTaskStateChange(() => { loadTasks(); });
    return unsub;
  }, [loadTasks]);

  const handleUnblock = async (taskId: string) => {
    if (!targetAgent) {
      setError('No target agent configured. Set the manager agent ID.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const context: Record<string, string> = {};
      for (const entry of unblockForm.contextEntries) {
        if (entry.key.trim() && entry.value.trim()) {
          context[entry.key.trim()] = entry.value.trim();
        }
      }

      const result = await tasksApi.unblock(taskId, {
        note: unblockForm.note || undefined,
        context: Object.keys(context).length > 0 ? context : undefined,
        targetAgent,
        repoPath,
      });

      setSuccessMsg(result.message);
      setSelectedTask(null);
      setUnblockForm({ note: '', contextEntries: [] });

      // Refresh after a brief delay
      setTimeout(loadTasks, 1000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const addContextEntry = () => {
    setUnblockForm(prev => ({
      ...prev,
      contextEntries: [...prev.contextEntries, { key: '', value: '' }],
    }));
  };

  const removeContextEntry = (index: number) => {
    setUnblockForm(prev => ({
      ...prev,
      contextEntries: prev.contextEntries.filter((_, i) => i !== index),
    }));
  };

  const updateContextEntry = (index: number, field: 'key' | 'value', val: string) => {
    setUnblockForm(prev => ({
      ...prev,
      contextEntries: prev.contextEntries.map((e, i) => i === index ? { ...e, [field]: val } : e),
    }));
  };

  const addSuggestedKey = (key: string) => {
    if (!unblockForm.contextEntries.some(e => e.key === key)) {
      setUnblockForm(prev => ({
        ...prev,
        contextEntries: [...prev.contextEntries, { key, value: '' }],
      }));
    }
  };

  const stateColor = (state: string) => {
    switch (state) {
      case 'BLOCKED': return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
      case 'DONE': return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300';
      case 'IMPLEMENTING': return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300';
      case 'ASSIGN': return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300';
      case 'VALIDATING': return 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300';
      case 'ESCALATED': return 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300';
      default: return 'bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-300';
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AlertOctagon className="w-5 h-5 text-red-500" />
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Workflow Tasks
          </h3>
          {tasks.length > 0 && (
            <span className="px-2 py-0.5 text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300 rounded-full">
              {tasks.length} blocked
            </span>
          )}
        </div>
        <button
          onClick={loadTasks}
          disabled={loading}
          className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          title="Refresh"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Success message */}
      {successMsg && (
        <div className="flex items-center justify-between px-3 py-2 text-sm bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 rounded-lg text-green-800 dark:text-green-200">
          <span>{successMsg}</span>
          <button onClick={() => setSuccessMsg(null)} className="ml-2">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Error message */}
      {error && (
        <div className="flex items-center justify-between px-3 py-2 text-sm bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-lg text-red-800 dark:text-red-200">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-2">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Blocked tasks list */}
      {tasks.length === 0 && !loading && (
        <p className="text-sm text-gray-500 dark:text-gray-400 italic">
          No blocked tasks found.
        </p>
      )}

      {tasks.map(task => (
        <div key={task.taskId} className="border border-red-200 dark:border-red-700 rounded-lg bg-red-50/50 dark:bg-red-900/10">
          <div className="px-4 py-3 flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {task.taskId}
                </span>
                <span className={`px-2 py-0.5 text-xs font-medium rounded ${stateColor(task.currentState)}`}>
                  {task.currentState}
                </span>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5">
                {task.subject}
              </p>
              {task.notes.length > 0 && (
                <div className="flex items-center gap-1 mt-1 text-xs text-gray-500">
                  <MessageSquare className="w-3 h-3" />
                  <span>{task.notes.length} note{task.notes.length !== 1 ? 's' : ''}</span>
                </div>
              )}
            </div>
            <button
              onClick={() => setSelectedTask(selectedTask === task.taskId ? null : task.taskId)}
              className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-md transition-colors"
            >
              <Unlock className="w-3.5 h-3.5" />
              Unblock
            </button>
          </div>

          {/* Existing notes */}
          {task.notes.length > 0 && selectedTask === task.taskId && (
            <div className="px-4 pb-2 border-t border-red-200 dark:border-red-700 pt-2">
              <p className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Previous notes:</p>
              {task.notes.map((n, i) => (
                <div key={i} className="text-xs bg-white dark:bg-gray-800 rounded p-2 mb-1 border border-gray-200 dark:border-gray-700">
                  <span className="font-medium">[{n.role}@{n.state}]</span> {n.content}
                  <span className="text-gray-400 ml-2">{new Date(n.timestamp).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}

          {/* Unblock form */}
          {selectedTask === task.taskId && (
            <div className="px-4 pb-4 border-t border-red-200 dark:border-red-700 pt-3 space-y-3">
              {/* Resolution note */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Resolution note (will be shown to the agent)
                </label>
                <textarea
                  value={unblockForm.note}
                  onChange={e => setUnblockForm(prev => ({ ...prev, note: e.target.value }))}
                  placeholder="Describe what was resolved or what the agent should know..."
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400"
                  rows={3}
                />
              </div>

              {/* Context key-value pairs */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    Additional context (key-value metadata)
                  </label>
                  <button
                    onClick={addContextEntry}
                    className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400"
                  >
                    <Plus className="w-3 h-3" />
                    Add field
                  </button>
                </div>

                {/* Suggested keys */}
                {unblockForm.contextEntries.length === 0 && (
                  <div className="flex flex-wrap gap-1 mb-2">
                    {SUGGESTED_CONTEXT_KEYS.map(({ key, label }) => (
                      <button
                        key={key}
                        onClick={() => addSuggestedKey(key)}
                        className="px-2 py-0.5 text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                        title={label}
                      >
                        + {key}
                      </button>
                    ))}
                  </div>
                )}

                {unblockForm.contextEntries.map((entry, i) => (
                  <div key={i} className="flex gap-2 mb-1.5">
                    <input
                      value={entry.key}
                      onChange={e => updateContextEntry(i, 'key', e.target.value)}
                      placeholder="key"
                      className="w-1/3 px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 font-mono"
                    />
                    <input
                      value={entry.value}
                      onChange={e => updateContextEntry(i, 'value', e.target.value)}
                      placeholder="value"
                      className="flex-1 px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                    />
                    <button
                      onClick={() => removeContextEntry(i)}
                      className="p-1.5 text-gray-400 hover:text-red-500"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>

              {/* Submit / cancel */}
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => handleUnblock(task.taskId)}
                  disabled={submitting}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 disabled:opacity-50 rounded-md transition-colors"
                >
                  <Unlock className="w-4 h-4" />
                  {submitting ? 'Sending...' : 'Confirm Unblock'}
                </button>
                <button
                  onClick={() => { setSelectedTask(null); setUnblockForm({ note: '', contextEntries: [] }); }}
                  className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      ))}

      {/* All tasks overview (collapsible) */}
      {allTasks.length > 0 && (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg">
          <button
            onClick={() => setShowAllTasks(!showAllTasks)}
            className="w-full px-4 py-2.5 flex items-center justify-between text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors rounded-lg"
          >
            <span>All tasks ({allTasks.length})</span>
            {showAllTasks ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          {showAllTasks && (
            <div className="px-4 pb-3 space-y-1.5 border-t border-gray-200 dark:border-gray-700 pt-2">
              {allTasks.map(task => (
                <div key={`${task.taskId}-${task.filename}`} className="flex items-center justify-between py-1.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-gray-700 dark:text-gray-300">{task.taskId}</span>
                    <span className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-[200px]">
                      {task.subject}
                    </span>
                  </div>
                  <span className={`px-2 py-0.5 text-xs font-medium rounded ${stateColor(task.currentState)}`}>
                    {task.currentState}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
