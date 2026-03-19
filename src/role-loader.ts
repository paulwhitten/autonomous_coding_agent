/**
 * Shared role-loading utilities.
 *
 * Loads the base roles.json (roleDefinitionsFile) and, if configured,
 * overlays a customRolesFile on top.  Custom role keys override base
 * keys; new keys are added.  This lets teams create project-specific
 * roles without modifying the shared roles.json.
 */

import { readFile } from 'fs/promises';
import path from 'path';
import type { AgentConfig } from './types.js';

export type RoleDefinitions = Record<string, Record<string, unknown>>;

/**
 * Load the base roles file, optionally merge a custom overlay, and
 * return the combined role definitions keyed by role name.
 *
 * Resolution order:
 *   1. config.agent.roleDefinitionsFile  (default: ./roles.json)
 *   2. config.agent.customRolesFile      (optional, additive overlay)
 *
 * Both paths are resolved relative to `configDir` (the directory
 * containing the agent's config.json).
 */
export async function loadMergedRoles(
  config: AgentConfig,
  configDir: string = process.cwd(),
): Promise<RoleDefinitions> {
  // --- Base roles ---
  const baseFile = config.agent.roleDefinitionsFile
    ? path.resolve(configDir, config.agent.roleDefinitionsFile)
    : path.resolve('./roles.json');

  const baseContent = await readFile(baseFile, 'utf-8');
  const baseRoles: RoleDefinitions = JSON.parse(baseContent);

  // --- Custom overlay ---
  if (!config.agent.customRolesFile) {
    return baseRoles;
  }

  const customFile = path.resolve(configDir, config.agent.customRolesFile);
  let customRoles: RoleDefinitions;
  try {
    const customContent = await readFile(customFile, 'utf-8');
    customRoles = JSON.parse(customContent);
  } catch {
    // Custom file missing or unparseable -- log and fall through to base only.
    // Callers that have a logger can catch & log themselves; here we just
    // return base roles so the agent still starts.
    return baseRoles;
  }

  // Shallow merge: custom keys win.
  return { ...baseRoles, ...customRoles };
}
