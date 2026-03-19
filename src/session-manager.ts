// Session Manager - Handles Copilot SDK session lifecycle
//
// Responsibilities:
// - Create and resume Copilot sessions
// - Manage event listener lifecycle
// - Handle session errors and recovery
// - Track session state

import { CopilotClient, CopilotSession } from '@github/copilot-sdk';
import pino from 'pino';

export interface SessionConfig {
  model: string;
  streaming: boolean;
  tools: any[];
  availableTools?: string[];  // CAUTION: Acts as whitelist — disables all tools NOT listed.
                              // Omit to keep all built-in tools (file I/O, terminal, etc.) enabled.
  onPermissionRequest?: (request: any, invocation: { sessionId: string }) => any;
  workingDirectory?: string;
}

// Default permission handler: auto-approve all requests.
// Used when config.onPermissionRequest is not provided, ensuring
// compatibility with SDK versions where the field is required.
const defaultPermissionHandler = (request: any, _invocation: { sessionId: string }) => {
  return { permission: 'allow' as const, ...request };
};

export interface SessionState {
  sessionId?: string;
  isActive: boolean;
  lastActivity?: Date;
}

/**
 * SessionManager encapsulates all Copilot SDK session management
 */
/**
 * Check whether an error message indicates a Copilot API rate limit.
 * Exported so other modules can reuse the check without duplication.
 */
export function isRateLimitError(msg: string): boolean {
  return msg.includes('rate limit') || msg.includes('429');
}

/**
 * Extract the retry-after duration (in ms) from a rate-limit message.
 *
 * Handles these patterns from the Copilot API:
 *   - "try again in 46 minutes"   -> 46 * 60_000
 *   - "try again in 30 seconds"   -> 30 * 1_000
 *   - "try again in 2 hours"      -> 2 * 3_600_000
 *
 * Falls back to `defaultMs` (2 min) when the message has no parseable hint.
 */
export function parseRateLimitDelay(msg: string, defaultMs: number = 120_000): number {
  // Try "N minute(s)" first (most common)
  const minMatch = msg.match(/try again in (\d+)\s*minute/i);
  if (minMatch) {
    return parseInt(minMatch[1], 10) * 60_000;
  }
  // Try "N second(s)"
  const secMatch = msg.match(/try again in (\d+)\s*second/i);
  if (secMatch) {
    return parseInt(secMatch[1], 10) * 1_000;
  }
  // Try "N hour(s)"
  const hrMatch = msg.match(/try again in (\d+)\s*hour/i);
  if (hrMatch) {
    return parseInt(hrMatch[1], 10) * 3_600_000;
  }
  return defaultMs;
}

export class SessionManager {
  private client: CopilotClient;
  private session: CopilotSession | null = null;
  private logger: pino.Logger;
  private eventUnsubscribers: Array<() => void> = [];
  private nextHandlerId = 0;
  private activeHandlerIds: Set<number> = new Set();
  private sessionState: SessionState = {
    isActive: false
  };

  /**
   * Last config used to create/resume a session.  Stored so the
   * manager can transparently recreate an expired session without
   * requiring callers to pass the config again.
   */
  private lastSessionConfig: SessionConfig | null = null;

  /**
   * Timestamp (epoch ms) until which the agent should avoid making API
   * calls due to a rate limit.  Zero means no active backoff.
   */
  private _rateLimitUntil: number = 0;

  /** True when the agent is currently in a rate-limit backoff period. */
  get isRateLimited(): boolean {
    return Date.now() < this._rateLimitUntil;
  }

  /** Milliseconds remaining in the current rate-limit backoff (0 if none). */
  get rateLimitRemainingMs(): number {
    return Math.max(0, this._rateLimitUntil - Date.now());
  }

  /**
   * Record that a rate limit was hit and set the backoff expiry.
   * @param durationMs  How long to back off (ms).
   */
  setRateLimitBackoff(durationMs: number): void {
    this._rateLimitUntil = Date.now() + durationMs;
    this.logger.warn(
      { backoffMs: durationMs, until: new Date(this._rateLimitUntil).toISOString() },
      'Rate-limit backoff activated',
    );
  }

