// Main autonomous agent implementation

import { CopilotClient } from '@github/copilot-sdk';
import { MailboxManager } from './mailbox.js';
import { createMailboxTools, OnMessageSentCallback } from './tools/mailbox-tools.js';
import { AgentConfig, SessionContext } from './types.js';
import { sleep, loadJSON, saveJSON } from './utils.js';
import { QuotaManager } from './quota-manager.js';
import { WorkspaceManager, WorkItem } from './workspace-manager.js';
import { TimeoutManager } from './timeout-manager.js';
import { SessionManager, isRateLimitError, parseRateLimitDelay } from './session-manager.js';
import { WorkItemExecutor } from './work-item-executor.js';
import { CompletionTracker } from './completion-tracker.js';
import { createPermissionHandler, DEFAULT_PERMISSIONS, PermissionsConfig, PermissionOverrides } from './permission-handler.js';
import { ToolHealthMonitor } from './tool-health-monitor.js';
import { createLogger, createComponentLogger } from './logger.js';
import { ConfigWatcher, HotReloadableFields } from './config-watcher.js';
import { WorkflowEngine } from './workflow-engine.js';
import { WorkflowAssignment, OutOfBandMessage, StateExecutionResult, StateCommand, ExitEvaluation } from './workflow-types.js';
import { detectFailureIndicators } from './fail-pattern-detector.js';
import { composeEvaluationPrompt, parseEvaluationResponse } from './exit-evaluation.js';
import { CommunicationBackend, AgentAddress, AgentMessage } from './communication-backend.js';
import { createBackend } from './backend-factory.js';
import { CompositeBackend } from './backends/composite-backend.js';
import { resolveTargetAddress } from './agent-uri.js';
import pino from 'pino';
import path from 'path';
import fs from 'fs/promises';
import { execSync } from 'child_process';

/** Format an AgentAddress as a flat "hostname_role" string. */
function formatAgentId(addr: AgentAddress): string {
  return `${addr.hostname}_${addr.role}`;
}

export class AutonomousAgent {
  private client: CopilotClient;
  private backend!: CommunicationBackend;
  private mailbox!: MailboxManager;
  private workspace: WorkspaceManager;
  private timeoutManager: TimeoutManager;
  private sessionManager: SessionManager;
  private workItemExecutor: WorkItemExecutor;
  private completionTracker!: CompletionTracker;
  private permissionHandler: ReturnType<typeof createPermissionHandler>;
  private permissionOverrides: PermissionOverrides = {};
  private toolHealthMonitor: ToolHealthMonitor;
  private config: AgentConfig;
  private configWatcher: ConfigWatcher | null = null;
  private configPath: string;
  private logger: pino.Logger;
  private baseLogger: pino.Logger;
  private quotaManager: QuotaManager;
  private hostname: string;
  private workflowEngine: WorkflowEngine | null = null;
  /** Task ID currently active in the workflow engine (set when a workflow
   *  assignment message is received, consumed during work item execution). */
  private activeWorkflowTaskId: string | null = null;
  /** Accumulated LLM response text from all work items in the current workflow phase.
   *  Reset when a new workflow assignment is received; scanned for fail
   *  indicators before the state transition fires. */
  private workflowPhaseResponseText: string = '';
  /** Set to true when entry commands fail on a mechanical state so that
   *  handleWorkflowTransition forces a failure transition. */
  private entryCommandsFailed: boolean = false;
  /** Work items decomposed by the manager during ASSIGN (or similar states).
   *  Attached to the next workflow assignment so the developer receives
   *  pre-decomposed tasks instead of one monolithic prompt. */
  private pendingWorkItems: Array<{ title: string; content: string }> | null = null;
  /** WIP tracking callback for manager role - called when messages are sent to track in-flight delegations */
  private onMessageSentCallback: OnMessageSentCallback | undefined;
  private running: boolean = false;
  private context: SessionContext;
  private contextFile: string;
  private retryAttempts: Map<string, number> = new Map(); // Track retry attempts per work item
  
  constructor(config: AgentConfig, configPath?: string) {
    this.config = config;
    this.configPath = configPath || path.resolve(process.argv[2] || 'config.json');
    const baseLogger = createLogger(path.resolve(config.logging.path));
    this.baseLogger = baseLogger;
    this.logger = createComponentLogger(baseLogger, 'AutonomousAgent');
    
    // Support external Copilot CLI via environment variable
    const cliUrl = process.env.COPILOT_CLI_URL;
    this.client = new CopilotClient(cliUrl ? { cliUrl } : undefined);
    
    // Create SessionManager
    this.sessionManager = new SessionManager(
      this.client,
      createComponentLogger(baseLogger, 'SessionManager')
    );
    
    this.quotaManager = new QuotaManager(config, this.logger);

    // Hostname is resolved by applyDefaults() before the agent is constructed
    this.hostname = config.agent.hostname;

    // Create WorkflowEngine (loading deferred to initialize())
    this.workflowEngine = new WorkflowEngine(
      createComponentLogger(baseLogger, 'WorkflowEngine')
    );
    
    // Workspace manager needs callbacks for message sequence tracking
    this.workspace = new WorkspaceManager(
      config.workspace.path,
      this.logger,
      () => this.getNextMessageSequence(),
      (messageSeq, mailboxFile, workItems) => this.trackMessage(messageSeq, mailboxFile, workItems),
      config.workspace.tasksFolder,
      config.workspace.taskSubfolders,
      config.workspace.workingFolder || 'project'
    );
    
    this.timeoutManager = new TimeoutManager(
      path.resolve(config.workspace.path),
      config.agent.sdkTimeoutMs,
      config.agent.timeoutStrategy
    );
    
    // Create permission handler for SDK tool operations
    // Merges user config overrides with safe defaults
    const permissionsConfig: PermissionsConfig = {
      ...DEFAULT_PERMISSIONS,
      ...config.copilot.permissions,
    };
    this.permissionHandler = createPermissionHandler(
      permissionsConfig,
      path.resolve(config.workspace.path),
      createComponentLogger(baseLogger, 'Permissions'),
      this.permissionOverrides
    );
    this.logger.info({ permissions: permissionsConfig }, 'Permission handler configured');
    
    // Create ToolHealthMonitor to detect PTY/infrastructure failures
    // See: github/copilot-cli#1239, microsoft/node-pty#882
    this.toolHealthMonitor = new ToolHealthMonitor(
      createComponentLogger(baseLogger, 'ToolHealth'),
      {
        degradedThreshold: 2,
        criticalThreshold: 3,
        onAlert: (alert) => {
          this.logger.error({
            level: alert.level,
            ptyFailures: alert.details.ptyFailures,
            totalBashCalls: alert.details.totalBashCalls,
          }, `Tool health alert: ${alert.message}`);
        },
      }
    );
    
    // Create WorkItemExecutor
    this.workItemExecutor = new WorkItemExecutor(
      this.sessionManager,
      this.workspace,
      this.timeoutManager,
      {
        workspacePath: config.workspace.path,
        workingFolder: config.workspace.workingFolder || 'project',
        sdkTimeoutMs: config.agent.sdkTimeoutMs,
        gracePeriodMs: 60000, // 60s grace period
        taskRetryCount: config.agent.taskRetryCount,
        agentRole: config.agent.role,
        teamMembers: config.teamMembers
      },
      createComponentLogger(baseLogger, 'WorkItemExecutor'),
      this.toolHealthMonitor
    );
    
    // CompletionTracker is created in initialize() after the backend is ready
    
    this.contextFile = path.resolve(config.workspace.path, 'session_context.json');
    
    // Initialize context (will be loaded from file if exists)
    this.context = {
      agentId: `${this.hostname}_${config.agent.role}`,
      lastMailboxCheck: new Date(),
      messagesProcessed: 0,
      status: 'idle',
      workingDirectory: path.resolve(config.workspace.path, config.workspace.workingFolder || 'project'),
      nextMessageSequence: 1,
      messageTracking: {}
    };
  }
  
  /**
   * Initialize the agent
   */
  async initialize(): Promise<void> {
    // Create workspace and log directories first (before any logger calls)
    await fs.mkdir(path.dirname(this.config.logging.path), { recursive: true });
    await fs.mkdir(this.context.workingDirectory, { recursive: true });
    
    // Create and initialize the communication backend.
    // The CompositeBackend always includes both the git mailbox and
    // the A2A HTTP server (sensible defaults when unconfigured).
    this.backend = await createBackend(this.config, this.baseLogger);
    await this.backend.initialize();

    // Extract MailboxManager from the composite backend for tool wiring
    // and CompletionTracker compatibility.
    if (this.backend instanceof CompositeBackend) {
      this.mailbox = this.backend.getMailboxBackend().getMailboxManager();
    } else {
      // Fallback for tests or non-composite backends
      this.mailbox = new MailboxManager(
        this.config.mailbox.repoPath,
        this.hostname,
        this.config.agent.role,
        this.config.mailbox.gitSync,
        this.config.mailbox.autoCommit,
        this.config.mailbox.commitMessage,
        this.config.mailbox.supportBroadcast,
        this.config.mailbox.supportAttachments,
        this.config.mailbox.supportPriority ?? true,
        this.config.manager?.hostname ?? this.hostname,
      );
      await this.mailbox.initialize();
    }

    // Create CompletionTracker now that the backend is available
    this.completionTracker = new CompletionTracker(
      this.workspace,
      this.backend,
      {
        managerHostname: this.config.manager?.hostname ?? this.hostname,
        managerRole: this.config.manager?.role ?? this.config.agent.role,
        managerUri: this.config.manager?.uri,
        agentId: `${this.hostname}_${this.config.agent.role}`,
        workspacePath: this.config.workspace.path,
        gitSync: this.config.mailbox.gitSync,
        autoCommit: this.config.mailbox.autoCommit,
      },
      createComponentLogger(this.baseLogger, 'CompletionTracker'),
    );

    this.logger.info({
      agentId: this.context.agentId,
      backend: this.backend.name,
      gitSync: this.config.mailbox.gitSync
    }, 'Initializing autonomous agent');
    
    // Generate .github/copilot-instructions.md from role definition
    // Write to the SDK workingDirectory so the SDK picks it up automatically
    this.logger.info('Generating role-specific copilot instructions...');
    try {
      const { generateCopilotInstructions } = await import('./generate-instructions.js');
      await generateCopilotInstructions(this.config, this.context.workingDirectory);
      this.logger.info('Copilot instructions generated');
    } catch (error) {
      this.logger.warn({ error: String(error) }, 'Failed to generate copilot instructions');
    }
    
    // Initialize workspace manager
    await this.workspace.initialize();
    
    // Initialize quota manager
    await this.quotaManager.initialize();
    
    // Initialize timeout manager
    await this.timeoutManager.initialize();
    
    // Initial git sync (via backend abstraction)
    if (this.config.mailbox.gitSync) {
      this.logger.info('Performing initial git sync...');
      const syncResult = await this.backend.syncFromRemote();
      if (syncResult.success) {
        this.logger.info('Git sync successful');
      } else {
        this.logger.warn({ error: syncResult.message }, 'Git sync failed');
      }
    }
    
    // Load previous context if exists (atomic read with corruption recovery)
    if (this.config.workspace.persistContext) {
      const loadedContext = await loadJSON<SessionContext>(this.contextFile, this.context);
      if (loadedContext) {
        // Merge loaded persistent state with initial context
        this.context = {
          ...this.context,
          ...loadedContext,
          lastMailboxCheck: new Date(loadedContext.lastMailboxCheck),
          nextMessageSequence: loadedContext.nextMessageSequence || 1,
          messageTracking: loadedContext.messageTracking || {},
          reworkTracking: loadedContext.reworkTracking || {}
        };
        this.logger.info({
          messagesProcessed: this.context.messagesProcessed,
          nextMessageSequence: this.context.nextMessageSequence,
          trackedMessages: Object.keys(this.context.messageTracking || {}).length
        }, 'Restored session context');
      }
    }
    
    // Start config file watcher for hot-reload
    this.configWatcher = new ConfigWatcher(
      this.configPath,
      this.config,
      (updated, fullConfig) => this.applyConfigChanges(updated, fullConfig),
      createComponentLogger(createLogger(path.resolve(this.config.logging.path)), 'ConfigWatcher'),
      {
        onTeamRosterChange: () => {
          this.mailbox.clearTeamRosterCache();
          // Reload A2A known agents so updated URIs take effect
          if (this.backend instanceof CompositeBackend) {
            const a2a = this.backend.getA2ABackend();
            if (a2a) {
              a2a.reloadKnownAgents().catch(err => {
                this.logger.warn({ error: String(err) }, 'Failed to reload A2A known agents');
              });
            }
          }
          this.logger.info('Team roster cache invalidated (team.json changed)');
        },
      },
    );
    this.configWatcher.start();

    // Load workflow definition if configured
    if (this.config.agent.workflowFile && this.workflowEngine) {
      try {
        const workflowPath = path.resolve(
          path.dirname(this.configPath),
          this.config.agent.workflowFile
        );
        await this.workflowEngine.loadWorkflowFromFile(workflowPath);
        this.logger.info(
          { workflowFile: this.config.agent.workflowFile },
          'Workflow engine loaded'
        );
      } catch (error) {
        this.logger.error(
          { error: String(error), workflowFile: this.config.agent.workflowFile },
          'Failed to load workflow -- falling back to unstructured mode'
        );
        // Don't crash the agent; fall back to the legacy prompt-based flow
      }
    }

    this.logger.info('Agent initialized successfully');
  }

