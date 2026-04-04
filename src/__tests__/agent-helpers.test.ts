/**
 * Tests for pure helper functions extracted from AutonomousAgent (Phase 1).
 *
 * These functions contain no SDK or I/O dependencies and can be tested
 * with simple input/output assertions.
 */
import {
  buildBreakdownPrompt,
  parseBreakdownResponse,
  buildSyntheticCommandWorkItem,
  applyBackpressure,
  buildTerminalNotificationPayload,
} from '../agent.js';

// ---------------------------------------------------------------------------
// buildBreakdownPrompt
// ---------------------------------------------------------------------------
describe('buildBreakdownPrompt', () => {
  const baseParams = {
    from: 'alice@example.com',
    subject: 'Implement feature X',
    priority: 'HIGH',
    content: 'Build the new widget system.',
    isManager: false,
    teamMembers: undefined as any,
    minWorkItems: 5,
    maxWorkItems: 20,
  };

  it('returns prompt containing the subject and content strings', () => {
    const result = buildBreakdownPrompt(baseParams);
    expect(result).toContain('Implement feature X');
    expect(result).toContain('Build the new widget system.');
  });

  it('includes from and priority in the prompt', () => {
    const result = buildBreakdownPrompt(baseParams);
    expect(result).toContain('From: alice@example.com');
    expect(result).toContain('Priority: HIGH');
  });

  it('includes minWorkItems and maxWorkItems range', () => {
    const result = buildBreakdownPrompt({ ...baseParams, minWorkItems: 3, maxWorkItems: 10 });
    expect(result).toContain('3-10');
  });

  it('when isManager=true and teamMembers has entries, includes each member', () => {
    const result = buildBreakdownPrompt({
      ...baseParams,
      isManager: true,
      teamMembers: [
        { hostname: 'dev1', role: 'developer', responsibilities: 'backend' },
        { hostname: 'qa1', role: 'qa', responsibilities: 'testing' },
      ],
    });
    expect(result).toContain('dev1');
    expect(result).toContain('backend');
    expect(result).toContain('qa1');
    expect(result).toContain('testing');
    expect(result).toContain('**CRITICAL: You are a MANAGER');
  });

  it('when isManager=false, omits CRITICAL MANAGER instructions', () => {
    const result = buildBreakdownPrompt(baseParams);
    expect(result).not.toContain('**CRITICAL: You are a MANAGER');
  });

  it('when teamMembers is empty array, no Your Team section appears', () => {
    const result = buildBreakdownPrompt({
      ...baseParams,
      isManager: true,
      teamMembers: [],
    });
    expect(result).not.toContain('**Your Team');
  });

  it('uses coding agent framing when isManager=false', () => {
    const result = buildBreakdownPrompt(baseParams);
    expect(result).toContain('autonomous coding agent');
  });

  it('uses project manager framing when isManager=true', () => {
    const result = buildBreakdownPrompt({ ...baseParams, isManager: true });
    expect(result).toContain('autonomous project manager agent');
  });
});

