// Tool Health Monitor - Detects infrastructure failures in CLI tool execution
//
// The Copilot CLI's bash tool uses node-pty to allocate pseudo-terminals.
// On macOS, a known bug (microsoft/node-pty#882) leaks /dev/ptmx file descriptors,
// causing posix_openpt() to eventually fail with "Device not configured" (ENXIO).
// After sustained use (~100-200 bash calls), ALL shell commands silently fail.
// See: github/copilot-cli#1239
//
// This monitor listens to tool.execution_start and tool.execution_complete events,
// correlates them by toolCallId, and detects PTY-related failures. It tracks
// failure rates and emits warnings/critical alerts so the agent can take action
// (e.g., restart the CLI, notify the user, or skip shell-dependent work items).

import pino from 'pino';

/**
 * Known error patterns indicating PTY/infrastructure failures
 * (as opposed to legitimate command errors like "file not found")
 */
const PTY_ERROR_PATTERNS: ReadonlyArray<{ pattern: RegExp; description: string }> = [
  { pattern: /posix_openpt\s+failed/i, description: 'PTY allocation failed (posix_openpt)' },
  { pattern: /openpty.*failed/i, description: 'PTY allocation failed (openpty)' },
  { pattern: /Device not configured/i, description: 'PTY device not available (ENXIO)' },
  { pattern: /pty_posix_spawn\s+failed/i, description: 'PTY spawn failed' },
  { pattern: /out of pty devices/i, description: 'System PTY pool exhausted' },
  { pattern: /posix_spawnp.*error:\s*2/i, description: 'PTY spawn ENOENT (corrupted state)' },
  { pattern: /No such file or directory.*pty/i, description: 'PTY device missing' },
];

/**
 * Tracked info about a tool call in progress
 */
interface PendingToolCall {
  toolCallId: string;
  toolName: string;
  startTime: number;
  arguments?: unknown;
}

/**
 * Record of a detected tool failure
 */
export interface ToolFailureRecord {
  toolCallId: string;
  toolName: string;
  timestamp: number;
  duration: number;
  errorMessage: string;
  matchedPattern: string;
  isPtyError: boolean;
}

/**
 * Health status summary
 */
export interface ToolHealthStatus {
  /** Total bash tool calls observed */
  totalBashCalls: number;
  /** Total bash tool failures */
  totalBashFailures: number;
  /** PTY-specific failures (subset of totalBashFailures) */
  ptyFailures: number;
  /** Consecutive PTY failures (resets on success) */
  consecutivePtyFailures: number;
  /** Whether PTY subsystem appears healthy */
  ptyHealthy: boolean;
  /** Current health level */
  level: 'healthy' | 'degraded' | 'critical';
  /** Human-readable status message */
  message: string;
  /** Recent failure records (last N) */
  recentFailures: ToolFailureRecord[];
}

export type HealthAlertLevel = 'warning' | 'critical';

export interface HealthAlert {
  level: HealthAlertLevel;
  message: string;
  details: ToolHealthStatus;
  timestamp: number;
}

export type HealthAlertCallback = (alert: HealthAlert) => void;

/**
 * Configuration for the health monitor
 */
export interface ToolHealthMonitorConfig {
  /** Number of consecutive PTY failures before 'degraded' status (default: 2) */
  degradedThreshold?: number;
  /** Number of consecutive PTY failures before 'critical' status (default: 3) */
  criticalThreshold?: number;
  /** Max recent failures to keep in memory (default: 20) */
  maxRecentFailures?: number;
  /** Callback when health alert is triggered */
  onAlert?: HealthAlertCallback;
}

/**
 * Monitors tool execution health by observing SDK session events.
 *
 * Usage:
 *   const monitor = new ToolHealthMonitor(logger, config);
 *   
 *   // Wire up to session events:
 *   session.on('tool.execution_start', (e) => monitor.onToolExecutionStart(e));
 *   session.on('tool.execution_complete', (e) => monitor.onToolExecutionComplete(e));
 *   
 *   // Check health:
 *   const status = monitor.getHealthStatus();
 *   if (status.level === 'critical') { ... }
 */
export class ToolHealthMonitor {
  private logger: pino.Logger;
  private config: Required<ToolHealthMonitorConfig>;
  private pendingCalls: Map<string, PendingToolCall> = new Map();
  private recentFailures: ToolFailureRecord[] = [];
  
