// Permission Handler - Controls what SDK tool operations are allowed
//
// The Copilot SDK has built-in tools for shell execution, file I/O, URL access, etc.
// Each operation triggers a PermissionRequest that must be explicitly approved.
// WITHOUT a permission handler, ALL requests are silently denied.
//
// This module provides a config-driven permission handler that approves or denies
// requests based on the permission kind and optional rules (e.g., working directory
// constraints, shell command allowlists).

import pino from 'pino';

/**
 * Permission configuration for each request kind.
 *
 * - "allow":      Approve all requests of this kind
 * - "deny":       Deny all requests of this kind
 * - "workingDir": Allow only within the configured working directory (file ops)
 * - "allowlist":  (shell only) Allow only commands whose base executable is in
 *                 the allowed commands list
 */
export type PermissionPolicy = 'allow' | 'deny' | 'workingDir' | 'allowlist';

export interface PermissionsConfig {
  /** Shell command execution — "allow" | "deny" | "allowlist" */
  shell: PermissionPolicy;
  /** File write operations — "allow" | "deny" | "workingDir" */
  write: PermissionPolicy;
  /** File read operations — "allow" | "deny" | "workingDir" */
  read: PermissionPolicy;
  /** URL/network access — "allow" | "deny" */
  url: PermissionPolicy;
  /** MCP server tool calls — "allow" | "deny" */
  mcp: PermissionPolicy;
  /** Custom tool calls (registered mailbox/workflow tools) — "allow" | "deny" */
  'custom-tool': PermissionPolicy;
  /** Memory operations — "allow" | "deny" */
  memory?: PermissionPolicy;
  /** Hook operations — "allow" | "deny" */
  hook?: PermissionPolicy;
  /** Additional shell commands to allow when shell policy is "allowlist" */
  shellAllowAdditional?: string[];
}

/**
 * SDK PermissionRequest shape (matches @github/copilot-sdk types)
 */
export interface PermissionRequest {
  kind: 'shell' | 'write' | 'mcp' | 'read' | 'url' | 'custom-tool' | 'memory' | 'hook';
  toolCallId?: string;
  [key: string]: unknown;
}

export interface PermissionRequestResult {
  kind: 'approve-once' | 'reject';
}

/**
 * Common development commands that are safe for an autonomous coding agent.
 * These cover SCM, package managers, build tools, and language toolchains.
 *
 * The allowlist matches the BASE EXECUTABLE name (first word of a command line,
 * with path stripped). For example "git", "npm", "/usr/bin/python3" all resolve
 * to their basename for matching.
 */
