// Tests for ToolHealthMonitor — PTY failure detection and health tracking

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { ToolHealthMonitor, HealthAlert } from '../tool-health-monitor.js';

// Minimal mock logger
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  child: jest.fn().mockReturnThis(),
  fatal: jest.fn(),
  trace: jest.fn(),
  level: 'debug',
  silent: jest.fn(),
} as any;

function makeStartEvent(toolCallId: string, toolName: string, args?: unknown) {
  return { data: { toolCallId, toolName, arguments: args } };
}

function makeCompleteEvent(
  toolCallId: string,
  success: boolean,
  opts?: { errorMessage?: string; errorCode?: string; resultContent?: string }
) {
  return {
    data: {
      toolCallId,
      success,
      ...(opts?.errorMessage ? { error: { message: opts.errorMessage, code: opts.errorCode } } : {}),
      ...(opts?.resultContent ? { result: { content: opts.resultContent } } : {}),
    },
  };
}

describe('ToolHealthMonitor', () => {
  let monitor: ToolHealthMonitor;
  let alerts: HealthAlert[];

  beforeEach(() => {
    jest.clearAllMocks();
    alerts = [];
    monitor = new ToolHealthMonitor(mockLogger, {
      degradedThreshold: 2,
      criticalThreshold: 3,
      onAlert: (alert) => alerts.push(alert),
    });
  });

  describe('basic tracking', () => {
    it('starts with healthy status and zero counters', () => {
      const status = monitor.getHealthStatus();
      expect(status.level).toBe('healthy');
      expect(status.totalBashCalls).toBe(0);
      expect(status.totalBashFailures).toBe(0);
      expect(status.ptyFailures).toBe(0);
      expect(status.consecutivePtyFailures).toBe(0);
      expect(status.ptyHealthy).toBe(true);
    });

    it('counts bash tool calls', () => {
      monitor.onToolExecutionStart(makeStartEvent('call-1', 'bash'));
      monitor.onToolExecutionComplete(makeCompleteEvent('call-1', true));
      
      monitor.onToolExecutionStart(makeStartEvent('call-2', 'bash'));
      monitor.onToolExecutionComplete(makeCompleteEvent('call-2', true));

      const status = monitor.getHealthStatus();
      expect(status.totalBashCalls).toBe(2);
      expect(status.totalBashFailures).toBe(0);
      expect(status.level).toBe('healthy');
    });

    it('ignores non-bash tools', () => {
      monitor.onToolExecutionStart(makeStartEvent('call-1', 'create_file'));
      monitor.onToolExecutionComplete(makeCompleteEvent('call-1', false, { errorMessage: 'posix_openpt failed' }));

      const status = monitor.getHealthStatus();
      expect(status.totalBashCalls).toBe(0);
      expect(status.ptyFailures).toBe(0);
    });

    it('recognizes shell and run_in_terminal as bash-like tools', () => {
      monitor.onToolExecutionStart(makeStartEvent('call-1', 'shell'));
      monitor.onToolExecutionComplete(makeCompleteEvent('call-1', true));
      
      monitor.onToolExecutionStart(makeStartEvent('call-2', 'run_in_terminal'));
      monitor.onToolExecutionComplete(makeCompleteEvent('call-2', true));

      expect(monitor.getHealthStatus().totalBashCalls).toBe(2);
    });

    it('handles completion without matching start event gracefully', () => {
      // Should not throw
      monitor.onToolExecutionComplete(makeCompleteEvent('unknown-call', true));
      expect(monitor.getHealthStatus().totalBashCalls).toBe(0);
    });
  });

  describe('PTY error detection', () => {
    it('detects "posix_openpt failed: Device not configured"', () => {
      monitor.onToolExecutionStart(makeStartEvent('call-1', 'bash'));
      monitor.onToolExecutionComplete(makeCompleteEvent('call-1', false, {
        errorMessage: 'posix_openpt failed: Device not configured',
      }));

      const status = monitor.getHealthStatus();
      expect(status.ptyFailures).toBe(1);
      expect(status.totalBashFailures).toBe(1);
      expect(status.recentFailures).toHaveLength(1);
      expect(status.recentFailures[0].isPtyError).toBe(true);
      expect(status.recentFailures[0].matchedPattern).toContain('posix_openpt');
    });

    it('detects "pty_posix_spawn failed with error: 2"', () => {
      monitor.onToolExecutionStart(makeStartEvent('call-1', 'bash'));
      monitor.onToolExecutionComplete(makeCompleteEvent('call-1', false, {
        errorMessage: 'pty_posix_spawn failed with error: 2',
      }));

      expect(monitor.getHealthStatus().ptyFailures).toBe(1);
    });

    it('detects "openpty(3) failed"', () => {
      monitor.onToolExecutionStart(makeStartEvent('call-1', 'bash'));
      monitor.onToolExecutionComplete(makeCompleteEvent('call-1', false, {
        errorMessage: 'openpty(3) failed.',
      }));

      expect(monitor.getHealthStatus().ptyFailures).toBe(1);
    });

    it('detects "out of pty devices"', () => {
      monitor.onToolExecutionStart(makeStartEvent('call-1', 'bash'));
      monitor.onToolExecutionComplete(makeCompleteEvent('call-1', false, {
        errorMessage: 'OSError: out of pty devices',
      }));

      expect(monitor.getHealthStatus().ptyFailures).toBe(1);
    });

    it('detects PTY error in successful result content (CLI wraps error as output)', () => {
      monitor.onToolExecutionStart(makeStartEvent('call-1', 'bash'));
      monitor.onToolExecutionComplete(makeCompleteEvent('call-1', true, {
        resultContent: 'Error: posix_openpt failed: Device not configured',
      }));

      const status = monitor.getHealthStatus();
      expect(status.ptyFailures).toBe(1);
      expect(status.recentFailures[0].isPtyError).toBe(true);
    });

    it('does NOT flag normal bash failures as PTY errors', () => {
      monitor.onToolExecutionStart(makeStartEvent('call-1', 'bash'));
      monitor.onToolExecutionComplete(makeCompleteEvent('call-1', false, {
        errorMessage: 'command not found: foobar',
      }));

      const status = monitor.getHealthStatus();
      expect(status.totalBashFailures).toBe(1);
      expect(status.ptyFailures).toBe(0);
    });
  });

  describe('health levels and consecutive tracking', () => {
    function failWithPty(id: string) {
      monitor.onToolExecutionStart(makeStartEvent(id, 'bash'));
      monitor.onToolExecutionComplete(makeCompleteEvent(id, false, {
        errorMessage: 'posix_openpt failed: Device not configured',
      }));
    }

    function succeedBash(id: string) {
      monitor.onToolExecutionStart(makeStartEvent(id, 'bash'));
      monitor.onToolExecutionComplete(makeCompleteEvent(id, true));
    }

    it('stays healthy with 1 PTY failure', () => {
      failWithPty('call-1');
      expect(monitor.getHealthStatus().level).toBe('healthy');
      expect(monitor.getHealthStatus().consecutivePtyFailures).toBe(1);
    });

    it('goes to degraded at 2 consecutive PTY failures', () => {
      failWithPty('call-1');
      failWithPty('call-2');
      expect(monitor.getHealthStatus().level).toBe('degraded');
      expect(monitor.getHealthStatus().consecutivePtyFailures).toBe(2);
    });

    it('goes to critical at 3 consecutive PTY failures', () => {
      failWithPty('call-1');
      failWithPty('call-2');
      failWithPty('call-3');
      expect(monitor.getHealthStatus().level).toBe('critical');
      expect(monitor.getHealthStatus().consecutivePtyFailures).toBe(3);
    });

    it('resets consecutive counter on success', () => {
      failWithPty('call-1');
      failWithPty('call-2');
      expect(monitor.getHealthStatus().level).toBe('degraded');
      
      succeedBash('call-3');
      expect(monitor.getHealthStatus().level).toBe('healthy');
      expect(monitor.getHealthStatus().consecutivePtyFailures).toBe(0);
      // But total PTY failures remain
      expect(monitor.getHealthStatus().ptyFailures).toBe(2);
    });

    it('tracks level correctly through multiple cycles', () => {
      // First degradation
      failWithPty('c1');
      failWithPty('c2');
      expect(monitor.getHealthStatus().level).toBe('degraded');
      
      // Recovery
      succeedBash('c3');
      expect(monitor.getHealthStatus().level).toBe('healthy');
      
      // Second degradation → critical
      failWithPty('c4');
      failWithPty('c5');
      failWithPty('c6');
      expect(monitor.getHealthStatus().level).toBe('critical');
      expect(monitor.getHealthStatus().ptyFailures).toBe(5);
    });
  });

  describe('alerts', () => {
    function failWithPty(id: string) {
      monitor.onToolExecutionStart(makeStartEvent(id, 'bash'));
      monitor.onToolExecutionComplete(makeCompleteEvent(id, false, {
        errorMessage: 'posix_openpt failed: Device not configured',
      }));
    }

    it('emits warning alert at degraded threshold', () => {
      failWithPty('call-1');
      expect(alerts).toHaveLength(0);
      
      failWithPty('call-2');
      expect(alerts).toHaveLength(1);
      expect(alerts[0].level).toBe('warning');
      expect(alerts[0].message).toContain('degraded');
    });

    it('emits critical alert at critical threshold', () => {
      failWithPty('call-1');
      failWithPty('call-2');
      failWithPty('call-3');
      
      // Should have warning + critical
      expect(alerts).toHaveLength(2);
      expect(alerts[0].level).toBe('warning');
      expect(alerts[1].level).toBe('critical');
      expect(alerts[1].message).toContain('CRITICAL');
    });

    it('does not re-emit same alert level', () => {
      failWithPty('call-1');
      failWithPty('call-2');
      failWithPty('call-3'); // triggers critical
      failWithPty('call-4'); // still critical, no new alert
      failWithPty('call-5'); // still critical, no new alert

      expect(alerts).toHaveLength(2); // warning + critical only
    });

    it('re-emits alerts after recovery and re-degradation', () => {
      failWithPty('c1');
      failWithPty('c2'); // warning
      
      // Recover
      monitor.onToolExecutionStart(makeStartEvent('c3', 'bash'));
      monitor.onToolExecutionComplete(makeCompleteEvent('c3', true));
      
      // Degrade again
      failWithPty('c4');
      failWithPty('c5'); // warning again
      
      expect(alerts).toHaveLength(2);
      expect(alerts[0].level).toBe('warning');
      expect(alerts[1].level).toBe('warning');
    });
  });

  describe('reset', () => {
    it('clears all counters and state', () => {
      monitor.onToolExecutionStart(makeStartEvent('call-1', 'bash'));
      monitor.onToolExecutionComplete(makeCompleteEvent('call-1', false, {
        errorMessage: 'posix_openpt failed: Device not configured',
      }));
      
      expect(monitor.getHealthStatus().ptyFailures).toBe(1);
      
      monitor.reset();
      
      const status = monitor.getHealthStatus();
      expect(status.totalBashCalls).toBe(0);
      expect(status.totalBashFailures).toBe(0);
      expect(status.ptyFailures).toBe(0);
      expect(status.consecutivePtyFailures).toBe(0);
      expect(status.recentFailures).toHaveLength(0);
      expect(status.level).toBe('healthy');
    });
  });

  describe('isPtyHealthy', () => {
    it('returns true when healthy', () => {
      expect(monitor.isPtyHealthy()).toBe(true);
    });

    it('returns false when degraded', () => {
      monitor.onToolExecutionStart(makeStartEvent('c1', 'bash'));
      monitor.onToolExecutionComplete(makeCompleteEvent('c1', false, { errorMessage: 'posix_openpt failed' }));
      monitor.onToolExecutionStart(makeStartEvent('c2', 'bash'));
      monitor.onToolExecutionComplete(makeCompleteEvent('c2', false, { errorMessage: 'posix_openpt failed' }));
      
      expect(monitor.isPtyHealthy()).toBe(false);
    });
  });

  describe('status messages', () => {
    it('includes helpful references in critical message', () => {
      for (let i = 0; i < 3; i++) {
        monitor.onToolExecutionStart(makeStartEvent(`c${i}`, 'bash'));
        monitor.onToolExecutionComplete(makeCompleteEvent(`c${i}`, false, { errorMessage: 'posix_openpt failed' }));
      }
      
      const msg = monitor.getHealthStatus().message;
      expect(msg).toContain('copilot-cli#1239');
      expect(msg).toContain('node-pty#882');
      expect(msg).toContain('kern.tty.ptmx_max');
    });

    it('healthy message includes call count', () => {
      monitor.onToolExecutionStart(makeStartEvent('c1', 'bash'));
      monitor.onToolExecutionComplete(makeCompleteEvent('c1', true));
      
      expect(monitor.getHealthStatus().message).toContain('1 bash calls');
    });

    it('recovered message includes total failure count', () => {
      monitor.onToolExecutionStart(makeStartEvent('c1', 'bash'));
      monitor.onToolExecutionComplete(makeCompleteEvent('c1', false, { errorMessage: 'posix_openpt failed' }));
      
      monitor.onToolExecutionStart(makeStartEvent('c2', 'bash'));
      monitor.onToolExecutionComplete(makeCompleteEvent('c2', true));
      
      const msg = monitor.getHealthStatus().message;
      expect(msg).toContain('recovered');
      expect(msg).toContain('1 total PTY failures');
    });
  });

  describe('recent failures buffer', () => {
    it('limits stored failures to maxRecentFailures', () => {
      const smallMonitor = new ToolHealthMonitor(mockLogger, {
        maxRecentFailures: 3,
        onAlert: () => {},
      });

      for (let i = 0; i < 5; i++) {
        smallMonitor.onToolExecutionStart(makeStartEvent(`c${i}`, 'bash'));
        smallMonitor.onToolExecutionComplete(makeCompleteEvent(`c${i}`, false, {
          errorMessage: 'posix_openpt failed',
        }));
      }

      expect(smallMonitor.getHealthStatus().recentFailures).toHaveLength(3);
      // Should keep the most recent ones
      expect(smallMonitor.getHealthStatus().recentFailures[2].toolCallId).toBe('c4');
    });
  });
});