  // Counters
  private totalBashCalls: number = 0;
  private totalBashFailures: number = 0;
  private ptyFailures: number = 0;
  private consecutivePtyFailures: number = 0;
  private lastAlertLevel: 'healthy' | 'degraded' | 'critical' = 'healthy';

  constructor(logger: pino.Logger, config?: ToolHealthMonitorConfig) {
    this.logger = logger;
    this.config = {
      degradedThreshold: config?.degradedThreshold ?? 2,
      criticalThreshold: config?.criticalThreshold ?? 3,
      maxRecentFailures: config?.maxRecentFailures ?? 20,
      onAlert: config?.onAlert ?? (() => {}),
    };
  }

  /**
   * Handle a tool.execution_start event from the SDK session.
   * 
   * Expected event shape:
   *   { data: { toolCallId: string, toolName: string, arguments?: unknown } }
   */
  onToolExecutionStart(event: { data: { toolCallId: string; toolName: string; arguments?: unknown } }): void {
    const { toolCallId, toolName, arguments: args } = event.data;
    
    this.pendingCalls.set(toolCallId, {
      toolCallId,
      toolName,
      startTime: Date.now(),
      arguments: args,
    });

    if (this.isBashTool(toolName)) {
      this.totalBashCalls++;
      this.logger.debug({ toolCallId, toolName, totalBashCalls: this.totalBashCalls }, 'Bash tool call started');
    }
  }

  /**
   * Handle a tool.execution_complete event from the SDK session.
   * 
   * Expected event shape:
   *   { data: { toolCallId: string, success: boolean, error?: { message: string, code?: string }, result?: { content: string } } }
   */
  onToolExecutionComplete(event: {
    data: {
      toolCallId: string;
      success: boolean;
      error?: { message: string; code?: string };
      result?: { content: string; detailedContent?: string };
    };
  }): void {
    const { toolCallId, success, error, result } = event.data;
    const pending = this.pendingCalls.get(toolCallId);
    
    if (!pending) {
      // We may not have seen the start event (e.g., monitor attached mid-session)
      return;
    }
    
    this.pendingCalls.delete(toolCallId);
    const duration = Date.now() - pending.startTime;

    if (!this.isBashTool(pending.toolName)) {
      return; // Only monitor bash/shell tools for PTY issues
    }

    if (success) {
      // Check the result content too — some PTY errors come back as "success"
      // with the error text in the result content (the CLI catches the error and
      // returns it as output rather than marking the tool call as failed)
      const resultContent = result?.content ?? '';
      const ptyMatch = this.matchPtyError(resultContent);
      
      if (ptyMatch) {
        this.recordPtyFailure(pending, duration, resultContent, ptyMatch);
      } else {
        // Genuine success — reset consecutive failure counter
        if (this.consecutivePtyFailures > 0) {
          this.logger.info(
            { consecutivePtyFailures: this.consecutivePtyFailures },
            'Bash tool succeeded — resetting consecutive PTY failure counter'
          );
        }
        this.consecutivePtyFailures = 0;
        this.lastAlertLevel = 'healthy';
      }
      return;
    }

    // Explicit failure — check if it's PTY-related
    const errorMessage = error?.message ?? '';
    const ptyMatch = this.matchPtyError(errorMessage);
    
    if (ptyMatch) {
      this.recordPtyFailure(pending, duration, errorMessage, ptyMatch);
    } else {
      // Non-PTY failure (e.g., command not found, permission denied)
      this.totalBashFailures++;
      this.logger.debug({
        toolCallId,
        error: errorMessage,
        duration
      }, 'Bash tool failed (non-PTY error)');
    }
  }

  /**
   * Get current health status
   */
  getHealthStatus(): ToolHealthStatus {
    const level = this.computeHealthLevel();
    const message = this.computeStatusMessage(level);

    return {
      totalBashCalls: this.totalBashCalls,
      totalBashFailures: this.totalBashFailures,
      ptyFailures: this.ptyFailures,
      consecutivePtyFailures: this.consecutivePtyFailures,
      ptyHealthy: level === 'healthy',
      level,
      message,
      recentFailures: [...this.recentFailures],
    };
  }

  /**
   * Check if PTY subsystem is currently healthy
   */
  isPtyHealthy(): boolean {
    return this.computeHealthLevel() === 'healthy';
  }

