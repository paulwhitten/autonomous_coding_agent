import { useState, useEffect } from 'react';
import { Save, RotateCcw, FileText, Plus, Trash2, Eye } from 'lucide-react';

const API_BASE = '/api';

interface BuildSystem {
  buildCommand: string;
  testCommand: string;
  lintCommand: string;
  formatCommand: string;
}

interface CodingStandards {
  language: string;
  description: string;
  preCommitChecklist: string[];
  sections: Record<string, string[]>;
}

interface AdditionalSection {
  title: string;
  items: string[];
}

interface CustomInstructions {
  gitWorkflow: Record<string, unknown>;
  codingStandards: Partial<CodingStandards>;
  buildSystem: Partial<BuildSystem>;
  projectContext: string[];
  additionalSections: AdditionalSection[];
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

const emptyInstructions: CustomInstructions = {
  gitWorkflow: {},
  codingStandards: {},
  buildSystem: {},
  projectContext: [],
  additionalSections: [],
};

export default function InstructionsPage() {
  const [instructions, setInstructions] = useState<CustomInstructions>(emptyInstructions);
  const [showPreview, setShowPreview] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'build' | 'coding' | 'context' | 'sections'>('build');

  useEffect(() => {
    request<CustomInstructions>('/instructions')
      .then(data => setInstructions(data))
      .catch(() => {});
  }, []);

  const save = async () => {
    try {
      await request('/instructions', {
        method: 'PUT',
        body: JSON.stringify(instructions),
      });
      setSaveStatus('Saved!');
      setTimeout(() => setSaveStatus(null), 3000);
    } catch (err) {
      setSaveStatus(`Error: ${(err as Error).message}`);
    }
  };

  const loadExample = async () => {
    try {
      const data = await request<CustomInstructions>('/instructions/example');
      setInstructions(data);
      setSaveStatus('Loaded example. Edit and save to apply.');
      setTimeout(() => setSaveStatus(null), 4000);
    } catch (err) {
      setSaveStatus(`Error: ${(err as Error).message}`);
    }
  };

  const updateBuild = (field: keyof BuildSystem, value: string) => {
    setInstructions(prev => ({
      ...prev,
      buildSystem: { ...prev.buildSystem, [field]: value },
    }));
  };

  const updateCoding = (field: keyof CodingStandards, value: unknown) => {
    setInstructions(prev => ({
      ...prev,
      codingStandards: { ...prev.codingStandards, [field]: value },
    }));
  };

  const addContextItem = () => {
    setInstructions(prev => ({
      ...prev,
      projectContext: [...prev.projectContext, ''],
    }));
  };

  const updateContextItem = (index: number, value: string) => {
    setInstructions(prev => ({
      ...prev,
      projectContext: prev.projectContext.map((item, i) => i === index ? value : item),
    }));
  };

  const removeContextItem = (index: number) => {
    setInstructions(prev => ({
      ...prev,
      projectContext: prev.projectContext.filter((_, i) => i !== index),
    }));
  };

  const addSection = () => {
    setInstructions(prev => ({
      ...prev,
      additionalSections: [...prev.additionalSections, { title: '', items: [''] }],
    }));
  };

  const updateSection = (index: number, field: 'title', value: string) => {
    setInstructions(prev => ({
      ...prev,
      additionalSections: prev.additionalSections.map((s, i) =>
        i === index ? { ...s, [field]: value } : s
      ),
    }));
  };

  const addSectionItem = (sectionIndex: number) => {
    setInstructions(prev => ({
      ...prev,
      additionalSections: prev.additionalSections.map((s, i) =>
        i === sectionIndex ? { ...s, items: [...s.items, ''] } : s
      ),
    }));
  };

  const updateSectionItem = (sectionIndex: number, itemIndex: number, value: string) => {
    setInstructions(prev => ({
      ...prev,
      additionalSections: prev.additionalSections.map((s, i) =>
        i === sectionIndex
          ? { ...s, items: s.items.map((item, j) => j === itemIndex ? value : item) }
          : s
      ),
    }));
  };

  const removeSectionItem = (sectionIndex: number, itemIndex: number) => {
    setInstructions(prev => ({
      ...prev,
      additionalSections: prev.additionalSections.map((s, i) =>
        i === sectionIndex
          ? { ...s, items: s.items.filter((_, j) => j !== itemIndex) }
          : s
      ),
    }));
  };

  const removeSection = (index: number) => {
    setInstructions(prev => ({
      ...prev,
      additionalSections: prev.additionalSections.filter((_, i) => i !== index),
    }));
  };

  const tabs: Array<{ key: typeof activeTab; label: string }> = [
    { key: 'build', label: 'Build System' },
    { key: 'coding', label: 'Coding Standards' },
    { key: 'context', label: 'Project Context' },
    { key: 'sections', label: 'Additional Sections' },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Custom Instructions</h1>
          <p className="text-xs text-gray-400 mt-0.5">Local UI server · edits apply to this host only</p>
        </div>
        <div className="flex gap-2">
          <button onClick={loadExample} className="flex items-center gap-1 px-3 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600 text-sm">
            <RotateCcw size={14} /> Load Example
          </button>
          <button
            onClick={() => setShowPreview(!showPreview)}
            className={`flex items-center gap-1 px-3 py-2 rounded-lg text-sm ${showPreview ? 'bg-blue-600 text-white' : 'bg-gray-200 hover:bg-gray-300'}`}
          >
            <Eye size={14} /> Preview JSON
          </button>
          <button onClick={save} className="flex items-center gap-1 px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">
            <Save size={14} /> Save
          </button>
        </div>
      </div>

      {saveStatus && (
        <div className={`mb-4 p-3 rounded-lg text-sm ${saveStatus.startsWith('Error') ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
          {saveStatus}
        </div>
      )}

      {showPreview && (
        <div className="mb-4 bg-gray-900 text-green-400 p-4 rounded-xl font-mono text-xs max-h-64 overflow-auto">
          <pre>{JSON.stringify(instructions, null, 2)}</pre>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === tab.key
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-6">
        {activeTab === 'build' && (
          <div className="space-y-4">
            <p className="text-sm text-gray-500 mb-4">
              <FileText size={14} className="inline mr-1" />
              Configure the commands agents should use for building, testing, and linting your project.
            </p>
            {(['buildCommand', 'testCommand', 'lintCommand', 'formatCommand'] as const).map(field => (
              <label key={field} className="block">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-200 capitalize">
                  {field.replace(/([A-Z])/g, ' $1')}
                </span>
                <input
                  value={(instructions.buildSystem as Record<string, string>)?.[field] || ''}
                  onChange={(e) => updateBuild(field, e.target.value)}
                  placeholder={`e.g. ${field === 'buildCommand' ? 'npm run build' : field === 'testCommand' ? 'npm test' : field === 'lintCommand' ? 'npm run lint' : 'npm run format'}`}
                  className="input text-sm mt-1 font-mono"
                />
              </label>
            ))}
          </div>
        )}

        {activeTab === 'coding' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <label className="block">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-200">Language</span>
                <input
                  value={instructions.codingStandards?.language || ''}
                  onChange={(e) => updateCoding('language', e.target.value)}
                  placeholder="e.g. TypeScript"
                  className="input text-sm mt-1"
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-200">Description</span>
                <input
                  value={instructions.codingStandards?.description || ''}
                  onChange={(e) => updateCoding('description', e.target.value)}
                  placeholder="e.g. Mandatory quality gates..."
                  className="input text-sm mt-1"
                />
              </label>
            </div>

            <label className="block">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-200">Pre-Commit Checklist (one per line)</span>
              <textarea
                value={(instructions.codingStandards?.preCommitChecklist || []).join('\n')}
                onChange={(e) => updateCoding('preCommitChecklist', e.target.value.split('\n').filter(Boolean))}
                placeholder="1. npm run lint&#10;2. npm run build&#10;3. npm test"
                className="input text-sm mt-1 h-32 font-mono"
              />
            </label>
          </div>
        )}

        {activeTab === 'context' && (
          <div className="space-y-3">
            <p className="text-sm text-gray-500 mb-4">
              <FileText size={14} className="inline mr-1" />
              Provide project context items that help agents understand the project.
            </p>
            {instructions.projectContext.map((item, i) => (
              <div key={i} className="flex gap-2">
                <input
                  value={item}
                  onChange={(e) => updateContextItem(i, e.target.value)}
                  placeholder="e.g. Node.js REST API with Express and PostgreSQL"
                  className="input text-sm flex-1"
                />
                <button onClick={() => removeContextItem(i)} className="p-2 text-red-500 hover:bg-red-50 rounded">
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <button onClick={addContextItem} className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700">
              <Plus size={14} /> Add context item
            </button>
          </div>
        )}

        {activeTab === 'sections' && (
          <div className="space-y-6">
            <p className="text-sm text-gray-500 mb-4">
              <FileText size={14} className="inline mr-1" />
              Add custom sections with specific rules, guidelines, or notes for agents.
            </p>
            {instructions.additionalSections.map((section, si) => (
              <div key={si} className="border rounded-lg p-4">
                <div className="flex items-center gap-2 mb-3">
                  <input
                    value={section.title}
                    onChange={(e) => updateSection(si, 'title', e.target.value)}
                    placeholder="Section title"
                    className="input text-sm flex-1 font-medium"
                  />
                  <button onClick={() => removeSection(si)} className="p-2 text-red-500 hover:bg-red-50 rounded">
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="space-y-2">
                  {section.items.map((item, ii) => (
                    <div key={ii} className="flex gap-2">
                      <input
                        value={item}
                        onChange={(e) => updateSectionItem(si, ii, e.target.value)}
                        placeholder="Rule or guideline..."
                        className="input text-sm flex-1"
                      />
                      <button onClick={() => removeSectionItem(si, ii)} className="p-2 text-red-400 hover:bg-red-50 rounded">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                  <button onClick={() => addSectionItem(si)} className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700">
                    <Plus size={12} /> Add item
                  </button>
                </div>
              </div>
            ))}
            <button onClick={addSection} className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700">
              <Plus size={14} /> Add section
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
