import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { configApi, workflowApi, agentsApi } from '../lib/api';
import { Save, Download, ChevronRight, ChevronLeft, Eye, FolderOpen, Trash2, FilePlus, Plus, X, Users } from 'lucide-react';

const STEPS = ['Agent', 'Mailbox', 'Copilot', 'Workspace', 'Logging', 'Manager', 'Team', 'Quota'] as const;

const MODELS = ['gpt-4.1', 'gpt-5', 'claude-sonnet-4.5', 'claude-opus-4', 'o3-mini'];
const ROLES = ['developer', 'qa', 'manager', 'researcher', 'requirements-analyst'];
const VALIDATION_MODES = ['none', 'spot_check', 'always', 'milestone'];
const QUOTA_PRESETS = ['conservative', 'aggressive', 'adaptive', 'unlimited'];

interface ConfigForm {
  agent: {
    hostname: string;
    role: string;
    checkIntervalMs: number;
    stuckTimeoutMs: number;
    sdkTimeoutMs: number;
    taskRetryCount: number;
    minWorkItems: number;
    maxWorkItems: number;
    decompositionPrompt: string;
    wipLimit: number;
    workflowFile: string;
    timeoutStrategy: {
      enabled: boolean;
      tier1_multiplier: number;
      tier2_backgroundThreshold: number;
      tier3_decomposeThreshold: number;
      tier4_adaptiveWindow: number;
      tier4_adaptiveThreshold: number;
    };
    validation: {
      mode: string;
      reviewEveryNthItem: number;
    };
  };
  mailbox: {
    repoPath: string;
    gitSync: boolean;
    autoCommit: boolean;
    commitMessage: string;
    supportBroadcast: boolean;
    supportAttachments: boolean;
    supportPriority: boolean;
  };
  copilot: {
    model: string;
    permissions: {
      shell: string;
      write: string;
      read: string;
      url: string;
      mcp: string;
    };
  };
  workspace: {
    path: string;
    tasksFolder: string;
    workingFolder: string;
    persistContext: boolean;
  };
  logging: {
    level: string;
    path: string;
    maxSizeMB: number;
  };
  manager: {
    hostname: string;
    role: string;
    escalationPriority: string;
  };
  quota: {
    enabled: boolean;
    preset: string;
  };
  communication: {
    a2a: {
      serverPort: number;
    };
  };
}

interface TeamMember {
  hostname: string;
  role: string;
  responsibilities: string;
  uri: string;
}

interface WorkflowSummary {
  file: string;
  id: string;
  name: string;
  description: string;
}

const defaultValues: ConfigForm = {
  agent: {
    hostname: 'auto-detect',
    role: 'developer',
    checkIntervalMs: 60000,
    stuckTimeoutMs: 2700000,
    sdkTimeoutMs: 300000,
    taskRetryCount: 3,
    minWorkItems: 5,
    maxWorkItems: 20,
    decompositionPrompt: '',
    wipLimit: 0,
    workflowFile: '',
    timeoutStrategy: {
      enabled: true,
      tier1_multiplier: 1.5,
      tier2_backgroundThreshold: 2,
      tier3_decomposeThreshold: 3,
      tier4_adaptiveWindow: 3600000,
      tier4_adaptiveThreshold: 5,
    },
    validation: {
      mode: 'spot_check',
      reviewEveryNthItem: 5,
    },
  },
  mailbox: {
    repoPath: '../mailbox_repo',
    gitSync: true,
    autoCommit: true,
    commitMessage: 'Auto-sync: {hostname}_{role} at {timestamp}',
    supportBroadcast: true,
    supportAttachments: true,
    supportPriority: true,
  },
  copilot: {
    model: 'gpt-4.1',
    permissions: {
      shell: 'allowlist',
      write: 'allow',
      read: 'allow',
      url: 'deny',
      mcp: 'deny',
    },
  },
  workspace: {
    path: './workspace',
    tasksFolder: 'tasks',
    workingFolder: 'project',
    persistContext: true,
  },
  logging: {
    level: 'info',
    path: './logs/agent.log',
    maxSizeMB: 100,
  },
  manager: {
    hostname: '',
    role: 'manager',
    escalationPriority: 'HIGH',
  },
  quota: {
    enabled: true,
    preset: 'adaptive',
  },
  communication: {
    a2a: {
      serverPort: 0,
    },
  },
};