export const DEFAULT_SHELL_ALLOWLIST: ReadonlySet<string> = new Set([
  // --- SCM ---
  'git',
  'gh',             // GitHub CLI
  'svn',

  // --- Node.js / JavaScript ---
  'node',
  'npm',
  'npx',
  'yarn',
  'pnpm',
  'corepack',
  'tsc',            // TypeScript compiler
  'tsx',            // TypeScript execute
  'eslint',
  'prettier',
  'jest',
  'vitest',
  'mocha',

  // --- Python ---
  'python',
  'python3',
  'pip',
  'pip3',
  'pipx',
  'uv',             // fast Python package manager
  'poetry',
  'conda',
  'pytest',
  'mypy',
  'ruff',
  'black',
  'isort',
  'flake8',
  'pylint',

  // --- Rust ---
  'rustup',
  'cargo',
  'rustc',

  // --- C / C++ ---
  'gcc',
  'g++',
  'cc',
  'c++',
  'clang',
  'clang++',
  'make',
  'cmake',
  'ninja',

  // --- Java / JVM ---
  'java',
  'javac',
  'mvn',
  'gradle',
  'gradlew',

  // --- Go ---
  'go',

  // --- .NET ---
  'dotnet',

  // --- General build / shell utilities ---
  'bash',
  'sh',
  'zsh',

  // Shell keywords / builtins — control flow constructs that appear as the
  // first token when the SDK sends compound commands like "for i in …; do …; done".
  // These are no more dangerous than 'bash' (already allowlisted); the real
  // security-relevant commands are the ones *inside* the construct.
  'for',
  'while',
  'until',
  'if',
  'case',
  'select',
  '[',              // test synonym
  '[[',             // extended test
  'source',         // shell builtin — loads env (e.g. venv activate)
  '.',              // POSIX equivalent of source

  'cat',
  'echo',
  'printf',          // formatted output; no more powerful than echo
  '#',               // a shell comment line (the SDK reports "# ..." as a command)
  'grep',
  'find',
  'ls',
  'mkdir',
  'cp',
  'mv',
  'rm',
  'touch',
  'chmod',
  'head',
  'tail',
  'sort',
  'uniq',
  'wc',
  'diff',
  'patch',
  'sed',
  'awk',
  'xargs',
  'which',
  'env',
  'printenv',
  'pwd',
  'cd',
  'set',             // bash set -e/-x/-o etc.
  'test',            // shell test / [ ]
  'true',
  'false',
  'tar',
  'gzip',
  'gunzip',
  'zip',
  'unzip',
  'curl',            // often needed to install tools
  'wget',

  // --- Process management ---
  // Needed for server lifecycle management across work items
  // (e.g., killing an Express/Flask server between steps)
  'ps',              // list processes
  'kill',            // terminate processes by PID
  'killall',         // terminate processes by name
  'lsof',            // list open files / ports (lsof -i :3000)
  'fuser',           // identify processes using files/ports
  'wait',            // wait for background process
  'nohup',           // run process immune to hangups
  'timeout',         // run command with time limit (coreutils)
  'gtimeout',        // GNU timeout on macOS (via coreutils)

  // --- System inspection ---
  // Safe read-only utilities for debugging and environment discovery
  'uname',           // system info
  'hostname',        // machine name
  'whoami',          // current user
  'id',              // user/group info
  'date',            // current date/time
  'df',              // disk free space
  'du',              // disk usage
  'free',            // memory usage (Linux)
  'top',             // process monitor (typically used with -b -n1)
  'file',            // determine file type
  'stat',            // file metadata
  'readlink',        // resolve symlinks
  'realpath',        // canonical path
  'basename',        // strip directory from path
  'dirname',         // strip filename from path
  'tee',             // pipe to file and stdout
  'tr',              // translate/delete characters
  'cut',             // extract columns
  'paste',           // merge lines
  'yes',             // repeated output (for piping to prompts)
  'sleep',           // delay execution
]);

/**
 * Default permission config: shell allowlisted, read/write allowed, url/mcp denied.
 * This is a safe default for an autonomous coding agent:
 * - Shell: allowlisted to common dev tools (git, npm, python, cargo, etc.)
 * - Read/Write: allowed (agent needs full file access in its workspace)
 * - URL: denied (agent shouldn't make arbitrary network requests)
 * - MCP: denied (no MCP servers configured by default)
 */
export const DEFAULT_PERMISSIONS: PermissionsConfig = {
  shell: 'allowlist',
  write: 'allow',
  read: 'allow',
  url: 'deny',
  mcp: 'deny',
  'custom-tool': 'allow',
  memory: 'allow',
  hook: 'allow',
};

/**
 * Mutable permission overrides applied by the workflow engine on state
 * transitions.  When a workflow state declares `permissions: { write: "deny" }`,
 * the agent sets the override before the LLM session starts and clears it
 * on state exit.  The permission handler closure reads this object on every
 * request, so mutations take effect immediately.
 *
 * Keys mirror PermissionsConfig but only present keys are overridden.
 */
export type PermissionOverrides = Partial<Pick<PermissionsConfig, 'write' | 'read' | 'shell' | 'url' | 'mcp' | 'custom-tool' | 'memory' | 'hook'>>;