  /**
   * Resolve a team member address by role.  Checks config.teamMembers
   * first, then enriches with the uri from the team roster (team.json)
   * when the config entry does not provide one.
   */
  private async resolveTargetByRole(role: string): Promise<AgentAddress | undefined> {
    const roster = await this.backend.getTeamRoster();
    return resolveTargetAddress(role, this.config.teamMembers, roster);
  }

  /**
   * Apply hot-reloaded config changes at runtime.
   * Only safe, non-structural fields are updated.
   */
  private applyConfigChanges(updated: HotReloadableFields, fullConfig: AgentConfig): void {
    // Timing fields
    this.config.agent.checkIntervalMs = updated.checkIntervalMs;
    this.config.agent.stuckTimeoutMs = updated.stuckTimeoutMs;
    this.config.agent.sdkTimeoutMs = updated.sdkTimeoutMs;
    this.config.agent.taskRetryCount = updated.taskRetryCount;

    // Strategy and validation
    this.config.agent.timeoutStrategy = updated.timeoutStrategy;
    this.config.agent.validation = updated.validation;

    // Team members (affects manager delegation prompts)
    this.config.teamMembers = updated.teamMembers;

    // Quota
    if (this.config.quota && updated.quotaEnabled !== undefined) {
      this.config.quota.enabled = updated.quotaEnabled;
    }
    if (this.config.quota && updated.quotaPreset !== undefined) {
      this.config.quota.preset = updated.quotaPreset;
    }

    // Update timeout manager with new SDK timeout
    this.timeoutManager.updateTimeout(updated.sdkTimeoutMs);

    this.logger.info(
      { checkIntervalMs: updated.checkIntervalMs, sdkTimeoutMs: updated.sdkTimeoutMs },
      'Config hot-reloaded successfully'
    );
  }
  
  /**
   * Start the autonomous agent loop
   */
  async start(): Promise<void> {
    this.running = true;
    this.logger.info('Starting autonomous agent loop');
    
    // Create or resume persistent session
    await this.initializeSession();
    
    // Main autonomous loop
    while (this.running) {
      try {
        // RATE-LIMIT GUARD: If the session manager is in a backoff period,
        // sleep through it instead of burning cycles on calls that will fail.
        if (this.sessionManager.isRateLimited) {
          const waitMs = this.sessionManager.rateLimitRemainingMs;
          const waitMin = Math.ceil(waitMs / 60_000);
          const resumeAt = new Date(Date.now() + waitMs).toISOString();
          this.logger.warn(
            { waitMs, waitMin, resumeAt },
            `RATE LIMIT BACKOFF -- pausing agent for ~${waitMin} min (resume at ${resumeAt})`,
          );
          // Sleep in 5s chunks so we can still respond to SIGINT/SIGTERM
          const chunks = Math.ceil(waitMs / 5000);
          for (let i = 0; i < chunks && this.running; i++) {
            await sleep(Math.min(5000, waitMs - i * 5000));
          }
          continue;
        }

        // PRIORITY 1: Check priority mailbox FIRST for urgent messages
        // This allows manager responses and urgent corrections to interrupt current work
        const priorityHandled = await this.checkPriorityMailbox();
        
        if (priorityHandled) {
          // Priority messages processed - sleep briefly then restart loop
          // This ensures we drain all priority items before resuming normal work
          const priorityJitter = 0.75 + Math.random() * 0.5;
          const prioritySleepMs = Math.round(this.config.agent.checkIntervalMs * priorityJitter);
          this.logger.info(
            `Sleeping for ${(prioritySleepMs / 1000).toFixed(1)}s until next check`
          );
          await sleep(prioritySleepMs);
          continue;
        }

        // PRIORITY 2: WIP gate for manager role.
        // If there are in-flight delegations at or above the WIP limit,
        // the manager waits for completion messages before delegating more work.
        const wipLimit = this.config.agent.wipLimit ?? 0; // 0 = disabled
        if (wipLimit > 0 && this.config.agent.role === 'manager') {
          const inFlightCount = this.getInFlightCount();
          if (inFlightCount >= wipLimit) {
            this.logger.info(
              { inFlightCount, wipLimit },
              'WIP limit reached -- checking for completion messages only',
            );
            await this.checkForCompletionMessages();
            this.expireStaleInFlightDelegations();
            await saveJSON(this.contextFile, this.context);
            const wipJitter = 0.75 + Math.random() * 0.5;
            const wipSleepMs = Math.round(this.config.agent.checkIntervalMs * wipJitter);
            this.logger.debug(`WIP gate active -- sleeping ${(wipSleepMs / 1000).toFixed(1)}s`);
            const sleepChunkMs = 1000;
            const wipChunks = Math.ceil(wipSleepMs / sleepChunkMs);
            for (let i = 0; i < wipChunks && this.running; i++) {
              await sleep(sleepChunkMs);
            }
            continue;
          }
        }

        // PRIORITY 3: Process pending work items from previous messages
        const hasWork = await this.workspace.hasWorkItems();
        
        if (hasWork) {
          await this.processNextWorkItem();
        } else {
          // PRIORITY 4: Check normal and background mailbox for new messages
          await this.checkAndProcessMailbox();
        }
        
        // Save context after each iteration
        await saveJSON(this.contextFile, this.context);
        
        // Wait for next check interval with jitter to prevent agent synchronization.
        // +/-25% random offset keeps multiple agents from polling in lockstep,
        // even after variable-length tasks cause them to temporarily align.
        const jitterFactor = 0.75 + Math.random() * 0.5; // 0.75 to 1.25
        const jitteredMs = Math.round(this.config.agent.checkIntervalMs * jitterFactor);
        this.logger.info(
          `Sleeping for ${(jitteredMs / 1000).toFixed(1)}s until next check (base: ${this.config.agent.checkIntervalMs / 1000}s)`
        );
        
        // Sleep in smaller chunks to allow faster shutdown response
        const sleepChunkMs = 1000; // Check every second
        const chunks = Math.ceil(jitteredMs / sleepChunkMs);
        for (let i = 0; i < chunks && this.running; i++) {
          await sleep(sleepChunkMs);
        }
        
      } catch (error) {
        this.logger.error({ error: String(error) }, 'Error in agent loop');
        
        // Wait before retrying on error (also check running flag)
        for (let i = 0; i < 60 && this.running; i++) {
          await sleep(1000);
        }
      }
    }
    
    this.logger.info('Agent main loop exited');
  }
  
  /**
   * Stop the agent gracefully
   */
  async stop(): Promise<void> {
    this.running = false;
    
    // Stop config watcher
    if (this.configWatcher) {
      this.configWatcher.stop();
      this.configWatcher = null;
    }
    
    await saveJSON(this.contextFile, this.context);
    
    if (this.config.mailbox.gitSync && this.config.mailbox.autoCommit) {
      await this.backend.syncToRemote('Agent shutdown');
    }

    // Shut down the communication backend (stops servers, flushes buffers)
    await this.backend.shutdown();
    
    // Delete the current session so it does not accumulate in the VS
    // Code session list.  This is a lightweight SDK call (HTTP DELETE)
    // that is safe during shutdown -- unlike send/abort which have
    // streaming race conditions.
    try {
      await this.sessionManager.deleteCurrentSession();
    } catch {
      // Best-effort -- do not block shutdown
    }

    // Clear the persisted session ID so the next run creates fresh
    this.context.sessionId = undefined;
  }
  
  /**
   * Get session ID for context persistence
   */
  private getSessionId(): string | undefined {
    const state = this.sessionManager.getState();
    return state.sessionId;
  }
  
  /**
   * Get next message sequence number (persistent across restarts)
   * Protected to allow testing of sequence persistence
   */
  protected getNextMessageSequence(): number {
    const current = this.context.nextMessageSequence || 1;
    this.context.nextMessageSequence = current + 1;
    return current;
  }
  
  /**
   * Track message decomposition in persistent context
   * Protected to allow testing of message tracking
   */
  protected trackMessage(messageSeq: number, mailboxFile: string, workItems: string[]): void {
    const messageSeqStr = String(messageSeq).padStart(3, '0');
    
    if (!this.context.messageTracking) {
      this.context.messageTracking = {};
    }
    
    // Extract timestamp from filename if present (e.g., "2025-12-20-1000_task.md")
    const timestampMatch = mailboxFile.match(/^(\d{4}-\d{2}-\d{2}-\d{4})/);
    
    this.context.messageTracking[messageSeqStr] = {
      mailboxFile,
      mailboxTimestamp: timestampMatch ? timestampMatch[1] : undefined,
      decomposedAt: new Date().toISOString(),
      status: 'decomposed',
      workItemsCreated: workItems,
      pendingWorkItems: [...workItems]
    };
  }
  
  // ========================================================================
  // Public methods for testing and state introspection
  // ========================================================================
  
  /**
   * Get current session context (for testing)
   */
  public getContext(): Readonly<SessionContext> {
    return { ...this.context };
  }
  
  /**
   * Get next message sequence without incrementing (for testing)
   */
  public peekNextSequence(): number {
    return this.context.nextMessageSequence || 1;
  }
  
  /**
   * Get message tracking info (for testing)
   */
  public getMessageTracking(messageSeq: number): any {
    const key = String(messageSeq).padStart(3, '0');
    return this.context.messageTracking?.[key];
  }
  
  /**
   * Manually save context (for testing state persistence)
   */
  public async saveContext(): Promise<void> {
    await saveJSON(this.contextFile, this.context);
  }
  
  /**
   * Get context file path (for testing corruption scenarios)
   */
  public getContextFilePath(): string {
    return this.contextFile;
  }
  
  // ========================================================================
  // End of test introspection methods
  // ========================================================================
  
  /**
   * Initialize or resume Copilot session
   */
  private async initializeSession(forceNew: boolean = false): Promise<void> {
    // Get quota and model selection
    const quotaCheck = await this.quotaManager.checkQuotaAndSelectModel('NORMAL');
    
    // Create WIP tracking callback and store for later use in processWorkflowAssignment()
    this.onMessageSentCallback = this.createOnMessageSentCallback();
    
    // Create tools array with WIP tracking callback for manager role
    const tools = createMailboxTools(this.mailbox, this.onMessageSentCallback);
    
    this.logger.info({ 
      toolCount: tools.length,
      toolNames: tools.map(t => t.name)
    }, 'Registering mailbox tools with session');
    
    // Initialize session through SessionManager
    // NOTE: Do NOT set availableTools — it acts as a whitelist and would
    // disable Copilot's built-in tools (file I/O, terminal, etc.).
    // The tools array registers our custom tools; built-in tools remain available.
    const sessionId = await this.sessionManager.initializeSession(
      this.context.sessionId,
      {
        model: quotaCheck.model,
        streaming: true,  // Hardcoded - agent only works in streaming mode
        tools: tools,
        onPermissionRequest: this.permissionHandler,
        workingDirectory: path.resolve(this.config.workspace.path, this.config.workspace.workingFolder || 'project'),
      },
      forceNew
    );
    
    // Update context with session ID
    this.context.sessionId = sessionId;
  }

