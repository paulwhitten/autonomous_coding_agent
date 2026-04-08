// Persistent mDNS browser for the UI API server
//
// Runs continuously in the background, emitting Socket.io events as
// agents appear or disappear on the network.  This lets the dashboard
// update instantly without polling.
//
// Also runs periodic health checks against A2A endpoints to report
// online/offline/degraded status.

import { Bonjour, type Service, type Browser } from 'bonjour-service';
import { broadcast } from './websocket.js';

const SERVICE_TYPE = 'autonomous-agent';
const HEALTH_CHECK_INTERVAL_MS = 30_000; // 30 seconds
const HEALTH_HISTORY_MAX = 60; // keep last 60 data points (~30 min at 30s intervals)

export interface HealthPoint {
  time: string;          // ISO timestamp
  health: 'online' | 'offline' | 'degraded' | 'unknown';
}

let bonjour: InstanceType<typeof Bonjour> | null = null;
let browser: Browser | null = null;
let healthInterval: ReturnType<typeof setInterval> | null = null;
const knownAgents = new Map<string, Record<string, unknown>>();
const healthHistory = new Map<string, HealthPoint[]>();

function serviceToAgent(service: Service): Record<string, unknown> {
  const txt = (service.txt || {}) as Record<string, string>;
  const agent: Record<string, unknown> = {
    agentId: txt.agentId || service.name,
    hostname: txt.hostname || service.host || 'unknown',
    role: txt.role || 'agent',
    pid: parseInt(txt.pid, 10) || 0,
    startedAt: txt.startedAt || new Date().toISOString(),
    health: 'unknown' as 'online' | 'offline' | 'degraded' | 'unknown',
  };
  if (txt.a2aUrl) agent.a2aUrl = txt.a2aUrl;
  if (txt.capabilities) agent.capabilities = txt.capabilities.split(',');
  if (txt.description) agent.description = txt.description;
  if (txt.mailboxRepoPath) agent.mailboxRepoPath = txt.mailboxRepoPath;
  if (txt.workspacePath) agent.workspacePath = txt.workspacePath;
  if (txt.configPath) agent.configPath = txt.configPath;
  if (txt.teamMembers) {
    try { agent.teamMembers = JSON.parse(txt.teamMembers); } catch { /* ignore */ }
  }
  return agent;
}

async function checkAgentHealth(agent: Record<string, unknown>): Promise<'online' | 'offline' | 'degraded'> {
  const a2aUrl = agent.a2aUrl as string | undefined;
  if (!a2aUrl) return 'unknown' as 'online'; // no A2A endpoint — we know it's on the network via mDNS

  const healthUrl = a2aUrl.endsWith('/')
    ? `${a2aUrl}health`
    : `${a2aUrl}/health`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const resp = await fetch(healthUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (resp.ok) return 'online';
    return 'degraded';
  } catch {
    clearTimeout(timeout);
    return 'offline';
  }
}

function recordHealthPoint(id: string, health: string): void {
  const points = healthHistory.get(id) || [];
  points.push({ time: new Date().toISOString(), health: health as HealthPoint['health'] });
  if (points.length > HEALTH_HISTORY_MAX) points.splice(0, points.length - HEALTH_HISTORY_MAX);
  healthHistory.set(id, points);
}

async function runHealthChecks(): Promise<void> {
  let changed = false;
  const checks = Array.from(knownAgents.entries()).map(async ([id, agent]) => {
    const health = await checkAgentHealth(agent);
    recordHealthPoint(id, health);
    if (agent.health !== health) {
      agent.health = health;
      knownAgents.set(id, agent);
      changed = true;
      broadcast('agents:health', { agentId: id, health, history: healthHistory.get(id) });
    }
  });
  await Promise.allSettled(checks);
  if (changed) {
    broadcast('agents:list', { agents: Array.from(knownAgents.values()), total: knownAgents.size });
  }
}

export function startAgentBrowser(): void {
  if (browser) return; // already running

  bonjour = new Bonjour();
  browser = bonjour.find({ type: SERVICE_TYPE });

  browser.on('up', (service: Service) => {
    const agent = serviceToAgent(service);
    const id = agent.agentId as string;
    knownAgents.set(id, agent);
    broadcast('agents:discovered', agent);
    broadcast('agents:list', { agents: Array.from(knownAgents.values()), total: knownAgents.size });
    // Immediate health check for the new agent
    checkAgentHealth(agent).then(health => {
      agent.health = health;
      knownAgents.set(id, agent);
      recordHealthPoint(id, health);
      broadcast('agents:health', { agentId: id, health, history: healthHistory.get(id) });
      broadcast('agents:list', { agents: Array.from(knownAgents.values()), total: knownAgents.size });
    });
  });

  browser.on('down', (service: Service) => {
    const txt = (service.txt || {}) as Record<string, string>;
    const id = txt.agentId || service.name;
    knownAgents.delete(id);
    broadcast('agents:lost', { agentId: id });
    broadcast('agents:list', { agents: Array.from(knownAgents.values()), total: knownAgents.size });
  });

  // Periodic health checks
  healthInterval = setInterval(() => { runHealthChecks(); }, HEALTH_CHECK_INTERVAL_MS);
}

export function stopAgentBrowser(): void {
  if (healthInterval) {
    clearInterval(healthInterval);
    healthInterval = null;
  }
  if (browser) {
    browser.stop();
    browser = null;
  }
  if (bonjour) {
    bonjour.destroy();
    bonjour = null;
  }
  knownAgents.clear();
  healthHistory.clear();
}

export function getKnownAgents(): Record<string, unknown>[] {
  return Array.from(knownAgents.values());
}

export function getHealthHistory(): Map<string, HealthPoint[]> {
  return healthHistory;
}
