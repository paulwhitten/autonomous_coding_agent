import { useState, useEffect } from 'react';
import { workflowApi } from '../lib/api';
import { GitBranch, Circle, CheckCircle, AlertTriangle, ArrowRight } from 'lucide-react';

interface WorkflowState {
  id: string;
  name: string;
  role: string;
  description: string;
  transitions: Record<string, string>;
  isInitial: boolean;
  isTerminal: boolean;
}

interface WorkflowInfo {
  workflow: { id: string; name: string; description: string };
  states: WorkflowState[];
  initialState: string;
  terminalStates: string[];
}

interface WorkflowSummary {
  file: string;
  id: string;
  name: string;
  description: string;
}

const ROLE_COLORS: Record<string, string> = {
  manager: 'bg-purple-100 text-purple-700 border-purple-300 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-700',
  developer: 'bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700',
  qa: 'bg-green-100 text-green-700 border-green-300 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700',
  researcher: 'bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700',
  'requirements-analyst': 'bg-pink-100 text-pink-700 border-pink-300 dark:bg-pink-900/30 dark:text-pink-300 dark:border-pink-700',
};

function getRoleColor(role: string): string {
  return ROLE_COLORS[role] || 'bg-gray-100 text-gray-700 border-gray-300 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600';
}

export default function WorkflowVisualization({ currentTaskState }: { currentTaskState?: string }) {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [selectedFile, setSelectedFile] = useState('');
  const [workflowInfo, setWorkflowInfo] = useState<WorkflowInfo | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    workflowApi.list().then(data => {
      setWorkflows(data.workflows as unknown as WorkflowSummary[]);
      if (data.workflows.length > 0) {
        setSelectedFile(data.workflows[0].file);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedFile) return;
    setLoading(true);
    workflowApi.states(selectedFile).then(data => {
      setWorkflowInfo(data);
    }).catch(() => setWorkflowInfo(null))
    .finally(() => setLoading(false));
  }, [selectedFile]);

  if (workflows.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-4">
        <div className="flex items-center gap-2 mb-2">
          <GitBranch size={18} className="text-gray-400" />
          <h3 className="font-semibold text-sm text-gray-700 dark:text-gray-200">Workflow States</h3>
        </div>
        <p className="text-sm text-gray-400 italic">No workflows found</p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <GitBranch size={18} className="text-blue-500" />
          <h3 className="font-semibold text-sm text-gray-700 dark:text-gray-200">Workflow States</h3>
        </div>
        {workflows.length > 1 && (
          <select
            value={selectedFile}
            onChange={(e) => setSelectedFile(e.target.value)}
            className="text-xs bg-gray-100 dark:bg-gray-700 border dark:border-gray-600 rounded px-2 py-1"
          >
            {workflows.map(w => (
              <option key={w.file} value={w.file}>{w.name || w.file}</option>
            ))}
          </select>
        )}
      </div>

      {loading && <p className="text-xs text-gray-400">Loading...</p>}

      {workflowInfo && (
        <div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">{workflowInfo.workflow.description}</p>

          {/* State flow visualization */}
          <div className="space-y-2">
            {workflowInfo.states.map((state) => {
              const isActive = currentTaskState === state.id;
              const transitions = Object.entries(state.transitions);

              return (
                <div
                  key={state.id}
                  className={`flex items-start gap-3 p-2 rounded-lg border transition-all ${
                    isActive
                      ? 'ring-2 ring-blue-500 border-blue-300 dark:border-blue-600 bg-blue-50 dark:bg-blue-900/20'
                      : 'border-transparent hover:border-gray-200 dark:hover:border-gray-600'
                  }`}
                >
                  {/* State icon */}
                  <div className="mt-0.5">
                    {state.isInitial ? (
                      <Circle size={16} className="text-green-500" fill="currentColor" />
                    ) : state.isTerminal ? (
                      state.id === 'DONE' || state.id.includes('DONE') ? (
                        <CheckCircle size={16} className="text-green-500" />
                      ) : (
                        <AlertTriangle size={16} className="text-amber-500" />
                      )
                    ) : isActive ? (
                      <Circle size={16} className="text-blue-500 animate-pulse" fill="currentColor" />
                    ) : (
                      <Circle size={16} className="text-gray-300 dark:text-gray-600" />
                    )}
                  </div>

                  {/* State details */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm text-gray-700 dark:text-gray-200">
                        {state.name}
                      </span>
                      <span className={`text-xs px-1.5 py-0.5 rounded border ${getRoleColor(state.role)}`}>
                        {state.role}
                      </span>
                      {isActive && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500 text-white">active</span>
                      )}
                    </div>
                    {state.description && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">{state.description}</p>
                    )}
                    {/* Transitions */}
                    {transitions.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {transitions.map(([trigger, target]) => (
                          <span key={trigger} className="flex items-center gap-0.5 text-xs text-gray-400 dark:text-gray-500">
                            <ArrowRight size={10} />
                            <span className={trigger === 'onFailure' ? 'text-red-400' : 'text-gray-500 dark:text-gray-400'}>
                              {target}
                            </span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Legend */}
          <div className="flex flex-wrap gap-3 mt-3 pt-3 border-t dark:border-gray-700">
            <span className="flex items-center gap-1 text-xs text-gray-400">
              <Circle size={10} className="text-green-500" fill="currentColor" /> Initial
            </span>
            <span className="flex items-center gap-1 text-xs text-gray-400">
              <CheckCircle size={10} className="text-green-500" /> Complete
            </span>
            <span className="flex items-center gap-1 text-xs text-gray-400">
              <AlertTriangle size={10} className="text-amber-500" /> Escalated
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