/**
 * Create a permission handler function compatible with the Copilot SDK.
 *
 * The returned handler evaluates each PermissionRequest against the provided
 * config and returns approved/denied accordingly. ALL requests are logged at
 * info level as an audit trail for discovering new tools/commands that may need
 * to be added to the allowlist.
 *
 * @param config - Permission policies per request kind
 * @param workingDirectory - Absolute path to the agent's working directory (for 'workingDir' policy)
 * @param logger - Logger instance for audit trail
 * @param overrides - Shared mutable per-state policy overrides
 * @param isToolRestricted - Returns true if a tool name is on the active
 *   workflow state's restrictedTools deny-list.  Checked first for every
 *   request that names a tool (custom-tool, mcp, hook).
 * @returns A PermissionHandler function for use with SessionConfig.onPermissionRequest
 */
export function createPermissionHandler(
  config: PermissionsConfig,
  workingDirectory: string,
  logger: pino.Logger,
  overrides?: PermissionOverrides,
  isToolRestricted?: (toolName: string) => boolean
): (request: PermissionRequest, invocation: { sessionId: string }) => PermissionRequestResult {

  // Build the effective shell allowlist (defaults + any user-configured extras)
  const shellAllowlist = new Set(DEFAULT_SHELL_ALLOWLIST);
  if (config.shellAllowAdditional) {
    for (const cmd of config.shellAllowAdditional) {
      shellAllowlist.add(cmd);
    }
  }

  // Shared mutable overrides object.  The agent sets fields on this
  // object when entering workflow states that declare permission
  // overrides, and clears them on exit.  Because the closure captures
  // the reference, mutations take effect on the next permission request.
  const activeOverrides: PermissionOverrides = overrides ?? {};

  return (request: PermissionRequest, invocation: { sessionId: string }): PermissionRequestResult => {
    // Check workflow-driven overrides first (they take precedence)
    const overridePolicy = activeOverrides[request.kind as keyof PermissionOverrides];
    const policy = overridePolicy ?? config[request.kind];

    // Log every permission request at info level for audit trail.
    // Strip 'kind' and 'toolCallId' to show the remaining request-specific properties.
    const { kind, toolCallId, ...requestDetails } = request;
    logger.info({
      kind: request.kind,
      toolCallId: request.toolCallId,
      details: Object.keys(requestDetails).length > 0 ? requestDetails : undefined,
      sessionId: invocation.sessionId,
      ...(overridePolicy ? { override: overridePolicy } : {}),
    }, `Permission request: ${request.kind}`);

    // Workflow restrictedTools deny-list takes precedence over any policy.
    if (isToolRestricted && typeof request.toolName === 'string' && isToolRestricted(request.toolName)) {
      logger.warn({
        kind: request.kind,
        toolName: request.toolName,
        sessionId: invocation.sessionId,
        decision: 'denied',
        reason: 'workflow-restricted',
      }, `Permission denied: tool '${request.toolName}' is restricted in this workflow state`);
      return { kind: 'reject' };
    }

    if (!policy) {
      // Unknown permission kind — deny by default
      logger.warn({
        kind: request.kind,
        sessionId: invocation.sessionId,
        decision: 'denied',
        reason: 'unknown-kind',
      }, 'Permission denied: unknown kind');
      return { kind: 'reject' };
    }

    if (policy === 'deny') {
      logger.info({
        kind: request.kind,
        sessionId: invocation.sessionId,
        decision: 'denied',
        reason: 'policy-deny',
      }, `Permission denied by policy: ${request.kind}`);
      return { kind: 'reject' };
    }

    if (policy === 'allow') {
      logger.info({
        kind: request.kind,
        sessionId: invocation.sessionId,
        decision: 'approved',
        reason: 'policy-allow',
      }, `Permission approved: ${request.kind}`);
      return { kind: 'approve-once' };
    }

    // policy === 'allowlist': Check if the command's base executable is allowed
    if (policy === 'allowlist') {
      return evaluateAllowlist(request, invocation, shellAllowlist, logger);
    }

    // policy === 'workingDir': Check if the operation is within the working directory
    if (policy === 'workingDir') {
      return evaluateWorkingDir(request, invocation, workingDirectory, logger);
    }

    // Fallback (shouldn't reach here with TypeScript's exhaustive checks)
    logger.warn({ kind: request.kind, policy, decision: 'denied' }, 'Unhandled policy — denied');
    return { kind: 'reject' };
  };
}