  /** Clear the rate-limit backoff (e.g. after a successful call). */
  clearRateLimitBackoff(): void {
    if (this._rateLimitUntil > 0) {
      this._rateLimitUntil = 0;
      this.logger.info('Rate-limit backoff cleared');
    }
  }

  constructor(client: CopilotClient, logger: pino.Logger) {
    this.client = client;
    this.logger = logger;
  }

  /**
   * Get current session (may be null if not initialized)
   */
  getSession(): CopilotSession | null {
    return this.session;
  }

  /**
   * Get current session state
   */
  getState(): SessionState {
    return { ...this.sessionState };
  }

  /**
   * Check if session is active and ready
   */
  isActive(): boolean {
    return this.sessionState.isActive && this.session !== null;
  }

  /**
   * Initialize or resume a session
   * 
   * @param sessionId - Optional session ID to resume. If null, creates new session.
   * @param config - Session configuration (model, tools, etc.)
   * @param forceNew - If true, creates new session even if sessionId provided
   * @returns The session ID (new or resumed)
   */
  async initializeSession(
    sessionId: string | undefined,
    config: SessionConfig,
    forceNew: boolean = false
  ): Promise<string> {
    // Track the old session ID so we can delete it after replacement
    const oldSessionId = this.sessionState.sessionId;

    // Clean up any existing session first
    if (this.session) {
      this.cleanupEventListeners();
    }

    // Try to resume existing session (unless forcing new)
    if (!forceNew && sessionId) {
      try {
        this.logger.info({ sessionId }, 'Attempting to resume session');
        this.session = await this.client.resumeSession(sessionId, {
          tools: config.tools,
          streaming: config.streaming,
          onPermissionRequest: config.onPermissionRequest ?? defaultPermissionHandler,
          workingDirectory: config.workingDirectory,
        });
        this.sessionState = {
          sessionId: this.session.sessionId,
          isActive: true,
          lastActivity: new Date()
        };
        this.lastSessionConfig = config;
        this.logger.info({ sessionId: this.session.sessionId }, 'Resumed existing session');
        return this.session.sessionId;
      } catch (error) {
        this.logger.warn({
          error: String(error),
          sessionId
        }, 'Failed to resume session, creating new one');
        // Fall through to create new session
      }
    }

    // Create new session
    this.logger.info({ model: config.model }, 'Creating new session');
    this.session = await this.client.createSession({
      model: config.model,
      streaming: config.streaming,
      tools: config.tools,
      availableTools: config.availableTools,  // Pass through availableTools
      onPermissionRequest: config.onPermissionRequest ?? defaultPermissionHandler,
      workingDirectory: config.workingDirectory,
    });

    this.sessionState = {
      sessionId: this.session.sessionId,
      isActive: true,
      lastActivity: new Date()
    };

    this.logger.info({
      sessionId: this.session.sessionId,
      model: config.model,
      availableTools: config.availableTools
    }, 'Created new persistent session');

    // Remember config so expired sessions can be transparently recreated
    this.lastSessionConfig = config;

    // Delete the old session to prevent accumulation in the VS Code
    // session list.  Fire-and-forget so it does not block startup.
    if (oldSessionId && oldSessionId !== this.session.sessionId) {
      this.deleteSessionQuietly(oldSessionId);
    }

    return this.session.sessionId;
  }

  /**
   * Delete a session without throwing on failure.
   * Used to clean up replaced/expired sessions so they do not
   * accumulate in the VS Code session list.
   */
  private deleteSessionQuietly(sessionId: string): void {
    this.client.deleteSession(sessionId).then(
      () => this.logger.info({ sessionId }, 'Deleted old session'),
      (err: unknown) => this.logger.debug(
        { sessionId, error: String(err) },
        'Could not delete old session (may already be removed)',
      ),
    );
  }

