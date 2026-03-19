// WorkItemExecutor - Handles execution of individual work items with timeout and retry logic

import { SessionManager, isRateLimitError, parseRateLimitDelay } from './session-manager.js';
import { WorkspaceManager, WorkItem } from './workspace-manager.js';
import { TimeoutManager } from './timeout-manager.js';
import { ToolHealthMonitor } from './tool-health-monitor.js';
import { buildWorkItemPrompt } from './prompt-templates.js';
import pino from 'pino';
import path from 'path';

/**
 * Configuration for work item execution
 */
export interface WorkItemExecutorConfig {
  workspacePath: string;
  workingFolder: string;
  sdkTimeoutMs: number;
  gracePeriodMs?: number;
  taskRetryCount?: number;
  agentRole?: string;
  teamMembers?: Array<{ hostname: string; role: string; responsibilities: string }>;
  /**
   * When set, the workflow engine's rendered prompt context is prepended
   * to every work item prompt.  This provides continuity (prior state
   * history), tool guidance (recommended/restricted), and acceptance
   * criteria from the workflow state definition.
   *
   * Set by the agent when a workflow assignment is received and cleared
   * when the phase completes.
   */
  workflowPromptPrefix?: string;
  /**
   * Tools that the workflow state explicitly restricts.  Injected as a
   * warning into each work item prompt so the LLM avoids them.
   */
  workflowRestrictedTools?: string[];
}

/**
 * Result of work item execution
 */
export interface ExecutionResult {
  success: boolean;
  duration: number;
  timedOut: boolean;
  error?: string;
  strategy?: string;
  /** Accumulated LLM response text from the session (message_delta events). */
  responseText?: string;
}

/**
 * Executes work items with timeout handling and retry logic
 */
export class WorkItemExecutor {
  private retryAttempts: Map<string, number> = new Map();
  /** Accumulated LLM response text from the most recent work item execution. */
  private lastResponseText: string = '';
  
  constructor(
    private sessionManager: SessionManager,
    private workspace: WorkspaceManager,
    private timeoutManager: TimeoutManager,
    private config: WorkItemExecutorConfig,
    private logger: pino.Logger,
    private toolHealthMonitor?: ToolHealthMonitor
  ) {}

  /**
   * Set workflow context that will be prepended to every work item prompt.
   * Called when a workflow assignment is received.
   */
  updateWorkflowContext(promptPrefix: string, restrictedTools: string[]): void {
    this.config.workflowPromptPrefix = promptPrefix;
    this.config.workflowRestrictedTools = restrictedTools;
    this.logger.info(
      { restrictedTools: restrictedTools.length },
      'Workflow context injected into executor'
    );
  }

  /**
   * Clear workflow context (called when a workflow phase completes).
   */
  clearWorkflowContext(): void {
    this.config.workflowPromptPrefix = undefined;
    this.config.workflowRestrictedTools = undefined;
    this.logger.info('Workflow context cleared');
  }
  
  /**
   * Execute a work item with timeout and error handling
   * 
   * @param workItem - The work item to execute
   * @returns Execution result with success status and metadata
   */
  async execute(workItem: WorkItem): Promise<ExecutionResult> {
    const startTime = Date.now();
    
    this.logger.info({
      sequence: workItem.sequence,
      filename: workItem.filename
    }, `Executing work item: ${workItem.title}`);
    
    try {
      // Build context from recent completed items
      const recentCompleted = await this.workspace.getRecentCompletedItems(3);
      const contextSummary = recentCompleted.length > 0
        ? recentCompleted.map(item => `- #${item.sequence}: ${item.title}`).join('\n')
        : 'This is the first work item.';
      
      // Construct work item prompt
      const workPrompt = this.buildWorkPrompt(workItem, contextSummary);
      
      // Get adaptive timeout strategy
      const strategy = await this.timeoutManager.getRecommendedStrategy(workItem);
      this.logger.info({
        timeout: `${strategy.timeout / 1000}s`,
        reason: strategy.reason
      }, `Using timeout strategy: ${strategy.strategy}`);
      
      // Execute with timeout handling
      const timedOut = await this.executeWithTimeout(workItem, workPrompt, strategy.timeout);
      
      const duration = Date.now() - startTime;
      
      // Record successful completion if no timeout
      if (!timedOut) {
        await this.timeoutManager.recordSuccess(workItem, strategy.strategy, duration);
      }
      
      // Log tool health status after each work item
      if (this.toolHealthMonitor) {
        const health = this.toolHealthMonitor.getHealthStatus();
        if (health.ptyFailures > 0 || health.totalBashCalls > 0) {
          this.logger.info({
            level: health.level,
            bashCalls: health.totalBashCalls,
            ptyFailures: health.ptyFailures,
            consecutivePtyFailures: health.consecutivePtyFailures,
          }, `Tool health after work item: ${health.message}`);
        }
      }
      
      return {
        success: true,
        duration,
        timedOut,
        strategy: strategy.strategy,
        responseText: this.lastResponseText,
      };
      
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error({
        error: String(error),
        duration
      }, `Failed to execute work item: ${workItem.title}`);
      
      return {
        success: false,
        duration,
        timedOut: false,
        error: String(error),
        responseText: this.lastResponseText,
      };
    }
  }
  