/**
 * Evaluate a shell command against the allowlist.
 *
 * Every command the request names must be allowlisted: the base of the
 * full command text, and the base of each entry in the SDK's parsed
 * `commands` list (which covers chained commands such as
 * "cd /foo && rm -rf bar").  A request with no command to validate is
 * denied.
 *
 * This is a guardrail against accidental commands, not a sandbox:
 * allowlisted interpreters and wrappers (bash -c, sh, env, xargs,
 * find -exec, timeout, nohup) can still run arbitrary programs.
 */
function evaluateAllowlist(
  request: PermissionRequest,
  invocation: { sessionId: string },
  allowlist: Set<string>,
  logger: pino.Logger
): PermissionRequestResult {
  const commands = extractCommands(request);

  if (commands.length === 0) {
    logger.warn({
      kind: request.kind,
      sessionId: invocation.sessionId,
      decision: 'denied',
      reason: 'no-command-to-validate',
    }, 'Shell DENIED (no command to validate)');
    return { kind: 'reject' };
  }

  const command = commands[0];
  const baseCommands = [...new Set(commands.map(extractBaseCommand))];
  const notAllowed = baseCommands.filter((c) => !allowlist.has(c));

  if (notAllowed.length === 0) {
    logger.info({
      kind: request.kind,
      command: command,
      baseCommands,
      sessionId: invocation.sessionId,
      decision: 'approved',
      reason: 'allowlisted',
    }, `Shell approved (allowlisted): ${baseCommands.join(', ')}`);
    return { kind: 'approve-once' };
  }

  // Not in allowlist — deny and log prominently so operator can review
  logger.warn({
    kind: request.kind,
    command: command,
    baseCommands,
    notAllowed,
    sessionId: invocation.sessionId,
    decision: 'denied',
    reason: 'not-in-allowlist',
  }, `Shell DENIED (not in allowlist): ${notAllowed.join(', ')} — add to shellAllowAdditional config if needed`);
  return { kind: 'reject' };
}

/**
 * Evaluate a file operation against the working directory constraint.
 */
function evaluateWorkingDir(
  request: PermissionRequest,
  invocation: { sessionId: string },
  workingDirectory: string,
  logger: pino.Logger
): PermissionRequestResult {
  const requestPath = extractPath(request);

  if (!requestPath) {
    // No path to validate — approve (e.g. shell with workingDir policy)
    logger.info({
      kind: request.kind,
      sessionId: invocation.sessionId,
      decision: 'approved',
      reason: 'no-path-to-validate',
    }, `Permission approved (workingDir policy, no path): ${request.kind}`);
    return { kind: 'approve-once' };
  }

  if (isWithinDirectory(requestPath, workingDirectory)) {
    logger.info({
      kind: request.kind,
      path: requestPath,
      sessionId: invocation.sessionId,
      decision: 'approved',
      reason: 'within-working-dir',
    }, `Permission approved (within working dir): ${request.kind}`);
    return { kind: 'approve-once' };
  }

  logger.warn({
    kind: request.kind,
    path: requestPath,
    workingDirectory,
    sessionId: invocation.sessionId,
    decision: 'denied',
    reason: 'outside-working-dir',
  }, `Permission denied (outside working dir): ${request.kind}`);
  return { kind: 'reject' };
}