  /**
   * Delete the current session from the server.
   * Intended for agent shutdown so completed sessions do not litter
   * the VS Code session list.
   */
  async deleteCurrentSession(): Promise<void> {
    const id = this.sessionState.sessionId;
    if (!id) return;
    this.cleanupEventListeners();
    this.session = null;
    this.sessionState.isActive = false;
    try {
      await this.client.deleteSession(id);
      this.logger.info({ sessionId: id }, 'Deleted current session on shutdown');
    } catch (err) {
      this.logger.debug(
        { sessionId: id, error: String(err) },
        'Could not delete current session on shutdown',
      );
    }
  }

  /**
   * Check whether an error indicates the SDK session has expired or
   * been invalidated server-side.  Callers can use this to decide
   * whether a retry after session renewal is appropriate.
   */
  static isSessionExpiredError(errorMsg: string): boolean {
    return errorMsg.includes('Session not found') ||
      errorMsg.includes('session.send failed') ||
      errorMsg.includes('Session expired');
  }

  /**
   * Validate that the SDK session is alive and ready for use.
   *
   * Call this before registering event listeners and sending prompts.
   * If the session has expired or the client is disconnected, this
   * method transparently creates a fresh session using the stored
   * configuration.
   *
   * This is the primary defense against silent session expiry.  Both
   * sendPrompt() and sendPromptAndWait() call it internally, but
   * callers that register event listeners before sending should call
   * it explicitly BEFORE listener registration so the listeners bind
   * to a guaranteed-live session.
   *
   * @throws Error if no prior session config is stored and renewal is needed
   */
  async ensureSession(): Promise<void> {
    // Fast path: session object exists and is marked active
    if (this.session && this.sessionState.isActive) {
      // Client connectivity check (synchronous, negligible cost)
      const clientState = this.client.getState();
      if (clientState === 'connected') {
        // For sessions idle > 2 min, verify the server still knows them
        const lastActivity = this.sessionState.lastActivity;
        const idleMs = lastActivity
          ? Date.now() - lastActivity.getTime()
          : Infinity;
        if (idleMs < 120_000) {
          return; // Recently active — trust it
        }
        // Stale session — verify it still exists server-side
        try {
          const sessions = await this.client.listSessions();
          const exists = sessions.some(
            s => s.sessionId === this.sessionState.sessionId,
          );
          if (exists) {
            this.logger.debug('ensureSession: stale session verified via listSessions');
            return;
          }
          this.logger.warn(
            { sessionId: this.sessionState.sessionId },
            'ensureSession: session no longer exists server-side — renewing',
          );
        } catch (error) {
          this.logger.warn(
            { error: String(error) },
            'ensureSession: listSessions check failed — renewing defensively',
          );
        }
      } else {
        this.logger.warn(
          { clientState },
          'ensureSession: client not connected — renewing session',
        );
      }
    } else {
      this.logger.info(
        { hasSession: !!this.session, isActive: this.sessionState.isActive },
        'ensureSession: no active session — renewing',
      );
    }

    // Slow path: session needs renewal
    const newId = await this.renewExpiredSession();
    if (!newId) {
      throw new Error(
        'ensureSession failed: no active session and renewal failed (no stored config)',
      );
    }
  }

  /**
   * Recreate the current session using the stored config.
   * Callers should invoke this when they catch a session-expired error
   * and want to retry.  Not called automatically from sendPrompt /
   * sendPromptAndWait because those methods cannot re-register event
   * listeners that callers set up before the send call.
   *
   * @returns The new session ID, or null if no prior config is available.
   */
  async renewExpiredSession(): Promise<string | null> {
    if (!this.lastSessionConfig) {
      this.logger.warn('Cannot renew session -- no prior session config stored');
      return null;
    }

    this.logger.info('Renewing expired session');
    const expiredId = this.sessionState.sessionId;
    this.cleanupEventListeners();
    this.session = null;
    this.sessionState.isActive = false;

    const newId = await this.initializeSession(undefined, this.lastSessionConfig, true);

    // initializeSession already deletes the old session, but if the
    // expired session had a different ID than what was tracked (edge
    // case), clean it up here.
    if (expiredId && expiredId !== newId) {
      this.deleteSessionQuietly(expiredId);
    }

    return newId;
  }

