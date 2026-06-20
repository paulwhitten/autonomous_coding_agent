import { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { a2aApi } from '../lib/api';
import { onA2AEvent } from '../lib/socket';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface A2AStatus {
  configured: boolean;
  serverPort: number;
  transport: string;
  agentCardPath: string;
  tls: { enabled: boolean };
  authentication: { scheme: string };
  pushNotifications: { enabled: boolean };
  knownAgentUrls: string[];
  registryUrl: string;
  auditDir: string;
  hostname: string;
  role: string;
  message?: string;
}

interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  inputModes?: string[];
  outputModes?: string[];
}

interface AgentCard {
  name: string;
  description: string;
  protocolVersion: string;
  version: string;
  url: string;
  skills: AgentSkill[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  provider: { organization: string; url?: string };
}

interface AuditEntry {
  id: string;
  timestamp: string;
  direction: 'inbound' | 'outbound';
  remoteAgent: string;
  method: string;
  status: string;
  durationMs: number;
  error?: string;
}

interface DiscoveredAgents {
  knownUrls: string[];
  teamAgents: Array<{
    hostname: string;
    role: string;
    uri: string;
    url: string;
    capabilities: string[];
  }>;
}

interface A2AConfigData {
  serverPort?: number;
  transport?: string;
  agentCardPath?: string;
  tls?: { enabled?: boolean };
  authentication?: { scheme?: string; token?: string };
  pushNotifications?: { enabled?: boolean };
  knownAgentUrls?: string[];
  registryUrl?: string;
  auditDir?: string;
}

interface ServerStatus {
  running: boolean;
  port?: number;
  protocol?: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusPanel({ status }: { status: A2AStatus }) {
  if (!status.configured) {
    return (
      <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
        <p className="text-yellow-800 dark:text-yellow-200 font-medium">No config file found</p>
        <p className="text-yellow-600 dark:text-yellow-400 text-sm mt-1">
          Create a config.json to enable A2A settings display.
        </p>
      </div>
    );
  }