  /**
   * Build the work item prompt with context
   */
  private buildWorkPrompt(workItem: WorkItem, contextSummary: string): string {
    const workingDir = path.resolve(this.config.workspacePath, this.config.workingFolder);
    
    this.logger.info({
      sequence: workItem.sequence
    }, `Building prompt for work item`);
    
    const basePrompt = buildWorkItemPrompt(
      {
        sequence: workItem.sequence,
        title: workItem.title,
        content: workItem.content
      },
      contextSummary,
      workingDir,
      this.config.agentRole,
      this.config.teamMembers
    );

    // Prepend workflow context if active (history, tool guidance, etc.)
    if (this.config.workflowPromptPrefix) {
      return `${this.config.workflowPromptPrefix}\n\n---\n\n${basePrompt}`;
    }

    return basePrompt;
  }
  
  /**
   * Execute work item with timeout and grace period handling
   * 
   * @returns true if timed out, false if completed successfully
   */
  private async executeWithTimeout(
    workItem: WorkItem,
    workPrompt: string,
    timeout: number
  ): Promise<boolean> {
    let sessionIdleReceived = false;
    let timedOut = false;
    const gracePeriodMs = this.config.gracePeriodMs ?? 60000;
    
    // Validate the session is alive BEFORE registering listeners.
    // If the session expired between iterations, ensureSession() will
    // transparently create a fresh one so that the listeners below
    // bind to a guaranteed-live session.
    await this.sessionManager.ensureSession();
    
    // Set up streaming output handlers
    this.setupStreamingHandlers();
    
    // Create promise for session idle
    const idlePromise = new Promise<void>((resolve) => {
      const idleHandler = this.sessionManager.addEventListener('session.idle' as any, () => {
        sessionIdleReceived = true;
        idleHandler(); // Unsubscribe
        resolve();
      });
    });
    
    // Listen for abort events
    const abortHandler = this.sessionManager.addEventListener('abort' as any, (event: any) => {
      this.logger.info({ reason: event.data.reason }, 'Received abort event');
    });
    
    try {
      // Send the prompt (non-blocking)
      await this.sessionManager.sendPrompt(workPrompt);
      
      // Wait for idle with timeout
      await Promise.race([
        idlePromise,
        new Promise<void>((_, reject) => {
          const timeout1 = setTimeout(() => reject(new Error('timeout')), timeout);
          timeout1.unref();
        })
      ]);
      
    } catch (error) {
      const errorMsg = String(error);
      
      // Check if this was our timeout
      if (errorMsg.includes('timeout')) {
        timedOut = true;
        this.logger.warn(`Timeout after ${timeout / 1000}s waiting for idle`);
        
        // Wait for grace period
        this.logger.info(`Grace period: Waiting ${gracePeriodMs / 1000}s for session to complete...`);
        
        await Promise.race([
          idlePromise,
          new Promise(resolve => {
            const timeout2 = setTimeout(resolve, gracePeriodMs);
            timeout2.unref();
          })
        ]);
        
        if (sessionIdleReceived) {
          this.logger.info('Session completed during grace period');
          timedOut = false;
          abortHandler();
        } else {
          // Grace period expired - abort and clean up
          await this.handleTimeoutFailure(workItem, timeout, abortHandler);
          throw new Error(this.buildTimeoutErrorMessage(timeout));
        }
      } else {
        // Handle other error types
        this.sessionManager.cleanupEventListeners();
        
        if (this.isSessionProtocolError(errorMsg)) {
          throw new Error('Session protocol error - work item abandoned');
        }
        
        if (this.isSessionExpiredError(errorMsg)) {
          // Session expired -- signal the caller so retry logic can
          // reinitialize the session and re-attempt the work item.
          throw new Error('Session expired - retry after session renewal');
        }

        if (isRateLimitError(errorMsg)) {
          const delayMs = parseRateLimitDelay(errorMsg);
          const delayMin = Math.ceil(delayMs / 60_000);
          const resumeAt = new Date(Date.now() + delayMs).toISOString();
          this.logger.error(
            { delayMs, delayMin, resumeAt, rawMessage: errorMsg.substring(0, 200) },
            'RATE LIMIT HIT in executeWithTimeout',
          );
          this.sessionManager.setRateLimitBackoff(delayMs);
          throw new Error(
            `Rate-limited -- backing off for ${delayMin} min (resume at ${resumeAt})`,
          );
        }
        
        throw error;
      }
    } finally {
      // Always clean up event listeners
      this.sessionManager.cleanupEventListeners();
    }
    
    return timedOut;
  }
  
