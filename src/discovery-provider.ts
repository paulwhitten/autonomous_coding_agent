// Discovery Provider
//
// Enhances agent discovery with A2A protocol features:
// - Well-known URI (/.well-known/agent-card.json) fetching
// - Optional registry-based lookup
// - Local team roster enrichment with remote agent cards
//
// Can be used independently of the CommunicationBackend; both
// mailbox and A2A backends can leverage discovery for richer
// agent metadata.

import { EnrichedAgentCard, fromA2AAgentCard, toA2AAgentCard, enrichTeamAgent, mergeCapabilitiesAndSkills } from './agent-card.js';
import type { TeamAgent } from './types.js';
import type pino from 'pino';

/**
 * Discovery configuration.
 */
export interface DiscoveryConfig {
  /** URLs of known agents to probe at startup. */
  knownAgentUrls?: string[];
  /** Optional A2A registry URL for agent lookup. */
  registryUrl?: string;
  /** How long to cache discovered agent cards (ms). Default: 300000 (5 min). */
  cacheTtlMs?: number;
}

/**
 * Cached discovery entry.
 */
interface CacheEntry {
  card: EnrichedAgentCard;
  fetchedAt: number;
}

/**
 * Transport-agnostic agent discovery provider.
 *
 * Maintains a cache of known agents discovered through:
 * 1. Local team roster (seeded by MailboxManager or config)
 * 2. A2A well-known URI probing
 * 3. Registry lookup (when registryUrl is configured)
 */
export class DiscoveryProvider {
  private config: DiscoveryConfig;
  private logger: pino.Logger;
  private cache: Map<string, CacheEntry> = new Map();
  private cacheTtlMs: number;

  constructor(config: DiscoveryConfig, logger: pino.Logger) {
    this.config = config;
    this.logger = logger;
    this.cacheTtlMs = config.cacheTtlMs ?? 300_000;
  }

  /**
   * Seed the cache with agents from the local team roster.
   */
  seedFromRoster(agents: TeamAgent[]): void {
    for (const agent of agents) {
      const enriched = enrichTeamAgent(agent);
      this.cache.set(enriched.id, { card: enriched, fetchedAt: Date.now() });
    }
    this.logger.info({ count: agents.length }, 'Discovery cache seeded from roster');
  }

  /**
   * Probe all known agent URLs for their agent cards.
   */
  async probeKnownAgents(): Promise<EnrichedAgentCard[]> {
    const urls = this.config.knownAgentUrls || [];
    const discovered: EnrichedAgentCard[] = [];

    const results = await Promise.allSettled(
      urls.map(url => this.fetchAgentCard(url)),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled' && result.value) {
        discovered.push(result.value);
      } else if (result.status === 'rejected') {
        this.logger.warn({ url: urls[i], error: String(result.reason) }, 'Failed to probe agent');
      }
    }

    this.logger.info({ probed: urls.length, discovered: discovered.length }, 'Known agent probe complete');
    return discovered;
  }

  /**
   * Fetch an agent card from the well-known URI.
   */
  async fetchAgentCard(baseUrl: string): Promise<EnrichedAgentCard | null> {
    const wellKnownUrl = baseUrl.endsWith('/')
      ? `${baseUrl}.well-known/agent-card.json`
      : `${baseUrl}/.well-known/agent-card.json`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(wellKnownUrl, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) {
        this.logger.debug({ url: wellKnownUrl, status: response.status }, 'Agent card not found');
        return null;
      }

      const cardJson = await response.json() as Record<string, unknown>;
      const enriched = fromA2AAgentCard(cardJson);
      enriched.url = baseUrl;

      // Cache it
      this.cache.set(enriched.id, { card: enriched, fetchedAt: Date.now() });

      this.logger.info({ url: baseUrl, agentId: enriched.id }, 'Agent card fetched');
      return enriched;
    } catch (err) {
      this.logger.debug({ url: wellKnownUrl, error: String(err) }, 'Agent card fetch failed');
      return null;
    }
  }

  /**
   * Search a registry for agents matching criteria.
   */
  async searchRegistry(query: {
    role?: string;
    capability?: string;
    tag?: string;
  }): Promise<EnrichedAgentCard[]> {
    if (!this.config.registryUrl) return [];

    try {
      const params = new URLSearchParams();
      if (query.role) params.set('role', query.role);
      if (query.capability) params.set('capability', query.capability);
      if (query.tag) params.set('tag', query.tag);

      const url = `${this.config.registryUrl}/agents?${params.toString()}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) {
        this.logger.warn({ url, status: response.status }, 'Registry search failed');
        return [];
      }

      const data = await response.json() as { agents?: Record<string, unknown>[] };
      const agents = (data.agents || []).map(card => {
        const enriched = fromA2AAgentCard(card);
        this.cache.set(enriched.id, { card: enriched, fetchedAt: Date.now() });
        return enriched;
      });

      this.logger.info({ count: agents.length, query }, 'Registry search complete');
      return agents;
    } catch (err) {
      this.logger.warn({ error: String(err) }, 'Registry search error');
      return [];
    }
  }

  /**
   * Find cached agents matching a capability, skill ID, or tag.
   */
  findByCapability(capability: string): EnrichedAgentCard[] {
    const capLower = capability.toLowerCase();
    const results: EnrichedAgentCard[] = [];

    for (const entry of this.cache.values()) {
      if (this.isExpired(entry)) continue;
      const card = entry.card;

      // Check flat capabilities
      if (card.capabilities?.some(c => c.toLowerCase() === capLower)) {
        results.push(card);
        continue;
      }

      // Check structured skills
      const skills = mergeCapabilitiesAndSkills(card.capabilities, card.skills, card.role);
      if (skills.some(s =>
        s.id.toLowerCase() === capLower ||
        s.tags.some(t => t.toLowerCase() === capLower),
      )) {
        results.push(card);
      }
    }

    return results;
  }

  /**
   * Find a specific agent by ID, optionally refreshing if expired.
   */
  async findById(agentId: string, refresh = false): Promise<EnrichedAgentCard | null> {
    const entry = this.cache.get(agentId);

    if (entry && !this.isExpired(entry) && !refresh) {
      return entry.card;
    }

    // If we have a URL, try to refresh
    if (entry?.card.url) {
      const refreshed = await this.fetchAgentCard(entry.card.url);
      if (refreshed) return refreshed;
    }

    return entry?.card ?? null;
  }

  /**
   * Get all cached agents (non-expired).
   */
  getAllCached(): EnrichedAgentCard[] {
    const results: EnrichedAgentCard[] = [];
    for (const entry of this.cache.values()) {
      if (!this.isExpired(entry)) {
        results.push(entry.card);
      }
    }
    return results;
  }

  /**
   * Generate an A2A agent card JSON for a local agent.
   * Suitable for serving at /.well-known/agent-card.json.
   */
  generateAgentCard(
    agent: TeamAgent,
    options: { protocolVersion?: string; serverPort?: number } = {},
  ): Record<string, unknown> {
    const enriched = enrichTeamAgent(agent);
    return toA2AAgentCard(enriched, {
      protocolVersion: options.protocolVersion ?? '0.3.0',
      serverPort: options.serverPort ?? 4000,
    });
  }

  private isExpired(entry: CacheEntry): boolean {
    return Date.now() - entry.fetchedAt > this.cacheTtlMs;
  }
}
