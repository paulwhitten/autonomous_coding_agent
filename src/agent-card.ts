// Agent Card types and conversion utilities
//
// Inspired by the A2A protocol Agent Card specification.
// These types enrich the existing TeamAgent with structured skill
// descriptions, input/output modes, endpoint URLs, and provider metadata.
// They are usable regardless of communication backend (mailbox or A2A).

import { TeamAgent, TeamRoster } from './types.js';

// ---------------------------------------------------------------------------
// Core Types
// ---------------------------------------------------------------------------

/**
 * Structured description of an agent skill or capability.
 * Richer than the flat string[] in the original TeamAgent.capabilities.
 *
 * Aligns with A2A AgentSkill: id, name, description, tags,
 * optional input/output modes and examples.
 */
export interface AgentSkill {
  /** Unique identifier for this skill (e.g., "python", "csv-analysis"). */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** What this skill does -- used for discovery matching. */
  description: string;
  /** Searchable tags for capability-based discovery. */
  tags: string[];
  /** Accepted input MIME types (e.g., ["text/plain", "application/json"]). */
  inputModes?: string[];
  /** Produced output MIME types. */
  outputModes?: string[];
  /** Example prompts or usage patterns. */
  examples?: string[];
}

/**
 * Provider / organization metadata.
 * Maps to the A2A Agent Card `provider` field.
 */
export interface AgentProvider {
  organization: string;
  url?: string;
}

/**
 * Security scheme descriptor.
 * Simplified from the A2A / OpenAPI security scheme.
 */
export interface SecurityScheme {
  /** Scheme type: "bearer", "apiKey", "oauth2", "none". */
  type: string;
  /** Where the credential goes: "header", "query". */
  in?: string;
  /** Header or query parameter name (e.g., "Authorization"). */
  name?: string;
}

/**
 * Enriched agent card combining the existing TeamAgent fields with
 * A2A-inspired metadata.  Backward-compatible: all new fields are optional.
 */
export interface EnrichedAgentCard extends TeamAgent {
  /** Structured skill descriptions (supersedes flat capabilities[]). */
  skills?: AgentSkill[];
  /** Accepted input MIME types at the agent level. */
  inputModes?: string[];
  /** Produced output MIME types at the agent level. */
  outputModes?: string[];
  /** A2A protocol version if this agent speaks A2A. */
  protocolVersion?: string;
  /** Network endpoint URL for A2A communication. */
  url?: string;
  /** Provider / organization information. */
  provider?: AgentProvider;
  /** Authentication requirements. */
  security?: SecurityScheme[];
  /** Protocol extensions (A2A extensions field). */
  extensions?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Conversion Utilities
// ---------------------------------------------------------------------------

/**
 * Convert flat capability strings into structured AgentSkill objects.
 * Used when migrating existing team.json files or when skills[] is absent.
 */
export function capabilitiesToSkills(capabilities: string[], role?: string): AgentSkill[] {
  return capabilities.map(cap => ({
    id: cap,
    name: cap.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    description: `Capability: ${cap}`,
    tags: role ? [role, cap] : [cap],
  }));
}

/**
 * Merge flat capabilities and structured skills into a unified skills list.
 * Skills take precedence; capabilities not already represented are appended.
 */
export function mergeCapabilitiesAndSkills(
  capabilities?: string[],
  skills?: AgentSkill[],
  role?: string,
): AgentSkill[] {
  const result: AgentSkill[] = [...(skills || [])];
  const existingIds = new Set(result.map(s => s.id));

  for (const cap of capabilities || []) {
    if (!existingIds.has(cap)) {
      result.push(...capabilitiesToSkills([cap], role));
      existingIds.add(cap);
    }
  }

  return result;
}

/**
 * Build an EnrichedAgentCard from a plain TeamAgent.
 * Populates skills from capabilities when skills[] is not already set.
 */
export function enrichTeamAgent(agent: TeamAgent): EnrichedAgentCard {
  const enriched: EnrichedAgentCard = { ...agent };

  // Derive id from hostname + role when not explicitly provided
  if (!enriched.id && enriched.hostname) {
    enriched.id = `${enriched.hostname}_${enriched.role || 'agent'}`;
  }

  // Generate skills from capabilities if not already present
  if (!enriched.skills && enriched.capabilities) {
    enriched.skills = capabilitiesToSkills(enriched.capabilities, enriched.role);
  }

  // Default input/output modes
  if (!enriched.inputModes) {
    enriched.inputModes = ['text/plain'];
  }
  if (!enriched.outputModes) {
    enriched.outputModes = ['text/plain'];
  }

  return enriched;
}

/**
 * Convert an EnrichedAgentCard to an A2A-compatible Agent Card JSON object.
 * Useful when serving the card at /.well-known/agent-card.json.
 */
export function toA2AAgentCard(
  card: EnrichedAgentCard,
  defaults?: {
    protocolVersion?: string;
    serverPort?: number;
    /** Config-level agent card overrides (from communication.a2a.agentCard). */
    overrides?: import('./types.js').AgentCardConfig;
  },
): Record<string, unknown> {
  const overrides = defaults?.overrides;

  // Merge config-level skills with auto-derived skills (additive).
  const baseSkills = mergeCapabilitiesAndSkills(card.capabilities, card.skills, card.role);
  const extraSkills: AgentSkill[] = (overrides?.skills ?? []).map(s => ({
    id: s.id,
    name: s.name,
    description: s.description,
    tags: s.tags,
    inputModes: s.inputModes,
    outputModes: s.outputModes,
    examples: s.examples,
  }));
  const existingIds = new Set(baseSkills.map(s => s.id));
  const allSkills = [...baseSkills, ...extraSkills.filter(s => !existingIds.has(s.id))];

  const port = defaults?.serverPort ?? 4000;

  return {
    name: overrides?.name || card.id,
    description: overrides?.description || card.description || `${card.role} agent`,
    protocolVersion: card.protocolVersion || defaults?.protocolVersion || '0.3.0',
    version: overrides?.version || '1.0.0',
    url: card.url || `http://${card.hostname}:${port}/a2a/jsonrpc`,
    skills: allSkills.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      tags: s.tags,
      ...(s.inputModes ? { inputModes: s.inputModes } : {}),
      ...(s.outputModes ? { outputModes: s.outputModes } : {}),
      ...(s.examples ? { examples: s.examples } : {}),
    })),
    capabilities: {
      pushNotifications: false,
      streaming: false,
    },
    defaultInputModes: overrides?.inputModes || card.inputModes || ['text/plain'],
    defaultOutputModes: overrides?.outputModes || card.outputModes || ['text/plain'],
    ...(overrides?.provider || card.provider ? { provider: overrides?.provider || card.provider } : {}),
    ...(card.security ? { security: card.security } : {}),
    ...(overrides?.extensions || card.extensions ? { extensions: { ...card.extensions, ...overrides?.extensions } } : {}),
  };
}