  /**
   * Set up streaming output handlers
   */
  private setupStreamingHandlers(): void {
    // Clean up any listeners from a previous work item to prevent
    // listener accumulation across sequential execute() calls.
    this.sessionManager.cleanupEventListeners();

    let hasStreamedContent = false;
    this.lastResponseText = '';
    let workItemEventCount = 0;
    const workStreamId = `wi-${Date.now()}`;
    
    // Wire tool health monitor to detect PTY/infrastructure failures
    if (this.toolHealthMonitor) {
      this.sessionManager.addEventListener('tool.execution_start' as any, (event: any) => {
        this.toolHealthMonitor!.onToolExecutionStart(event);
      });
      this.sessionManager.addEventListener('tool.execution_complete' as any, (event: any) => {
        this.toolHealthMonitor!.onToolExecutionComplete(event);
      });
    }
    
    // Duplicate-delta detection state.  Tracks the last delta content
    // and timestamp to detect server-side event duplication caused by
    // stale notification channels (see stuttering-root-cause-research.md).
    let lastDeltaContent = '';
    let lastDeltaTime = 0;
    let duplicateDeltaCount = 0;

    // Attach message delta handler
    this.sessionManager.addEventListener('assistant.message_delta' as any, (event: any) => {
      workItemEventCount++;
      const content = event.data.deltaContent;

      // Duplicate-delta canary: warn when consecutive deltas carry
      // identical content within 10ms.  This indicates the Copilot CLI
      // is delivering the same event through multiple notification
      // channels (a symptom of redundant resumeSession calls).
      const now = Date.now();
      if (content === lastDeltaContent && (now - lastDeltaTime) < 10) {
        duplicateDeltaCount++;
        if (duplicateDeltaCount <= 5 || duplicateDeltaCount % 50 === 0) {
          this.logger.warn({
            streamId: workStreamId,
            eventSeq: workItemEventCount,
            duplicateCount: duplicateDeltaCount,
            deltaHead: content.slice(0, 32),
          }, '[DIAG-WI] DUPLICATE delta detected -- possible stale notification channel');
        }
        // Skip accumulating the duplicate content
        lastDeltaTime = now;
        return;
      }
      lastDeltaContent = content;
      lastDeltaTime = now;

      this.lastResponseText += content;

      // Log every 50th event to keep volume manageable
      if (workItemEventCount <= 5 || workItemEventCount % 50 === 0) {
        this.logger.debug({
          streamId: workStreamId,
          eventSeq: workItemEventCount,
          deltaLen: content.length,
          deltaHead: content.slice(0, 32),
          accumulatedLen: this.lastResponseText.length,
        }, '[DIAG-WI] message_delta fired');
      }
      
      // Only show essential progress indicators
      const isProgressIndicator = content.includes('✅') || content.includes('❌') ||
                                 content.includes('🔍') || content.includes('🔧') ||
                                 content.includes('📊');
      if (isProgressIndicator && !content.includes('autonomous_copilot_agent@') &&
          !content.includes('node --experimental-vm-modules')) {
        process.stdout.write(content);
        hasStreamedContent = true;
      }
    });
    
    // Attach idle handler for output summary
    this.sessionManager.addEventListener('session.idle' as any, () => {
      this.logger.debug({
        streamId: workStreamId,
        totalDeltaEvents: workItemEventCount,
        responseLen: this.lastResponseText.length,
      }, '[DIAG-WI] session.idle - stream summary');

      if (hasStreamedContent) {
        console.log();
        hasStreamedContent = false;
      }
      
      if (this.lastResponseText.length > 500) {
        this.logger.debug({
          length: this.lastResponseText.length,
          preview: this.lastResponseText.substring(0, 200) + '...'
        }, 'Work item output summary');
      }
    });
  }
  