  /**
   * Reset the Copilot session while preserving context from prior work.
   *
   * This is the primary anti-stuttering mechanism.  The Copilot SDK
   * accumulates conversation history server-side.  After several
   * sendPromptAndWait() calls the history grows large enough that the
   * LLM's streaming response echoes / replays fragments from earlier
   * turns, producing the characteristic "DeDeDecomcomcom..." stutter
   * in message_delta events.  The repetition factor grows linearly
   * with the number of prior prompts.
   *
   * The fix:
   *   1. Compress the current session's history into a bounded summary
   *   2. Destroy the old session (clears server-side history)
   *   3. Create a fresh session
   *   4. Seed it with the compressed summary as the first prompt
   *
   * Call this between workflow task cycles (after transition routing,
   * before the next assignment is processed).
   *
   * @param contextPreamble - Optional extra context (e.g. task notes)
   */
  private async resetSessionWithContext(contextPreamble?: string): Promise<void> {
    try {
      const quotaCheck = await this.quotaManager.checkQuotaAndSelectModel('NORMAL');
      
      // Create WIP tracking callback and store for later use in processWorkflowAssignment()
      this.onMessageSentCallback = this.createOnMessageSentCallback();
      const tools = createMailboxTools(this.mailbox, this.onMessageSentCallback);

      const config = {
        model: quotaCheck.model,
        streaming: true,
        tools: tools,
        onPermissionRequest: this.permissionHandler,
        workingDirectory: path.resolve(
          this.config.workspace.path,
          this.config.workspace.workingFolder || 'project',
        ),
      };

      const newSessionId = await this.sessionManager.resetWithContext(
        config,
        contextPreamble,
      );

      this.context.sessionId = newSessionId;
      this.logger.info(
        { newSessionId },
        'Session reset with context preservation complete',
      );
    } catch (error) {
      this.logger.warn(
        { error: String(error) },
        'Session reset with context failed -- next initializeSession() will recover',
      );
      // Non-fatal: the next initializeSession() call will create or
      // resume a session as usual.  Stuttering may persist until then.
    }
  }


  /**
   * Send a prompt to the LLM and return the accumulated response text.
   * Handles listener registration, cleanup, and optional length capping.
   *
   * If the SDK session has expired, renews it once, re-registers the
   * delta listener on the fresh session, and retries.
   *
   * This is the single seam for all LLM interactions that only need
   * text output (not tool calls).  Tests mock this one method.
   */
  private async promptLLM(
    prompt: string,
    maxResponseChars?: number,
  ): Promise<string> {
    const attempt = async (): Promise<string> => {
      this.sessionManager.cleanupEventListeners();

      let responseText = '';
      const unsub = this.sessionManager.addEventListener(
        'assistant.message_delta' as any,
        (event: any) => {
          const delta = event.data.deltaContent ?? '';
          if (!maxResponseChars || responseText.length < maxResponseChars) {
            responseText += delta;
          }
        },
      );

      try {
        await this.sessionManager.sendPromptAndWait(
          prompt,
          this.config.agent.sdkTimeoutMs,
        );
      } finally {
        unsub();
        this.sessionManager.cleanupEventListeners();
      }

      return responseText;
    };

    try {
      return await attempt();
    } catch (error) {
      const msg = String((error as any)?.message ?? error ?? '');
      if (SessionManager.isSessionExpiredError(msg)) {
        this.logger.warn('Session expired in promptLLM -- renewing and retrying');
        const newId = await this.sessionManager.renewExpiredSession();
        if (!newId) {
          throw new Error('Session expired and renewal failed in promptLLM');
        }
        return await attempt();
      }
      throw error;
    }
  }

  /**
   * Check priority mailbox only and process any HIGH priority messages
   * Returns true if priority messages were processed
   */
  private async checkPriorityMailbox(): Promise<boolean> {
    if (!this.config.mailbox.supportPriority) {
      return false; // Priority not enabled
    }
    
    this.logger.debug('Checking priority mailbox');
    
    // Git sync before checking mailbox
    if (this.config.mailbox.gitSync) {
      this.logger.debug('Syncing from git remote...');
      const syncResult = await this.backend.syncFromRemote();
      if (!syncResult.success) {
        this.logger.warn({ error: syncResult.message }, 'Git sync failed');
      }
    }
    
    // Get all messages (priority will be first in the list)
    const messages = await this.backend.receiveMessages();
    
    // Filter for only HIGH priority messages
    let priorityMessages = messages.filter(msg => msg.priority === 'HIGH');
    
    if (priorityMessages.length === 0) {
      return false;
    }
    
    this.logger.info(`Found ${priorityMessages.length} HIGH priority message(s)`);
    
    // Receiver-side backpressure: limit how many priority messages we accept
    // when the pending work queue is already large
    const backpressure = this.config.agent.backpressure;
    const bpEnabled = backpressure?.enabled !== false; // default: true
    const maxPending = backpressure?.maxPendingWorkItems ?? 50;
    
    if (bpEnabled) {
      const pendingCount = await this.workspace.getWorkItemCount();
      const bp = applyBackpressure(priorityMessages, pendingCount, {
        enabled: true,
        maxPendingWorkItems: maxPending,
      });
      if (bp.skipped) {
        this.logger.warn(
          { pendingCount, maxPending, deferredMessages: priorityMessages.length },
          bp.reason || 'Backpressure: skipping priority messages',
        );
        return false;
      }
      priorityMessages = bp.messages;
    }
    
    // Process priority messages (may be limited by backpressure above)
    for (const message of priorityMessages) {
      this.logger.info({
        from: message.from,
        priority: message.priority
      }, `Breaking down HIGH priority message: ${message.subject}`);
      
      try {
        this.context.status = 'breaking_down_task';
        this.context.currentTask = {
          messageId: message.id,
          subject: message.subject,
          description: message.content,
          acceptanceCriteria: [],
          priority: message.priority || 'HIGH'
        };
        
        // Check if this is a QA rejection (rework request)
        if (this.isQARejection(message)) {
          await this.handleQARejection(message);
        } else {
          // Classify and process (workflow-aware or legacy)
          await this.classifyAndProcessMessage(message);
        }
        
        // Archive the message after breaking it down
        await this.backend.acknowledgeMessage(message.id);
        this.logger.info(`Archived HIGH priority message: ${message.id}`);
        
        this.context.messagesProcessed++;
        this.context.status = 'idle';
        
      } catch (error) {
        this.logger.error({
          error: String(error)
        }, `Failed to break down HIGH priority message: ${message.subject}`);
        
        // Guard: do NOT escalate if this message is itself an escalation.
        // The manager is the escalation target, so re-escalating creates an
        // infinite loop (the new escalation lands back in priority/ and fails
        // again the same way).  Archive the poison message instead.
        const isEscalation = (message.subject || '').startsWith('Escalation:');
        if (isEscalation) {
          this.logger.warn(
            { subject: message.subject },
            'Suppressing re-escalation of already-escalated message to prevent infinite loop',
          );
          await this.backend.acknowledgeMessage(message.id);
        } else {
          await this.backend.escalate(
            `Failed to break down HIGH priority task: ${message.subject}`,
            `Error: ${String(error)}\n\nOriginal message:\n${message.content}`
          );
        }
        
        this.context.status = 'escalated';
      }
    }
    
    // Git sync after processing priority messages
    if (this.config.mailbox.gitSync) {
      await this.backend.syncToRemote();
    }
    
    return true; // Indicate priority messages were processed
  }
  
  /**
   * Check mailbox for normal and background priority messages
   */
  private async checkAndProcessMailbox(): Promise<void> {
    this.logger.debug('Checking mailbox for new messages');
    
    // Git sync before checking mailbox
    if (this.config.mailbox.gitSync) {
      this.logger.debug('Syncing from git remote...');
      const syncResult = await this.backend.syncFromRemote();
      if (!syncResult.success) {
        this.logger.warn({ error: syncResult.message }, 'Git sync failed');
      }
    }
    
    this.context.lastMailboxCheck = new Date();
    
    const messages = await this.backend.receiveMessages();
    
    // Filter out HIGH priority messages (already handled by checkPriorityMailbox)
    const normalMessages = this.config.mailbox.supportPriority 
      ? messages.filter(msg => msg.priority !== 'HIGH')
      : messages;
    
    if (normalMessages.length === 0) {
      this.logger.info('No new messages in mailbox');
      this.context.status = 'idle';
      return;
    }
    
    this.logger.info(`Found ${normalMessages.length} new message(s)`);
    
    // Process first message by breaking it down into work items
    const message = normalMessages[0];
    
    this.logger.info({
      from: message.from,
      priority: message.priority
    }, `Breaking down message into work items: ${message.subject}`);
    
    try {
      this.context.status = 'breaking_down_task';
      this.context.currentTask = {
        messageId: message.id,
        subject: message.subject,
        description: message.content,
        acceptanceCriteria: [],
        priority: message.priority || 'NORMAL'
      };
      
      // Break down the message into work items (workflow-aware)
      await this.classifyAndProcessMessage(message);
      
      // Archive the message after breaking it down
      await this.backend.acknowledgeMessage(message.id);
      this.logger.info(`Archived message: ${message.id}`);
      
      // Git sync after archiving
      if (this.config.mailbox.gitSync && this.config.mailbox.autoCommit) {
        await this.backend.syncToRemote(`Break down task: ${message.subject}`);
      }
      
      this.context.messagesProcessed++;
      this.context.status = 'idle';
      
    } catch (error) {
      this.logger.error({
        error: String(error)
      }, `Failed to break down message: ${message.subject}`);
      
      // Guard: do NOT escalate if this message is itself an escalation
      // to prevent infinite self-escalation loops on the manager.
      const isEscalation = (message.subject || '').startsWith('Escalation:');
      if (isEscalation) {
        this.logger.warn(
          { subject: message.subject },
          'Suppressing re-escalation of already-escalated message to prevent infinite loop',
        );
        await this.backend.acknowledgeMessage(message.id);
      } else {
        await this.backend.escalate(
          `Failed to break down task: ${message.subject}`,
          `Error: ${String(error)}\n\nOriginal message:\n${message.content}`
        );
      }
      
      this.context.status = 'escalated';
    }
  }
  
  /**
   * Check if a message is a QA rejection (rework request)
   * QA rejections have subjects starting with "QA Rejection:" and come from QA agents
   */
  private isQARejection(message: any): boolean {
    const subject = (message.subject || '').trim();
    return subject.startsWith('QA Rejection:');
  }
  
  /**
   * Handle QA rejection by creating a rework work item directly
   * 
   * Unlike normal messages that get broken down via LLM, QA rejections
   * already contain structured feedback (failures, what to fix, files to check).
   * We create a single rework work item that includes the full rejection context.
   */
  private async handleQARejection(message: any): Promise<void> {
    // Extract the original task name from the subject
    const originalTask = (message.subject || '')
      .replace(/^QA Rejection:\s*/, '')
      .trim();
    
    // Track rework cycles to prevent infinite loops
    const reworkKey = `rework:${originalTask}`;
    const reworkCycle = (this.context.reworkTracking?.[reworkKey] ?? 0) + 1;
    const maxReworkCycles = 2;
    
    // Initialize rework tracking in context if needed
    if (!this.context.reworkTracking) {
      this.context.reworkTracking = {};
    }
    this.context.reworkTracking[reworkKey] = reworkCycle;
    
    this.logger.info({
      originalTask,
      reworkCycle,
      maxReworkCycles,
      from: message.from
    }, 'Handling QA rejection as rework');
    
    if (reworkCycle > maxReworkCycles) {
      // Too many rework cycles — escalate to manager
      this.logger.warn({
        originalTask,
        reworkCycle
      }, `Rework cycle limit exceeded (${reworkCycle}/${maxReworkCycles}), escalating to manager`);
      
      await this.backend.escalate(
        `QA rejection cycle limit reached: ${originalTask}`,
        `This task has been rejected by QA ${reworkCycle} times and I cannot resolve the issues.\n\n` +
        `**Latest QA rejection:**\n${message.content}\n\n` +
        `**Action needed:** Please review the task requirements and QA feedback, ` +
        `then either adjust the requirements or provide additional guidance.`
      );
      
      // Clear the rework counter so it can be retried if manager provides guidance
      delete this.context.reworkTracking[reworkKey];
      return;
    }
    
    // Create a single rework work item with the rejection context embedded
    const reworkContent = `## REWORK REQUEST (Cycle ${reworkCycle}/${maxReworkCycles})

This is a rework of a previously completed task that was rejected by QA.
Address ALL failures listed below before resubmitting.

**From QA:** ${formatAgentId(message.from)}

---

${message.content}

---

**Instructions:**
1. Read the QA feedback above carefully
2. Fix EACH issue listed in "Failures Found" and "What To Fix"
3. Check every file listed in "Files To Check"
4. Run the build, tests, and linter locally to verify your fixes
5. Only send completion report when ALL checks pass
6. If the QA feedback is unclear, escalate to manager instead of guessing`;

    // Create work item directly — no LLM breakdown needed
    await this.workspace.createWorkItems(
      [{
        title: `Rework: ${originalTask}`,
        content: reworkContent
      }],
      message.id
    );
    
    this.logger.info({
      originalTask,
      reworkCycle
    }, `Created rework work item for: ${originalTask}`);
  }

  // ========================================================================
  // Workflow-aware message classification and routing
  // ========================================================================