/**
 * Convert an A2A-format agent card JSON object back to a TeamAgent.
 * Used when discovering remote A2A agents.
 */
export function fromA2AAgentCard(a2aCard: Record<string, unknown>): EnrichedAgentCard {
  const url = a2aCard.url as string | undefined;
  let hostname = 'unknown';
  try {
    if (url) hostname = new URL(url).hostname;
  } catch {
    // If URL parsing fails, use the name
    hostname = (a2aCard.name as string) || 'unknown';
  }

  const a2aSkills = (a2aCard.skills as Array<Record<string, unknown>>) || [];
  const skills: AgentSkill[] = a2aSkills.map(s => ({
    id: (s.id as string) || '',
    name: (s.name as string) || '',
    description: (s.description as string) || '',
    tags: (s.tags as string[]) || [],
    inputModes: s.inputModes as string[] | undefined,
    outputModes: s.outputModes as string[] | undefined,
    examples: s.examples as string[] | undefined,
  }));

  return {
    id: (a2aCard.name as string) || hostname,
    hostname,
    role: inferRoleFromSkills(skills),
    description: a2aCard.description as string | undefined,
    capabilities: skills.map(s => s.id),
    skills,
    inputModes: a2aCard.defaultInputModes as string[] | undefined,
    outputModes: a2aCard.defaultOutputModes as string[] | undefined,
    protocolVersion: a2aCard.protocolVersion as string | undefined,
    url,
    provider: a2aCard.provider as AgentProvider | undefined,
    security: a2aCard.security as SecurityScheme[] | undefined,
    extensions: a2aCard.extensions as Record<string, unknown> | undefined,
  };
}

/**
 * Infer an agent role from its skills / tags.
 * Returns 'agent' if no known role is detected.
 */
export function inferRoleFromSkills(skills: AgentSkill[]): string {
  const allTags = skills.flatMap(s => s.tags).map(t => t.toLowerCase());

  const roleKeywords: Record<string, string[]> = {
    manager: ['coordination', 'task-assignment', 'planning', 'manager'],
    developer: ['python', 'coding', 'implementation', 'developer', 'typescript'],
    qa: ['validation', 'testing', 'verification', 'qa', 'quality'],
    researcher: ['literature-review', 'research', 'methodology', 'researcher'],
  };

  for (const [role, keywords] of Object.entries(roleKeywords)) {
    if (keywords.some(kw => allTags.includes(kw))) {
      return role;
    }
  }

  return 'agent';
}