  /**
   * Handle timeout failure - check status and abort
   */
  private async handleTimeoutFailure(
    workItem: WorkItem,
    timeout: number,
    abortHandler: () => void
  ): Promise<void> {
    this.logger.warn('Session still not idle after grace period - checking status');
    
    // Check session status
    try {
      const messages = await this.sessionManager.getMessages();
      const recentMessages = messages.slice(-5);
      const lastEvent = recentMessages[recentMessages.length - 1];
      
      this.logger.info({
        totalEvents: messages.length,
        lastEventType: lastEvent?.type,
        lastEventTimestamp: lastEvent?.timestamp,
        recentEventTypes: recentMessages.map(e => e.type)
      }, 'Session status check');
      
      const hasRecentActivity = recentMessages.some(e => 
        e.type === 'assistant.message_delta' || 
        e.type === 'tool.user_requested' ||
        e.type === 'tool.execution_start' ||
        e.type === 'tool.execution_complete'
      );
      
      if (hasRecentActivity) {
        this.logger.warn('Session shows recent activity but not idle - possible SDK issue');
      }
    } catch (statusError) {
      this.logger.warn({ error: String(statusError) }, 'Failed to check session status');
    }
    
    // Abort the request
    this.logger.info('Aborting in-flight request');
    try {
      await this.sessionManager.abort();
      this.logger.info('Aborted in-flight request');
    } catch (abortError) {
      this.logger.warn({ error: String(abortError) }, 'Failed to abort request');
    }
    
    // Clean up
    abortHandler();
    this.sessionManager.cleanupEventListeners();
    
    // Record timeout event
    const currentAttempts = this.retryAttempts.get(workItem.filename) ?? 0;
    await this.timeoutManager.recordTimeout({
      workItem: workItem.title,
      sequence: workItem.sequence,
      attempt: currentAttempts + 1,
      timeout: timeout,
      strategy: 'extended',
      result: 'timeout',
      timestamp: Date.now()
    });
  }
  
  /**
   * Build error message for timeout
   */
  private buildTimeoutErrorMessage(timeout: number): string {
    const gracePeriodMs = this.config.gracePeriodMs ?? 60000;
    const totalTime = (timeout + gracePeriodMs) / 1000;
    return `Session did not complete in ${totalTime}s (aborted). Consider increasing timeout or simplifying task.`;
  }
  
  /**
   * Check if error is a session protocol error
   */
  private isSessionProtocolError(errorMsg: string): boolean {
    return errorMsg.includes('messages with role') && errorMsg.includes('tool');
  }
  
  /**
   * Check if error is a session expired error
   */
  private isSessionExpiredError(errorMsg: string): boolean {
    return SessionManager.isSessionExpiredError(errorMsg);
  }
  
  /**
   * Get current retry attempt for a work item
   */
  getRetryAttempt(filename: string): number {
    return this.retryAttempts.get(filename) ?? 0;
  }
  
  /**
   * Set retry attempt for a work item
   */
  setRetryAttempt(filename: string, attempt: number): void {
    this.retryAttempts.set(filename, attempt);
  }
  
  /**
   * Clear retry tracking for a work item
   */
  clearRetryAttempt(filename: string): void {
    this.retryAttempts.delete(filename);
  }
  
  /**
   * Calculate next timeout based on retry attempts
   */
  calculateNextTimeout(baseTimeout: number, attempt: number, multiplier: number): number {
    return attempt === 0 ? baseTimeout : baseTimeout * Math.pow(multiplier, attempt);
  }
}