  /**
   * Classify an incoming message and route it through the appropriate path.
   *
   * 1. If the workflow engine is loaded and the message contains an embedded
   *    WorkflowAssignment, use receiveAssignment() to hydrate task state &
   *    get the rendered prompt, then break down into work items with that
   *    enriched context.
   * 2. If the message contains an OutOfBandMessage, process it with urgent
   *    prompt and full tool access.
   * 3. Otherwise, fall through to the legacy LLM-driven breakdown.
   */
  private async classifyAndProcessMessage(message: any): Promise<void> {
    // If no workflow engine or no workflows loaded, go straight to legacy path
    if (!this.workflowEngine || this.workflowEngine.getLoadedWorkflowIds().length === 0) {
      await this.breakDownIntoWorkItems(message);
      return;
    }

    // ---------------------------------------------------------------
    // PRIMARY PATH: Use the strict MessageType header from the parsed
    // MailboxMessage.  The header is set at write time and validated
    // by parseMailboxMessage, so no content sniffing is needed.
    // ---------------------------------------------------------------
    const messageType: string = message.messageType || 'unstructured';
    const payload: Record<string, unknown> | undefined = message.payload;

    if (messageType === 'workflow' && payload) {
      const assignment = this.workflowEngine.validateWorkflowPayload(payload);
      if (assignment) {
        return this.processWorkflowAssignment(message, assignment);
      }
      // Validation failed -- fall through to legacy path
      this.logger.warn(
        { subject: message.subject },
        'MessageType header says workflow but payload validation failed -- trying legacy parse',
      );
    }

    if (messageType === 'oob' && payload) {
      const oob = this.workflowEngine.validateOOBPayload(payload);
      if (oob) {
        return this.processOOBMessage(message, oob);
      }
      this.logger.warn(
        { subject: message.subject },
        'MessageType header says oob but payload validation failed -- trying legacy parse',
      );
    }

    // ---------------------------------------------------------------
    // STATUS -- informational messages (completion reports, status
    // updates).  Log and acknowledge but do NOT decompose into work
    // items.  This prevents the manager from trying to JSON-parse
    // free-text completion reports that the LLM returns as prose.
    // ---------------------------------------------------------------
    if (messageType === 'status') {
      this.logger.info(
        { from: message.from, subject: message.subject },
        'Received status message -- logged (no decomposition)',
      );
      return;
    }

    // ---------------------------------------------------------------
    // FALLBACK: Legacy content-sniffing for messages without
    // MessageType header (backward compatibility).
    // ---------------------------------------------------------------
    if (messageType === 'unstructured') {
      const classification = this.workflowEngine.classifyMessage(message.content);

      if (classification === 'workflow') {
        const unpacked = this.workflowEngine.unpackMessage(message.content);
        if (unpacked && unpacked.type === 'workflow') {
          this.logger.info('Handled legacy WORKFLOW_MSG envelope (no MessageType header)');
          return this.processWorkflowAssignment(message, unpacked as WorkflowAssignment);
        }
      }

      if (classification === 'oob') {
        const unpacked = this.workflowEngine.unpackMessage(message.content);
        if (unpacked && unpacked.type === 'oob') {
          this.logger.info('Handled legacy OOB envelope (no MessageType header)');
          return this.processOOBMessage(message, unpacked as OutOfBandMessage);
        }
      }
    }

    // ---------------------------------------------------------------
    // UNSTRUCTURED -- process via LLM decomposition when no workflow is
    // in flight.  When the manager has active workflow tasks, suppress
    // decomposition to prevent duplicate delegations (Bug 12).
    //
    // The workflow engine already tracks active tasks in its activeTasks
    // Map, even after the manager clears its local activeWorkflowTaskId
    // once it routes an assignment.  Without this guard, messages from
    // workflow participants (e.g. QA "Task Complete") that lack a
    // MessageType header would be decomposed into 5-6 delegation work
    // items -- flooding the developer inbox with stale duplicates while
    // the workflow engine has already routed the proper transition.
    // ---------------------------------------------------------------
    const isManagerRole = this.config.agent.role === 'manager';
    const workflowInFlight = this.workflowEngine.getActiveTaskCount() > 0;

    if (isManagerRole && workflowInFlight) {
      this.logger.warn(
        {
          from: message.from,
          subject: message.subject,
          activeTaskCount: this.workflowEngine.getActiveTaskCount(),
          activeTaskIds: this.workflowEngine.getActiveTaskIds(),
        },
        'Suppressing unstructured decomposition -- workflow in flight (Bug 12 guard)',
      );
      return;
    }

    this.logger.info('Message classified as unstructured -- using legacy breakdown');
    await this.breakDownIntoWorkItems(message);
  }

  // -----------------------------------------------------------------------
  // Extracted helpers for workflow / OOB message processing
  // -----------------------------------------------------------------------

  /**
   * Process a validated WorkflowAssignment.
   */
  private async processWorkflowAssignment(
    message: any,
    assignment: WorkflowAssignment,
  ): Promise<void> {
    this.logger.info({
      taskId: assignment.taskId,
      targetState: assignment.targetState,
      targetRole: assignment.targetRole,
      workflowId: assignment.workflowId,
      hasWorkItems: !!(assignment.workItems && assignment.workItems.length),
    }, 'Received workflow assignment');

    // ---- Manager as pure workflow router ----
    const isManager = this.config.agent.role === 'manager';
    if (isManager) {
      if (assignment.targetRole !== 'manager') {
        // Route to the designated team member
        const target = await this.resolveTargetByRole(assignment.targetRole);
        if (target) {
          // Forward using strict schema -- re-serialize the assignment as payload
          const sendResult = await this.backend.sendMessage(
            target,
            {
              to: target,
              subject: message.subject || `[Workflow] ${assignment.targetState}: ${assignment.taskId}`,
              content: '',
              priority: 'NORMAL',
              messageType: 'workflow',
              payload: assignment as unknown as Record<string, unknown>,
            },
          );
          
          // Notify WIP tracking callback (needed because we're calling backend.sendMessage
          // directly, not via the send_message tool which normally triggers this)
          if (this.onMessageSentCallback) {
            this.onMessageSentCallback({
              toHostname: target.hostname,
              toRole: target.role,
              subject: message.subject || `[Workflow] ${assignment.targetState}: ${assignment.taskId}`,
              filepath: sendResult.ref,
            });
          }
          
          this.logger.info({
            taskId: assignment.taskId,
            targetState: assignment.targetState,
            targetRole: assignment.targetRole,
            targetHostname: target.hostname,
          }, 'Manager routed workflow assignment to target role');
        } else {
          this.logger.warn(
            { taskId: assignment.taskId, role: assignment.targetRole },
            'Manager cannot route workflow -- no team member with matching role',
          );
        }
        return;
      }

      // targetRole === 'manager' -- check if this is a terminal state
      const workflow = this.workflowEngine!.getWorkflow(assignment.workflowId);
      if (workflow && workflow.terminalStates.includes(assignment.targetState)) {
        this.logger.info({
          taskId: assignment.taskId,
          targetState: assignment.targetState,
        }, 'Manager received terminal workflow assignment');
        this.logger.info({ taskId: assignment.taskId }, 'Workflow reached terminal state -- complete');

        // Remove the task from active tracking so the Bug 12 guard
        // does not block subsequent unstructured messages (e.g. defect
        // reports) after the workflow completes.
        this.workflowEngine!.removeTask(assignment.taskId);
        return;
      }

      // Non-terminal state targeted at manager (e.g. ASSIGN) -- execute
      // as a single interactive turn.  The LLM decomposes the task into
      // developer-actionable work items (JSON array).  Those work items
      // are attached to the workflow assignment that handleWorkflowTransition()
      // sends to the developer, so the developer receives pre-decomposed
      // tasks rather than one monolithic prompt.
      this.logger.info({
        taskId: assignment.taskId,
        targetState: assignment.targetState,
      }, 'Manager executing own workflow state (decomposition)');

      const received = this.workflowEngine!.receiveAssignment(assignment);
      this.activeWorkflowTaskId = received.taskId;
      this.workflowPhaseResponseText = '';
      this.pendingWorkItems = null;

      // ---- Empty-prompt fast-path (mechanical routing) ----
      // When the ASSIGN state has no prompt, the manager is acting as a
      // pure routing gate.  Skip the LLM turn entirely and transition
      // immediately.  This avoids wasted tokens and prevents the LLM
      // from calling tools (like send_message) that fail because no
      // meaningful context was provided.
      const statePrompt = received.prompt?.trim() ?? '';
      if (statePrompt.length === 0) {
        this.logger.info(
          { taskId: assignment.taskId, targetState: assignment.targetState },
          'Empty prompt -- mechanical routing (no LLM turn)',
        );
        await this.handleWorkflowTransition();
        this.pendingWorkItems = null;
        this.workItemExecutor.clearWorkflowContext();
        return;
      }

      this.logger.info({
        taskId: received.taskId,
        restrictedTools: received.restrictedTools,
        recommendedTools: received.allowedTools.length,
      }, 'Workflow task activated (manager single-turn)');

      this.workItemExecutor.updateWorkflowContext(
        received.prompt,
        received.restrictedTools,
      );

      // Build a single synthetic work item carrying the full ASSIGN prompt
      // so the LLM produces a decomposed JSON array of work items.
      // Inject min/max work item counts from agent config into the prompt
      // (the workflow template uses {{minWorkItems}}/{{maxWorkItems}}).
      // Only create/resume if no active session exists to prevent
      // duplicate event notification channels (stuttering fix).
      if (!this.sessionManager.isActive()) {
        await this.initializeSession(false);
      }

      const minWI = this.config.agent.minWorkItems ?? 5;
      const maxWI = this.config.agent.maxWorkItems ?? 20;
      const renderedPrompt = received.prompt
        .replace(/\{\{minWorkItems\}\}/g, String(minWI))
        .replace(/\{\{maxWorkItems\}\}/g, String(maxWI));

      const syntheticWorkItem: WorkItem = {
        filename: `workflow-${assignment.taskId}-${assignment.targetState}.md`,
        sequence: 0,
        title: `${assignment.targetState}: ${assignment.taskId}`,
        content: renderedPrompt + `\n\n---\n**Task prompt:**\n${assignment.taskPrompt}`,
        fullPath: '',  // synthetic -- not persisted to disk
      };

      this.logger.info(
        { taskId: assignment.taskId, targetState: assignment.targetState },
        'Executing manager workflow state as single turn',
      );

      let result = await this.workItemExecutor.execute(syntheticWorkItem);

      // If the session expired, renew it and retry once before giving up.
      if (!result.success && result.error &&
          SessionManager.isSessionExpiredError(result.error)) {
        this.logger.warn(
          { taskId: assignment.taskId },
          'Session expired during manager ASSIGN -- renewing and retrying',
        );
        await this.initializeSession(true);
        result = await this.workItemExecutor.execute(syntheticWorkItem);
      }

      if (result.responseText) {
        this.workflowPhaseResponseText += result.responseText;

        // Try to parse work items from the LLM response.
        // The ASSIGN prompt instructs the LLM to output a raw JSON array.
        const parsed = this.parseWorkItemsFromResponse(result.responseText);
        if (parsed && parsed.length > 0) {
          this.pendingWorkItems = parsed;
          this.logger.info(
            { taskId: assignment.taskId, count: parsed.length },
            'Manager decomposed task into work items',
          );
        } else {
          this.logger.warn(
            { taskId: assignment.taskId },
            'Manager response did not contain parseable work items -- developer will use LLM decomposition',
          );
        }
      }

      if (result.success) {
        this.logger.info(
          { taskId: assignment.taskId },
          'Manager workflow state completed',
        );
        // Transition the workflow state machine and route to next role.
        await this.handleWorkflowTransition();
      } else {
        this.logger.error(
          { taskId: assignment.taskId, error: result.error },
          'Manager workflow state failed',
        );
      }

      this.pendingWorkItems = null;
      this.workItemExecutor.clearWorkflowContext();
      return;
    }

    // ---- Terminal state notification from another agent ----
    // When a task ESCALATES on a remote agent, it peer-routes a terminal
    // notification here so we log it and allow the test harness to detect
    // completion by monitoring our log.
    if ((assignment as any).isTerminal) {
      this.logger.info({
        taskId: assignment.taskId,
        newState: assignment.targetState,
        newRole: assignment.targetRole,
        isTerminal: true,
      }, 'Workflow state transition');
      this.logger.info(
        { taskId: assignment.taskId },
        'Workflow task reached terminal state',
      );
      return;
    }

    // ---- Non-manager: receive and execute ----
    const received = this.workflowEngine!.receiveAssignment(assignment);
    this.activeWorkflowTaskId = received.taskId;
    this.workflowPhaseResponseText = '';  // Reset for new phase

    this.logger.info({
      taskId: received.taskId,
      restrictedTools: received.restrictedTools,
      recommendedTools: received.allowedTools.length,
    }, 'Workflow task activated');

    this.workItemExecutor.updateWorkflowContext(
      received.prompt,
      received.restrictedTools,
    );

    // Execute onEntryCommands (e.g. git fetch / checkout / reset)
    // before the LLM starts on the real work items.
    const entryCommands = this.workflowEngine!.getStateCommands(
      received.taskId,
      'entry',
    );
    let entryOk = true;
    let entryFailedCommand: string | undefined;
    let entryFailedError: string | undefined;
    if (entryCommands.length > 0) {
      const entryResult = await this.executeStateCommands(
        entryCommands,
        'entry',
        received.taskId,
      );
      entryOk = entryResult.success;
      entryFailedCommand = entryResult.failedCommand;
      entryFailedError = entryResult.failedError;
      if (!entryOk) {
        this.logger.error(
          { taskId: received.taskId, failedCommand: entryFailedCommand },
          'Entry commands failed',
        );
      }
    }

    // Apply workflow-declared permission overrides (e.g. write: deny for
    // read-only validation states).  This runs AFTER entry commands so
    // that git operations in entry commands are not blocked, but BEFORE
    // the LLM session starts so the LLM cannot write files.
    const statePermissions = this.workflowEngine!.getStatePermissions(received.taskId);
    if (statePermissions) {
      Object.assign(this.permissionOverrides, statePermissions);
      this.logger.info(
        { taskId: received.taskId, permissions: statePermissions },
        'Applied workflow permission overrides for state',
      );
    }

    // If entry commands failed (any command with failOnError: true
    // returned non-zero), force the failure transition immediately.
    // The workflow author controls which commands are critical via
    // failOnError -- we honour that unconditionally.
    if (!entryOk) {
      this.logger.error(
        { taskId: received.taskId, state: assignment.targetState },
        'Entry commands failed -- forcing failure transition',
      );
      this.entryCommandsFailed = true;

      // Truncate error output to keep prompts manageable but include
      // enough for the developer to diagnose the failure.
      const errorSnippet = entryFailedError
        ? entryFailedError.substring(0, 2000)
        : 'unknown';
      const rejectionText = `Entry command failed: \`${entryFailedCommand}\`\n\n${errorSnippet}`;

      // Store as rejectionReason so {{rejectionReason}} resolves in the
      // REWORK prompt template, giving the developer the actual error.
      this.workflowEngine!.getTask(received.taskId)!.context.rejectionReason = rejectionText;

      this.workflowEngine!.addNote(
        received.taskId,
        this.config.agent.role,
        `[${assignment.targetState}] ${rejectionText}`,
      );
      await this.handleWorkflowTransition();
      return;
    }

    // If the workflow state has an empty prompt, it is purely mechanical
    // (e.g. MERGING, VALIDATING) -- the onEntryCommands already ran
    // above and there is nothing for the LLM to decompose.  Proceed
    // directly to the completion / state-transition handler.
    if (!received.prompt || received.prompt.trim() === '') {
      this.logger.info(
        { taskId: received.taskId, state: assignment.targetState },
        'Workflow state has empty prompt -- skipping LLM decomposition (mechanical state)',
      );
      await this.handleWorkflowTransition();
      return;
    }

    // If the assignment contains pre-decomposed workItems, queue them
    // directly -- skip LLM decomposition entirely.
    if (assignment.workItems && assignment.workItems.length > 0) {
      this.logger.info(
        { count: assignment.workItems.length },
        'Pre-decomposed work items received -- skipping LLM breakdown',
      );
      await this.workspace.createWorkItems(assignment.workItems, message.filename);
      return;
    }

    // Otherwise, pass the rendered prompt to the LLM for breakdown.
    // Pull decomposition guidance from the workflow state definition.
    const { state: stateDef } = this.workflowEngine!.getStateInfo(received.taskId);
    const workflowMessage = {
      ...message,
      content: received.prompt + `\n\n---\n**Task prompt:**\n${assignment.taskPrompt}`,
      _tasks: stateDef.tasks,
      _decompositionPrompt: stateDef.decompositionPrompt,
    };

    await this.breakDownIntoWorkItems(workflowMessage);
  }

