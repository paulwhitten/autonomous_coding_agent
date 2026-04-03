// Agent URI utilities
//
// Parses transport URIs used in team.json and AgentAddress to determine
// which communication backend should deliver a message.
//
// Supported schemes:
//   a2a://host:port     -- route via the A2A HTTP backend
//   mailbox://agent_id  -- route via the git mailbox backend (explicit)
//   (absent / empty)    -- route via the git mailbox backend (default)
//
// Backward compatible: agents in team.json without a uri field are
// treated as mailbox-only.  This lets existing deployments work
// without configuration changes.

/**
 * Parsed result of an agent transport URI.
 */
export interface ParsedAgentUri {
  /** Transport scheme: 'a2a' or 'mailbox'. */
  scheme: 'a2a' | 'mailbox';
  /** For a2a:// -- the HTTP endpoint URL (e.g., "http://host:port"). */
  a2aUrl?: string;
}

/**
 * Parse a transport URI from team.json or AgentAddress.
 *
 * Supported formats:
 *   "a2a://host:port"         -> { scheme: 'a2a', a2aUrl: 'http://host:port' }
 *   "a2a://host:port/path"    -> { scheme: 'a2a', a2aUrl: 'http://host:port/path' }
 *   "mailbox://agent_id"      -> { scheme: 'mailbox' }
 *   "mailbox://"              -> { scheme: 'mailbox' }
 *   undefined / null / ""     -> { scheme: 'mailbox' }  (backward compat default)
 *
 * @param uri - The transport URI string, or undefined/null for the default.
 * @returns Parsed URI with scheme and optional A2A URL.
 */
export function parseAgentUri(uri: string | undefined | null): ParsedAgentUri {
  if (!uri || uri.trim() === '') {
    return { scheme: 'mailbox' };
  }

  const trimmed = uri.trim();

  if (trimmed.startsWith('a2a://')) {
    // Strip scheme, build an HTTP URL from the remainder.
    const rest = trimmed.slice('a2a://'.length);
    if (!rest) {
      return { scheme: 'a2a' };
    }
    return { scheme: 'a2a', a2aUrl: `http://${rest}` };
  }

  if (trimmed.startsWith('mailbox://')) {
    return { scheme: 'mailbox' };
  }

  // Unknown scheme -- treat as mailbox for safety.
  return { scheme: 'mailbox' };
}

/**
 * Resolve a target address by role from config teamMembers,
 * enriching with the URI from the team roster when the config
 * entry does not provide one.
 *
 * @param role - role to look up (e.g. 'developer')
 * @param teamMembers - config.teamMembers array (may be undefined)
 * @param roster - team roster from getTeamRoster() (may be null)
 * @returns AgentAddress with hostname, role, and uri (if available), or undefined if no match
 */
export function resolveTargetAddress(
  role: string,
  teamMembers: ReadonlyArray<{ hostname: string; role: string; uri?: string }> | undefined,
  roster: ReadonlyArray<{ role: string; uri?: string }> | null | undefined,
): { hostname: string; role: string; uri?: string } | undefined {
  const member = teamMembers?.find(m => m.role === role);
  if (!member) return undefined;

  if (member.uri) {
    return { hostname: member.hostname, role: member.role, uri: member.uri };
  }

  const rosterEntry = roster?.find(a => a.role === role);
  return { hostname: member.hostname, role: member.role, uri: rosterEntry?.uri };
}