  /**
   * Reset all counters (e.g., after CLI restart)
   */
  reset(): void {
    this.logger.info('Resetting tool health monitor counters');
    this.pendingCalls.clear();
    this.recentFailures = [];
    this.totalBashCalls = 0;
    this.totalBashFailures = 0;
    this.ptyFailures = 0;
    this.consecutivePtyFailures = 0;
    this.lastAlertLevel = 'healthy';
  }

  // --- Internal ---

  private isBashTool(toolName: string): boolean {
    return toolName === 'bash' || toolName === 'shell' || toolName === 'run_in_terminal';
  }

  private matchPtyError(text: string): string | null {
    for (const { pattern, description } of PTY_ERROR_PATTERNS) {
      if (pattern.test(text)) {
        return description;
      }
    }
    return null;
  }

  private recordPtyFailure(
    pending: PendingToolCall,
    duration: number,
    errorMessage: string,
    matchedPattern: string
  ): void {
    this.totalBashFailures++;
    this.ptyFailures++;
    this.consecutivePtyFailures++;

    const record: ToolFailureRecord = {
      toolCallId: pending.toolCallId,
      toolName: pending.toolName,
      timestamp: Date.now(),
      duration,
      errorMessage: errorMessage.substring(0, 500), // Truncate long error messages
      matchedPattern,
      isPtyError: true,
    };

    this.recentFailures.push(record);
    if (this.recentFailures.length > this.config.maxRecentFailures) {
      this.recentFailures.shift();
    }

    this.logger.warn({
      toolCallId: pending.toolCallId,
      matchedPattern,
      consecutivePtyFailures: this.consecutivePtyFailures,
      totalPtyFailures: this.ptyFailures,
      totalBashCalls: this.totalBashCalls,
      duration,
    }, `PTY failure detected: ${matchedPattern}`);

    // Check thresholds and emit alerts
    this.checkAlertThresholds();
  }

  private computeHealthLevel(): 'healthy' | 'degraded' | 'critical' {
    if (this.consecutivePtyFailures >= this.config.criticalThreshold) {
      return 'critical';
    }
    if (this.consecutivePtyFailures >= this.config.degradedThreshold) {
      return 'degraded';
    }
    return 'healthy';
  }

  private computeStatusMessage(level: 'healthy' | 'degraded' | 'critical'): string {
    switch (level) {
      case 'healthy':
        return this.ptyFailures > 0
          ? `PTY subsystem recovered. ${this.ptyFailures} total PTY failures across ${this.totalBashCalls} bash calls.`
          : `PTY subsystem healthy. ${this.totalBashCalls} bash calls, 0 PTY failures.`;
      case 'degraded':
        return `PTY subsystem degraded: ${this.consecutivePtyFailures} consecutive PTY failures. ` +
          `Likely macOS PTY leak (node-pty#882). Consider restarting the Copilot CLI.`;
      case 'critical':
        return `PTY subsystem CRITICAL: ${this.consecutivePtyFailures} consecutive PTY failures. ` +
          `All bash commands will fail. Restart the Copilot CLI or increase kern.tty.ptmx_max. ` +
          `See: github/copilot-cli#1239, microsoft/node-pty#882`;
    }
  }

  private checkAlertThresholds(): void {
    const level = this.computeHealthLevel();
    
    // Only alert on state transitions (don't spam)
    if (level === 'critical' && this.lastAlertLevel !== 'critical') {
      this.emitAlert('critical');
      this.lastAlertLevel = 'critical';
    } else if (level === 'degraded' && this.lastAlertLevel === 'healthy') {
      this.emitAlert('warning');
      this.lastAlertLevel = 'degraded';
    }
  }

  private emitAlert(alertLevel: HealthAlertLevel): void {
    const status = this.getHealthStatus();
    const alert: HealthAlert = {
      level: alertLevel,
      message: status.message,
      details: status,
      timestamp: Date.now(),
    };

    this.logger.error({
      alertLevel,
      consecutivePtyFailures: this.consecutivePtyFailures,
      totalPtyFailures: this.ptyFailures,
      totalBashCalls: this.totalBashCalls,
    }, `Tool health alert [${alertLevel}]: ${status.message}`);

    try {
      this.config.onAlert(alert);
    } catch (err) {
      this.logger.warn({ error: String(err) }, 'Error in health alert callback');
    }
  }
}