  const items = [
    { label: 'Hostname', value: status.hostname },
    { label: 'Role', value: status.role },
    { label: 'Server Port', value: String(status.serverPort) },
    { label: 'Transport', value: status.transport },
    { label: 'Agent Card Path', value: status.agentCardPath },
    { label: 'TLS', value: status.tls.enabled ? 'Enabled' : 'Disabled' },
    { label: 'Authentication', value: status.authentication.scheme },
    { label: 'Push Notifications', value: status.pushNotifications.enabled ? 'Enabled' : 'Disabled' },
    { label: 'Registry URL', value: status.registryUrl || '(none)' },
    { label: 'Audit Directory', value: status.auditDir },
  ];

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">A2A Server Configuration</h3>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2">
        {items.map(({ label, value }) => (
          <div key={label} className="flex justify-between py-1 border-b border-gray-100 dark:border-gray-700">
            <dt className="text-sm text-gray-500 dark:text-gray-400">{label}</dt>
            <dd className="text-sm font-medium text-gray-900 dark:text-gray-100">{value}</dd>
          </div>
        ))}
      </dl>
      {status.knownAgentUrls.length > 0 && (
        <div className="mt-3">
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">Known Agent URLs</p>
          <div className="flex flex-wrap gap-1">
            {status.knownAgentUrls.map(url => (
              <span key={url} className="inline-block bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200 text-xs px-2 py-0.5 rounded">
                {url}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AgentCardPanel({ card }: { card: AgentCard }) {
  const [showRaw, setShowRaw] = useState(false);

  const exportCard = () => {
    const blob = new Blob([JSON.stringify(card, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${card.name || 'agent-card'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Local Agent Card</h3>
        <div className="flex items-center gap-2">
          <button
            onClick={exportCard}
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
          >
            Export JSON
          </button>
          <span className="text-gray-300 dark:text-gray-600">|</span>
          <button
            onClick={() => setShowRaw(!showRaw)}
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
          >
            {showRaw ? 'Formatted' : 'Raw JSON'}
          </button>
        </div>
      </div>

      {showRaw ? (
        <pre className="bg-gray-50 dark:bg-gray-900 rounded p-3 text-xs overflow-auto max-h-96 text-gray-800 dark:text-gray-200">
          {JSON.stringify(card, null, 2)}
        </pre>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400">Name</p>
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{card.name}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400">Version</p>
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{card.version}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400">Protocol Version</p>
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{card.protocolVersion}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400">Provider</p>
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{card.provider?.organization || 'N/A'}</p>
            </div>
          </div>

          <div>
            <p className="text-xs text-gray-500 dark:text-gray-400">Description</p>
            <p className="text-sm text-gray-700 dark:text-gray-300">{card.description}</p>
          </div>

          <div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Endpoint URL</p>
            <code className="text-xs bg-gray-100 dark:bg-gray-900 px-2 py-1 rounded text-gray-800 dark:text-gray-200">
              {card.url}
            </code>
          </div>

          <div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Input / Output Modes</p>
            <div className="flex gap-2 text-xs">
              <span className="text-gray-700 dark:text-gray-300">In: {(card.defaultInputModes || []).join(', ') || 'text/plain'}</span>
              <span className="text-gray-400">|</span>
              <span className="text-gray-700 dark:text-gray-300">Out: {(card.defaultOutputModes || []).join(', ') || 'text/plain'}</span>
            </div>
          </div>

          {card.skills?.length > 0 && (
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">Skills ({card.skills.length})</p>
              <div className="space-y-2">
                {card.skills.map(skill => (
                  <div key={skill.id} className="bg-gray-50 dark:bg-gray-900 rounded p-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{skill.name}</span>
                      <span className="text-xs text-gray-400">({skill.id})</span>
                    </div>
                    <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">{skill.description}</p>
                    {skill.tags?.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {skill.tags.map(tag => (
                          <span key={tag} className="bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 text-xs px-1.5 py-0.5 rounded">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DiscoveryPanel({ agents, onProbe }: { agents: DiscoveredAgents; onProbe: (url: string) => void }) {
  const [probeUrl, setProbeUrl] = useState('');
  const [probeAllResults, setProbeAllResults] = useState<Array<{ url: string; found: boolean; agentCard?: unknown; error?: string }> | null>(null);
  const [probingAll, setProbingAll] = useState(false);

  // Discovery state
  const [discoveryResults, setDiscoveryResults] = useState<Array<{
    url: string;
    found: boolean;
    card?: { name: string; description: string; version: string; protocolVersion: string; url: string; skills: Array<{ id: string; name: string; description: string; tags: string[] }>; provider: Record<string, unknown> };
    error?: string;
  }> | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryTimestamp, setDiscoveryTimestamp] = useState<string | null>(null);

  // Registry search state
  const [registryRole, setRegistryRole] = useState('');
  const [registryCapability, setRegistryCapability] = useState('');
  const [registryTag, setRegistryTag] = useState('');
  const [registryResults, setRegistryResults] = useState<Array<Record<string, unknown>> | null>(null);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [searchingRegistry, setSearchingRegistry] = useState(false);

  const allUrls = [
    ...(agents.teamAgents || []).map(a => a.url),
    ...(agents.knownUrls || []),
  ];

  const probeAll = async () => {
    if (allUrls.length === 0) return;
    setProbingAll(true);
    setProbeAllResults(null);
    try {
      const data = await a2aApi.probeAll(allUrls) as { results: Array<{ url: string; found: boolean; agentCard?: unknown; error?: string }> };
      setProbeAllResults(data.results);
    } catch {
      setProbeAllResults([]);
    } finally {
      setProbingAll(false);
    }
  };

  const runDiscovery = async () => {
    setDiscovering(true);
    setDiscoveryResults(null);
    try {
      const data = await a2aApi.discover() as {
        agents: Array<{ url: string; found: boolean; card?: Record<string, unknown>; error?: string }>;
        probed: number;
        found: number;
        timestamp: string;
      };
      setDiscoveryResults(data.agents as typeof discoveryResults);
      setDiscoveryTimestamp(data.timestamp);
    } catch {
      setDiscoveryResults([]);
    } finally {
      setDiscovering(false);
    }
  };

  const searchRegistry = async () => {
    if (!registryRole && !registryCapability && !registryTag) return;
    setSearchingRegistry(true);
    setRegistryResults(null);
    setRegistryError(null);
    try {
      const data = await a2aApi.registrySearch({
        role: registryRole || undefined,
        capability: registryCapability || undefined,
        tag: registryTag || undefined,
      }) as { agents: Array<Record<string, unknown>>; error?: string; registryUrl?: string };
      setRegistryResults(data.agents);
      if (data.error) setRegistryError(data.error);
    } catch (err) {
      setRegistryError((err as Error).message);
      setRegistryResults([]);
    } finally {
      setSearchingRegistry(false);
    }
  };

  const inputCls = "border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500";

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Agent Discovery</h3>
        <div className="flex items-center gap-2">
          {allUrls.length > 0 && (
            <button
              onClick={probeAll}
              disabled={probingAll}
              className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 px-2.5 py-1 rounded font-medium"
            >
              {probingAll ? 'Probing…' : `Probe All (${allUrls.length})`}
            </button>
          )}
          <button
            onClick={runDiscovery}
            disabled={discovering}
            className="text-xs bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 px-2.5 py-1 rounded font-medium"
          >
            {discovering ? 'Discovering…' : 'Run Discovery'}
          </button>
        </div>
      </div>

      {/* Probe form */}
      <div className="flex gap-2 mb-4">
        <input
          type="text"
          value={probeUrl}
          onChange={e => setProbeUrl(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && probeUrl.trim()) onProbe(probeUrl.trim()); }}
          placeholder="http://agent-host:4000"
          className={`flex-1 ${inputCls}`}
        />
        <button
          onClick={() => { if (probeUrl.trim()) onProbe(probeUrl.trim()); }}
          disabled={!probeUrl.trim()}
          className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white px-4 py-1.5 rounded text-sm font-medium"
        >
          Probe
        </button>
      </div>

      {/* Discovery Results — enriched agent cards */}
      {discoveryResults && (
        <div className="mb-4 bg-gray-50 dark:bg-gray-900 rounded-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <div>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Discovery Results — {discoveryResults.filter(r => r.found).length}/{discoveryResults.length} agents found
              </p>
              {discoveryTimestamp && (
                <p className="text-xs text-gray-400 mt-0.5">
                  Discovered at {new Date(discoveryTimestamp).toLocaleTimeString()}
                </p>
              )}
            </div>
            <button onClick={() => setDiscoveryResults(null)} className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">✕</button>
          </div>
          <div className="space-y-2">
            {discoveryResults.map(r => (
              <div key={r.url} className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className={`inline-block w-2 h-2 rounded-full ${r.found ? 'bg-green-500' : 'bg-red-400'}`} />
                    {r.found && r.card ? (
                      <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{r.card.name}</span>
                    ) : (
                      <code className="text-xs text-gray-500 dark:text-gray-400">{r.url}</code>
                    )}
                  </div>
                  {r.found && (
                    <button
                      onClick={() => onProbe(r.url)}
                      className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      Details
                    </button>
                  )}
                </div>
                {r.found && r.card ? (
                  <div className="ml-4">
                    <p className="text-xs text-gray-500 dark:text-gray-400">{r.card.description}</p>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1 text-xs text-gray-500 dark:text-gray-400">
                      <span>v{r.card.version}</span>
                      {r.card.protocolVersion && <span>Protocol: {r.card.protocolVersion}</span>}
                      <code className="text-gray-400">{r.card.url}</code>
                    </div>
                    {r.card.skills && r.card.skills.length > 0 && (
                      <div className="mt-2">
                        <p className="text-xs text-gray-500 dark:text-gray-400 font-medium mb-1">
                          Skills ({r.card.skills.length})
                        </p>
                        <div className="flex flex-wrap gap-1">
                          {r.card.skills.map((s: { id: string; name: string; tags?: string[] }) => (
                            <span
                              key={s.id}
                              className="inline-block bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200 text-xs px-2 py-0.5 rounded"
                              title={s.name}
                            >
                              {s.name}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-red-500 dark:text-red-400 ml-4">{r.error || 'Not found'}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Registry Search */}
      <div className="mb-4 border border-gray-200 dark:border-gray-700 rounded-lg p-3">
        <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Registry Search</p>
        <p className="text-xs text-gray-400 dark:text-gray-500 mb-2">
          Search an A2A agent registry by role, capability, or tag. Requires <code className="text-xs">registryUrl</code> in A2A config.
        </p>
        <div className="flex flex-wrap gap-2 items-end">
          <div>
            <label className="text-xs text-gray-500 dark:text-gray-400 block mb-0.5">Role</label>
            <input type="text" className={inputCls} value={registryRole} placeholder="developer"
              onChange={e => setRegistryRole(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-gray-500 dark:text-gray-400 block mb-0.5">Capability</label>
            <input type="text" className={inputCls} value={registryCapability} placeholder="code-review"
              onChange={e => setRegistryCapability(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-gray-500 dark:text-gray-400 block mb-0.5">Tag</label>
            <input type="text" className={inputCls} value={registryTag} placeholder="python"
              onChange={e => setRegistryTag(e.target.value)} />
          </div>
          <button
            onClick={searchRegistry}
            disabled={searchingRegistry || (!registryRole && !registryCapability && !registryTag)}
            className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white px-3 py-1 rounded text-sm font-medium"
          >
            {searchingRegistry ? 'Searching…' : 'Search'}
          </button>
        </div>

        {registryError && (
          <p className="text-xs text-yellow-600 dark:text-yellow-400 mt-2">{registryError}</p>
        )}

        {registryResults && registryResults.length > 0 && (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-gray-500 dark:text-gray-400">Found {registryResults.length} agent(s)</p>
            {registryResults.map((agent, i) => (
              <div key={i} className="bg-gray-50 dark:bg-gray-900 rounded p-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {String(agent.name || 'Unknown')}
                  </span>
                  {Boolean(agent.url) && (
                    <button
                      onClick={() => onProbe(agent.url as string)}
                      className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      Probe
                    </button>
                  )}
                </div>
                {Boolean(agent.description) && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{String(agent.description)}</p>
                )}
                {Boolean(agent.url) && (
                  <code className="text-xs text-gray-400 mt-0.5 block">{String(agent.url)}</code>
                )}
              </div>
            ))}
          </div>
        )}
        {registryResults && registryResults.length === 0 && !registryError && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 italic">No agents matched the search criteria.</p>
        )}
      </div>

      {/* Probe All results */}
      {probeAllResults && (
        <div className="mb-4 bg-gray-50 dark:bg-gray-900 rounded-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Batch Probe Results — {probeAllResults.filter(r => r.found).length}/{probeAllResults.length} found
            </p>
            <button onClick={() => setProbeAllResults(null)} className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">✕</button>
          </div>
          <div className="space-y-1">
            {probeAllResults.map(r => (
              <div key={r.url} className="flex items-center gap-2 text-xs py-1">
                <span className={`inline-block w-2 h-2 rounded-full ${r.found ? 'bg-green-500' : 'bg-red-400'}`} />
                <code className="text-gray-700 dark:text-gray-300 flex-1 truncate">{r.url}</code>
                {r.found ? (
                  <span className="text-green-600 dark:text-green-400 font-medium">Found</span>
                ) : (
                  <span className="text-red-500 dark:text-red-400">{r.error || 'Not found'}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Team agents with A2A URIs */}
      {(agents.teamAgents || []).length > 0 && (
        <div className="mb-4">
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">Team Agents (A2A Transport)</p>
          <div className="space-y-2">
            {(agents.teamAgents || []).map(agent => (
              <div
                key={`${agent.hostname}-${agent.role}`}
                className="flex items-center justify-between bg-gray-50 dark:bg-gray-900 rounded p-2"
              >
                <div>
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {agent.hostname}
                  </span>
                  <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">({agent.role})</span>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    <code>{agent.uri}</code>
                  </div>
                </div>
                <button
                  onClick={() => onProbe(agent.url)}
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                >
                  Probe
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Known URLs from config */}
      {(agents.knownUrls || []).length > 0 && (
        <div>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">Known Agent URLs (from config)</p>
          <div className="space-y-1">
            {(agents.knownUrls || []).map(url => (
              <div key={url} className="flex items-center justify-between bg-gray-50 dark:bg-gray-900 rounded px-2 py-1">
                <code className="text-xs text-gray-700 dark:text-gray-300">{url}</code>
                <button
                  onClick={() => onProbe(url)}
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline ml-2"
                >
                  Probe
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {(agents.teamAgents || []).length === 0 && (agents.knownUrls || []).length === 0 && (
        <p className="text-sm text-gray-500 dark:text-gray-400 italic">
          No known agents configured. Add <code className="text-xs">knownAgentUrls</code> to config or set <code className="text-xs">uri</code> fields on team agents.
        </p>
      )}
    </div>
  );
}

function ProbeResultPanel({ result, onClose }: { result: Record<string, unknown> | null; onClose: () => void }) {
  if (!result) return null;

  const found = result.found as boolean;
  const error = result.error as string | undefined;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Probe Result</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-sm">✕</button>
      </div>
      {found ? (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="inline-block w-2 h-2 bg-green-500 rounded-full" />
            <span className="text-sm text-green-700 dark:text-green-400 font-medium">Agent found</span>
            <span className="text-xs text-gray-400">{result.url as string}</span>
          </div>
          <pre className="bg-gray-50 dark:bg-gray-900 rounded p-3 text-xs overflow-auto max-h-64 text-gray-800 dark:text-gray-200">
            {JSON.stringify(result.agentCard, null, 2)}
          </pre>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="inline-block w-2 h-2 bg-red-500 rounded-full" />
          <span className="text-sm text-red-700 dark:text-red-400 font-medium">Not found</span>
          {error && <span className="text-xs text-gray-500 dark:text-gray-400">— {error}</span>}
        </div>
      )}
    </div>
  );
}

function AuditPanel() {
  const [direction, setDirection] = useState<string>('');
  const [remoteAgent, setRemoteAgent] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [pageSize, setPageSize] = useState(25);
  const [offset, setOffset] = useState(0);

  const auditQuery = useQuery({
    queryKey: ['a2a', 'audit', { direction, remoteAgent, startDate, endDate, pageSize, offset }],
    queryFn: () => a2aApi.audit({
      limit: pageSize,
      offset,
      direction: direction || undefined,
      remoteAgent: remoteAgent || undefined,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
    }),
    refetchInterval: 10_000,
  });

  const data = auditQuery.data as { entries: AuditEntry[]; total: number; offset: number; limit: number } | undefined;
  const entries = data?.entries ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.floor(offset / pageSize) + 1;

  const exportUrl = (format: string) =>
    a2aApi.auditExport({
      format,
      direction: direction || undefined,
      remoteAgent: remoteAgent || undefined,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
    });

  // Listen for real-time audit events
  useEffect(() => {
    const unsub = onA2AEvent('a2a:message-sent', () => {
      auditQuery.refetch();
    });
    return unsub;
  }, [auditQuery]);

  const inputCls = "border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-xs bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500";

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Audit Log</h3>
        <div className="flex items-center gap-2">
          <a href={exportUrl('json')} download className="text-xs text-blue-600 dark:text-blue-400 hover:underline">JSON</a>
          <span className="text-gray-300 dark:text-gray-600">|</span>
          <a href={exportUrl('csv')} download className="text-xs text-blue-600 dark:text-blue-400 hover:underline">CSV</a>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4 items-end">
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 block mb-0.5">Direction</label>
          <select className={inputCls} value={direction} onChange={e => { setDirection(e.target.value); setOffset(0); }}>
            <option value="">All</option>
            <option value="inbound">Inbound</option>
            <option value="outbound">Outbound</option>
          </select>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 block mb-0.5">Remote Agent</label>
          <input type="text" className={inputCls} value={remoteAgent} placeholder="Filter…"
            onChange={e => { setRemoteAgent(e.target.value); setOffset(0); }} />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 block mb-0.5">Start Date</label>
          <input type="date" className={inputCls} value={startDate}
            onChange={e => { setStartDate(e.target.value); setOffset(0); }} />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 block mb-0.5">End Date</label>
          <input type="date" className={inputCls} value={endDate}
            onChange={e => { setEndDate(e.target.value); setOffset(0); }} />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 block mb-0.5">Per Page</label>
          <select className={inputCls} value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setOffset(0); }}>
            <option value={10}>10</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </div>
        {(direction || remoteAgent || startDate || endDate) && (
          <button
            onClick={() => { setDirection(''); setRemoteAgent(''); setStartDate(''); setEndDate(''); setOffset(0); }}
            className="text-xs text-gray-500 dark:text-gray-400 hover:text-red-500 dark:hover:text-red-400 py-1"
          >
            Clear filters
          </button>
        )}
      </div>

      {entries.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 italic">
          {total === 0 ? 'No audit entries found. A2A interactions will appear here when agents communicate.' : 'No entries match the current filters.'}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                  <th className="pb-2 pr-4">Time</th>
                  <th className="pb-2 pr-4">Direction</th>
                  <th className="pb-2 pr-4">Remote Agent</th>
                  <th className="pb-2 pr-4">Method</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2">Duration</th>
                </tr>
              </thead>
              <tbody>
                {entries.map(entry => (
                  <tr key={entry.id} className="border-b border-gray-100 dark:border-gray-700/50">
                    <td className="py-1.5 pr-4 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                      {new Date(entry.timestamp).toLocaleString()}
                    </td>
                    <td className="py-1.5 pr-4">
                      <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                        entry.direction === 'inbound'
                          ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                          : 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'
                      }`}>
                        {entry.direction === 'inbound' ? '← In' : '→ Out'}
                      </span>
                    </td>
                    <td className="py-1.5 pr-4 text-gray-900 dark:text-gray-100">{entry.remoteAgent}</td>
                    <td className="py-1.5 pr-4 font-mono text-xs text-gray-700 dark:text-gray-300">{entry.method}</td>
                    <td className="py-1.5 pr-4">
                      <span className={`text-xs ${
                        entry.status === 'success'
                          ? 'text-green-600 dark:text-green-400'
                          : 'text-red-600 dark:text-red-400'
                      }`}>
                        {entry.status}
                      </span>
                      {entry.error && <span className="text-xs text-red-500 ml-1">({entry.error})</span>}
                    </td>
                    <td className="py-1.5 text-xs text-gray-500 dark:text-gray-400">{entry.durationMs}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between mt-3 text-xs text-gray-500 dark:text-gray-400">
            <span>
              Showing {offset + 1}–{Math.min(offset + pageSize, total)} of {total}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setOffset(Math.max(0, offset - pageSize))}
                disabled={offset === 0}
                className="px-2 py-1 rounded bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-40"
              >
                ← Prev
              </button>
              <span>Page {currentPage} of {totalPages}</span>
              <button
                onClick={() => setOffset(offset + pageSize)}
                disabled={offset + pageSize >= total}
                className="px-2 py-1 rounded bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-40"
              >
                Next →
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Config Editor
// ---------------------------------------------------------------------------

function ConfigEditorPanel({ onSaved }: { onSaved: () => void }) {
  const [config, setConfig] = useState<A2AConfigData>({});
  const [configFile, setConfigFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [newUrl, setNewUrl] = useState('');

  useEffect(() => {
    a2aApi.config().then(data => {
      const d = data as { a2aConfig: A2AConfigData; configFile: string | null };
      setConfig(d.a2aConfig || {});
      setConfigFile(d.configFile);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      await a2aApi.saveConfig(config);
      setStatus({ type: 'success', msg: 'Saved' });
      onSaved();
      setTimeout(() => setStatus(null), 3000);
    } catch (err) {
      setStatus({ type: 'error', msg: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const addUrl = () => {
    if (!newUrl.trim()) return;
    const urls = config.knownAgentUrls || [];
    if (!urls.includes(newUrl.trim())) {
      setConfig({ ...config, knownAgentUrls: [...urls, newUrl.trim()] });
    }
    setNewUrl('');
  };

  const removeUrl = (url: string) => {
    setConfig({ ...config, knownAgentUrls: (config.knownAgentUrls || []).filter(u => u !== url) });
  };

  if (loading) return null;
  if (!configFile) {
    return (
      <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
        <p className="text-yellow-800 dark:text-yellow-200 text-sm">No config file found. Create one on the Configuration page first.</p>
      </div>
    );
  }

  const inputCls = "w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500";
  const labelCls = "text-xs font-medium text-gray-700 dark:text-gray-300";

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">A2A Configuration</h3>
        <div className="flex items-center gap-2">
          {status && (
            <span className={`text-xs ${status.type === 'success' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
              {status.msg}
            </span>
          )}
          <button
            onClick={save}
            disabled={saving}
            className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white px-3 py-1 rounded text-sm font-medium"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelCls}>Server Port</label>
          <input type="number" className={inputCls} value={config.serverPort ?? 4000}
            onChange={e => setConfig({ ...config, serverPort: parseInt(e.target.value) || 4000 })} />
        </div>
        <div>
          <label className={labelCls}>Transport</label>
          <select className={inputCls} value={config.transport ?? 'jsonrpc'}
            onChange={e => setConfig({ ...config, transport: e.target.value })}>
            <option value="jsonrpc">JSON-RPC</option>
            <option value="rest">REST</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>Agent Card Path</label>
          <input type="text" className={inputCls} value={config.agentCardPath ?? '/.well-known/agent-card.json'}
            onChange={e => setConfig({ ...config, agentCardPath: e.target.value })} />
        </div>
        <div>
          <label className={labelCls}>Audit Directory</label>
          <input type="text" className={inputCls} value={config.auditDir ?? 'audit/a2a'}
            onChange={e => setConfig({ ...config, auditDir: e.target.value })} />
        </div>
        <div>
          <label className={labelCls}>Authentication Scheme</label>
          <select className={inputCls} value={config.authentication?.scheme ?? 'none'}
            onChange={e => setConfig({ ...config, authentication: { ...config.authentication, scheme: e.target.value } })}>
            <option value="none">None</option>
            <option value="bearer">Bearer Token</option>
            <option value="apiKey">API Key</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>Registry URL</label>
          <input type="text" className={inputCls} value={config.registryUrl ?? ''}
            placeholder="(optional)"
            onChange={e => setConfig({ ...config, registryUrl: e.target.value })} />
        </div>
        <div className="flex items-center gap-2">
          <input type="checkbox" id="tls-enabled" checked={config.tls?.enabled ?? false}
            onChange={e => setConfig({ ...config, tls: { ...config.tls, enabled: e.target.checked } })} />
          <label htmlFor="tls-enabled" className={labelCls}>TLS Enabled</label>
        </div>
        <div className="flex items-center gap-2">
          <input type="checkbox" id="push-enabled" checked={config.pushNotifications?.enabled ?? false}
            onChange={e => setConfig({ ...config, pushNotifications: { ...config.pushNotifications, enabled: e.target.checked } })} />
          <label htmlFor="push-enabled" className={labelCls}>Push Notifications</label>
        </div>
      </div>

      {/* Known Agent URLs */}
      <div className="mt-4">
        <label className={labelCls}>Known Agent URLs</label>
        <div className="flex gap-2 mt-1">
          <input type="text" className={`flex-1 ${inputCls}`} value={newUrl}
            placeholder="http://agent-host:4000"
            onChange={e => setNewUrl(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addUrl(); }} />
          <button onClick={addUrl} disabled={!newUrl.trim()}
            className="bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-50 text-gray-700 dark:text-gray-200 px-3 py-1 rounded text-sm">
            Add
          </button>
        </div>
        {(config.knownAgentUrls || []).length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {config.knownAgentUrls!.map(url => (
              <span key={url} className="inline-flex items-center gap-1 bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200 text-xs px-2 py-0.5 rounded">
                {url}
                <button onClick={() => removeUrl(url)} className="hover:text-red-600 dark:hover:text-red-400">✕</button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent Card Editor
// ---------------------------------------------------------------------------

interface AgentCardOverrides {
  name?: string;
  description?: string;
  version?: string;
  provider?: { organization?: string; url?: string };
  skills?: Array<{ id: string; name: string; description: string; tags: string[] }>;
  inputModes?: string[];
  outputModes?: string[];
}

function AgentCardEditorPanel({ onSaved }: { onSaved: () => void }) {
  const [overrides, setOverrides] = useState<AgentCardOverrides>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [newSkill, setNewSkill] = useState({ id: '', name: '', description: '', tags: '' });
  const [newInputMode, setNewInputMode] = useState('');
  const [newOutputMode, setNewOutputMode] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  useEffect(() => {
    a2aApi.config().then(data => {
      const d = data as { a2aConfig: Record<string, unknown> };
      const card = (d.a2aConfig?.agentCard || {}) as AgentCardOverrides;
      setOverrides(card);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const configData = await a2aApi.config() as { a2aConfig: Record<string, unknown> };
      const updated = { ...configData.a2aConfig, agentCard: overrides };
      await a2aApi.saveConfig(updated);
      setStatus({ type: 'success', msg: 'Saved' });
      onSaved();
      setTimeout(() => setStatus(null), 3000);
    } catch (err) {
      setStatus({ type: 'error', msg: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const loadPreview = async () => {
    if (showPreview) {
      setShowPreview(false);
      return;
    }
    setPreviewLoading(true);
    try {
      const data = await a2aApi.agentCardPreview() as { mergedCard: Record<string, unknown> };
      setPreview(data.mergedCard);
      setShowPreview(true);
    } catch {
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  const addSkill = () => {
    if (!newSkill.id.trim() || !newSkill.name.trim()) return;
    const skills = overrides.skills || [];
    if (skills.some(s => s.id === newSkill.id.trim())) return;
    setOverrides({
      ...overrides,
      skills: [...skills, {
        id: newSkill.id.trim(),
        name: newSkill.name.trim(),
        description: newSkill.description.trim(),
        tags: newSkill.tags.split(',').map(t => t.trim()).filter(Boolean),
      }],
    });
    setNewSkill({ id: '', name: '', description: '', tags: '' });
  };

  const removeSkill = (id: string) => {
    setOverrides({ ...overrides, skills: (overrides.skills || []).filter(s => s.id !== id) });
  };

  const addMode = (type: 'input' | 'output') => {
    const value = type === 'input' ? newInputMode.trim() : newOutputMode.trim();
    if (!value) return;
    const key = type === 'input' ? 'inputModes' : 'outputModes';
    const existing = overrides[key] || [];
    if (!existing.includes(value)) {
      setOverrides({ ...overrides, [key]: [...existing, value] });
    }
    type === 'input' ? setNewInputMode('') : setNewOutputMode('');
  };

  const removeMode = (type: 'input' | 'output', mode: string) => {
    const key = type === 'input' ? 'inputModes' : 'outputModes';
    setOverrides({ ...overrides, [key]: (overrides[key] || []).filter(m => m !== mode) });
  };

  if (loading) return null;

  const inputCls = "w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500";
  const labelCls = "text-xs font-medium text-gray-700 dark:text-gray-300";

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Agent Card Overrides</h3>
        <div className="flex items-center gap-2">
          {status && (
            <span className={`text-xs ${status.type === 'success' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
              {status.msg}
            </span>
          )}
          <button onClick={loadPreview} disabled={previewLoading}
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
            {previewLoading ? 'Loading…' : showPreview ? 'Hide Preview' : 'Preview Merged Card'}
          </button>
          <button onClick={save} disabled={saving}
            className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white px-3 py-1 rounded text-sm font-medium">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
        Override the auto-generated agent card fields. Empty fields use defaults derived from agent config.
      </p>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelCls}>Name</label>
          <input type="text" className={inputCls} value={overrides.name ?? ''} placeholder="(auto: hostname_role)"
            onChange={e => setOverrides({ ...overrides, name: e.target.value || undefined })} />
        </div>
        <div>
          <label className={labelCls}>Version</label>
          <input type="text" className={inputCls} value={overrides.version ?? ''} placeholder="1.0.0"
            onChange={e => setOverrides({ ...overrides, version: e.target.value || undefined })} />
        </div>
        <div className="col-span-2">
          <label className={labelCls}>Description</label>
          <input type="text" className={inputCls} value={overrides.description ?? ''} placeholder="(auto: Autonomous role agent)"
            onChange={e => setOverrides({ ...overrides, description: e.target.value || undefined })} />
        </div>
        <div>
          <label className={labelCls}>Provider Organization</label>
          <input type="text" className={inputCls} value={overrides.provider?.organization ?? ''}
            onChange={e => setOverrides({ ...overrides, provider: { ...overrides.provider, organization: e.target.value || undefined } })} />
        </div>
        <div>
          <label className={labelCls}>Provider URL</label>
          <input type="text" className={inputCls} value={overrides.provider?.url ?? ''} placeholder="https://…"
            onChange={e => setOverrides({ ...overrides, provider: { ...overrides.provider, url: e.target.value || undefined } })} />
        </div>
      </div>

      {/* Input/Output Modes */}
      <div className="grid grid-cols-2 gap-4 mt-4">
        <div>
          <label className={labelCls}>Input Modes</label>
          <div className="flex gap-1 mt-1">
            <input type="text" className={`flex-1 ${inputCls}`} value={newInputMode} placeholder="text/plain"
              onChange={e => setNewInputMode(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addMode('input'); }} />
            <button onClick={() => addMode('input')} disabled={!newInputMode.trim()}
              className="bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-50 text-gray-700 dark:text-gray-200 px-2 py-1 rounded text-xs">
              Add
            </button>
          </div>
          {(overrides.inputModes || []).length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {overrides.inputModes!.map(m => (
                <span key={m} className="inline-flex items-center gap-1 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 text-xs px-2 py-0.5 rounded">
                  {m}
                  <button onClick={() => removeMode('input', m)} className="hover:text-red-600 dark:hover:text-red-400">✕</button>
                </span>
              ))}
            </div>
          )}
        </div>
        <div>
          <label className={labelCls}>Output Modes</label>
          <div className="flex gap-1 mt-1">
            <input type="text" className={`flex-1 ${inputCls}`} value={newOutputMode} placeholder="text/plain"
              onChange={e => setNewOutputMode(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addMode('output'); }} />
            <button onClick={() => addMode('output')} disabled={!newOutputMode.trim()}
              className="bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-50 text-gray-700 dark:text-gray-200 px-2 py-1 rounded text-xs">
              Add
            </button>
          </div>
          {(overrides.outputModes || []).length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {overrides.outputModes!.map(m => (
                <span key={m} className="inline-flex items-center gap-1 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 text-xs px-2 py-0.5 rounded">
                  {m}
                  <button onClick={() => removeMode('output', m)} className="hover:text-red-600 dark:hover:text-red-400">✕</button>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Custom Skills */}
      <div className="mt-4">
        <label className={labelCls}>Custom Skills</label>
        <div className="grid grid-cols-4 gap-2 mt-1">
          <input type="text" className={inputCls} value={newSkill.id} placeholder="skill-id"
            onChange={e => setNewSkill({ ...newSkill, id: e.target.value })} />
          <input type="text" className={inputCls} value={newSkill.name} placeholder="Skill Name"
            onChange={e => setNewSkill({ ...newSkill, name: e.target.value })} />
          <input type="text" className={inputCls} value={newSkill.description} placeholder="Description"
            onChange={e => setNewSkill({ ...newSkill, description: e.target.value })} />
          <div className="flex gap-1">
            <input type="text" className={`flex-1 ${inputCls}`} value={newSkill.tags} placeholder="tag1, tag2"
              onChange={e => setNewSkill({ ...newSkill, tags: e.target.value })}
              onKeyDown={e => { if (e.key === 'Enter') addSkill(); }} />
            <button onClick={addSkill} disabled={!newSkill.id.trim() || !newSkill.name.trim()}
              className="bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-50 text-gray-700 dark:text-gray-200 px-2 py-1 rounded text-xs">
              Add
            </button>
          </div>
        </div>
        {(overrides.skills || []).length > 0 && (
          <div className="space-y-2 mt-2">
            {overrides.skills!.map(skill => (
              <div key={skill.id} className="flex items-start justify-between bg-gray-50 dark:bg-gray-900 rounded p-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{skill.name}</span>
                    <span className="text-xs text-gray-400">({skill.id})</span>
                  </div>
                  {skill.description && <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">{skill.description}</p>}
                  {skill.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {skill.tags.map(tag => (
                        <span key={tag} className="bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 text-xs px-1.5 py-0.5 rounded">{tag}</span>
                      ))}
                    </div>
                  )}
                </div>
                <button onClick={() => removeSkill(skill.id)}
                  className="text-xs text-gray-400 hover:text-red-500 dark:hover:text-red-400 ml-2">✕</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Merged Card Preview */}
      {showPreview && preview && (
        <div className="mt-4 bg-gray-50 dark:bg-gray-900 rounded-lg p-3">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Merged Agent Card Preview (saved overrides + auto-generated defaults):</p>
          <pre className="text-xs overflow-auto max-h-64 text-gray-800 dark:text-gray-200">
            {JSON.stringify(preview, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Send A2A Message
// ---------------------------------------------------------------------------

function SendMessagePanel({ knownUrls, teamAgents }: {
  knownUrls: string[];
  teamAgents: Array<{ hostname: string; role: string; url: string }>;
}) {
  const [targetUrl, setTargetUrl] = useState('');
  const [subject, setSubject] = useState('');
  const [content, setContent] = useState('');
  const [priority, setPriority] = useState('NORMAL');
  const [result, setResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [sending, setSending] = useState(false);

  const allTargets = [
    ...teamAgents.map(a => ({ label: `${a.hostname} (${a.role})`, url: a.url })),
    ...knownUrls.map(u => ({ label: u, url: u })),
  ];

  const send = async () => {
    if (!targetUrl || !content) return;
    setSending(true);
    setResult(null);
    try {
      const data = await a2aApi.send(targetUrl, { subject, content, priority });
      setResult(data as { success: boolean; error?: string });
      if ((data as { success: boolean }).success) {
        setContent('');
        setSubject('');
      }
    } catch (err) {
      setResult({ success: false, error: (err as Error).message });
    } finally {
      setSending(false);
    }
  };

  const inputCls = "w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500";

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">Send A2A Message</h3>

      <div className="space-y-3">
        <div>
          <label className="text-xs font-medium text-gray-700 dark:text-gray-300">Target Agent</label>
          {allTargets.length > 0 ? (
            <select className={inputCls} value={targetUrl}
              onChange={e => setTargetUrl(e.target.value)}>
              <option value="">Select a target…</option>
              {allTargets.map(t => (
                <option key={t.url} value={t.url}>{t.label}</option>
              ))}
              <option value="__custom__">Custom URL…</option>
            </select>
          ) : (
            <input type="text" className={inputCls} value={targetUrl}
              placeholder="http://agent-host:4000"
              onChange={e => setTargetUrl(e.target.value)} />
          )}
          {targetUrl === '__custom__' && (
            <input type="text" className={`${inputCls} mt-1`}
              placeholder="http://agent-host:4000"
              onChange={e => setTargetUrl(e.target.value)} />
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-gray-700 dark:text-gray-300">Subject</label>
            <input type="text" className={inputCls} value={subject}
              placeholder="(optional)"
              onChange={e => setSubject(e.target.value)} />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-700 dark:text-gray-300">Priority</label>
            <select className={inputCls} value={priority}
              onChange={e => setPriority(e.target.value)}>
              <option value="HIGH">High</option>
              <option value="NORMAL">Normal</option>
              <option value="LOW">Low</option>
            </select>
          </div>
        </div>

        <div>
          <label className="text-xs font-medium text-gray-700 dark:text-gray-300">Message Content</label>
          <textarea className={`${inputCls} h-24 resize-y`} value={content}
            placeholder="Enter message content…"
            onChange={e => setContent(e.target.value)} />
        </div>

        <div className="flex items-center justify-between">
          <button
            onClick={send}
            disabled={sending || !targetUrl || targetUrl === '__custom__' || !content}
            className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white px-4 py-1.5 rounded text-sm font-medium"
          >
            {sending ? 'Sending…' : 'Send Message'}
          </button>
          {result && (
            <span className={`text-xs ${result.success ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
              {result.success ? 'Message sent successfully' : `Failed: ${result.error || 'Unknown error'}`}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connection Health Monitor
// ---------------------------------------------------------------------------

interface HealthResult {
  url: string;
  status: 'healthy' | 'unhealthy' | 'unreachable' | 'error';
  latencyMs: number;
  error?: string;
  httpStatus?: number;
}

function HealthCheckPanel() {
  const [results, setResults] = useState<HealthResult[]>([]);
  const [checking, setChecking] = useState(false);
  const [lastCheck, setLastCheck] = useState<string | null>(null);

  // Listen for real-time health-check events
  useEffect(() => {
    const unsub = onA2AEvent('a2a:health-check', (data) => {
      const d = data as { results: HealthResult[]; timestamp: string };
      setResults(d.results);
      setLastCheck(d.timestamp);
    });
    return unsub;
  }, []);

  const runCheck = async () => {
    setChecking(true);
    try {
      const data = await a2aApi.healthCheck() as { results: HealthResult[]; timestamp: string };
      setResults(data.results);
      setLastCheck(data.timestamp);
    } catch { /* ignore */ }
    setChecking(false);
  };

  const statusColor = (s: string) => {
    switch (s) {
      case 'healthy': return 'bg-green-500';
      case 'unhealthy': return 'bg-yellow-500';
      default: return 'bg-red-400';
    }
  };

  const statusLabel = (s: string) => {
    switch (s) {
      case 'healthy': return 'text-green-700 dark:text-green-400';
      case 'unhealthy': return 'text-yellow-700 dark:text-yellow-400';
      default: return 'text-red-600 dark:text-red-400';
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Connection Health</h3>
        <div className="flex items-center gap-3">
          {lastCheck && (
            <span className="text-xs text-gray-400 dark:text-gray-500">
              Last: {new Date(lastCheck).toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={runCheck}
            disabled={checking}
            className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white px-3 py-1 rounded text-sm font-medium"
          >
            {checking ? 'Checking…' : 'Run Health Check'}
          </button>
        </div>
      </div>

      {results.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 italic">
          Click "Run Health Check" to probe all known agents for health and latency.
        </p>
      ) : (
        <div className="space-y-2">
          {results.map(r => (
            <div key={r.url} className="flex items-center justify-between bg-gray-50 dark:bg-gray-900 rounded p-2">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${statusColor(r.status)}`} />
                <code className="text-xs text-gray-700 dark:text-gray-300 truncate">{r.url}</code>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0 ml-3">
                <span className={`text-xs font-medium capitalize ${statusLabel(r.status)}`}>
                  {r.status}
                </span>
                <span className="text-xs text-gray-500 dark:text-gray-400 w-16 text-right">
                  {r.latencyMs}ms
                </span>
              </div>
            </div>
          ))}
          <div className="text-xs text-gray-400 text-right mt-1">
            {results.filter(r => r.status === 'healthy').length}/{results.length} healthy
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live Server Status Badge
// ---------------------------------------------------------------------------

function ServerStatusBadge() {
  const { data, isLoading } = useQuery({
    queryKey: ['a2a', 'server-status'],
    queryFn: () => a2aApi.serverStatus(),
    refetchInterval: 15_000,
  });

  const status = data as ServerStatus | undefined;

  if (isLoading) {
    return <span className="inline-block w-2 h-2 bg-gray-400 rounded-full animate-pulse" title="Checking…" />;
  }

  if (status?.running) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-green-700 dark:text-green-400">
        <span className="inline-block w-2 h-2 bg-green-500 rounded-full" />
        A2A Server running on port {status.port}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
      <span className="inline-block w-2 h-2 bg-gray-400 rounded-full" />
      A2A Server not running{status?.reason ? ` — ${status.reason}` : ''}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function A2APage() {
  const queryClient = useQueryClient();
  const [probeResult, setProbeResult] = useState<Record<string, unknown> | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'config' | 'messaging'>('overview');

  const statusQuery = useQuery({
    queryKey: ['a2a', 'status'],
    queryFn: () => a2aApi.status(),
  });

  const cardQuery = useQuery({
    queryKey: ['a2a', 'agent-card'],
    queryFn: () => a2aApi.agentCard(),
  });

  const discoveredQuery = useQuery({
    queryKey: ['a2a', 'discovered-agents'],
    queryFn: () => a2aApi.discoveredAgents(),
  });

  const probeMutation = useMutation({
    mutationFn: (url: string) => a2aApi.probe(url),
    onSuccess: (data) => setProbeResult(data),
  });

  // Listen for WebSocket server-status and discovery events
  useEffect(() => {
    const unsub1 = onA2AEvent('a2a:server-status', () => {
      queryClient.invalidateQueries({ queryKey: ['a2a', 'server-status'] });
    });
    const unsub2 = onA2AEvent('a2a:discovery-complete', () => {
      queryClient.invalidateQueries({ queryKey: ['a2a', 'discovered-agents'] });
    });
    return () => { unsub1(); unsub2(); };
  }, [queryClient]);

  const status = statusQuery.data as A2AStatus | undefined;
  const card = (cardQuery.data as { agentCard: AgentCard } | undefined)?.agentCard;
  const agents = discoveredQuery.data as DiscoveredAgents | undefined;

  const tabs = [
    { id: 'overview' as const, label: 'Overview' },
    { id: 'config' as const, label: 'Configuration' },
    { id: 'messaging' as const, label: 'Messaging' },
  ];

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">A2A Protocol</h2>
            <ServerStatusBadge />
          </div>
          <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">
            Agent-to-Agent protocol configuration, discovery, and communication
          </p>
        </div>
        <button
          onClick={() => queryClient.invalidateQueries({ queryKey: ['a2a'] })}
          className="bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600
                     text-gray-700 dark:text-gray-200 px-3 py-1.5 rounded text-sm"
        >
          Refresh
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === tab.id
                ? 'border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {statusQuery.isLoading ? (
        <div className="flex items-center justify-center h-32">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : statusQuery.error ? (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 text-red-700 dark:text-red-400">
          Failed to load A2A status: {String(statusQuery.error)}
        </div>
      ) : (
        <>
          {/* Overview Tab */}
          {activeTab === 'overview' && (
            <>
              {status && <StatusPanel status={status} />}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {card && <AgentCardPanel card={card} />}
                {agents && (
                  <DiscoveryPanel
                    agents={agents}
                    onProbe={(url) => probeMutation.mutate(url)}
                  />
                )}
              </div>

              {probeResult && (
                <ProbeResultPanel result={probeResult} onClose={() => setProbeResult(null)} />
              )}

              <HealthCheckPanel />

              <AuditPanel />
            </>
          )}

          {/* Configuration Tab */}
          {activeTab === 'config' && (
            <div className="space-y-6">
              <ConfigEditorPanel
                onSaved={() => queryClient.invalidateQueries({ queryKey: ['a2a'] })}
              />
              <AgentCardEditorPanel
                onSaved={() => queryClient.invalidateQueries({ queryKey: ['a2a'] })}
              />
            </div>
          )}

          {/* Messaging Tab */}
          {activeTab === 'messaging' && (
            <SendMessagePanel
              knownUrls={agents?.knownUrls || []}
              teamAgents={agents?.teamAgents || []}
            />
          )}
        </>
      )}
    </div>
  );
}
