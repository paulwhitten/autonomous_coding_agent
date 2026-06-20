// Agent Registry — Zero-config agent discovery via mDNS/DNS-SD
//
// Uses multicast DNS (Bonjour/Zeroconf) so agents on the same network
// discover each other automatically — no paths, no URIs, no central
// registry.  Each agent publishes a `_autonomous-agent._tcp` service
// record with TXT metadata.  The UI browses for that service type.

import { Bonjour, type Service, type Browser } from 'bonjour-service';

/** DNS-SD service type for autonomous agents. */
const SERVICE_TYPE = 'autonomous-agent';

/**
 * Metadata an agent publishes when it registers.
 */
export interface AgentRegistration {
  agentId: string;
  hostname: string;
  role: string;
  pid: number;
  startedAt: string;
  a2aUrl?: string;
  capabilities?: string[];
  description?: string;
  teamMembers?: Array<{ hostname: string; role: string; responsibilities?: string[] }>;
  mailboxRepoPath?: string;
  workspacePath?: string;
  configPath?: string;
}

/**
 * Manages mDNS advertisement and browsing for autonomous agents.
 */
export class AgentRegistry {
  private bonjour: InstanceType<typeof Bonjour>;
  private publishedService: Service | null = null;

  constructor() {
    this.bonjour = new Bonjour();
  }

  /**
   * Publish this agent as an mDNS service on the local network.
   */
  publish(info: AgentRegistration, port: number): void {
    // TXT record values must be strings
    const txt: Record<string, string> = {
      agentId: info.agentId,
      hostname: info.hostname,
      role: info.role,
      pid: String(info.pid),
      startedAt: info.startedAt,
    };
    if (info.a2aUrl) txt.a2aUrl = info.a2aUrl;
    if (info.capabilities?.length) txt.capabilities = info.capabilities.join(',');
    if (info.description) txt.description = info.description;
    if (info.mailboxRepoPath) txt.mailboxRepoPath = info.mailboxRepoPath;
    if (info.workspacePath) txt.workspacePath = info.workspacePath;
    if (info.configPath) txt.configPath = info.configPath;
    if (info.teamMembers?.length) {
      txt.teamMembers = JSON.stringify(
        info.teamMembers.map(m => ({ hostname: m.hostname, role: m.role }))
      );
    }

    this.publishedService = this.bonjour.publish({
      name: info.agentId,
      type: SERVICE_TYPE,
      port,
      txt,
    });
  }

  /**
   * Browse for agents on the network.  Returns a promise that resolves
   * after `timeoutMs` with all agents discovered in that window.
   */
  browse(timeoutMs: number = 3000): Promise<AgentRegistration[]> {
    return new Promise((resolve) => {
      const found = new Map<string, AgentRegistration>();
      const browser: Browser = this.bonjour.find({ type: SERVICE_TYPE });

      browser.on('up', (service: Service) => {
        const txt = (service.txt || {}) as Record<string, string>;
        const reg = parseTxtRecord(txt, service);
        if (reg) found.set(reg.agentId, reg);
      });

      setTimeout(() => {
        browser.stop();
        resolve(Array.from(found.values()));
      }, timeoutMs);
    });
  }

  /**
   * Unpublish the service and destroy the Bonjour instance.
   */
  unpublish(): void {
    if (this.publishedService) {
      this.publishedService.stop?.();
      this.publishedService = null;
    }
    this.bonjour.unpublishAll();
    this.bonjour.destroy();
  }
}

/**
 * Parse a TXT record from a discovered service back into an AgentRegistration.
 */
function parseTxtRecord(txt: Record<string, string>, service: Service): AgentRegistration | null {
  const agentId = txt.agentId;
  if (!agentId) return null;

  const reg: AgentRegistration = {
    agentId,
    hostname: txt.hostname || service.host || 'unknown',
    role: txt.role || 'agent',
    pid: parseInt(txt.pid, 10) || 0,
    startedAt: txt.startedAt || new Date().toISOString(),
  };
  if (txt.a2aUrl) reg.a2aUrl = txt.a2aUrl;
  if (txt.capabilities) reg.capabilities = txt.capabilities.split(',');
  if (txt.description) reg.description = txt.description;
  if (txt.mailboxRepoPath) reg.mailboxRepoPath = txt.mailboxRepoPath;
  if (txt.workspacePath) reg.workspacePath = txt.workspacePath;
  if (txt.configPath) reg.configPath = txt.configPath;
  if (txt.teamMembers) {
    try {
      reg.teamMembers = JSON.parse(txt.teamMembers);
    } catch { /* ignore malformed */ }
  }
  return reg;
}

// --- Convenience singleton for the UI API server (browse-only) -----------

let browseInstance: InstanceType<typeof Bonjour> | null = null;

/**
 * Discover all active agents on the network via mDNS browse.
 * Intended for the UI API — no publishing, just discovery.
 */
export async function discoverAgents(timeoutMs: number = 3000): Promise<AgentRegistration[]> {
  if (!browseInstance) {
    browseInstance = new Bonjour();
  }

  return new Promise((resolve) => {
    const found = new Map<string, AgentRegistration>();
    const browser: Browser = browseInstance!.find({ type: SERVICE_TYPE });

    browser.on('up', (service: Service) => {
      const txt = (service.txt || {}) as Record<string, string>;
      const reg = parseTxtRecord(txt, service);
      if (reg) found.set(reg.agentId, reg);
    });

    setTimeout(() => {
      browser.stop();
      resolve(Array.from(found.values()));
    }, timeoutMs);
  });
}

/**
 * Clean up the browse singleton (call on API server shutdown).
 */
export function destroyBrowseInstance(): void {
  if (browseInstance) {
    browseInstance.destroy();
    browseInstance = null;
  }
}