// ---------------------------------------------------------------------------
// parseBreakdownResponse
// ---------------------------------------------------------------------------
describe('parseBreakdownResponse', () => {
  it('parses valid raw JSON array of { title, content } objects', () => {
    const input = JSON.stringify([
      { title: 'Step 1', content: 'Do thing A' },
      { title: 'Step 2', content: 'Do thing B' },
    ]);
    const result = parseBreakdownResponse(input);
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe('Step 1');
    expect(result[1].content).toBe('Do thing B');
  });

  it('strips markdown ```json fences and parses successfully', () => {
    const input = '```json\n[{"title":"A","content":"B"}]\n```';
    const result = parseBreakdownResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('A');
  });

  it('throws on empty array', () => {
    expect(() => parseBreakdownResponse('[]')).toThrow('expected non-empty array');
  });

  it('throws on non-array JSON (e.g. {})', () => {
    expect(() => parseBreakdownResponse('{}')).toThrow('expected non-empty array');
  });

  it('throws on empty string', () => {
    expect(() => parseBreakdownResponse('')).toThrow();
  });

  it('throws on malformed JSON', () => {
    expect(() => parseBreakdownResponse('not json at all')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildSyntheticCommandWorkItem
// ---------------------------------------------------------------------------
describe('buildSyntheticCommandWorkItem', () => {
  const cmd = { command: 'npm test', reason: 'Run the test suite' };

  it('returns WorkItem with correct filename for entry phase', () => {
    const wi = buildSyntheticCommandWorkItem(cmd, 'entry', 0, 3, '/proj');
    expect(wi.filename).toBe('state-entry-cmd-0.md');
  });

  it('returns WorkItem with correct filename for exit phase', () => {
    const wi = buildSyntheticCommandWorkItem(cmd, 'exit', 2, 5, '/proj');
    expect(wi.filename).toBe('state-exit-cmd-2.md');
  });

  it('content includes the command string verbatim', () => {
    const wi = buildSyntheticCommandWorkItem(cmd, 'entry', 0, 1, '/proj');
    expect(wi.content).toContain('npm test');
  });

  it('content includes the reason string', () => {
    const wi = buildSyntheticCommandWorkItem(cmd, 'entry', 0, 1, '/proj');
    expect(wi.content).toContain('Run the test suite');
  });

  it('content includes the projectDir path', () => {
    const wi = buildSyntheticCommandWorkItem(cmd, 'entry', 0, 1, '/my/project');
    expect(wi.content).toContain('/my/project');
  });

  it('fullPath is empty string (synthetic, not persisted)', () => {
    const wi = buildSyntheticCommandWorkItem(cmd, 'entry', 0, 1, '/proj');
    expect(wi.fullPath).toBe('');
  });

  it('title contains the [entry 1/3]-style label', () => {
    const wi = buildSyntheticCommandWorkItem(cmd, 'entry', 0, 3, '/proj');
    expect(wi.title).toContain('[entry 1/3]');
  });

  it('title contains the [exit 2/5]-style label', () => {
    const wi = buildSyntheticCommandWorkItem(cmd, 'exit', 1, 5, '/proj');
    expect(wi.title).toContain('[exit 2/5]');
  });

  it('sequence matches the index parameter', () => {
    const wi = buildSyntheticCommandWorkItem(cmd, 'entry', 7, 10, '/proj');
    expect(wi.sequence).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// applyBackpressure
// ---------------------------------------------------------------------------
describe('applyBackpressure', () => {
  const msgs = [{ id: 1 }, { id: 2 }, { id: 3 }];

  it('when pendingCount >= maxPendingWorkItems, returns skipped: true', () => {
    const result = applyBackpressure(msgs, 50, { enabled: true, maxPendingWorkItems: 50 });
    expect(result.skipped).toBe(true);
    expect(result.messages).toHaveLength(0);
    expect(result.reason).toContain('full');
  });

  it('when pendingCount > 0 and multiple messages, returns array with only first element', () => {
    const result = applyBackpressure(msgs, 5, { enabled: true, maxPendingWorkItems: 50 });
    expect(result.skipped).toBe(false);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({ id: 1 });
  });

  it('when pendingCount === 0, returns all messages unchanged', () => {
    const result = applyBackpressure(msgs, 0, { enabled: true, maxPendingWorkItems: 50 });
    expect(result.skipped).toBe(false);
    expect(result.messages).toHaveLength(3);
    expect(result.messages).toEqual(msgs);
  });

  it('when enabled: false, returns all messages unchanged', () => {
    const result = applyBackpressure(msgs, 100, { enabled: false, maxPendingWorkItems: 50 });
    expect(result.skipped).toBe(false);
    expect(result.messages).toHaveLength(3);
  });

  it('does not mutate the input array', () => {
    const original = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const copy = [...original];
    applyBackpressure(original, 5, { enabled: true, maxPendingWorkItems: 50 });
    expect(original).toEqual(copy);
    expect(original).toHaveLength(3);
  });

  it('with single message and pending > 0, returns that single message', () => {
    const single = [{ id: 1 }];
    const result = applyBackpressure(single, 10, { enabled: true, maxPendingWorkItems: 50 });
    expect(result.skipped).toBe(false);
    expect(result.messages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// buildTerminalNotificationPayload
// ---------------------------------------------------------------------------
describe('buildTerminalNotificationPayload', () => {
  const baseParams = {
    workflowId: 'wf-123',
    taskId: 'task-456',
    newState: 'ESCALATED',
    targetRole: 'regulatory_affairs',
    taskPrompt: 'Review the compliance docs',
  };

  it('returns object with type: workflow and isTerminal: true', () => {
    const payload = buildTerminalNotificationPayload(baseParams);
    expect(payload.type).toBe('workflow');
    expect(payload.isTerminal).toBe(true);
  });

  it('nested taskState.currentState matches params.newState', () => {
    const payload = buildTerminalNotificationPayload(baseParams);
    const taskState = payload.taskState as any;
    expect(taskState.currentState).toBe('ESCALATED');
  });

  it('all input params appear in output at expected paths', () => {
    const payload = buildTerminalNotificationPayload(baseParams);
    expect(payload.workflowId).toBe('wf-123');
    expect(payload.taskId).toBe('task-456');
    expect(payload.targetState).toBe('ESCALATED');
    expect(payload.targetRole).toBe('regulatory_affairs');
    expect(payload.taskPrompt).toBe('Review the compliance docs');
  });

  it('taskState contains required fields for validateWorkflowPayload', () => {
    const payload = buildTerminalNotificationPayload(baseParams);
    const taskState = payload.taskState as any;
    expect(taskState.taskId).toBe('task-456');
    expect(taskState.workflowId).toBe('wf-123');
    expect(taskState.context).toEqual({});
    expect(taskState.retryCount).toBe(0);
    expect(taskState.history).toEqual([]);
  });

  it('uses different newState values correctly', () => {
    const payload = buildTerminalNotificationPayload({
      ...baseParams,
      newState: 'COMPLETED',
    });
    expect(payload.targetState).toBe('COMPLETED');
    const taskState = payload.taskState as any;
    expect(taskState.currentState).toBe('COMPLETED');
  });
});