  /**
   * Process a validated OutOfBandMessage.
   */
  private async processOOBMessage(
    message: any,
    oob: OutOfBandMessage,
  ): Promise<void> {
    this.logger.info({
      priority: oob.priority,
      reason: oob.reason,
      relatedTaskId: oob.relatedTaskId,
    }, 'Received OOB message');

    const received = this.workflowEngine!.receiveOOB(oob);

    if (received.relatedTaskId) {
      this.activeWorkflowTaskId = received.relatedTaskId;
      this.workflowPhaseResponseText = '';  // Reset for rework phase
    }

    const oobMessage = {
      ...message,
      content: received.prompt + `\n\n---\n**OOB content:**\n${oob.content}`,
    };

    await this.breakDownIntoWorkItems(oobMessage);
  }

  /**
   * Execute a list of state commands (onEntryCommands / onExitCommands)
   * directly via child_process.execSync -- no LLM involvement.
   *
   * Every command is executed by the engine itself.  The trimmed stdout
   * and stderr are always logged.  When a command has `captureAs` set,
   * the trimmed stdout is additionally stored in the returned `captured`
   * map so it can be used as a workflow variable (e.g. "commitSha").
   *
   * @param commands - Resolved StateCommand array from workflow engine
   * @param phase   - 'entry' or 'exit' (used in logging / prompt framing)
   * @param taskId  - Active workflow task ID
   * @returns Object with `success` (false if a failOnError command failed),
   *          `captured` (map of captureAs key -> trimmed stdout), and
   *          `failedCommand` / `failedError` when a command aborts.
   */
  private async executeStateCommands(
    commands: StateCommand[],
    phase: 'entry' | 'exit',
    taskId: string,
  ): Promise<{ success: boolean; captured: Record<string, string>; failedCommand?: string; failedError?: string }> {
    const captured: Record<string, string> = {};
    if (commands.length === 0) return { success: true, captured };

    this.logger.info(
      { taskId, phase, count: commands.length },
      `Executing ${phase} state commands`,
    );

    const projectDir = path.resolve(
      this.config.workspace.path,
      this.config.workspace.workingFolder ?? 'project',
    );

    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      const label = `[${phase} ${i + 1}/${commands.length}]`;

      this.logger.info(
        { taskId, phase, index: i, command: cmd.command, captureAs: cmd.captureAs },
        `${label} ${cmd.command}`,
      );

      const result = this.captureCommandOutput(cmd.command, projectDir);

      if (result.success) {
        this.logger.info(
          { taskId, phase, command: cmd.command, output: result.output },
          `${label} OK: ${cmd.command}`,
        );

        if (cmd.captureAs) {
          captured[cmd.captureAs] = result.output;
          this.logger.info(
            { taskId, phase, captureAs: cmd.captureAs, value: result.output },
            `${label} Captured ${cmd.captureAs}=${result.output}`,
          );
        }
      } else {
        this.logger.warn(
          { taskId, phase, command: cmd.command, error: result.error },
          `${label} Command failed: ${cmd.command}`,
        );

        const shouldAbort = cmd.failOnError !== false;  // default true
        if (shouldAbort) {
          return { success: false, captured, failedCommand: cmd.command, failedError: result.error };
        }
      }
    }