  /**
   * Send a prompt to the active session
   * 
   * Calls ensureSession() to validate the session before sending.
   * Does NOT retry internally on failure because callers may have
   * pre-registered event listeners that would be orphaned on a new
   * session.  Callers should call ensureSession() explicitly before
   * registering listeners and before this method.
   * 
   * @param prompt - The prompt to send
   * @returns Promise that resolves when message is sent (not when response complete)
   * @throws Error if no active session or session has expired server-side
   */
  async sendPrompt(prompt: string): Promise<string> {
    await this.ensureSession();

    this.sessionState.lastActivity = new Date();
    const messageId = await this.session!.send({ prompt });
    return messageId;
  }

  /**
   * Send a prompt and wait for completion
   * 
   * Calls ensureSession() to validate the session before sending.
   * Does NOT retry internally on failure because callers (e.g.
   * promptLLM) may have pre-registered event listeners that would be
   * orphaned on a new session.  Callers should handle retry with
   * listener re-registration.
   * 
   * @param prompt - The prompt to send
   * @param timeoutMs - Optional timeout in milliseconds
   * @returns Promise that resolves when session is idle
   * @throws Error if no active session
   */
  async sendPromptAndWait(prompt: string, timeoutMs?: number): Promise<void> {
    await this.ensureSession();

    // If we are still in a rate-limit backoff window, throw immediately
    // so the caller's catch logic can decide to sleep or skip.
    if (this.isRateLimited) {
      throw new Error(
        `Rate-limited -- backoff active for another ${Math.ceil(this.rateLimitRemainingMs / 1000)}s`,
      );
    }

    this.sessionState.lastActivity = new Date();
    try {
      await this.session!.sendAndWait({ prompt }, timeoutMs);
      // Successful call -- ensure backoff is cleared.
      this.clearRateLimitBackoff();
    } catch (error) {
      const msg = String((error as any)?.message ?? error ?? '');
      if (isRateLimitError(msg)) {
        const delayMs = parseRateLimitDelay(msg);
        this.logger.error(
          {
            delayMs,
            delayMin: Math.ceil(delayMs / 60_000),
            resumeAt: new Date(Date.now() + delayMs).toISOString(),
            rawMessage: msg.substring(0, 200),
          },
          'RATE LIMIT HIT -- Copilot API rate limit detected',
        );
        this.setRateLimitBackoff(delayMs);
      }
      throw error;
    }
  }

  /**
   * Register an event listener on the current session
   * 
   * Callers MUST call ensureSession() before this method to guarantee
   * the listeners bind to a live session.
   * 
   * @param eventType - Event type to listen for
   * @param handler - Event handler function
   * @returns Unsubscribe function
   * @throws Error if no active session (call ensureSession() first)
   */
  addEventListener(
    eventType: Parameters<CopilotSession['on']>[0],
    handler: (event: any) => void
  ): () => void {
    if (!this.session) {
      throw new Error('No active session - call ensureSession() before registering listeners');
    }

    const handlerId = ++this.nextHandlerId;
    this.activeHandlerIds.add(handlerId);

    const unsubscribe = this.session.on(eventType as any, handler);

    // Track whether the SDK unsubscribe has already been called so we
    // never double-fire it.  Both the returned per-handler unsub
    // function and the bulk cleanupEventListeners() may try to call it.
    let alreadyUnsubscribed = false;

    const wrappedUnsub = () => {
      if (!alreadyUnsubscribed) {
        alreadyUnsubscribed = true;
        unsubscribe();
      }
      this.activeHandlerIds.delete(handlerId);
    };

    this.eventUnsubscribers.push(wrappedUnsub);
    
    this.logger.debug({ 
      eventType,
      handlerId,
      activeHandlerCount: this.activeHandlerIds.size,
      totalListeners: this.eventUnsubscribers.length 
    }, '[DIAG] handler subscribed');

    // The returned function calls the same guarded unsub *and* removes
    // the entry from the bulk array so cleanupEventListeners() won't
    // fire a stale no-op closure.
    return () => {
      wrappedUnsub();
      const idx = this.eventUnsubscribers.indexOf(wrappedUnsub);
      if (idx !== -1) {
        this.eventUnsubscribers.splice(idx, 1);
      }
      this.logger.debug({
        eventType,
        handlerId,
        activeHandlerCount: this.activeHandlerIds.size,
        totalListeners: this.eventUnsubscribers.length,
      }, '[DIAG] handler unsubscribed (individual)');
    };
  }

