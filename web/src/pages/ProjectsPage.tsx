import { useState, useEffect } from 'react';
import {
  FolderOpen, Plus, ArrowRight, ArrowLeft, Check, GitBranch, Code, Wrench,
  FileText, Rocket, Trash2, ChevronDown, ChevronUp, Play, AlertCircle, Square, ExternalLink,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { projectsApi, workflowApi, processesApi, type ProjectDefinition } from '../lib/api';

type WizardStep = 'project' | 'workflow' | 'team' | 'launch';
const STEPS: WizardStep[] = ['project', 'workflow', 'team', 'launch'];
const STEP_LABELS: Record<WizardStep, string> = {
  project: 'Project Setup',
  workflow: 'Workflow',
  team: 'Review Team',
  launch: 'Launch',
};

interface WorkflowSummary {
  file: string;
  id: string;
  name: string;
  description: string;
  version: string;
}

interface WorkflowState {
  id: string;
  name: string;
  role: string;
  description: string;
  isInitial: boolean;
  isTerminal: boolean;
}

interface TeamConfig {
  role: string;
  configFile: string;
}

const LANGUAGES = [
  'TypeScript', 'JavaScript', 'Python', 'Rust', 'Go', 'Java', 'C#', 'C++', 'C', 'Ruby', 'Swift', 'Kotlin', 'Other',
];

function emptyProject(): Partial<ProjectDefinition> {
  return {
    name: '',
    description: '',
    repoUrl: '',
    language: '',
    techStack: [],
    projectContext: [],
    buildSystem: {},
    additionalSections: [],
  };
}

export default function ProjectsPage() {
  // Project list
  const [projects, setProjects] = useState<ProjectDefinition[]>([]);
  const [loading, setLoading] = useState(true);

  // Wizard state
  const [wizardOpen, setWizardOpen] = useState(false);
  const [currentStep, setCurrentStep] = useState<WizardStep>('project');
  const [draft, setDraft] = useState<Partial<ProjectDefinition>>(emptyProject());
  const [editingId, setEditingId] = useState<string | null>(null);

  // Workflow data
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [workflowStates, setWorkflowStates] = useState<WorkflowState[]>([]);
  const [workflowRoles, setWorkflowRoles] = useState<string[]>([]);

  // Team / launch
  const [teamConfigs, setTeamConfigs] = useState<TeamConfig[]>([]);
  const [applyStatus, setApplyStatus] = useState<string | null>(null);
  const [launchStatus, setLaunchStatus] = useState<string | null>(null);
  const [runningProcesses, setRunningProcesses] = useState<Array<{ id: string; configFile: string; status: string }>>([]);
  const [stopping, setStopping] = useState(false);

  // Status messages
  const [status, setStatus] = useState<string | null>(null);

  // Context item input
  const [newContextItem, setNewContextItem] = useState('');
  const [newTechItem, setNewTechItem] = useState('');

  // Expanded project card
  const [expandedProject, setExpandedProject] = useState<string | null>(null);

  useEffect(() => {
    loadProjects();
    workflowApi.list().then(d => setWorkflows(d.workflows as unknown as WorkflowSummary[])).catch(() => { });
  }, []);

  const loadProjects = async () => {
    setLoading(true);
    try {
      const data = await projectsApi.list();
      setProjects(data.projects);
    } catch { /* empty */ }
    setLoading(false);
  };

  // Workflow selection — load states and derive roles
  const selectWorkflow = async (filename: string) => {
    setDraft(prev => ({ ...prev, workflow: filename }));
    if (!filename) {
      setWorkflowStates([]);
      setWorkflowRoles([]);
      return;
    }
    try {
      const data = await workflowApi.states(filename);
      setWorkflowStates(data.states);
      const roles = [...new Set(data.states.map(s => s.role))];
      setWorkflowRoles(roles);
    } catch {
      setWorkflowStates([]);
      setWorkflowRoles([]);
    }
  };

  // Create or update project
  const saveProject = async (): Promise<ProjectDefinition | null> => {
    try {
      if (editingId) {
        const updated = await projectsApi.update(editingId, draft);
        setProjects(prev => prev.map(p => p.id === editingId ? updated : p));
        return updated;
      } else {
        const created = await projectsApi.create(draft);
        setProjects(prev => [created, ...prev]);
        return created;
      }
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
      return null;
    }
  };

  const deleteProject = async (id: string) => {
    try {
      await projectsApi.delete(id);
      setProjects(prev => prev.filter(p => p.id !== id));
      setStatus('Project deleted');
      setTimeout(() => setStatus(null), 3000);
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
    }
  };

  // Apply project — generates custom_instructions + team configs
  const applyProject = async (id: string) => {
    setApplyStatus('Applying project...');
    try {
      const result = await projectsApi.apply(id);
      setTeamConfigs(result.teamConfigs);
      setApplyStatus(`Generated ${result.filesWritten.length} files: ${result.filesWritten.join(', ')}`);
      setTimeout(() => setApplyStatus(null), 5000);
      return result;
    } catch (err) {
      setApplyStatus(`Error: ${(err as Error).message}`);
      return null;
    }
  };

  // Poll running processes when on launch step
  const refreshProcesses = async () => {
    try {
      const data = await processesApi.list();
      setRunningProcesses(data.processes.map(p => ({ id: p.id, configFile: p.configFile, status: p.status })));
    } catch { /* ignore */ }
  };

  useEffect(() => {
    if (currentStep === 'launch') {
      refreshProcesses();
      const interval = setInterval(refreshProcesses, 3000);
      return () => clearInterval(interval);
    }
  }, [currentStep]);

  // Launch team
  const launchTeam = async () => {
    if (teamConfigs.length === 0) {
      setLaunchStatus('No team configs to launch');
      setTimeout(() => setLaunchStatus(null), 3000);
      return;
    }
    setLaunchStatus('Launching agents...');
    try {
      const files = teamConfigs.map(c => c.configFile);
      const data = await processesApi.batch(files);
      setLaunchStatus(`Launched ${data.launched} agents`);
      setTimeout(() => setLaunchStatus(null), 5000);
      await refreshProcesses();
    } catch (err) {
      setLaunchStatus(`Error: ${(err as Error).message}`);
    }
  };

  // Stop all running agents
  const stopAllAgents = async () => {
    const running = runningProcesses.filter(p => p.status === 'running');
    if (running.length === 0) return;
    setStopping(true);
    setLaunchStatus('Stopping agents...');
    try {
      await Promise.all(running.map(p => processesApi.stop(p.id)));
      setLaunchStatus(`Stopped ${running.length} agent${running.length !== 1 ? 's' : ''}`);
      setTimeout(() => setLaunchStatus(null), 5000);
      await refreshProcesses();
    } catch (err) {
      setLaunchStatus(`Error stopping: ${(err as Error).message}`);
    } finally {
      setStopping(false);
    }
  };

  // Reset all agent and mailbox state for this project
  const [resetting, setResetting] = useState(false);
  const resetProjectState = async () => {
    if (!editingId) return;
    const running = runningProcesses.filter(p => p.status === 'running');
    if (running.length > 0) {
      setLaunchStatus('Stop all agents before resetting state');
      setTimeout(() => setLaunchStatus(null), 4000);
      return;
    }
    if (!window.confirm(
      'Reset all agent state for this project?\n\n' +
      'This will delete:\n' +
      '  - Session contexts (message tracking, task progress)\n' +
      '  - Decomposed work items (pending, completed, in-progress)\n' +
      '  - Mailbox messages (all queues and archives)\n' +
      '  - A2A message archives\n\n' +
      'Project configuration and git workspaces will be preserved.\n\n' +
      'This cannot be undone.'
    )) return;
    setResetting(true);
    setLaunchStatus('Resetting agent state...');
    try {
      const result = await projectsApi.resetState(editingId);
      setLaunchStatus(`State reset complete — ${result.cleaned.length} items cleaned`);
      setTimeout(() => setLaunchStatus(null), 5000);
    } catch (err) {
      setLaunchStatus(`Error: ${(err as Error).message}`);
    } finally {
      setResetting(false);
    }
  };

  // Wizard navigation
  const stepIndex = STEPS.indexOf(currentStep);
  const canNext = () => {
    if (currentStep === 'project') return !!(draft.name && draft.name.trim());
    if (currentStep === 'workflow') return true; // workflow is optional
    return true;
  };

  const goNext = async () => {
    if (currentStep === 'project') {
      // Flush any pending context or tech stack input before saving
      if (newContextItem.trim()) {
        draft.projectContext = [...(draft.projectContext || []), newContextItem.trim()];
        setNewContextItem('');
      }
      if (newTechItem.trim()) {
        draft.techStack = [...(draft.techStack || []), newTechItem.trim()];
        setNewTechItem('');
      }
      // Save project when leaving step 1
      const saved = await saveProject();
      if (!saved) return;
      setEditingId(saved.id);
      setCurrentStep('workflow');
    } else if (currentStep === 'workflow') {
      // Save workflow selection
      if (editingId) {
        await projectsApi.update(editingId, { workflow: draft.workflow });
      }
      setCurrentStep('team');
      // Auto-apply to generate team configs
      if (editingId) {
        await applyProject(editingId);
      }
    } else if (currentStep === 'team') {
      setCurrentStep('launch');
    }
  };

  const goPrev = () => {
    const idx = STEPS.indexOf(currentStep);
    if (idx > 0) setCurrentStep(STEPS[idx - 1]);
  };

  const openNewProject = () => {
    setDraft(emptyProject());
    setEditingId(null);
    setCurrentStep('project');
    setTeamConfigs([]);
    setWorkflowStates([]);
    setWorkflowRoles([]);
    setApplyStatus(null);
    setLaunchStatus(null);
    setWizardOpen(true);
  };

  const openExistingProject = async (project: ProjectDefinition) => {
    setDraft(project);
    setEditingId(project.id);
    setCurrentStep('project');
    setTeamConfigs([]);
    setApplyStatus(null);
    setLaunchStatus(null);
    if (project.workflow) {
      await selectWorkflow(project.workflow);
    }
    setWizardOpen(true);
  };

  const closeWizard = () => {
    setWizardOpen(false);
    loadProjects();
  };

  // Render helpers
  const addContextItem = () => {
    if (!newContextItem.trim()) return;
    setDraft(prev => ({ ...prev, projectContext: [...(prev.projectContext || []), newContextItem.trim()] }));
    setNewContextItem('');
  };

  const removeContextItem = (index: number) => {
    setDraft(prev => ({ ...prev, projectContext: (prev.projectContext || []).filter((_, i) => i !== index) }));
  };

  const addTechItem = () => {
    if (!newTechItem.trim()) return;
    setDraft(prev => ({ ...prev, techStack: [...(prev.techStack || []), newTechItem.trim()] }));
    setNewTechItem('');
  };

  const removeTechItem = (index: number) => {
    setDraft(prev => ({ ...prev, techStack: (prev.techStack || []).filter((_, i) => i !== index) }));
  };

  if (wizardOpen) {
    return (
      <div>
        {/* Wizard header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2">
              <FolderOpen size={22} /> {editingId ? 'Edit Project' : 'New Project'}
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              {STEP_LABELS[currentStep]} — Step {stepIndex + 1} of {STEPS.length}
            </p>
          </div>
          <button onClick={closeWizard} className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
            ← Back to Projects
          </button>
        </div>

        {/* Step indicators */}
        <div className="flex items-center gap-2 mb-6">
          {STEPS.map((step, i) => (
            <div key={step} className="flex items-center gap-2">
              <button
                onClick={() => {
                  if (i < stepIndex) setCurrentStep(step);
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${step === currentStep
                  ? 'bg-blue-600 text-white'
                  : i < stepIndex
                    ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 cursor-pointer hover:bg-green-200'
                    : 'bg-gray-100 text-gray-400 dark:bg-gray-800'
                  }`}
              >
                {i < stepIndex ? <Check size={12} /> : <span>{i + 1}</span>}
                {STEP_LABELS[step]}
              </button>
              {i < STEPS.length - 1 && <ArrowRight size={14} className="text-gray-300" />}
            </div>
          ))}
        </div>

        {/* Step content */}
        <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-6">
          {/* Step 1: Project Setup */}
          {currentStep === 'project' && (
            <div className="space-y-5">
              <div>
                <label className="block text-sm font-medium mb-1">Project Name *</label>
                <input
                  value={draft.name || ''}
                  onChange={e => setDraft(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="My Awesome Project"
                  className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 text-sm"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Description</label>
                <textarea
                  value={draft.description || ''}
                  onChange={e => setDraft(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="Brief description of the project..."
                  rows={2}
                  className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 text-sm"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1 flex items-center gap-1">
                  <GitBranch size={14} /> Git Repository URL
                </label>
                <input
                  value={draft.repoUrl || ''}
                  onChange={e => setDraft(prev => ({ ...prev, repoUrl: e.target.value }))}
                  placeholder="https://github.com/org/repo.git"
                  className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 text-sm font-mono"
                />
                <p className="text-xs text-gray-400 mt-1">Agents will clone this repo into their workspace</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1 flex items-center gap-1">
                    <Code size={14} /> Language
                  </label>
                  <select
                    value={draft.language || ''}
                    onChange={e => setDraft(prev => ({ ...prev, language: e.target.value }))}
                    className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 text-sm"
                  >
                    <option value="">Select language...</option>
                    {LANGUAGES.map(lang => (
                      <option key={lang} value={lang}>{lang}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1 flex items-center gap-1">
                    <Wrench size={14} /> Tech Stack
                  </label>
                  <div className="flex gap-1">
                    <input
                      value={newTechItem}
                      onChange={e => setNewTechItem(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addTechItem())}
                      placeholder="e.g. React, Express..."
                      className="flex-1 px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 text-sm"
                    />
                    <button onClick={addTechItem} className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
                      <Plus size={14} />
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {(draft.techStack || []).map((item, i) => (
                      <span key={i} className="flex items-center gap-1 text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded-full">
                        {item}
                        <button onClick={() => removeTechItem(i)} className="hover:text-red-500">×</button>
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1 flex items-center gap-1">
                  <FileText size={14} /> Project Context
                </label>
                <p className="text-xs text-gray-400 mb-2">Key facts about the project that agents need to know</p>
                <div className="space-y-1 mb-2">
                  {(draft.projectContext || []).map((item, i) => (
                    <div key={i} className="flex items-center gap-2 p-2 bg-gray-50 dark:bg-gray-700 rounded text-sm">
                      <span className="flex-1">{item}</span>
                      <button onClick={() => removeContextItem(i)} className="text-red-400 hover:text-red-600">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="flex gap-1">
                  <input
                    value={newContextItem}
                    onChange={e => setNewContextItem(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addContextItem())}
                    placeholder="e.g. FDA-regulated medical device platform"
                    className="flex-1 px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 text-sm"
                  />
                  <button onClick={addContextItem} className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
                    <Plus size={14} />
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-2 flex items-center gap-1">
                  <Wrench size={14} /> Build Commands
                </label>
                <div className="grid grid-cols-2 gap-3">
                  {['buildCommand', 'testCommand', 'lintCommand', 'formatCommand'].map(field => (
                    <div key={field}>
                      <label className="block text-xs text-gray-500 mb-0.5">{field.replace('Command', '')}</label>
                      <input
                        value={(draft.buildSystem as Record<string, string>)?.[field] || ''}
                        onChange={e => setDraft(prev => ({
                          ...prev,
                          buildSystem: { ...prev.buildSystem, [field]: e.target.value },
                        }))}
                        placeholder={field === 'buildCommand' ? 'npm run build' : field === 'testCommand' ? 'npm test' : field === 'lintCommand' ? 'npm run lint' : 'npm run format'}
                        className="w-full px-2 py-1.5 border rounded dark:bg-gray-700 dark:border-gray-600 text-xs font-mono"
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Step 2: Workflow Selection */}
          {currentStep === 'workflow' && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">Select a Workflow</label>
                <p className="text-xs text-gray-400 mb-3">
                  The workflow determines how agents collaborate. Each workflow defines roles, states, and transitions.
                </p>
                <div className="grid gap-2">
                  {workflows.map(wf => (
                    <button
                      key={wf.file}
                      onClick={() => selectWorkflow(wf.file)}
                      className={`text-left p-3 rounded-lg border transition-colors ${draft.workflow === wf.file
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                        : 'dark:border-gray-600 hover:border-gray-400'
                        }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-sm">{wf.name}</span>
                        {draft.workflow === wf.file && <Check size={16} className="text-blue-600" />}
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">{wf.description}</p>
                      <span className="text-xs text-gray-400">v{wf.version} · {wf.file}</span>
                    </button>
                  ))}
                  {workflows.length === 0 && (
                    <div className="text-center py-6 text-gray-400">
                      <p className="text-sm">No workflows found</p>
                      <p className="text-xs mt-1">Create a workflow in the Workflows page first</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Preview workflow states and roles */}
              {workflowStates.length > 0 && (
                <div className="border-t dark:border-gray-700 pt-4">
                  <h3 className="text-sm font-medium mb-2">Workflow States & Roles</h3>
                  <div className="flex flex-wrap gap-2 mb-3">
                    {workflowRoles.map(role => (
                      <span key={role} className="text-xs font-medium bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 px-2.5 py-1 rounded-full">
                        {role}
                      </span>
                    ))}
                  </div>
                  <div className="space-y-1">
                    {workflowStates.map(state => (
                      <div key={state.id} className="flex items-center gap-2 text-xs p-2 bg-gray-50 dark:bg-gray-700 rounded">
                        {state.isInitial && <span className="text-green-500">●</span>}
                        {state.isTerminal && <span className="text-red-500">■</span>}
                        {!state.isInitial && !state.isTerminal && <span className="text-gray-400">○</span>}
                        <span className="font-medium">{state.name}</span>
                        <span className="text-gray-400">→ {state.role}</span>
                        {state.description && <span className="text-gray-400 ml-auto truncate max-w-xs">{state.description}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Step 3: Review Team */}
          {currentStep === 'team' && (
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-medium mb-1">Team derived from workflow</h3>
                <p className="text-xs text-gray-400 mb-3">
                  These agent configs were auto-generated from the workflow roles. Each role gets a minimal config with convention-over-configuration defaults.
                </p>
              </div>

              {applyStatus && (
                <div className={`text-sm p-3 rounded-lg ${applyStatus.startsWith('Error') ? 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400' : 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400'}`}>
                  {applyStatus}
                </div>
              )}

              {teamConfigs.length > 0 ? (
                <div className="space-y-2">
                  {teamConfigs.map((tc) => (
                    <div key={tc.role} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center">
                          <span className="text-purple-600 dark:text-purple-300 text-xs font-bold">{tc.role[0].toUpperCase()}</span>
                        </div>
                        <div>
                          <div className="font-medium text-sm capitalize">{tc.role}</div>
                          <div className="text-xs text-gray-400 font-mono">{tc.configFile}</div>
                        </div>
                      </div>
                      <span className="text-xs text-green-600 bg-green-50 dark:bg-green-900/20 px-2 py-0.5 rounded-full">Ready</span>
                    </div>
                  ))}
                </div>
              ) : workflowRoles.length > 0 ? (
                <div className="space-y-2">
                  {workflowRoles.map(role => (
                    <div key={role} className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                      <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-600 flex items-center justify-center">
                        <span className="text-gray-500 text-xs font-bold">{role[0].toUpperCase()}</span>
                      </div>
                      <div>
                        <div className="font-medium text-sm capitalize">{role}</div>
                        <div className="text-xs text-gray-400">Pending config generation</div>
                      </div>
                    </div>
                  ))}
                  <button
                    onClick={() => editingId && applyProject(editingId)}
                    className="w-full py-2 bg-purple-600 text-white rounded-lg text-sm hover:bg-purple-700 flex items-center justify-center gap-1"
                  >
                    <Wrench size={14} /> Generate Configs
                  </button>
                </div>
              ) : (
                <div className="text-center py-8 text-gray-400">
                  <AlertCircle size={24} className="mx-auto mb-2" />
                  <p className="text-sm">No workflow selected</p>
                  <p className="text-xs mt-1">Go back and select a workflow to auto-generate team configs</p>
                </div>
              )}

              {/* Project context summary */}
              {(draft.projectContext || []).length > 0 && (
                <div className="border-t dark:border-gray-700 pt-3">
                  <h4 className="text-xs font-medium text-gray-500 mb-1">Project Context (applied to custom_instructions.json)</h4>
                  <ul className="text-xs text-gray-400 space-y-0.5">
                    {(draft.projectContext || []).map((item, i) => (
                      <li key={i}>• {item}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Step 4: Launch */}
          {currentStep === 'launch' && (
            <div className="space-y-4">
              <div className="text-center py-4">
                <Rocket size={32} className="mx-auto text-blue-500 mb-3" />
                <h3 className="text-lg font-semibold">Ready to Launch</h3>
                <p className="text-sm text-gray-500 mt-1">
                  {teamConfigs.length} agent{teamConfigs.length !== 1 ? 's' : ''} configured for{' '}
                  <span className="font-medium">{draft.name}</span>
                </p>
              </div>

              {/* Summary */}
              <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">Project</span>
                  <span className="font-medium">{draft.name}</span>
                </div>
                {draft.repoUrl && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Repository</span>
                    <span className="font-mono text-xs truncate max-w-sm">{draft.repoUrl}</span>
                  </div>
                )}
                {draft.language && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Language</span>
                    <span>{draft.language}</span>
                  </div>
                )}
                {draft.workflow && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Workflow</span>
                    <span>{draft.workflow}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-gray-500">Team Size</span>
                  <span>{teamConfigs.length} agents</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Roles</span>
                  <span>{teamConfigs.map(c => c.role).join(', ')}</span>
                </div>
              </div>

              {launchStatus && (
                <div className={`text-sm p-3 rounded-lg ${launchStatus.startsWith('Error') ? 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400' : 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400'}`}>
                  {launchStatus}
                </div>
              )}

              {(() => {
                const running = runningProcesses.filter(p => p.status === 'running');
                return running.length > 0 ? (
                  <div className="space-y-2">
                    <button
                      onClick={stopAllAgents}
                      disabled={stopping}
                      className="w-full py-3 bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                      <Square size={16} /> Stop All Agents ({running.length} running)
                    </button>
                    <button
                      onClick={launchTeam}
                      disabled={teamConfigs.length === 0}
                      className="w-full py-3 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                      <Play size={16} /> Relaunch All Agents
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={launchTeam}
                    disabled={teamConfigs.length === 0}
                    className="w-full py-3 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    <Play size={16} /> Launch All Agents
                  </button>
                );
              })()}

              <div className="flex items-center justify-center gap-4 text-xs text-gray-400">
                <p>This will start {teamConfigs.length} agent processes using the generated configs</p>
                <Link to="/processes" className="flex items-center gap-1 text-blue-500 hover:text-blue-600 whitespace-nowrap">
                  <ExternalLink size={12} /> Processes
                </Link>
              </div>

              <div className="border-t border-gray-200 dark:border-gray-700 pt-3 mt-3">
                <button
                  onClick={resetProjectState}
                  disabled={resetting || runningProcesses.some(p => p.status === 'running')}
                  className="w-full py-2 border border-amber-500 text-amber-600 dark:text-amber-400 rounded-lg text-sm font-medium hover:bg-amber-50 dark:hover:bg-amber-950 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  <Trash2 size={14} /> Reset Agent &amp; Mailbox State
                </button>
                <p className="text-center text-xs text-gray-400 mt-1">Clears all agent progress, tasks, and messages. Preserves configs and workspaces.</p>
              </div>
            </div>
          )}
        </div>

        {/* Wizard navigation */}
        <div className="flex justify-between mt-4">
          <button
            onClick={stepIndex === 0 ? closeWizard : goPrev}
            className="flex items-center gap-1 px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white"
          >
            <ArrowLeft size={14} /> {stepIndex === 0 ? 'Cancel' : 'Back'}
          </button>
          {stepIndex < STEPS.length - 1 && (
            <button
              onClick={goNext}
              disabled={!canNext()}
              className="flex items-center gap-1 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              Next <ArrowRight size={14} />
            </button>
          )}
        </div>

        {status && (
          <div className="mt-4 text-sm text-center text-red-600">{status}</div>
        )}
      </div>
    );
  }

  // Project list view
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <FolderOpen size={22} /> Projects
          </h1>
          <p className="text-sm text-gray-500 mt-1">Create a project, assign a workflow, and launch your agent team</p>
        </div>
        <button
          onClick={openNewProject}
          className="flex items-center gap-1 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"
        >
          <Plus size={14} /> New Project
        </button>
      </div>

      {status && (
        <div className="mb-4 text-sm p-3 rounded-lg bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400">
          {status}
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading projects...</div>
      ) : projects.length === 0 ? (
        <div className="text-center py-16">
          <FolderOpen size={48} className="mx-auto text-gray-300 dark:text-gray-600 mb-4" />
          <h2 className="text-lg font-semibold text-gray-500 dark:text-gray-400">No projects yet</h2>
          <p className="text-sm text-gray-400 mt-1 mb-4">
            Create a project to define your tech stack, select a workflow, and launch an agent team
          </p>
          <button
            onClick={openNewProject}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"
          >
            Create Your First Project
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {projects.map(project => (
            <div key={project.id} className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700">
              <div className="p-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-sm">{project.name}</h3>
                      {project.language && (
                        <span className="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded-full">
                          {project.language}
                        </span>
                      )}
                      {project.workflow && (
                        <span className="text-xs bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 px-2 py-0.5 rounded-full">
                          {project.workflow.replace('.json', '')}
                        </span>
                      )}
                    </div>
                    {project.description && (
                      <p className="text-xs text-gray-500 mt-0.5 truncate">{project.description}</p>
                    )}
                    <div className="flex items-center gap-3 mt-1 text-xs text-gray-400">
                      {project.repoUrl && (
                        <span className="flex items-center gap-1 truncate max-w-xs">
                          <GitBranch size={10} /> {project.repoUrl}
                        </span>
                      )}
                      {(project.techStack || []).length > 0 && (
                        <span>{project.techStack!.join(', ')}</span>
                      )}
                      <span>Updated {new Date(project.updatedAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 ml-3 flex-shrink-0">
                    <button
                      onClick={() => openExistingProject(project)}
                      className="p-1.5 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded"
                      title="Open project"
                    >
                      <ArrowRight size={16} />
                    </button>
                    <button
                      onClick={() => setExpandedProject(expandedProject === project.id ? null : project.id)}
                      className="p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
                    >
                      {expandedProject === project.id ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    </button>
                    <button
                      onClick={() => deleteProject(project.id)}
                      className="p-1.5 text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded"
                      title="Delete project"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>

              {expandedProject === project.id && (
                <div className="px-4 pb-4 border-t dark:border-gray-700 pt-3 space-y-2 text-xs">
                  {(project.projectContext || []).length > 0 && (
                    <div>
                      <span className="font-medium text-gray-500">Context:</span>
                      <ul className="mt-0.5 text-gray-400 space-y-0.5">
                        {project.projectContext.map((item, i) => <li key={i}>• {item}</li>)}
                      </ul>
                    </div>
                  )}
                  {project.buildSystem && Object.values(project.buildSystem).some(Boolean) && (
                    <div>
                      <span className="font-medium text-gray-500">Build:</span>
                      <div className="flex flex-wrap gap-2 mt-0.5">
                        {Object.entries(project.buildSystem).filter(([, v]) => v).map(([k, v]) => (
                          <span key={k} className="font-mono bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded">{v}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