    this.logger.info({ taskId, phase }, `All ${phase} state commands completed`);
    return { success: true, captured };
  }

  /**
   * Execute a shell command directly and capture its trimmed stdout.
   * Delegates to the exported {@link captureCommandOutput} function.
   */
  private captureCommandOutput(
    command: string,
    cwd: string,
  ): { success: boolean; output: string; error?: string } {
    return captureCommandOutput(command, cwd);
  }


  /**
   * Called when all work items for a message assignment are complete.
   * If a workflow task is active, transitions the state machine and
   * routes the task to the next state's role via send_message.
   */
  private async handleWorkflowTransition(): Promise<void> {
    if (!this.workflowEngine || !this.activeWorkflowTaskId) {
      return; // No workflow task active
    }

    const taskId = this.activeWorkflowTaskId;

    try {
      // Build the initial result.  If entry commands failed (set by the
      // mechanical-state path in processWorkflowMessage), force failure
      // so the workflow engine retries or escalates instead of advancing.
      const result: StateExecutionResult = {
        success: !this.entryCommandsFailed,
        outputs: {},
        ...(this.entryCommandsFailed ? { error: 'Entry commands failed on mechanical state' } : {}),
      };
      if (this.entryCommandsFailed) {
        this.logger.warn(
          { taskId },
          'Entry commands failed -- forcing failure transition',
        );
      }
      this.entryCommandsFailed = false;  // Reset flag for next use

      // Try to extract common outputs from completed work context
      // These are listed in the workflow state's requiredOutputs
      const task = this.workflowEngine.getTask(taskId);
      if (task) {
        // Check session context for any outputs the workflow expects
        if (this.context.currentTask?.description) {
          // Look for branch name pattern in task context.
          // Use [\w./-]+ instead of \S+ because the description may
          // contain raw JSON where \n is literal "\" + "n" (both
          // non-whitespace), which causes \S+ to capture past the
          // branch name into adjacent text.
          const branchMatch = this.context.currentTask.description.match(/branch[:\s]+([\w./-]+)/i);
          if (branchMatch) {
            result.outputs.branch = branchMatch[1];
          }
          // Look for commit SHA pattern (7-40 hex chars after "commit")
          const shaMatch = this.context.currentTask.description.match(/commit[:\s]+([0-9a-f]{7,40})/i);
          if (shaMatch) {
            result.outputs.commitSha = shaMatch[1];
          }

          // Detect verification/QA failure indicators in the LLM's actual
          // work output (accumulated across all work items in this phase),
          // NOT in the incoming task prompt.
          //
          // Strategy:
          //   1. If the state defines an exitEvaluation, ask the LLM a
          //      constrained yes/no or enum question and parse the answer
          //      deterministically.  This avoids the "table header" problem
          //      where the word FAIL appears in column headers even for
          //      passing results.
          //   2. Fall back to regex-based fail-pattern detection if no
          //      exitEvaluation is defined (backward compat).
          const exitEval = this.workflowEngine!.getExitEvaluation(taskId);
          if (exitEval) {
            const evalResult = await this.evaluateExitCondition(exitEval, taskId, task);
            if (evalResult !== null) {
              result.success = evalResult;
              if (!evalResult) {
                result.error = 'Exit evaluation determined failure';

                // Ask the LLM for a rejection summary so the next agent
                // (developer in REWORK) knows exactly what to fix.
                const rejectionSummary = await this.extractRejectionSummary(taskId, task);
                if (rejectionSummary) {
                  result.outputs.rejectionReason = rejectionSummary;

                  // Also record as a persistent note for full trail visibility
                  this.workflowEngine!.addNote(
                    taskId,
                    task.context._role ?? this.config.agent.role,
                    rejectionSummary,
                  );
                }
              }
            }
          } else {
            // Fallback: regex-based fail-pattern detection
            const failDetection = detectFailureIndicators(this.workflowPhaseResponseText);
            if (failDetection.detected) {
              this.logger.warn(
                { taskId, state: task.currentState, matchedPattern: failDetection.matchedPattern, matchedText: failDetection.matchedText },
                'Failure indicator detected in work output -- marking transition as failure',
              );
              result.success = false;
              result.error = 'Work output indicates failure (verdict FAIL, tests failed, or annotations missing)';
            }
          }
        }
      }

      // Capture a summary note from the LLM for every state phase.
      // This gives each agent a voice in the notes trail: the developer
      // can explain rework decisions (or push back on QA findings), QA
      // can record observations, and the manager can document scope
      // decisions.  Notes persist across transitions and are rendered
      // in every subsequent prompt.
      if (task) {
        const stateSummary = await this.extractStateSummary(taskId, task);
        if (stateSummary) {
          this.workflowEngine!.addNote(
            taskId,
            this.config.agent.role,
            stateSummary,
          );
        }
      }

      // Execute onExitCommands (e.g. git add / commit / push) before
      // transitioning to the next state.  This ensures the agent's work
      // is committed and pushed regardless of whether the LLM remembered
      // to do it during the main work items.
      const exitCommands = this.workflowEngine.getStateCommands(taskId, 'exit');
      if (exitCommands.length > 0) {
        const { success: exitOk, captured } = await this.executeStateCommands(exitCommands, 'exit', taskId);
        if (!exitOk) {
          this.logger.error(
            { taskId },
            'Exit commands failed -- marking transition as failure so workflow can retry or escalate',
          );
          result.success = false;
          result.error = result.error ?? 'Exit commands failed (failOnError command returned non-zero)';

          // Record the failure as a persistent note so the retrying agent
          // can see that work was completed but the commit/push failed.
          const currentTask = this.workflowEngine.getTask(taskId);
          const currentState = currentTask?.currentState ?? 'unknown';
          this.workflowEngine.addNote(
            taskId,
            this.config.agent.role,
            `[${currentState}] Exit commands failed: ${result.error}. Work was completed but may not have been committed/pushed.`,
          );
        }
        // Merge captured values (e.g. commitSha from `git rev-parse HEAD`)
        // into result.outputs so they satisfy requiredOutputs validation
        // in the workflow engine's transition() method.
        if (Object.keys(captured).length > 0) {
          Object.assign(result.outputs, captured);
          this.logger.info(
            { taskId, captured },
            'Merged captured command outputs into transition result',
          );
        }
      }

      // Clear workflow permission overrides before transitioning to the
      // next state.  Each state applies its own overrides fresh, so this
      // ensures the next state (which may be on a different agent) or
      // subsequent work on THIS agent starts with the base config.
      for (const key of Object.keys(this.permissionOverrides)) {
        delete this.permissionOverrides[key as keyof PermissionOverrides];
      }

      const transition = this.workflowEngine.transition(taskId, result);

      this.logger.info({
        taskId,
        newState: transition.newState,
        newRole: transition.role,
        isTerminal: transition.isTerminal,
      }, 'Workflow state transition');

      if (transition.isTerminal) {
        // Capture the workflowId before removing the task
        const taskInfo = this.workflowEngine.getTask(taskId);
        const workflowId = taskInfo?.workflowId ?? 'unknown';

        // Task complete -- clean up locally
        this.workflowEngine.removeTask(taskId);
        this.activeWorkflowTaskId = null;
        this.workItemExecutor.clearWorkflowContext();
        this.logger.info({ taskId }, 'Workflow task reached terminal state');

        // Reset session at terminal state to prevent history accumulation
        // across independent workflow assignments.
        await this.resetSessionWithContext(
          `Workflow task ${taskId} reached terminal state ${transition.newState}.`,
        );

        // If the terminal state's role differs from this agent's role,
        // peer-route a notification so the designated owner (e.g. RA for
        // ESCALATED) is informed and logs the terminal state.  This keeps
        // wait_for_task_done working when it monitors only the RA log.
        const terminalRole = transition.role;
        const myRole = this.config.agent.role;
        const hasTeamRoster = this.config.teamMembers && this.config.teamMembers.length > 0;

        if (terminalRole && terminalRole !== myRole && hasTeamRoster) {
          const target = await this.resolveTargetByRole(terminalRole);
          if (target) {
            const subject = `[Workflow] ${transition.newState}: ${this.context.currentTask?.subject || taskId}`;
            const payload = buildTerminalNotificationPayload({
              workflowId,
              taskId,
              newState: transition.newState,
              targetRole: terminalRole,
              taskPrompt: this.context.currentTask?.description || '',
            });
            this.backend.sendMessage(
              target,
              {
                to: target,
                subject,
                content: '',
                priority: 'NORMAL',
                messageType: 'workflow',
                payload,
              },
            ).then(() => {
              this.logger.info({
                taskId,
                targetState: transition.newState,
                targetRole: terminalRole,
                targetHostname: target.hostname,
                fromAgent: this.config.agent.hostname,
              }, 'Peer-routed terminal state notification to designated role');
            }).catch((err: unknown) => {
              this.logger.warn(
                { taskId, error: err instanceof Error ? err.message : String(err) },
                'Failed to notify designated role of terminal state',
              );
            });
          } else {
            this.logger.warn(
              { taskId, role: terminalRole },
              'Cannot notify designated role of terminal state -- no matching team member',
            );
          }
        }

        return;
      }

      // Route to next state's role via mailbox.
      // All agents with a teamMembers roster route directly (peer-to-peer).
      // Fall back to sending completion to manager if no roster is available.
      const hasTeamRoster = this.config.teamMembers && this.config.teamMembers.length > 0;

      if (hasTeamRoster) {
        // Build the assignment for the next state and send it directly.
        // Strip any prior workflow envelope markers from the task description
        // to prevent nested markers that confuse the legacy parser.
        const rawPrompt = this.context.currentTask?.description || '';
        const cleanPrompt = this.workflowEngine.stripMessage(rawPrompt);
        const assignment = this.workflowEngine.buildAssignment(
          taskId,
          cleanPrompt,
        );

        // Attach pre-decomposed work items from the manager's ASSIGN phase
        // (if available).  The developer will queue these directly instead of
        // running LLM decomposition on the monolithic prompt.
        if (this.pendingWorkItems && this.pendingWorkItems.length > 0) {
          assignment.workItems = this.pendingWorkItems;
          this.logger.info(
            { taskId, workItemCount: this.pendingWorkItems.length },
            'Attaching manager-decomposed work items to workflow assignment',
          );
        }

        const subject = `[Workflow] ${assignment.targetState}: ${this.context.currentTask?.subject || taskId}`;

        // Self-loop detection: if the target role matches our own role,
        // re-queue to ourselves instead of looking in teamMembers (which
        // typically does not include the agent itself).
        const isSelfLoop = transition.role === this.config.agent.role;

        // Resolve role to hostname via team roster (or self)
        const target = isSelfLoop
          ? { hostname: this.config.agent.hostname, role: this.config.agent.role, uri: undefined }
          : await this.resolveTargetByRole(transition.role!);
        if (target) {
          // Send using strict schema -- JSON payload, no embedded markers
          const routeResult = await this.backend.sendMessage(
            target,
            {
              to: target,
              subject,
              content: '',
              priority: 'NORMAL',
              messageType: 'workflow',
              payload: assignment as unknown as Record<string, unknown>,
            },
          );

          // Record WIP delegation so the manager's WIP gate blocks
          // further dispatches until the developer completes this task.
          if (this.onMessageSentCallback) {
            this.onMessageSentCallback({
              toHostname: target.hostname,
              toRole: target.role,
              subject,
              filepath: routeResult.ref,
            });
          }

          this.logger.info({
            taskId,
            targetState: assignment.targetState,
            targetRole: transition.role,
            targetHostname: target.hostname,
            fromAgent: this.config.agent.hostname,
            isSelfLoop,
          }, isSelfLoop
            ? 'Self-loop: re-queued workflow assignment to own mailbox'
            : 'Peer-routed workflow assignment to next role');
        } else {
          this.logger.warn(
            { taskId, role: transition.role },
            'Cannot route workflow task -- no team member with matching role in roster',
          );
        }
      } else if (this.config.manager?.hostname) {
        // Legacy fallback: send completion report back to manager
        // with the task state embedded so manager can route the next step
        const taskState = this.workflowEngine.packTaskState(
          'Phase completed successfully.',
          taskId,
        );

        const managerAddr = { hostname: this.config.manager.hostname, role: this.config.manager.role ?? this.config.agent.role, uri: this.config.manager.uri };
        await this.backend.sendMessage(
          managerAddr,
          {
            to: managerAddr,
            subject: `[Workflow Complete] ${this.context.currentTask?.subject || taskId}`,
            content: `Phase completed successfully.\n\n${taskState}`,
            priority: 'NORMAL',
            messageType: 'status' as const,
          },
        );
        this.logger.info(
          { taskId, managerHostname: this.config.manager.hostname },
          'Sent workflow completion to manager (no peer roster -- legacy fallback)',
        );
      } else {
        this.logger.warn(
          { taskId, role: transition.role },
          'Cannot route workflow task -- no teamMembers roster and no manager configured',
        );
      }

      // Reset session with context preservation before clearing task.
      // This destroys the old session (clearing accumulated history that
      // causes stuttering) and seeds a fresh session with a compressed
      // summary of what was accomplished.  The next workflow assignment
      // will start with a clean session + relevant context.
      await this.resetSessionWithContext(
        `Workflow task ${taskId} completed phase and transitioned to ` +
        `${transition.newState} (role: ${transition.role}).`,
      );

      // Clear active task -- it's been handed off
      this.activeWorkflowTaskId = null;

      // Clear workflow context from the executor so subsequent
      // non-workflow work items use the default prompt
      this.workItemExecutor.clearWorkflowContext();

    } catch (error) {
      this.logger.error(
        { error: String(error), taskId },
        'Workflow transition failed -- task state may be stale',
      );
      // Don't crash the agent; the task stays active for retry
    }
  }

  /**
   * Parse work items from an LLM response that should contain a JSON array.
   *
   * The ASSIGN prompt instructs the LLM to output a raw JSON array of
   * `{ title, content }` objects.  This method tries several strategies:
   *   1. Direct JSON.parse of the full response
   *   2. Extract first JSON array from surrounding text
   *   3. Strip markdown fences and retry
   *
   * @returns Parsed work items, or null if parsing fails.
   */
  private parseWorkItemsFromResponse(
    responseText: string,
  ): Array<{ title: string; content: string }> | null {
    const tryParse = (text: string): Array<{ title: string; content: string }> | null => {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(
          (item: any) => typeof item.title === 'string' && typeof item.content === 'string',
        )) {
          return parsed;
        }
      } catch { /* not valid JSON */ }
      return null;
    };

    // Strategy 1: direct parse
    const direct = tryParse(responseText.trim());
    if (direct) return direct;

    // Strategy 2: extract first JSON array from text
    const arrayMatch = responseText.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      const extracted = tryParse(arrayMatch[0]);
      if (extracted) return extracted;
    }

    // Strategy 3: strip markdown fences
    const fenceStripped = responseText.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();
    const fenced = tryParse(fenceStripped);
    if (fenced) return fenced;

    // Strategy 4: array from fence-stripped text
    const fencedArray = fenceStripped.match(/\[[\s\S]*\]/);
    if (fencedArray) {
      return tryParse(fencedArray[0]);
    }

    return null;
  }

  /**
   * Evaluate the exit condition for the current state by sending a
   * constrained prompt to the LLM and parsing the response.
   *
   * This replaces regex-based fail-pattern detection for states that
   * declare an exitEvaluation in the workflow definition.  The LLM
   * receives a focused yes/no or enum question (e.g. "Did all
   * validation tests pass? true/false") and the response is parsed
   * mechanically.
   *
   * @returns true for success, false for failure, null if evaluation
   *          could not be performed (caller falls through to default).
   */
  private async evaluateExitCondition(
    exitEval: ExitEvaluation,
    taskId: string,
    task: { currentState: string; context: Record<string, string> },
  ): Promise<boolean | null> {
    try {
      // Build the evaluation prompt from the spec + task context
      const evalPrompt = composeEvaluationPrompt(exitEval, task.context);

      this.logger.info(
        { taskId, state: task.currentState, format: exitEval.responseFormat },
        'Sending exit evaluation prompt to LLM',
      );

      const responseText = await this.promptLLM(evalPrompt, 200);

      // Parse the LLM response deterministically
      const parseResult = parseEvaluationResponse(responseText, exitEval);

      this.logger.info({
        taskId,
        state: task.currentState,
        rawResponse: parseResult.rawResponse.substring(0, 200),
        parsedValue: parseResult.parsedValue,
        outcome: parseResult.outcome,
        fallback: parseResult.fallback,
      }, 'Exit evaluation result');

      return parseResult.outcome === 'success';

    } catch (error) {
      this.logger.error(
        { error: String(error), taskId, state: task.currentState },
        'Exit evaluation failed -- falling back to success (no regression)',
      );
      // Return null so the caller can try the regex fallback or default to success
      return null;
    }
  }

  /**
   * After a failed exit evaluation, ask the LLM to summarize what
   * specifically failed and what the developer needs to fix.
   *
   * This runs a focused prompt (capped at 1000 chars) that produces
   * an actionable rejection summary.  The result is stored in
   * task.context.rejectionReason and as a WorkflowNote so it flows
   * to the REWORK state prompt.
   *
   * @returns The rejection summary text, or null on failure.
   */
  private async extractRejectionSummary(
    taskId: string,
    task: { currentState: string; context: Record<string, string> },
  ): Promise<string | null> {
    try {
      const summaryPrompt =
        'You just determined that this task\'s validation FAILED.\n\n' +
        'In 3-5 bullet points, list the SPECIFIC issues you found.\n' +
        'For each issue, include:\n' +
        '- The file and line (if known)\n' +
        '- What is wrong\n' +
        '- What the fix should be\n\n' +
        'Be concrete and actionable. The developer will read this to know what to fix.\n' +
        'Do NOT include preamble. Start directly with the bullet list.';

      this.logger.info(
        { taskId, state: task.currentState },
        'Extracting rejection summary from LLM',
      );

      const responseText = await this.promptLLM(summaryPrompt, 1000);

      const summary = responseText.trim();
      if (summary.length === 0) {
        this.logger.warn({ taskId }, 'Rejection summary was empty');
        return null;
      }

      this.logger.info(
        { taskId, summaryLen: summary.length, summaryHead: summary.substring(0, 120) },
        'Rejection summary extracted',
      );

      return summary;

    } catch (error) {
      this.logger.error(
        { error: String(error), taskId },
        'Failed to extract rejection summary -- proceeding without it',
      );
      return null;
    }
  }

  /**
   * After completing work items in any state, ask the LLM for a brief
   * summary of what was done, what was found, or why they disagree
   * with a prior finding.
   *
   * This is the agent's "voice" in the shared notes trail.  It allows:
   * - Developer to explain rework decisions or push back on QA findings
   * - QA to record observations beyond the pass/fail verdict
   * - Manager to document scope decisions
   *
   * Returns null on failure (non-critical -- workflow proceeds).
   */
  private async extractStateSummary(
    taskId: string,
    task: { currentState: string; context: Record<string, string> },
  ): Promise<string | null> {
    try {
      const summaryPrompt =
        `You just completed work in the ${task.currentState} state.\n\n` +
        'In 2-4 sentences, summarize:\n' +
        '- What you did or found\n' +
        '- Any issues encountered\n' +
        '- If you disagree with a prior finding, explain why concisely\n\n' +
        'Be specific. This note will be visible to the next agent in the pipeline.\n' +
        'Do NOT include preamble. Start directly with the summary.';

      this.logger.info(
        { taskId, state: task.currentState },
        'Extracting state summary for notes',
      );

      const responseText = await this.promptLLM(summaryPrompt, 500);

      const summary = responseText.trim();
      if (summary.length === 0) {
        return null;
      }

      this.logger.info(
        { taskId, state: task.currentState, summaryLen: summary.length },
        'State summary extracted for notes',
      );

      return summary;

    } catch (error) {
      this.logger.warn(
        { error: String(error), taskId },
        'Failed to extract state summary -- non-critical, proceeding',
      );
      return null;
    }
  }

  /**
   * Break down mailbox message into work items
   */
  private async breakDownIntoWorkItems(message: any): Promise<void> {
    const priority = message.priority || 'NORMAL';
    
    this.logger.info({ priority }, 'Breaking down task into work items');
    
    // Check quota and select model
    const quotaCheck = await this.quotaManager.checkQuotaAndSelectModel(priority);
    
    if (!quotaCheck.canProcess) {
      this.logger.warn(`Cannot process task: ${quotaCheck.reason}`);
      await this.backend.escalate(
        `Quota limit reached - task paused`,
        `Unable to break down task: ${message.subject}\n\nReason: ${quotaCheck.reason}`
      );
      return;
    }
    
    // Initialize a fresh session for task breakdown.
    // IMPORTANT: Pass an empty tools array -- do NOT register mailbox tools
    // (send_message, etc.) here.  This session is strictly for JSON output --
    // the prompt asks the LLM to return a JSON array of work items.  If tools
    // like send_message are available, the LLM acts on the task directly
    // (calling send_message 10+ times) instead of returning structured JSON,
    // then the narrative response fails JSON.parse and triggers an escalation
    // loop.
    const sessionId = await this.sessionManager.initializeSession(
      undefined,
      {
        model: quotaCheck.model,
        streaming: true,
        tools: [],
        onPermissionRequest: this.permissionHandler,
        workingDirectory: path.resolve(this.config.workspace.path, this.config.workspace.workingFolder || 'project'),
      },
      true  // Force new session
    );
    
    // Construct the breakdown prompt (role-aware)
    const breakdownPrompt = buildBreakdownPrompt({
      from: typeof message.from === 'string' ? message.from : formatAgentId(message.from),
      subject: message.subject,
      priority: message.priority || 'NORMAL',
      content: message.content,
      isManager: this.config.agent.role === 'manager',
      teamMembers: this.config.teamMembers,
      minWorkItems: this.config.agent.minWorkItems ?? 5,
      maxWorkItems: this.config.agent.maxWorkItems ?? 20,
      tasks: message._tasks,
      decompositionPrompt: message._decompositionPrompt,
      agentDecompositionPrompt: this.config.agent.decompositionPrompt,
    });

    try {
      const responseText = await this.promptLLM(breakdownPrompt);
      
      // Parse the JSON response
      this.logger.info('Parsing task breakdown');
      
      const workItems = parseBreakdownResponse(responseText);
      
      this.logger.info(`Created ${workItems.length} work items`);
      
      // Create work item files with mailbox file tracking
      await this.workspace.createWorkItems(workItems, message.id);
      
      // Record quota usage
      await this.quotaManager.recordTaskCompletion(quotaCheck.model, priority);
      
    } catch (error) {
      this.logger.error({ error: String(error) }, 'Error breaking down task');
      throw error;
    }
  }
  
  /**
   * Process next work item from work folder
   */
  private async processNextWorkItem(): Promise<void> {
    const workItem = await this.workspace.getNextWorkItem();
    
    if (!workItem) {
      this.logger.info('No work items found');
      
      // Check if we just completed a project - send completion report.
      // Skip when a workflow task is active -- the workflow engine
      // already handles routing to the next state/role via peer-routed
      // workflow assignments.  Sending a legacy completion report on
      // top of that confuses the manager (it tries to decompose it).
      const stats = await this.workspace.getStats();
      if (stats.completedItems > 0 && !this.activeWorkflowTaskId) {
        await this.completionTracker.sendProjectCompletionReport();
      }
      
      return;
    }
    
    this.logger.info({
      sequence: workItem.sequence,
      filename: workItem.filename
    }, `Processing work item: ${workItem.title}`);
    
    this.context.status = 'working';
    this.context.taskStartTime = new Date();
    
    try {
      // Only create/resume a session when necessary.  Calling resumeSession
      // on an already-active session causes the Copilot CLI to set up an
      // additional server-side event notification channel without tearing
      // down the previous one.  Each extra channel delivers duplicate
      // message_delta events, producing the characteristic stuttering
      // ("ReReRequirements", "LatestLatestLatest").
      // See: .copilot-tracking/research/2026-03-02/stuttering-root-cause-research.md
      const isRetry = (this.retryAttempts.get(workItem.filename) ?? 0) > 0;
      if (isRetry || !this.sessionManager.isActive()) {
        await this.initializeSession(isRetry);
      }
      
      // Execute work item using WorkItemExecutor
      const result = await this.workItemExecutor.execute(workItem);

      // Accumulate LLM response text for fail-pattern detection at transition time
      if (result.responseText && this.activeWorkflowTaskId) {
        this.workflowPhaseResponseText += result.responseText;
      }
      
      if (result.success) {
        // Work item completed successfully
        this.logger.info(`Work item completed: ${workItem.title}`);
        
        // Decide: Review or Complete?
        const needsReview = await this.shouldReviewWorkItem(workItem);
        
        if (needsReview) {
          // Move to review folder for internal tracking/logging
          await this.workspace.moveToReviewFolder(workItem);
          this.logger.info(`Logged to review folder: ${workItem.title}`);
          
          // Auto-complete after brief review period (internal quality control only)
          await this.workspace.moveFromReviewToCompleted(workItem);
          this.logger.info(`Auto-approved: ${workItem.title}`);
        } else {
          // Direct to completed
          await this.workspace.completeWorkItem(workItem);
        }
        
        // Check if this completes a message assignment.
        // Skip the CompletionTracker when a workflow task is active --
        // the workflow engine's handleWorkflowTransition() handles
        // routing to the next role, so the separate completion report
        // to the manager is redundant and causes duplicate delegations.
        if (!this.activeWorkflowTaskId) {
          await this.completionTracker.checkMessageCompletion(workItem);
        }
        
        // If a workflow task is active, check whether the entire phase
        // (all work items for this message) is now complete.  If so,
        // transition the workflow state machine and route to the next role.
        if (this.activeWorkflowTaskId) {
          const hasMoreWork = await this.workspace.hasWorkItems();
          if (!hasMoreWork) {
            await this.handleWorkflowTransition();
          } else {
            // More work items remain in this phase.  Reset the session
            // now to prevent conversation history accumulation that
            // causes stuttering (repeated token fragments in deltas).
            // The compressed summary preserves context from prior items.
            await this.resetSessionWithContext(
              `Completed work item "${workItem.title}" for workflow task ` +
              `${this.activeWorkflowTaskId}.  More work items remain.`,
            );
          }
        }
        
        // Record quota usage
        await this.quotaManager.recordTaskCompletion(this.config.copilot.model, 'NORMAL');
        
        // Clear retry tracking on success
        this.retryAttempts.delete(workItem.filename);
        
        // Clear rework tracking if this was a successful rework
        if (workItem.title.startsWith('Rework: ')) {
          const originalTask = workItem.title.replace(/^Rework:\s*/, '');
          const reworkKey = `rework:${originalTask}`;
          if (this.context.reworkTracking?.[reworkKey]) {
            this.logger.info({ originalTask, reworkKey }, 'Rework succeeded, clearing rework cycle counter');
            delete this.context.reworkTracking[reworkKey];
          }
        }
        
        this.context.status = 'idle';
        this.context.taskStartTime = undefined;
        
        return; // SUCCESS!
      } else {
        // Execution failed, throw error to trigger retry logic
        throw new Error(result.error || 'Work item execution failed');
      }
      
    } catch (error) {
      // Check if we should retry
      const maxRetries = this.config.agent.taskRetryCount ?? 3;
      const currentAttempts = this.retryAttempts.get(workItem.filename) ?? 0;
      const totalAttempts = currentAttempts + 1; // +1 for the attempt that just failed
      const retriesRemaining = maxRetries - currentAttempts;
      
      this.logger.error({
        error: String(error),
        attempt: totalAttempts,
        retriesRemaining: retriesRemaining
      }, `Failed to process work item: ${workItem.title}`);
      
      if (retriesRemaining > 0) {
        // Retry: increment attempt count and leave in pending
        this.retryAttempts.set(workItem.filename, totalAttempts);

        // Force session renewal on expired-session errors so the next
        // retry starts with a live session instead of failing instantly.
        const errStr = String(error);
        if (SessionManager.isSessionExpiredError(errStr) ||
            errStr.includes('Session expired')) {
          this.logger.warn('Session expired -- forcing session renewal before retry');
          await this.initializeSession(true);
        }
        
        // Calculate timeout progression for visibility
        const baseTimeout = this.config.agent.sdkTimeoutMs;
        const multiplier = this.config.agent.timeoutStrategy?.tier1_multiplier ?? 1.5;
        const currentTimeout = currentAttempts === 0 ? baseTimeout : baseTimeout * Math.pow(multiplier, currentAttempts);
        const nextTimeout = baseTimeout * Math.pow(multiplier, totalAttempts);
        
        this.logger.warn({
          attempt: totalAttempts,
          totalRetries: maxRetries,
          retriesRemaining: retriesRemaining,
          currentTimeout: `${currentTimeout / 1000}s`,
          nextTimeout: `${nextTimeout / 1000}s`,
          multiplier: multiplier
        }, `Retry ${totalAttempts}/${maxRetries + 1} scheduled for: ${workItem.title}`);
        
        // Leave in pending folder for next iteration
        this.context.status = 'idle';
        return;
      }
      
      // No retries left - move to failed folder
      this.logger.error({
        totalAttempts: totalAttempts
      }, `All ${maxRetries} retries exhausted for: ${workItem.title}`);
      
      await this.workspace.moveToFailedFolder(workItem);
      
      // Clear retry tracking
      this.retryAttempts.delete(workItem.filename);
      
      // Don't escalate individual work item failures - the agent may recover
      // Escalation happens at assignment level in checkMessageCompletion
      
      this.context.status = 'idle';
    }
  }
  
  /**
   * Determine if work item needs internal review (for tracking/logging)
   */
  private async shouldReviewWorkItem(workItem: WorkItem): Promise<boolean> {
    const validation = this.config.agent.validation;
    
    if (!validation || validation.mode === 'none') {
      return false; // Trust mode - no review
    }
    
    if (validation.mode === 'always') {
      return true; // Review everything
    }
    
    if (validation.mode === 'spot_check') {
      const stats = await this.workspace.getStats();
      return stats.completedItems % validation.reviewEveryNthItem === 0;
    }
    
    if (validation.mode === 'milestone') {
      return validation.milestones?.includes(workItem.sequence) || false;
    }
    
    return false;
  }

  // =========================================================================
  // WIP gate helpers (manager role only)
  // =========================================================================

  /** Number of tasks currently delegated and awaiting completion. */
  private getInFlightCount(): number {
    return Object.keys(this.context.inFlightDelegations ?? {}).length;
  }

  /**
   * Returns a callback fired by the send_message tool whenever a message is
   * sent.  Only wired up for the manager role when wipLimit > 0; returns
   * undefined otherwise so the tools layer pays zero overhead.
   */
  private createOnMessageSentCallback(): OnMessageSentCallback | undefined {
    const wipLimit = this.config.agent.wipLimit ?? 0;
    if (wipLimit <= 0 || this.config.agent.role !== 'manager') {
      return undefined;
    }
    return (info: { toHostname: string; toRole: string; subject: string; filepath: string }) => {
      const selfId = `${this.config.agent.hostname}_${this.config.agent.role}`;
      const targetId = `${info.toHostname}_${info.toRole}`;
      if (targetId === selfId) return; // Don't track self-messages
      const key = `${targetId}:${info.subject}`.substring(0, 120);
      this.recordInFlightDelegation(key, targetId, info.subject);
      this.logger.info(
        { key, delegatedTo: targetId, inFlightCount: this.getInFlightCount(), wipLimit },
        'WIP: recorded outbound delegation',
      );
    };
  }

  private recordInFlightDelegation(
    key: string,
    delegatedTo: string,
    subject: string,
    workflowTaskId?: string,
  ): void {
    if (!this.context.inFlightDelegations) {
      this.context.inFlightDelegations = {};
    }
    this.context.inFlightDelegations[key] = {
      delegatedTo,
      subject,
      sentAt: new Date().toISOString(),
      workflowTaskId,
      timeoutMs: this.config.agent.stuckTimeoutMs || 1800000,
    };
  }

  private clearInFlightDelegation(key: string): void {
    if (this.context.inFlightDelegations?.[key]) {
      const d = this.context.inFlightDelegations[key];
      this.logger.info(
        { key, delegatedTo: d.delegatedTo, inFlightCount: this.getInFlightCount() - 1 },
        'WIP: cleared in-flight delegation',
      );
      delete this.context.inFlightDelegations[key];
    }
  }

  /** Expire in-flight delegations that have exceeded their watchdog timeout. */
  private expireStaleInFlightDelegations(): void {
    const delegations = this.context.inFlightDelegations;
    if (!delegations) return;
    const now = Date.now();
    for (const [key, d] of Object.entries(delegations)) {
      const age = now - new Date(d.sentAt).getTime();
      const timeout = d.timeoutMs ?? 1800000;
      if (age > timeout) {
        this.logger.warn(
          { key, delegatedTo: d.delegatedTo, ageMs: age, timeoutMs: timeout },
          'WIP: in-flight delegation expired (watchdog) -- freeing slot',
        );
        delete delegations[key];
      }
    }
  }

  /**
   * Scan the mailbox for completion messages that match an in-flight
   * delegation.  Matched messages are archived and the WIP slot is freed.
   * Non-matching messages are left untouched for later normal processing.
   */
  private async checkForCompletionMessages(): Promise<void> {
    const completionPattern = /\[Workflow Complete\]|\[Workflow\] (?:DONE|ESCALATED)|Assignment \d+ completed|completion report/i;
    const candidates = await this.backend.peekMessages(completionPattern);
    if (candidates.length === 0) {
      this.logger.debug('WIP gate: no completion messages found');
      return;
    }
    this.logger.debug({ candidateCount: candidates.length }, 'WIP gate: checking completion candidates');
    const delegations = this.context.inFlightDelegations ?? {};
    for (const msg of candidates) {
      let matched = false;
      const senderStr = msg.from ? formatAgentId(msg.from) : '';
      for (const [key, d] of Object.entries(delegations)) {
        const senderMatch = senderStr.includes(d.delegatedTo.split('_')[0]);
        const subjectOverlap = d.subject && msg.subject?.includes(
          d.subject.replace(/^\[Workflow\]\s*\S+:\s*/, '').trim().substring(0, 30),
        );
        if (senderMatch || subjectOverlap) {
          this.logger.info({ key, from: senderStr, subject: msg.subject }, 'WIP: matched completion message');
          matched = true;
          await this.backend.acknowledgeMessage(msg.id);
          if (d.workflowTaskId && this.workflowEngine) {
            this.activeWorkflowTaskId = d.workflowTaskId;
            await this.classifyAndProcessMessage(msg);
          }
          this.clearInFlightDelegation(key);
          break;
        }
      }
      if (!matched) {
        this.logger.debug({ from: senderStr, subject: msg.subject }, 'WIP: completion candidate did not match any in-flight delegation -- leaving in mailbox');
      }
    }
  }
}