  /**
   * Clean up all registered event listeners
   */
  cleanupEventListeners(): void {
    if (this.eventUnsubscribers.length > 0) {
      this.logger.debug(
        { count: this.eventUnsubscribers.length, activeHandlersBefore: this.activeHandlerIds.size },
        '[DIAG] cleanupEventListeners called'
      );
      this.eventUnsubscribers.forEach(unsubscribe => unsubscribe());
      this.eventUnsubscribers = [];
      this.logger.debug(
        { activeHandlersAfter: this.activeHandlerIds.size },
        '[DIAG] cleanupEventListeners done'
      );
    }
  }

  /**
   * Abort the current in-flight request
   * 
   * Safe to call even if no session is active (logs a warning instead
   * of throwing).  This is used in cleanup/timeout paths where
   * throwing would mask the original error.
   */
  async abort(): Promise<void> {
    if (!this.session) {
      this.logger.warn('abort called but no active session -- ignoring');
      return;
    }

    this.logger.info('Aborting in-flight request');
    try {
      await this.session.abort();
    } catch (error) {
      this.logger.warn(
        { error: String(error) },
        'Failed to abort session request -- session may already be terminated',
      );
    }
  }

  /**
   * Get session message history
   * 
   * @returns Array of session events, or empty array if no active session
   */
  async getMessages(): Promise<any[]> {
    if (!this.session) {
      this.logger.warn('getMessages called but no active session -- returning empty');
      return [];
    }

    try {
      return await this.session.getMessages();
    } catch (error) {
      this.logger.warn(
        { error: String(error) },
        'Failed to get session messages -- session may have expired',
      );
      return [];
    }
  }

  /**
   * Reinitialize session (clean up old, create new)
   * Useful for recovery from unrecoverable errors
   * 
   * @param config - Session configuration
   * @returns New session ID
   */
  async reinitialize(config: SessionConfig): Promise<string> {
    this.logger.info('Reinitializing session');
    this.cleanupEventListeners();
    
    if (this.session) {
      // Mark old session as inactive
      this.sessionState.isActive = false;
    }

    // Force new session creation
    return await this.initializeSession(undefined, config, true);
  }

  /**
   * Compress conversation history into a bounded context summary.
   *
   * Retrieves all messages from the current session and distills them
   * into a concise string suitable for seeding a fresh session.  The
   * summary preserves:
   *   - User prompts (task instructions)
   *   - Assistant conclusions (final messages, not intermediate deltas)
   *   - Tool invocations and their results (file paths, commands)
   *
   * The output is capped at `maxChars` to keep the seed prompt small.
   *
   * @param maxChars - Maximum character budget for the summary (default 4000)
   * @returns Compressed summary string, or null if no session / no history
   */
  async compressConversationHistory(maxChars: number = 4000): Promise<string | null> {
    if (!this.session) {
      return null;
    }

    try {
      const messages = await this.session.getMessages();
      if (!messages || messages.length === 0) {
        return null;
      }

      // Extract salient content from each message event.
      // We keep user prompts and assistant final messages; skip deltas.
      // Cast through `any` because the SDK's typed event union does not
      // cover all runtime event types (e.g. tool.result) and the data
      // shapes vary.
      const parts: string[] = [];
      let totalLen = 0;
      const budget = maxChars - 200; // reserve room for framing text

      for (const msg of messages) {
        if (totalLen >= budget) break;

        let line: string | null = null;
        const msgAny = msg as any;
        const msgType: string = msgAny.type ?? '';
        const msgData: any = msgAny.data ?? {};

        if (msgType === 'user.message') {
          // Truncate long user prompts to first 300 chars
          const content: string = msgData.content ?? msgData.prompt ?? '';
          const truncated = content.length > 300
            ? content.substring(0, 300) + '...'
            : content;
          line = `[USER] ${truncated}`;
        } else if (msgType === 'assistant.message') {
          // Keep assistant conclusions (capped)
          const content: string = msgData.content ?? '';
          const truncated = content.length > 500
            ? content.substring(0, 500) + '...'
            : content;
          line = `[ASSISTANT] ${truncated}`;
        } else if (msgType === 'tool.result' || msgType === 'tool.use') {
          // Summarize tool results compactly
          const name: string = msgData.toolName ?? msgData.name ?? 'tool';
          const result = String(msgData.result ?? msgData.output ?? '').substring(0, 150);
          line = `[TOOL:${name}] ${result}`;
        }
        // Skip message_delta, session.idle, and other noise

        if (line) {
          parts.push(line);
          totalLen += line.length;
        }
      }

      if (parts.length === 0) {
        return null;
      }

      const summary = parts.join('\n');
      this.logger.info(
        { messageCount: messages.length, summaryParts: parts.length, summaryLen: summary.length },
        'Compressed conversation history for session reset',
      );

      return summary;

    } catch (error) {
      this.logger.warn(
        { error: String(error) },
        'Failed to compress conversation history -- proceeding without context',
      );
      return null;
    }
  }

