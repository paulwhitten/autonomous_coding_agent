import { useState, useCallback, useEffect } from 'react';
import {
  ReactFlow,
  addEdge,
  useNodesState,
  useEdgesState,
  Controls,
  Background,
  MiniMap,
  Connection,
  Node,
  Edge,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { workflowApi, templatesApi } from '../lib/api';
import { Save, Upload, Download, Plus, Trash2, BookTemplate, AlertTriangle } from 'lucide-react';

interface WorkflowState {
  name: string;
  role: string;
  description: string;
  prompt: string;
  allowedTools: string[];
  transitions: { onSuccess: string | null; onFailure: string | null };
  maxRetries?: number;
  timeoutMs?: number;
}

interface Workflow {
  id: string;
  name: string;
  description: string;
  version: string;
  initialState: string;
  terminalStates: string[];
  globalContext: Record<string, string>;
  states: Record<string, WorkflowState>;
}

const ROLE_COLORS: Record<string, string> = {
  manager: '#6366f1',
  developer: '#22c55e',
  qa: '#f59e0b',
  researcher: '#3b82f6',
};

function workflowToNodes(workflow: Workflow): Node[] {
  const stateNames = Object.keys(workflow.states);
  return stateNames.map((key, i) => {
    const state = workflow.states[key];
    const col = i % 3;
    const row = Math.floor(i / 3);
    return {
      id: key,
      position: { x: 100 + col * 300, y: 100 + row * 250 },
      data: {
        label: (
          <div className="text-left">
            <div className="font-bold text-sm">{key}</div>
            <div className="text-xs opacity-80">{state.name}</div>
            <div className="text-xs mt-1 px-1.5 py-0.5 rounded bg-white/20 inline-block">
              {state.role}
            </div>
          </div>
        ),
      },
      style: {
        background: ROLE_COLORS[state.role] || '#6b7280',
        color: 'white',
        border: workflow.terminalStates.includes(key)
          ? '3px solid #ef4444'
          : key === workflow.initialState
          ? '3px solid #10b981'
          : '1px solid rgba(255,255,255,0.3)',
        borderRadius: '12px',
        padding: '12px 16px',
        minWidth: '160px',
      },
    };
  });
}

function workflowToEdges(workflow: Workflow): Edge[] {
  const edges: Edge[] = [];
  for (const [key, state] of Object.entries(workflow.states)) {
    if (state.transitions.onSuccess) {
      edges.push({
        id: `${key}-success-${state.transitions.onSuccess}`,
        source: key,
        target: state.transitions.onSuccess,
        label: 'success',
        style: { stroke: '#22c55e', strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#22c55e' },
        labelStyle: { fontSize: 10, fill: '#22c55e' },
      });
    }
    if (state.transitions.onFailure && state.transitions.onFailure !== key) {
      edges.push({
        id: `${key}-failure-${state.transitions.onFailure}`,
        source: key,
        target: state.transitions.onFailure,
        label: 'failure',
        style: { stroke: '#ef4444', strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#ef4444' },
        labelStyle: { fontSize: 10, fill: '#ef4444' },
      });
    }
  }
  return edges;
}

const emptyWorkflow: Workflow = {
  id: 'new-workflow',
  name: 'New Workflow',
  description: '',
  version: '1.0.0',
  initialState: 'START',
  terminalStates: ['DONE'],
  globalContext: {},
  states: {
    START: {
      name: 'Start',
      role: 'manager',
      description: 'Initial state',
      prompt: '',
      allowedTools: [],
      transitions: { onSuccess: 'DONE', onFailure: 'DONE' },
    },
    DONE: {
      name: 'Done',
      role: 'manager',
      description: 'Terminal state',
      prompt: '',
      allowedTools: [],
      transitions: { onSuccess: null, onFailure: null },
    },
  },
};

export default function WorkflowPage() {
  const [workflow, setWorkflow] = useState<Workflow>(emptyWorkflow);
  const [nodes, setNodes, onNodesChange] = useNodesState(workflowToNodes(emptyWorkflow));
  const [edges, setEdges, onEdgesChange] = useEdgesState(workflowToEdges(emptyWorkflow));
  const [selectedState, setSelectedState] = useState<string | null>(null);
  const [workflowList, setWorkflowList] = useState<Array<{ file: string; name: string }>>([]);
  const [templateList, setTemplateList] = useState<Array<{ id: string; name: string; description: string; category: string }>>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [newStateName, setNewStateName] = useState('');
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  useEffect(() => {
    workflowApi.list().then(data => {
      setWorkflowList(data.workflows.map(w => ({ file: w.file, name: w.name })));
    }).catch(() => {});
    templatesApi.list().then(data => {
      setTemplateList(data.templates);
    }).catch(() => {});
  }, []);

  // Live validation on workflow changes
  useEffect(() => {
    const timer = setTimeout(() => {
      workflowApi.validate(workflow).then(result => {
        setValidationErrors(result.valid ? [] : result.errors);
      }).catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [workflow]);

  const loadWorkflow = async (filename: string) => {
    try {
      const data = await workflowApi.get(filename) as unknown as Workflow;
      setWorkflow(data);
      setNodes(workflowToNodes(data));
      setEdges(workflowToEdges(data));
      setSelectedState(null);
    } catch (err) {
      setSaveStatus(`Error loading: ${(err as Error).message}`);
    }
  };

  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge(params, eds)),
    [setEdges]
  );

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedState(node.id);
  }, []);

  const addState = () => {
    const name = newStateName.trim().toUpperCase().replace(/\s+/g, '_');
    if (!name || workflow.states[name]) return;
    const updated = {
      ...workflow,
      states: {
        ...workflow.states,
        [name]: {
          name: name.charAt(0) + name.slice(1).toLowerCase(),
          role: 'developer',
          description: '',
          prompt: '',
          allowedTools: [],
          transitions: { onSuccess: null, onFailure: null },
        },
      },
    };
    setWorkflow(updated);
    setNodes(workflowToNodes(updated));
    setEdges(workflowToEdges(updated));
    setNewStateName('');
  };

  const removeState = (key: string) => {
    if (workflow.terminalStates.includes(key) || key === workflow.initialState) return;
    const { [key]: _, ...rest } = workflow.states;
    // Clean up transitions pointing to removed state
    for (const state of Object.values(rest)) {
      if (state.transitions.onSuccess === key) state.transitions.onSuccess = null;
      if (state.transitions.onFailure === key) state.transitions.onFailure = null;
    }
    const updated = { ...workflow, states: rest };
    setWorkflow(updated);
    setNodes(workflowToNodes(updated));
    setEdges(workflowToEdges(updated));
    if (selectedState === key) setSelectedState(null);
  };

  const updateState = (key: string, field: string, value: unknown) => {
    const state = { ...workflow.states[key] };
    if (field === 'onSuccess' || field === 'onFailure') {
      state.transitions = { ...state.transitions, [field]: value || null };
    } else {
      (state as Record<string, unknown>)[field] = value;
    }
    const updated = {
      ...workflow,
      states: { ...workflow.states, [key]: state },
    };
    setWorkflow(updated);
    setNodes(workflowToNodes(updated));
    setEdges(workflowToEdges(updated));
  };

  const saveWorkflow = async () => {
    try {
      const filename = `${workflow.id}.workflow.json`;
      await workflowApi.save(filename, workflow);
      setSaveStatus('Saved!');
      setTimeout(() => setSaveStatus(null), 3000);
    } catch (err) {
      setSaveStatus(`Error: ${(err as Error).message}`);
    }
  };

  const loadTemplate = async (templateId: string) => {
    try {
      const data = await templatesApi.get(templateId);
      const wf = data.workflow as unknown as Workflow;
      setWorkflow(wf);
      setNodes(workflowToNodes(wf));
      setEdges(workflowToEdges(wf));
      setSelectedState(null);
      setShowTemplates(false);
      setSaveStatus(`Loaded template: ${data.name}`);
      setTimeout(() => setSaveStatus(null), 3000);
    } catch (err) {
      setSaveStatus(`Error loading template: ${(err as Error).message}`);
    }
  };

  const exportWorkflow = () => {
    const blob = new Blob([JSON.stringify(workflow, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${workflow.id}.workflow.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importWorkflow = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.workflow.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const wf = JSON.parse(text);
        if (!wf.id || !wf.states) {
          setSaveStatus('Error: Invalid workflow (missing id or states)');
          return;
        }
        // Save to server (goes to projects/workflows/)
        const filename = file.name.endsWith('.workflow.json') ? file.name : `${wf.id}.workflow.json`;
        await workflowApi.save(filename, wf);
        // Load it into the editor
        setWorkflow(wf);
        setNodes(workflowToNodes(wf));
        setEdges(workflowToEdges(wf));
        setSelectedState(null);
        // Refresh the workflow list
        workflowApi.list().then(d => setWorkflowList(d.workflows)).catch(() => { });
        setSaveStatus(`Uploaded: ${filename}`);
        setTimeout(() => setSaveStatus(null), 3000);
      } catch (err) {
        setSaveStatus(`Error: ${(err as Error).message}`);
      }
    };
    input.click();
  };

  const stateKeys = Object.keys(workflow.states);
  const selectedStateData = selectedState ? workflow.states[selectedState] : null;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Workflow Designer</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setShowTemplates(!showTemplates)}
            className={`flex items-center gap-1 px-3 py-2 rounded-lg text-sm ${showTemplates ? 'bg-purple-600 text-white' : 'bg-purple-100 text-purple-700 hover:bg-purple-200'}`}
          >
            <BookTemplate size={14} /> Templates
          </button>
          <select
            onChange={(e) => e.target.value && loadWorkflow(e.target.value)}
            className="input text-sm"
            defaultValue=""
          >
            <option value="">Load workflow...</option>
            {workflowList.map(w => (
              <option key={w.file} value={w.file}>{w.name} ({w.file})</option>
            ))}
          </select>
          <button onClick={exportWorkflow} className="flex items-center gap-1 px-3 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600 text-sm">
            <Download size={14} /> Export
          </button>
          <button onClick={importWorkflow} className="flex items-center gap-1 px-3 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600 text-sm">
            <Upload size={14} /> Upload
          </button>
          <button onClick={saveWorkflow} className="flex items-center gap-1 px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">
            <Save size={14} /> Save
          </button>
          {validationErrors.length > 0 && (
            <span className="flex items-center gap-1 text-red-500 text-xs">
              <AlertTriangle size={12} /> {validationErrors.length}
            </span>
          )}
        </div>
      </div>

      {saveStatus && (
        <div className={`mb-3 p-2 rounded text-sm ${saveStatus.startsWith('Error') ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
          {saveStatus}
        </div>
      )}

      {/* Template picker */}
      {showTemplates && (
        <div className="mb-4 bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl p-4">
          <h3 className="font-semibold text-sm mb-3">Workflow Templates</h3>
          {templateList.length === 0 ? (
            <p className="text-sm text-gray-500">No templates available.</p>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              {templateList.map(t => (
                <button
                  key={t.id}
                  onClick={() => loadTemplate(t.id)}
                  className="text-left p-3 border dark:border-gray-600 rounded-lg hover:border-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/30 transition-colors"
                >
                  <div className="font-medium text-sm">{t.name}</div>
                  <div className="text-xs text-gray-500 mt-1">{t.description}</div>
                  <div className="text-xs text-purple-600 mt-1">{t.category}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Validation errors */}
      {validationErrors.length > 0 && (
        <div className="mb-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-3">
          <div className="flex items-center gap-2 text-red-700 dark:text-red-400 font-medium text-sm mb-2">
            <AlertTriangle size={14} /> {validationErrors.length} validation {validationErrors.length === 1 ? 'error' : 'errors'}
          </div>
          <ul className="space-y-1">
            {validationErrors.map((err, i) => (
              <li key={i} className="text-xs text-red-600 dark:text-red-400 pl-5">{err}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Workflow metadata */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        <input
          value={workflow.id}
          onChange={(e) => setWorkflow({ ...workflow, id: e.target.value })}
          placeholder="Workflow ID"
          className="input text-sm"
        />
        <input
          value={workflow.name}
          onChange={(e) => setWorkflow({ ...workflow, name: e.target.value })}
          placeholder="Workflow Name"
          className="input text-sm"
        />
        <input
          value={workflow.version}
          onChange={(e) => setWorkflow({ ...workflow, version: e.target.value })}
          placeholder="Version"
          className="input text-sm"
        />
        <div className="flex gap-2">
          <input
            value={newStateName}
            onChange={(e) => setNewStateName(e.target.value)}
            placeholder="New state name"
            className="input text-sm flex-1"
            onKeyDown={(e) => e.key === 'Enter' && addState()}
          />
          <button onClick={addState} className="px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm">
            <Plus size={14} />
          </button>
        </div>
      </div>

      <div className="flex gap-4" style={{ height: '60vh' }}>
        {/* Flow Canvas */}
        <div className="flex-1 border dark:border-gray-700 rounded-xl overflow-hidden bg-white dark:bg-gray-800">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            fitView
          >
            <Controls />
            <Background />
            <MiniMap />
          </ReactFlow>
        </div>

        {/* State editor sidebar */}
        {selectedStateData && selectedState && (
          <div className="w-80 bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-4 overflow-auto">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-sm">{selectedState}</h3>
              <button
                onClick={() => removeState(selectedState)}
                className="text-red-500 hover:text-red-700"
                title="Remove state"
              >
                <Trash2 size={14} />
              </button>
            </div>
            <div className="space-y-3">
              <label className="block">
                <span className="text-xs font-medium text-gray-600">Name</span>
                <input
                  value={selectedStateData.name}
                  onChange={(e) => updateState(selectedState, 'name', e.target.value)}
                  className="input text-sm mt-1"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-gray-600">Role</span>
                <select
                  value={selectedStateData.role}
                  onChange={(e) => updateState(selectedState, 'role', e.target.value)}
                  className="input text-sm mt-1"
                >
                  {['manager', 'developer', 'qa', 'researcher'].map(r => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-medium text-gray-600">Description</span>
                <textarea
                  value={selectedStateData.description}
                  onChange={(e) => updateState(selectedState, 'description', e.target.value)}
                  className="input text-sm mt-1 h-16"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-gray-600">Prompt</span>
                <textarea
                  value={selectedStateData.prompt}
                  onChange={(e) => updateState(selectedState, 'prompt', e.target.value)}
                  className="input text-sm mt-1 h-24 font-mono"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-gray-600">On Success → </span>
                <select
                  value={selectedStateData.transitions.onSuccess || ''}
                  onChange={(e) => updateState(selectedState, 'onSuccess', e.target.value)}
                  className="input text-sm mt-1"
                >
                  <option value="">(none - terminal)</option>
                  {stateKeys.filter(k => k !== selectedState).map(k => (
                    <option key={k} value={k}>{k}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-medium text-gray-600">On Failure → </span>
                <select
                  value={selectedStateData.transitions.onFailure || ''}
                  onChange={(e) => updateState(selectedState, 'onFailure', e.target.value)}
                  className="input text-sm mt-1"
                >
                  <option value="">(none - terminal)</option>
                  {stateKeys.map(k => (
                    <option key={k} value={k}>{k}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-medium text-gray-600">Allowed Tools (comma-separated)</span>
                <input
                  value={selectedStateData.allowedTools.join(', ')}
                  onChange={(e) => updateState(selectedState, 'allowedTools', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
                  className="input text-sm mt-1"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-xs font-medium text-gray-600">Max Retries</span>
                  <input
                    type="number"
                    value={selectedStateData.maxRetries ?? 2}
                    onChange={(e) => updateState(selectedState, 'maxRetries', parseInt(e.target.value))}
                    className="input text-sm mt-1"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-gray-600">Timeout (ms)</span>
                  <input
                    type="number"
                    value={selectedStateData.timeoutMs ?? ''}
                    onChange={(e) => updateState(selectedState, 'timeoutMs', parseInt(e.target.value) || undefined)}
                    className="input text-sm mt-1"
                  />
                </label>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex gap-4 mt-4 text-xs text-gray-500">
        <span>🟢 Green border = initial state</span>
        <span>🔴 Red border = terminal state</span>
        {Object.entries(ROLE_COLORS).map(([role, color]) => (
          <span key={role} className="flex items-center gap-1">
            <span className="w-3 h-3 rounded" style={{ background: color }}></span> {role}
          </span>
        ))}
      </div>
    </div>
  );
}