/**
 * Execute a shell command directly and capture its trimmed stdout.
 * All onEntryCommands / onExitCommands are executed through this
 * function -- the LLM is never involved in running these commands.
 *
 * Exported for testability; the agent delegates to this function.
 *
 * @param command - Shell command string to execute
 * @param cwd     - Working directory for the command
 * @returns Object with success flag, trimmed output, and optional error
 */
export function captureCommandOutput(
  command: string,
  cwd: string,
): { success: boolean; output: string; error?: string } {
  try {
    const stdout = execSync(command, {
      cwd,
      encoding: 'utf-8',
      timeout: 3_600_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true, output: stdout.trim() };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, output: '', error: message };
  }
}


// ---------------------------------------------------------------------------
// Phase 1 extracted pure functions (exported for testability)
// ---------------------------------------------------------------------------

/**
 * Build the role-aware prompt used by `breakDownIntoWorkItems` to ask the LLM
 * to decompose a task assignment into sequenced work items.
 *
 * Extracted so the prompt logic can be tested without an LLM round-trip.
 */
export function buildBreakdownPrompt(params: {
  from: string;
  subject: string;
  priority: string;
  content: string;
  isManager: boolean;
  teamMembers?: Array<{ hostname: string; role: string; responsibilities: string }>;
  minWorkItems: number;
  maxWorkItems: number;
  tasks?: string[];
  decompositionPrompt?: string;
  agentDecompositionPrompt?: string;
}): string {
  const { from, subject, priority, content, isManager, teamMembers, minWorkItems, maxWorkItems, tasks, decompositionPrompt, agentDecompositionPrompt } = params;

  const managerTeamSection = isManager && teamMembers && teamMembers.length > 0
    ? `\n**Your Team (delegate to these agents):**\n${teamMembers.map(m => `- ${m.hostname} (${m.role}): ${m.responsibilities}`).join('\n')}\n`
    : '';

  const managerInstructions = isManager
    ? `
**CRITICAL: You are a MANAGER. You do NOT do implementation work.**
- Each work item MUST be a delegation action: send a message to a team member via send_message()
- Each work item's "content" must contain: the target agent hostname and role, a clear task description, and acceptance criteria
- Format each work item content as: "DELEGATE to <hostname> (<role>): <detailed task description>. ACCEPTANCE CRITERIA: <what must be true when done>"
- Do NOT create work items that involve you writing code, running builds, or inspecting files
- Group related subtasks into single delegation messages (one message per agent per topic)
- Sequence so that dependencies are sent first (e.g., core types before protocol logic)
${managerTeamSection}`
    : '';

  // Build decomposition guidance from structured tasks + free-form prompts
  const guidanceParts: string[] = [];
  if (tasks && tasks.length > 0) {
    guidanceParts.push(`Work items MUST include: ${tasks.join(', ')}.`);
  }
  if (decompositionPrompt) {
    guidanceParts.push(decompositionPrompt);
  }
  if (agentDecompositionPrompt) {
    guidanceParts.push(agentDecompositionPrompt);
  }
  const decompositionGuidance = guidanceParts.length > 0
    ? `\n**Decomposition Requirements:**\n${guidanceParts.join('\n')}\n`
    : '';

  return `You are an autonomous ${isManager ? 'project manager' : 'coding'} agent. You've received a task assignment that needs to be broken down into smaller, sequenced work items.

**Task Assignment:**
From: ${from}
Subject: ${subject}
Priority: ${priority}

**Task Details:**
${content}
${managerInstructions}${decompositionGuidance}
**Your Instructions:**
1. Analyze the task requirements carefully
2. Break it down into ${minWorkItems}-${maxWorkItems} sequential work items (each should take 10-30 minutes)
3. Each work item should be:
   - Specific and actionable
   - Testable/verifiable
   - In logical dependency order
4. Output ONLY a JSON array of work items in this exact format:

[
  {
    "title": "${isManager ? 'Delegate core types implementation to protocol-lib' : 'Setup project structure'}",
    "content": "${isManager ? 'DELEGATE to protocol-lib (developer): Implement core protocol types including addressing structures, identifiers, and frame header parsing in protocol-core crate. ACCEPTANCE CRITERIA: cargo build succeeds, unit tests for all new types pass, cargo clippy clean.' : 'Create directories and initial files for the project. Set up build configuration and install dependencies.'}"
  }
]

**Important:**
- NO markdown code blocks (no \\\`\\\`\\\`json)
- NO explanatory text before or after
- ONLY the raw JSON array
- Use double quotes for JSON strings
- Each work item will become a sequenced task file (001_, 002_, etc.)

Begin the breakdown now:`;
}