/**
 * Extract every command string from a permission request.
 *
 * The SDK sends shell command info in several possible shapes:
 * - { fullCommandText: "npm test" }                          — primary field
 * - { commands: [{ identifier: "npm test" }] }               — parsed list, one per command
 * - { command: "npm test" }                                  — simple string
 * - { shellCommand: "npm test" }                             — alt name
 * - { cmd: "npm test" }                                      — alt name
 * - { args: ["npm", "test"] }                                — array form
 *
 * fullCommandText and all `commands` identifiers are returned together so
 * each can be checked; the other fields are fallbacks.
 */
function extractCommands(request: PermissionRequest): string[] {
  const result: string[] = [];

  // Primary: SDK sends fullCommandText for shell requests
  if (typeof request.fullCommandText === 'string' && request.fullCommandText.trim()) {
    result.push(request.fullCommandText);
  }

  // Structured: SDK sends commands array with identifier per command
  if (Array.isArray(request.commands)) {
    for (const entry of request.commands as Array<{ identifier?: unknown }>) {
      if (typeof entry?.identifier === 'string' && entry.identifier.trim()) {
        result.push(entry.identifier);
      }
    }
  }
  if (result.length > 0) return result;

  // Fallback: other possible property names
  for (const key of ['command', 'shellCommand', 'cmd'] as const) {
    const value = request[key];
    if (typeof value === 'string' && value.trim()) return [value];
  }

  // Array of args without a command name
  if (Array.isArray(request.args) && request.args.length > 0) {
    return [request.args.join(' ')];
  }

  return [];
}

/**
 * Extract the base executable name from a command string.
 *
 * Handles:
 * - Simple commands: "git status" → "git"
 * - Absolute paths: "/usr/bin/python3 script.py" → "python3"
 * - Env prefix: "env FOO=bar npm test" → "npm"
 * - Attached operators: "ls; cat x" → "ls", "(cd dir && make)" → "cd"
 * - Chained commands: "cd /foo && npm test" → "cd" (first command only;
 *   the SDK's parsed `commands` list supplies the rest)
 *
 * @param command Full command string
 * @returns The base executable name (lowercase-preserved)
 */
export function extractBaseCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return '';

  // Split on whitespace to get first token, then cut it at shell operators
  // so "ls;", "make&&" or "(cd" resolve to the command itself.
  let firstToken = trimmed.split(/\s+/)[0].replace(/^[({]+/, '');
  firstToken = firstToken.split(/[;&|<>`)]/)[0] || firstToken;

  // Strip path: "/usr/bin/python3" → "python3"
  const lastSlash = firstToken.lastIndexOf('/');
  if (lastSlash >= 0) {
    firstToken = firstToken.substring(lastSlash + 1);
  }

  // If first token is 'env', skip env vars (KEY=VALUE) to find the real command
  if (firstToken === 'env') {
    const parts = trimmed.split(/\s+/);
    for (let i = 1; i < parts.length; i++) {
      // Skip env var assignments (FOO=bar)
      if (!parts[i].includes('=')) {
        let cmd = parts[i];
        const slash = cmd.lastIndexOf('/');
        if (slash >= 0) cmd = cmd.substring(slash + 1);
        return cmd;
      }
    }
    return 'env';
  }

  return firstToken;
}

/**
 * Extract a file path from a permission request, if present.
 * The SDK may include path information in various properties depending on the tool.
 */
function extractPath(request: PermissionRequest): string | undefined {
  if (typeof request.path === 'string') return request.path;
  if (typeof request.filePath === 'string') return request.filePath;
  if (typeof request.uri === 'string') return request.uri;
  if (typeof request.file === 'string') return request.file;
  return undefined;
}

/**
 * Check if a path is within (or equal to) a directory.
 * Uses simple string prefix matching on normalized paths.
 */
function isWithinDirectory(targetPath: string, directory: string): boolean {
  // Normalize: ensure trailing slash for directory comparison
  const normalizedDir = directory.endsWith('/') ? directory : directory + '/';
  const normalizedPath = targetPath.startsWith('/') ? targetPath : '/' + targetPath;

  return normalizedPath === directory || normalizedPath.startsWith(normalizedDir);
}