export default function ConfigPage() {
  const [step, setStep] = useState(0);
  const [showPreview, setShowPreview] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [configFiles, setConfigFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState('config.json');
  const [newFileName, setNewFileName] = useState('');
  const [showNewFile, setShowNewFile] = useState(false);

  // Workflow and team state
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [workflowInfo, setWorkflowInfo] = useState<string | null>(null);

  const { register, handleSubmit, watch, reset, setValue } = useForm<ConfigForm>({
    defaultValues,
  });

  const formData = watch();

  useEffect(() => {
    configApi.list().then(data => setConfigFiles(data.configs)).catch(() => {});
    workflowApi.list().then(data => setWorkflows(data.workflows as WorkflowSummary[])).catch(() => {});
  }, []);

  // When workflow selection changes, fetch workflow details and auto-set role
  const onWorkflowChange = async (filename: string) => {
    setValue('agent.workflowFile', filename);
    setWorkflowInfo(null);
    if (!filename) return;
    try {
      const wf = await workflowApi.get(filename) as { name?: string; description?: string; initialState?: string; states?: Record<string, { role?: string }> };
      if (wf.initialState && wf.states?.[wf.initialState]?.role) {
        const role = wf.states[wf.initialState].role!;
        setValue('agent.role', role);
        setWorkflowInfo(`${wf.name || filename} — initial role: ${role}`);
      } else {
        setWorkflowInfo(wf.name || filename);
      }
    } catch { /* ignore */ }
  };

  const addTeamMember = () => {
    setTeamMembers(prev => [...prev, { hostname: '', role: 'developer', responsibilities: '', uri: '' }]);
  };

  const removeTeamMember = (index: number) => {
    setTeamMembers(prev => prev.filter((_, i) => i !== index));
  };

  const updateTeamMember = (index: number, field: keyof TeamMember, value: string) => {
    setTeamMembers(prev => prev.map((m, i) => i === index ? { ...m, [field]: value } : m));
  };

  const importFromDiscovered = async () => {
    try {
      const data = await agentsApi.discovered();
      const agents = data.agents || [];
      const newMembers: TeamMember[] = agents.map((a: { hostname: string; role: string; a2aUrl?: string }) => ({
        hostname: a.hostname,
        role: a.role,
        responsibilities: '',
        uri: a.a2aUrl ? `a2a://${new URL(a.a2aUrl).host}` : '',
      }));
      setTeamMembers(prev => {
        const existing = new Set(prev.map(m => `${m.hostname}_${m.role}`));
        return [...prev, ...newMembers.filter(m => !existing.has(`${m.hostname}_${m.role}`))];
      });
    } catch { /* ignore */ }
  };

  const loadConfig = async (filename: string) => {
    try {
      const data = await configApi.get(filename);
      const merged = { ...defaultValues };
      // Map loaded config into form shape
      if (data.agent) Object.assign(merged.agent, data.agent);
      if (data.mailbox) Object.assign(merged.mailbox, data.mailbox);
      if (data.copilot) Object.assign(merged.copilot, data.copilot);
      if (data.workspace) Object.assign(merged.workspace, data.workspace);
      if (data.logging) Object.assign(merged.logging, data.logging);
      if (data.manager) Object.assign(merged.manager, data.manager);
      if (data.quota) Object.assign(merged.quota, data.quota);
      const comm = data.communication as { a2a?: Record<string, unknown> } | undefined;
      if (comm?.a2a) Object.assign(merged.communication.a2a, comm.a2a);
      reset(merged);
      setActiveFile(filename);
      // Load team members if present
      if (Array.isArray(data.teamMembers)) {
        setTeamMembers(data.teamMembers);
      } else {
        setTeamMembers([]);
      }
      setSaveStatus(`Loaded ${filename}`);
      setTimeout(() => setSaveStatus(null), 3000);
    } catch (err) {
      setSaveStatus(`Error loading: ${(err as Error).message}`);
    }
  };

  const deleteConfig = async (filename: string) => {
    if (filename === 'config.example.json') return;
    try {
      await configApi.delete(filename);
      setConfigFiles(prev => prev.filter(f => f !== filename));
      if (activeFile === filename) {
        setActiveFile('config.json');
        reset(defaultValues);
      }
      setSaveStatus(`Deleted ${filename}`);
      setTimeout(() => setSaveStatus(null), 3000);
    } catch (err) {
      setSaveStatus(`Error: ${(err as Error).message}`);
    }
  };

  const createNewFile = () => {
    const name = newFileName.trim();
    if (!name) return;
    const filename = name.endsWith('.json') ? name : `${name}.json`;
    setActiveFile(filename);
    reset(defaultValues);
    setShowNewFile(false);
    setNewFileName('');
    setSaveStatus(`New config: ${filename} — edit and save when ready`);
    setTimeout(() => setSaveStatus(null), 4000);
  };

  const buildConfig = (data: ConfigForm) => {
    const config: Record<string, unknown> = {
      agent: {
        ...data.agent,
        allowedTools: ['all'],
      },
      mailbox: data.mailbox,
      copilot: {
        model: data.copilot.model,
        allowedTools: ['all'],
        permissions: data.copilot.permissions,
      },
      workspace: data.workspace,
      logging: data.logging,
      manager: data.manager,
      quota: data.quota,
    };
    // Include communication if A2A port is set
    if (data.communication.a2a.serverPort) {
      config.communication = data.communication;
    }
    // Include team members if any
    if (teamMembers.length > 0) {
      config.teamMembers = teamMembers;
    }
    return config;
  };

  const onSave = async (data: ConfigForm) => {
    try {
      const config = buildConfig(data);
      await configApi.save(activeFile, config);
      // Refresh file list in case this is a new file
      configApi.list().then(d => setConfigFiles(d.configs)).catch(() => {});
      setSaveStatus(`Saved ${activeFile} successfully!`);
      setTimeout(() => setSaveStatus(null), 3000);
    } catch (err) {
      setSaveStatus(`Error: ${(err as Error).message}`);
    }
  };

  const onDownload = () => {
    const config = buildConfig(formData);
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = activeFile;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Configuration Builder</h1>
          <span className="text-sm text-gray-500 dark:text-gray-400">— {activeFile}</span>
        </div>
        <div className="flex gap-2">
          <select
            value={activeFile}
            onChange={(e) => e.target.value && loadConfig(e.target.value)}
            className="input text-sm w-44"
          >
            <option value={activeFile}>{activeFile}</option>
            {configFiles.filter(f => f !== activeFile).map(f => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
          <button
            onClick={() => setShowNewFile(!showNewFile)}
            className="flex items-center gap-1 px-3 py-2 bg-green-100 text-green-700 rounded-lg hover:bg-green-200 text-sm dark:bg-green-900/30 dark:text-green-400 dark:hover:bg-green-900/50"
            title="Create new config"
          >
            <FilePlus size={14} />
          </button>
          {activeFile !== 'config.example.json' && configFiles.includes(activeFile) && (
            <button
              onClick={() => deleteConfig(activeFile)}
              className="flex items-center gap-1 px-3 py-2 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 text-sm dark:bg-red-900/30 dark:text-red-400"
              title="Delete config"
            >
              <Trash2 size={14} />
            </button>
          )}
          <button
            onClick={() => setShowPreview(!showPreview)}
            className="flex items-center gap-2 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600 text-sm"
          >
            <Eye size={16} /> {showPreview ? 'Hide' : 'Show'} JSON
          </button>
          <button
            onClick={onDownload}
            className="flex items-center gap-2 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600 text-sm"
          >
            <Download size={16} /> Download
          </button>
          <button
            onClick={handleSubmit(onSave)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
          >
            <Save size={16} /> Save
          </button>
        </div>
      </div>

      {/* New file input */}
      {showNewFile && (
        <div className="mb-4 flex gap-2">
          <input
            value={newFileName}
            onChange={(e) => setNewFileName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createNewFile()}
            placeholder="config-dev.json"
            className="input text-sm flex-1"
            autoFocus
          />
          <button onClick={createNewFile} className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm">
            Create
          </button>
        </div>
      )}

      {saveStatus && (
        <div className={`mb-4 p-3 rounded-lg text-sm ${saveStatus.startsWith('Error') ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
          {saveStatus}
        </div>
      )}

      {/* Step indicators */}
      <div className="flex gap-1 mb-6">
        {STEPS.map((s, i) => (
          <button
            key={s}
            onClick={() => setStep(i)}
            className={`flex-1 py-2 px-3 text-sm rounded-lg transition-colors ${
              i === step
                ? 'bg-blue-600 text-white'
                : i < step
                ? 'bg-blue-100 text-blue-700'
                : 'bg-gray-100 text-gray-500'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="flex gap-6">
        {/* Form */}
        <div className={`${showPreview ? 'w-1/2' : 'w-full'} bg-white dark:bg-gray-800 rounded-xl shadow-sm border dark:border-gray-700 p-6`}>
          <form onSubmit={handleSubmit(onSave)}>
            {step === 0 && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold mb-4">Agent Identity & Timing</h2>
                <Field label="Hostname" hint="Use 'auto-detect' for automatic">
                  <input {...register('agent.hostname')} className="input" />
                </Field>
                <Field label="Role">
                  <select {...register('agent.role')} className="input">
                    {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </Field>
                <Field label="Check Interval (ms)" hint="How often to poll mailbox. Min 20000.">
                  <input type="number" {...register('agent.checkIntervalMs', { valueAsNumber: true })} className="input" />
                </Field>
                <Field label="Stuck Timeout (ms)" hint="Escalate if stuck beyond this threshold">
                  <input type="number" {...register('agent.stuckTimeoutMs', { valueAsNumber: true })} className="input" />
                </Field>
                <Field label="SDK Timeout (ms)" hint="Base timeout for Copilot SDK calls">
                  <input type="number" {...register('agent.sdkTimeoutMs', { valueAsNumber: true })} className="input" />
                </Field>
                <Field label="Task Retry Count">
                  <input type="number" {...register('agent.taskRetryCount', { valueAsNumber: true })} className="input" />
                </Field>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Min Work Items">
                    <input type="number" {...register('agent.minWorkItems', { valueAsNumber: true })} className="input" />
                  </Field>
                  <Field label="Max Work Items">
                    <input type="number" {...register('agent.maxWorkItems', { valueAsNumber: true })} className="input" />
                  </Field>
                </div>
                <Field label="Decomposition Prompt" hint="Guidance for task breakdown">
                  <textarea {...register('agent.decompositionPrompt')} className="input h-20" />
                </Field>
                <Field label="WIP Limit" hint="0 = disabled. Manager only.">
                  <input type="number" {...register('agent.wipLimit', { valueAsNumber: true })} className="input" />
                </Field>
                <h3 className="text-md font-semibold pt-4">Workflow</h3>
                <Field label="Workflow File" hint="Select a workflow to assign this agent">
                  <select
                    value={formData.agent.workflowFile}
                    onChange={(e) => onWorkflowChange(e.target.value)}
                    className="input"
                  >
                    <option value="">None</option>
                    {workflows.map(w => (
                      <option key={w.file} value={w.file}>{w.name || w.file}</option>
                    ))}
                  </select>
                </Field>
                {workflowInfo && (
                  <p className="text-xs text-blue-600 dark:text-blue-400 -mt-2">{workflowInfo}</p>
                )}
                <h3 className="text-md font-semibold pt-4">A2A Communication</h3>
                <Field label="A2A Server Port" hint="0 = OS-assigned. Set to enable agent-to-agent protocol.">
                  <input type="number" {...register('communication.a2a.serverPort', { valueAsNumber: true })} className="input" />
                </Field>
                <h3 className="text-md font-semibold pt-4">Validation</h3>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Mode">
                    <select {...register('agent.validation.mode')} className="input">
                      {VALIDATION_MODES.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </Field>
                  <Field label="Review Every Nth Item">
                    <input type="number" {...register('agent.validation.reviewEveryNthItem', { valueAsNumber: true })} className="input" />
                  </Field>
                </div>
              </div>
            )}

            {step === 1 && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold mb-4">Mailbox Configuration</h2>
                <Field label="Repository Path" hint="Path to the shared mailbox git repo">
                  <input {...register('mailbox.repoPath')} className="input" />
                </Field>
                <Field label="Commit Message Template">
                  <input {...register('mailbox.commitMessage')} className="input" />
                </Field>
                <div className="grid grid-cols-2 gap-4">
                  <Toggle label="Git Sync" {...register('mailbox.gitSync')} />
                  <Toggle label="Auto Commit" {...register('mailbox.autoCommit')} />
                  <Toggle label="Broadcast Support" {...register('mailbox.supportBroadcast')} />
                  <Toggle label="Attachments Support" {...register('mailbox.supportAttachments')} />
                  <Toggle label="Priority Mailboxes" {...register('mailbox.supportPriority')} />
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold mb-4">Copilot SDK Settings</h2>
                <Field label="Model">
                  <select {...register('copilot.model')} className="input">
                    {MODELS.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </Field>
                <h3 className="text-md font-semibold pt-4">Permissions</h3>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Shell Access">
                    <select {...register('copilot.permissions.shell')} className="input">
                      <option value="allowlist">Allowlist (safe defaults)</option>
                      <option value="allow">Allow all</option>
                      <option value="deny">Deny</option>
                    </select>
                  </Field>
                  <Field label="File Write">
                    <select {...register('copilot.permissions.write')} className="input">
                      <option value="allow">Allow</option>
                      <option value="deny">Deny</option>
                      <option value="workingDir">Working Dir Only</option>
                    </select>
                  </Field>
                  <Field label="File Read">
                    <select {...register('copilot.permissions.read')} className="input">
                      <option value="allow">Allow</option>
                      <option value="deny">Deny</option>
                      <option value="workingDir">Working Dir Only</option>
                    </select>
                  </Field>
                  <Field label="URL/Network">
                    <select {...register('copilot.permissions.url')} className="input">
                      <option value="deny">Deny</option>
                      <option value="allow">Allow</option>
                    </select>
                  </Field>
                  <Field label="MCP Server">
                    <select {...register('copilot.permissions.mcp')} className="input">
                      <option value="deny">Deny</option>
                      <option value="allow">Allow</option>
                    </select>
                  </Field>
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold mb-4">Workspace Settings</h2>
                <Field label="Workspace Path">
                  <input {...register('workspace.path')} className="input" />
                </Field>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Tasks Folder">
                    <input {...register('workspace.tasksFolder')} className="input" />
                  </Field>
                  <Field label="Working Folder">
                    <input {...register('workspace.workingFolder')} className="input" />
                  </Field>
                </div>
                <Toggle label="Persist Context" {...register('workspace.persistContext')} />
              </div>
            )}

            {step === 4 && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold mb-4">Logging</h2>
                <Field label="Log Level">
                  <select {...register('logging.level')} className="input">
                    <option value="debug">Debug</option>
                    <option value="info">Info</option>
                    <option value="warn">Warn</option>
                    <option value="error">Error</option>
                  </select>
                </Field>
                <Field label="Log File Path">
                  <input {...register('logging.path')} className="input" />
                </Field>
                <Field label="Max Size (MB)">
                  <input type="number" {...register('logging.maxSizeMB', { valueAsNumber: true })} className="input" />
                </Field>
              </div>
            )}

            {step === 5 && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold mb-4">Manager</h2>
                <Field label="Manager Hostname" hint="Hostname of the manager agent">
                  <input {...register('manager.hostname')} className="input" />
                </Field>
                <Field label="Manager Role">
                  <select {...register('manager.role')} className="input">
                    {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </Field>
                <Field label="Escalation Priority">
                  <select {...register('manager.escalationPriority')} className="input">
                    <option value="HIGH">HIGH</option>
                    <option value="NORMAL">NORMAL</option>
                    <option value="LOW">LOW</option>
                  </select>
                </Field>
              </div>
            )}

            {step === 6 && (
              <div className="space-y-4">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold flex items-center gap-2">
                    <Users size={20} /> Team Members
                  </h2>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={importFromDiscovered}
                      className="flex items-center gap-1 px-3 py-1.5 bg-purple-100 text-purple-700 rounded-lg hover:bg-purple-200 text-sm dark:bg-purple-900/30 dark:text-purple-400"
                    >
                      <Download size={14} /> Import Discovered
                    </button>
                    <button
                      type="button"
                      onClick={addTeamMember}
                      className="flex items-center gap-1 px-3 py-1.5 bg-green-100 text-green-700 rounded-lg hover:bg-green-200 text-sm dark:bg-green-900/30 dark:text-green-400"
                    >
                      <Plus size={14} /> Add Member
                    </button>
                  </div>
                </div>
                {teamMembers.length === 0 && (
                  <p className="text-sm text-gray-400 dark:text-gray-500 italic">
                    No team members configured. Add members manually or import from discovered agents.
                  </p>
                )}
                {teamMembers.map((member, i) => (
                  <div key={i} className="border dark:border-gray-600 rounded-lg p-4 space-y-3 relative">
                    <button
                      type="button"
                      onClick={() => removeTeamMember(i)}
                      className="absolute top-2 right-2 text-red-400 hover:text-red-600"
                      title="Remove member"
                    >
                      <X size={16} />
                    </button>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Hostname">
                        <input
                          value={member.hostname}
                          onChange={(e) => updateTeamMember(i, 'hostname', e.target.value)}
                          className="input"
                          placeholder="agent-hostname"
                        />
                      </Field>
                      <Field label="Role">
                        <select
                          value={member.role}
                          onChange={(e) => updateTeamMember(i, 'role', e.target.value)}
                          className="input"
                        >
                          {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                      </Field>
                    </div>
                    <Field label="Responsibilities" hint="What this member is responsible for">
                      <input
                        value={member.responsibilities}
                        onChange={(e) => updateTeamMember(i, 'responsibilities', e.target.value)}
                        className="input"
                        placeholder="e.g. Backend API development"
                      />
                    </Field>
                    <Field label="A2A URI" hint="a2a://host:port or leave empty for mailbox-only">
                      <input
                        value={member.uri}
                        onChange={(e) => updateTeamMember(i, 'uri', e.target.value)}
                        className="input"
                        placeholder="a2a://localhost:4001"
                      />
                    </Field>
                  </div>
                ))}
              </div>
            )}

            {step === 7 && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold mb-4">Quota Management</h2>
                <Toggle label="Enable Quota" {...register('quota.enabled')} />
                <Field label="Preset">
                  <select {...register('quota.preset')} className="input">
                    {QUOTA_PRESETS.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </Field>
              </div>
            )}
          </form>

          {/* Navigation */}
          <div className="flex justify-between mt-6 pt-4 border-t">
            <button
              disabled={step === 0}
              onClick={() => setStep(s => s - 1)}
              className="flex items-center gap-1 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600 disabled:opacity-40 text-sm"
            >
              <ChevronLeft size={16} /> Previous
            </button>
            <button
              disabled={step === STEPS.length - 1}
              onClick={() => setStep(s => s + 1)}
              className="flex items-center gap-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-40 text-sm"
            >
              Next <ChevronRight size={16} />
            </button>
          </div>
        </div>

        {/* JSON Preview */}
        {showPreview && (
          <div className="w-1/2 bg-gray-900 text-green-400 rounded-xl p-4 overflow-auto">
            <h3 className="text-sm text-gray-500 mb-2 font-mono">config.json preview</h3>
            <pre className="text-xs font-mono whitespace-pre-wrap">
              {JSON.stringify(buildConfig(formData), null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-gray-700 dark:text-gray-200">{label}</span>
      {hint && <span className="text-xs text-gray-400 dark:text-gray-500 ml-2">{hint}</span>}
      <div className="mt-1">{children}</div>
    </label>
  );
}

function Toggle({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex items-center gap-2 py-2">
      <input type="checkbox" {...props} className="w-4 h-4 rounded border-gray-300 text-blue-600" />
      <span className="text-sm text-gray-700 dark:text-gray-200">{label}</span>
    </label>
  );
}