/**
 * Parse and validate the LLM response from a breakdown prompt.
 *
 * Strips markdown code fences, parses JSON, and validates that the result
 * is a non-empty array of `{ title, content }` objects.
 *
 * @throws Error on invalid / empty / non-array input
 */
export function parseBreakdownResponse(
  responseText: string,
): Array<{ title: string; content: string }> {
  let cleaned = responseText.trim();
  cleaned = cleaned.replace(/```json\n?/g, '');
  cleaned = cleaned.replace(/```\n?/g, '');
  cleaned = cleaned.trim();

  const workItems = JSON.parse(cleaned);

  if (!Array.isArray(workItems) || workItems.length === 0) {
    throw new Error('Invalid work items format: expected non-empty array');
  }

  return workItems;
}

/**
 * Build a synthetic `WorkItem` for a state-command execution.
 *
 * The returned work item is not persisted to disk -- it exists only so the
 * normal `WorkItemExecutor.execute()` pipeline can run the command.
 */
export function buildSyntheticCommandWorkItem(
  cmd: { command: string; reason: string },
  phase: 'entry' | 'exit',
  index: number,
  total: number,
  projectDir: string,
): WorkItem {
  const label = `[${phase} ${index + 1}/${total}]`;
  return {
    filename: `state-${phase}-cmd-${index}.md`,
    sequence: index,
    title: `${label} ${cmd.command}`,
    content: [
      `## State ${phase === 'entry' ? 'Entry' : 'Exit'} Command ${label}`,
      '',
      `Execute the following command in the project working directory (**${projectDir}**):`,
      '',
      '```bash',
      cmd.command,
      '```',
      '',
      `**Reason:** ${cmd.reason}`,
      '',
      'Run this command EXACTLY as written in a terminal.',
      'Do NOT append `|| true`, `2>/dev/null`, or any other error-suppression.',
      'Do NOT add `--quiet` or `--silent` flags.',
      'If the command fails, report the exact error output and STOP.',
      'Do NOT retry, adapt, or attempt alternative commands.',
      'The workflow engine decides how to handle failures.',
    ].join('\n'),
    fullPath: '',  // synthetic -- not persisted to disk
  };
}

/**
 * Pure decision logic for receiver-side backpressure.
 *
 * Given the current list of priority messages and the pending work-item count,
 * decide whether to skip all messages or truncate to the first one.
 *
 * Returns a **new** array (never mutates the input).
 */
export function applyBackpressure(
  priorityMessages: any[],
  pendingCount: number,
  config: { enabled: boolean; maxPendingWorkItems: number },
): { messages: any[]; skipped: boolean; reason?: string } {
  if (!config.enabled) {
    return { messages: [...priorityMessages], skipped: false };
  }

  if (pendingCount >= config.maxPendingWorkItems) {
    return {
      messages: [],
      skipped: true,
      reason: 'Backpressure: skipping priority messages -- pending work queue is full. Messages remain in priority/ folder for next cycle.',
    };
  }

  // If we have some pending work, only accept 1 priority message per cycle
  // to avoid queue explosion
  if (pendingCount > 0 && priorityMessages.length > 1) {
    return {
      messages: [priorityMessages[0]],
      skipped: false,
      reason: 'Backpressure: limiting to 1 priority message this cycle (pending work exists)',
    };
  }

  return { messages: [...priorityMessages], skipped: false };
}

/**
 * Build the payload object sent when peer-routing a terminal-state
 * notification to another agent (e.g. RA for ESCALATED).
 *
 * Includes a minimal `taskState` to satisfy `validateWorkflowPayload`.
 */
export function buildTerminalNotificationPayload(params: {
  workflowId: string;
  taskId: string;
  newState: string;
  targetRole: string;
  taskPrompt: string;
}): Record<string, unknown> {
  const { workflowId, taskId, newState, targetRole, taskPrompt } = params;
  return {
    type: 'workflow',
    workflowId,
    taskId,
    targetState: newState,
    targetRole,
    taskPrompt,
    isTerminal: true,
    // Minimal taskState to pass validateWorkflowPayload
    taskState: {
      taskId,
      workflowId,
      currentState: newState,
      context: {},
      retryCount: 0,
      history: [],
    },
  };
}
