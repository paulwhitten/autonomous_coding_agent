import { useState } from 'react';
import { Clock, CheckCircle, XCircle, AlertTriangle, ArrowRight, ChevronDown, ChevronUp } from 'lucide-react';

interface TaskProgressProps {
  workItems: Record<string, string[]>;
}

interface TaskEntry {
  name: string;
  folder: 'pending' | 'review' | 'completed' | 'failed';
  taskId?: string;
}

const FOLDER_CONFIG = {
  pending: { label: 'In Progress', icon: Clock, color: 'text-blue-500', bg: 'bg-blue-50 dark:bg-blue-900/20', border: 'border-blue-200 dark:border-blue-700' },
  review: { label: 'In Review', icon: AlertTriangle, color: 'text-amber-500', bg: 'bg-amber-50 dark:bg-amber-900/20', border: 'border-amber-200 dark:border-amber-700' },
  completed: { label: 'Completed', icon: CheckCircle, color: 'text-green-500', bg: 'bg-green-50 dark:bg-green-900/20', border: 'border-green-200 dark:border-green-700' },
  failed: { label: 'Failed', icon: XCircle, color: 'text-red-500', bg: 'bg-red-50 dark:bg-red-900/20', border: 'border-red-200 dark:border-red-700' },
} as const;

const STATE_ORDER: Array<'pending' | 'review' | 'completed' | 'failed'> = ['pending', 'review', 'completed', 'failed'];

export default function TaskProgress({ workItems }: TaskProgressProps) {
  const [expanded, setExpanded] = useState(false);

  // Build a flat task list with their current folder/status
  const tasks: TaskEntry[] = [];
  for (const folder of STATE_ORDER) {
    const items = workItems[folder] || [];
    for (const item of items) {
      // Extract task ID from filename pattern like "001_001_task_name"
      const match = item.match(/^(\d+_\d+)/);
      tasks.push({
        name: item,
        folder,
        taskId: match ? match[1] : undefined,
      });
    }
  }

  const totalTasks = tasks.length;
  const completedCount = (workItems.completed || []).length;
  const failedCount = (workItems.failed || []).length;
  const reviewCount = (workItems.review || []).length;
  const pendingCount = (workItems.pending || []).length;
  const progressPercent = totalTasks > 0 ? Math.round(((completedCount) / totalTasks) * 100) : 0;

  if (totalTasks === 0) {
    return null; // Don't render if no tasks
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-4">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between"
      >
        <div className="flex items-center gap-2">
          <Clock size={18} className="text-blue-500" />
          <h3 className="font-semibold text-sm text-gray-700 dark:text-gray-200">Task Progress</h3>
          <span className="text-xs text-gray-400">
            {completedCount}/{totalTasks} complete ({progressPercent}%)
          </span>
        </div>
        {expanded ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
      </button>

      {/* Progress bar */}
      <div className="mt-2 flex h-2 rounded-full overflow-hidden bg-gray-100 dark:bg-gray-700">
        {completedCount > 0 && (
          <div className="bg-green-500 transition-all" style={{ width: `${(completedCount / totalTasks) * 100}%` }} />
        )}
        {reviewCount > 0 && (
          <div className="bg-amber-400 transition-all" style={{ width: `${(reviewCount / totalTasks) * 100}%` }} />
        )}
        {pendingCount > 0 && (
          <div className="bg-blue-400 transition-all" style={{ width: `${(pendingCount / totalTasks) * 100}%` }} />
        )}
        {failedCount > 0 && (
          <div className="bg-red-500 transition-all" style={{ width: `${(failedCount / totalTasks) * 100}%` }} />
        )}
      </div>

      {/* Summary badges */}
      <div className="flex gap-2 mt-2">
        {STATE_ORDER.map(folder => {
          const count = (workItems[folder] || []).length;
          if (count === 0) return null;
          const config = FOLDER_CONFIG[folder];
          const Icon = config.icon;
          return (
            <span key={folder} className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${config.bg} ${config.color}`}>
              <Icon size={10} /> {count} {config.label.toLowerCase()}
            </span>
          );
        })}
      </div>

      {/* Expanded task list */}
      {expanded && (
        <div className="mt-3 pt-3 border-t dark:border-gray-700 space-y-1">
          {STATE_ORDER.map(folder => {
            const items = workItems[folder] || [];
            if (items.length === 0) return null;
            const config = FOLDER_CONFIG[folder];
            const Icon = config.icon;
            return (
              <div key={folder} className="space-y-0.5">
                <div className={`text-xs font-medium ${config.color} flex items-center gap-1 mt-2 first:mt-0`}>
                  <Icon size={12} /> {config.label}
                </div>
                {items.map(item => (
                  <div key={item} className={`flex items-center gap-2 p-1.5 rounded text-xs ${config.bg} border ${config.border}`}>
                    <ArrowRight size={10} className="text-gray-400 flex-shrink-0" />
                    <span className="text-gray-700 dark:text-gray-200 truncate">{item}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