  /**
   * Reset session with preserved context.
   *
   * This is the primary anti-stuttering mechanism.  It:
   *   1. Retrieves and compresses the current conversation history
   *   2. Destroys the old session (clearing server-side history)
   *   3. Creates a fresh session
   *   4. Seeds the new session with the compressed summary so the LLM
   *      retains awareness of prior work without the raw history that
   *      causes token echo / stuttering in message_delta events
   *
   * @param config - Session configuration for the new session
   * @param contextPreamble - Optional additional context to prepend
   * @returns New session ID
   */
  async resetWithContext(
    config: SessionConfig,
    contextPreamble?: string,
  ): Promise<string> {
    // Step 1: Compress history from the current session
    const historySummary = await this.compressConversationHistory();

    this.logger.info(
      { hasHistory: !!historySummary, historyLen: historySummary?.length ?? 0 },
      'Resetting session with context preservation',
    );

    // Step 2: Clean up the old session
    this.cleanupEventListeners();
    if (this.session) {
      try {
        await this.session.destroy();
        this.logger.info('Old session destroyed');
      } catch (error) {
        this.logger.warn(
          { error: String(error) },
          'Failed to destroy old session -- proceeding with new session',
        );
      }
      this.session = null;
      this.sessionState.isActive = false;
    }

    // Step 3: Create fresh session
    const newSessionId = await this.initializeSession(undefined, config, true);

    // Step 4: Seed with compressed context (if any)
    if (historySummary || contextPreamble) {
      const seedParts: string[] = [
        '## Session Context (carried forward from prior work)',
        '',
        'The following is a compressed summary of the conversation history',
        'from the previous session.  Use it as background context for the',
        'tasks that follow.  Do NOT repeat or echo this summary in your',
        'responses -- it is reference material only.',
        '',
      ];

      if (contextPreamble) {
        seedParts.push('### Additional Context', '', contextPreamble, '');
      }

      if (historySummary) {
        seedParts.push('### Prior Conversation Summary', '', historySummary, '');
      }

      seedParts.push(
        '---',
        'Acknowledge this context silently and wait for the next task.',
      );

      const seedPrompt = seedParts.join('\n');

      try {
        await this.sendPromptAndWait(seedPrompt, 30_000);
        this.logger.info(
          { seedLen: seedPrompt.length },
          'Session seeded with compressed context',
        );
      } catch (error) {
        // Non-fatal: the session is still usable, just without context
        this.logger.warn(
          { error: String(error) },
          'Failed to seed new session with context -- proceeding without it',
        );
      }
    }

    return newSessionId;
  }

  /**
   * Dispose of the session manager and clean up resources
   */
  dispose(): void {
    this.cleanupEventListeners();
    this.session = null;
    this.sessionState = {
      isActive: false
    };
    this.logger.info('Session manager disposed');
  }
}
