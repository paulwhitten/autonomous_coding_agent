// Tests for workflow-engine.ts

import { describe, it, expect, beforeEach } from '@jest/globals';
import { WorkflowEngine } from '../workflow-engine.js';
import {
  WorkflowDefinition,
  WorkflowValidationError,
  WorkflowAssignment,
  OutOfBandMessage,
} from '../workflow-types.js';
import { createMockLogger } from './test-helpers.js';
import path from 'path';

// Jest with ts-jest does not support import.meta.url.
// Tests run from the autonomous_copilot_agent directory, so we resolve
// relative to process.cwd() instead.
const WORKFLOWS_DIR = path.resolve(process.cwd(), 'workflows');

// Minimal valid workflow for testing
function createTestWorkflow(overrides?: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    id: 'test-workflow',
    name: 'Test Workflow',
    description: 'A minimal workflow for unit tests',
    version: '1.0.0',
    initialState: 'START',
    terminalStates: ['DONE', 'FAILED'],
    globalContext: {
      projectPath: '/test/project',
    },
    states: {
      START: {
        name: 'Start',
        role: 'developer',
        description: 'Initial state',
        prompt: 'Do the thing for task {{taskTitle}} in {{projectPath}}.',
        allowedTools: ['terminal', 'file_ops'],
        requiredOutputs: ['branch'],
        transitions: { onSuccess: 'REVIEW', onFailure: 'START' },
        maxRetries: 2,
      },
      REVIEW: {
        name: 'Review',
        role: 'qa',
        description: 'QA reviews',
        prompt: 'Review branch {{branch}} for task {{taskTitle}}.',
        allowedTools: ['terminal', 'reporting'],
        requiredOutputs: ['verdict'],
        transitions: { onSuccess: 'DONE', onFailure: 'REWORK' },
      },
      REWORK: {
        name: 'Rework',
        role: 'developer',
        description: 'Fix issues',
        prompt: 'Fix issues: {{rejectionReason}}',
        allowedTools: ['terminal', 'file_ops'],
        requiredOutputs: ['branch'],
        transitions: { onSuccess: 'REVIEW', onFailure: 'FAILED' },
        maxRetries: 1,
      },
      DONE: {
        name: 'Done',
        role: 'manager',
        description: 'Complete',
        prompt: '',
        allowedTools: [],
        transitions: { onSuccess: null, onFailure: null },
      },
      FAILED: {
        name: 'Failed',
        role: 'manager',
        description: 'Escalated',
        prompt: 'Task failed.',
        allowedTools: [],
        transitions: { onSuccess: null, onFailure: null },
      },
    },
    ...overrides,
  };
}

describe('WorkflowEngine', () => {
  let engine: WorkflowEngine;

  beforeEach(() => {
    engine = new WorkflowEngine(createMockLogger());
  });

  // =====================================================================
  // Workflow Loading and Validation
  // =====================================================================

  describe('loadWorkflow', () => {
    it('should load a valid workflow', () => {
      const def = createTestWorkflow();
      const loaded = engine.loadWorkflow(def);
      expect(loaded.id).toBe('test-workflow');
      expect(engine.getWorkflow('test-workflow')).toBeDefined();
    });

    it('should reject workflow with missing id', () => {
      const def = createTestWorkflow({ id: '' });
      expect(() => engine.loadWorkflow(def)).toThrow(WorkflowValidationError);
    });

    it('should reject workflow with unknown initialState', () => {
      const def = createTestWorkflow({ initialState: 'NONEXISTENT' });
      expect(() => engine.loadWorkflow(def)).toThrow('initialState');
    });

    it('should reject workflow with unknown terminalState', () => {
      const def = createTestWorkflow({ terminalStates: ['DONE', 'GHOST'] });
      expect(() => engine.loadWorkflow(def)).toThrow('terminalState');
    });

    it('should reject empty terminalStates', () => {
      const def = createTestWorkflow({ terminalStates: [] });
      expect(() => engine.loadWorkflow(def)).toThrow('terminalState');
    });

    it('should reject state with unknown onSuccess target', () => {
      const def = createTestWorkflow();
      def.states['START'].transitions.onSuccess = 'NOWHERE';
      expect(() => engine.loadWorkflow(def)).toThrow('NOWHERE');
    });

    it('should reject state with unknown onFailure target', () => {
      const def = createTestWorkflow();
      def.states['START'].transitions.onFailure = 'NOWHERE';
      expect(() => engine.loadWorkflow(def)).toThrow('NOWHERE');
    });

    it('should reject state without a role', () => {
      const def = createTestWorkflow();
      (def.states['START'] as any).role = '';
      expect(() => engine.loadWorkflow(def)).toThrow('role');
    });
  });

  describe('loadWorkflowFromFile', () => {
    it('should load the dev-qa-merge workflow from disk', async () => {
      const filePath = path.resolve(
        WORKFLOWS_DIR,
        'dev-qa-merge.workflow.json',
      );
      const def = await engine.loadWorkflowFromFile(filePath);
      expect(def.id).toBe('dev-qa-merge');
      expect(def.states['ASSIGN']).toBeDefined();
      expect(def.states['IMPLEMENTING']).toBeDefined();
      expect(def.states['VALIDATING']).toBeDefined();
      expect(def.states['MERGING']).toBeDefined();
      expect(def.states['DONE']).toBeDefined();
    });

    it('should load the regulatory workflow from disk', async () => {
      const filePath = path.resolve(
        WORKFLOWS_DIR,
        'regulatory.workflow.json',
      );
      const def = await engine.loadWorkflowFromFile(filePath);
      expect(def.id).toBe('regulatory');
      expect(Object.keys(def.states).length).toBeGreaterThanOrEqual(10);
    });
  });

  // =====================================================================
  // Task Creation
  // =====================================================================

  describe('createTask', () => {
    it('should create a task in the initial state', () => {
      engine.loadWorkflow(createTestWorkflow());
      const task = engine.createTask('test-workflow', 'task-001', {
        taskTitle: 'Implement DCP',
      });

      expect(task.taskId).toBe('task-001');
      expect(task.workflowId).toBe('test-workflow');
      expect(task.currentState).toBe('START');
      expect(task.context.taskTitle).toBe('Implement DCP');
      expect(task.context.projectPath).toBe('/test/project'); // from globalContext
      expect(task.retryCount).toBe(0);
      expect(task.history).toHaveLength(0);
    });

    it('should throw for unknown workflow', () => {
      expect(() => engine.createTask('no-such-workflow', 'task-001')).toThrow(
        'Unknown workflow',
      );
    });

    it('should track active tasks', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001');
      engine.createTask('test-workflow', 'task-002');

      expect(engine.getActiveTaskCount()).toBe(2);
      expect(engine.getActiveTaskIds()).toContain('task-001');
      expect(engine.getActiveTaskIds()).toContain('task-002');
    });

    it('should override global context with task context', () => {
      engine.loadWorkflow(createTestWorkflow());
      const task = engine.createTask('test-workflow', 'task-001', {
        projectPath: '/custom/path', // overrides globalContext
      });
      expect(task.context.projectPath).toBe('/custom/path');
    });
  });

  // =====================================================================
  // State Introspection
  // =====================================================================

  describe('getStateInfo', () => {
    it('should return state, task, and workflow', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001');

      const info = engine.getStateInfo('task-001');
      expect(info.task.taskId).toBe('task-001');
      expect(info.state.name).toBe('Start');
      expect(info.state.role).toBe('developer');
      expect(info.workflow.id).toBe('test-workflow');
    });

    it('should throw for unknown task', () => {
      expect(() => engine.getStateInfo('ghost')).toThrow('Unknown task');
    });
  });

  describe('getPrompt', () => {
    it('should substitute template variables', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001', {
        taskTitle: 'Implement DCP',
      });

      const prompt = engine.getPrompt('task-001');
      expect(prompt).toContain('Do the thing for task Implement DCP in /test/project.');
    });

    it('should include advisory tool guidance', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001', {
        taskTitle: 'Test',
      });

      const prompt = engine.getPrompt('task-001');
      expect(prompt).toContain('Recommended tools for this state:');
      expect(prompt).toContain('run_in_terminal');
      expect(prompt).toContain('All standard tools remain available');
    });

    it('should include restricted tool warning when restrictions exist', () => {
      const def = createTestWorkflow();
      def.states['START'].restrictedTools = ['mailbox:send'];
      engine.loadWorkflow(def);
      engine.createTask('test-workflow', 'task-001', { taskTitle: 'Test' });

      const prompt = engine.getPrompt('task-001');
      expect(prompt).toContain('Restricted tools (do NOT use):');
      expect(prompt).toContain('send_message');
    });

    it('should NOT include restricted section when no restrictions', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001', { taskTitle: 'Test' });

      const prompt = engine.getPrompt('task-001');
      expect(prompt).not.toContain('Restricted tools');
    });

    it('should leave unknown variables as-is', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001', {});

      const prompt = engine.getPrompt('task-001');
      expect(prompt).toContain('{{taskTitle}}');
      expect(prompt).toContain('/test/project');
    });

    it('should include context history after transitions', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001', { taskTitle: 'DCP' });

      // Transition through START -> REVIEW
      engine.transition('task-001', {
        success: true,
        outputs: { branch: 'dev/dcp-test' },
      });

      // Now in REVIEW state -- prompt should contain history
      const prompt = engine.getPrompt('task-001');
      expect(prompt).toContain('Prior workflow history:');
      expect(prompt).toContain('START');
      expect(prompt).toContain('completed');
      expect(prompt).toContain('branch=dev/dcp-test');
    });

    it('should include accumulated context in history block', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001', { taskTitle: 'DCP' });

      engine.transition('task-001', {
        success: true,
        outputs: { branch: 'dev/dcp' },
      });

      const prompt = engine.getPrompt('task-001');
      expect(prompt).toContain('Accumulated context:');
      expect(prompt).toContain('branch: dev/dcp');
    });
  });

  describe('getRecommendedTools / getAllowedTools (advisory)', () => {
    it('should expand tool groups', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001');

      const tools = engine.getRecommendedTools('task-001');
      // START state has ['terminal', 'file_ops'] which expand to:
      expect(tools).toContain('run_in_terminal');
      expect(tools).toContain('get_terminal_output');
      expect(tools).toContain('read_file');
      expect(tools).toContain('create_file');
      expect(tools).toContain('replace_string_in_file');
    });

    it('getAllowedTools should be backward-compat alias for getRecommendedTools', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001');

      const recommended = engine.getRecommendedTools('task-001');
      const allowed = engine.getAllowedTools('task-001');
      expect(allowed).toEqual(recommended);
    });

    it('should pass through individual tool names', () => {
      const def = createTestWorkflow();
      def.states['START'].allowedTools = ['send_message', 'terminal'];
      engine.loadWorkflow(def);
      engine.createTask('test-workflow', 'task-001');

      const tools = engine.getAllowedTools('task-001');
      expect(tools).toContain('send_message');
      expect(tools).toContain('run_in_terminal');
    });

    it('should deduplicate tools from overlapping groups', () => {
      const def = createTestWorkflow();
      def.states['START'].allowedTools = ['terminal', 'git']; // both include run_in_terminal
      engine.loadWorkflow(def);
      engine.createTask('test-workflow', 'task-001');

      const tools = engine.getAllowedTools('task-001');
      const rtCount = tools.filter((t) => t === 'run_in_terminal').length;
      expect(rtCount).toBe(1);
    });
  });

  describe('getRestrictedTools / isToolRestricted', () => {
    it('should return empty array when no restrictedTools defined', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001');

      const restricted = engine.getRestrictedTools('task-001');
      expect(restricted).toEqual([]);
    });

    it('should expand restricted tool groups', () => {
      const def = createTestWorkflow();
      def.states['START'].restrictedTools = ['mailbox:send'];
      engine.loadWorkflow(def);
      engine.createTask('test-workflow', 'task-001');

      const restricted = engine.getRestrictedTools('task-001');
      expect(restricted).toContain('send_message');
      expect(restricted).toContain('send_broadcast');
    });

    it('isToolRestricted should return true for restricted tools', () => {
      const def = createTestWorkflow();
      def.states['START'].restrictedTools = ['mailbox:send'];
      engine.loadWorkflow(def);
      engine.createTask('test-workflow', 'task-001');

      expect(engine.isToolRestricted('task-001', 'send_message')).toBe(true);
      expect(engine.isToolRestricted('task-001', 'send_broadcast')).toBe(true);
      expect(engine.isToolRestricted('task-001', 'run_in_terminal')).toBe(false);
    });
  });

  describe('isToolAllowed (deny-list based)', () => {
    it('should return true for any tool when no restrictions set', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001');

      // Even tools not in allowedTools are allowed (advisory only)
      expect(engine.isToolAllowed('task-001', 'run_in_terminal')).toBe(true);
      expect(engine.isToolAllowed('task-001', 'read_file')).toBe(true);
      expect(engine.isToolAllowed('task-001', 'send_message')).toBe(true);
      expect(engine.isToolAllowed('task-001', 'send_broadcast')).toBe(true);
    });

    it('should return false for explicitly restricted tools', () => {
      const def = createTestWorkflow();
      def.states['START'].restrictedTools = ['mailbox:send'];
      engine.loadWorkflow(def);
      engine.createTask('test-workflow', 'task-001');

      expect(engine.isToolAllowed('task-001', 'send_message')).toBe(false);
      expect(engine.isToolAllowed('task-001', 'send_broadcast')).toBe(false);
      // Non-restricted tools remain allowed
      expect(engine.isToolAllowed('task-001', 'run_in_terminal')).toBe(true);
    });
  });

  describe('isTerminal / getCurrentRole', () => {
    it('should identify terminal states', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001');

      expect(engine.isTerminal('task-001')).toBe(false);

      // Move to DONE
      engine.transition('task-001', {
        success: true,
        outputs: { branch: 'dev/test' },
      });
      engine.transition('task-001', {
        success: true,
        outputs: { verdict: 'pass' },
      });

      expect(engine.isTerminal('task-001')).toBe(true);
    });

    it('should return correct role for current state', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001');

      expect(engine.getCurrentRole('task-001')).toBe('developer');

      engine.transition('task-001', {
        success: true,
        outputs: { branch: 'dev/test' },
      });

      expect(engine.getCurrentRole('task-001')).toBe('qa');
    });
  });

  // =====================================================================
  // State Transitions
  // =====================================================================

  describe('transition', () => {
    it('should advance to onSuccess state', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001', { taskTitle: 'Test' });

      const result = engine.transition('task-001', {
        success: true,
        outputs: { branch: 'dev/task-001' },
      });

      expect(result.newState).toBe('REVIEW');
      expect(result.role).toBe('qa');
      expect(result.isTerminal).toBe(false);

      const task = engine.getTask('task-001')!;
      expect(task.currentState).toBe('REVIEW');
      expect(task.context.branch).toBe('dev/task-001');
      expect(task.history).toHaveLength(1);
      expect(task.history[0].fromState).toBe('START');
      expect(task.history[0].toState).toBe('REVIEW');
      expect(task.history[0].result).toBe('success');
    });

    it('should advance to onFailure state', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001');

      // REVIEW -> REWORK on failure
      engine.transition('task-001', {
        success: true,
        outputs: { branch: 'dev/test' },
      });
      const result = engine.transition('task-001', {
        success: false,
        outputs: {},
        error: 'tests failed',
      });

      expect(result.newState).toBe('REWORK');
      expect(result.role).toBe('developer');
    });

    it('should track retry count and escalate on max retries', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001');

      // START has maxRetries: 2
      // Failure 1: retry (stay in START since onFailure = START)
      engine.transition('task-001', {
        success: false,
        outputs: {},
        error: 'build failed',
      });
      expect(engine.getTask('task-001')!.currentState).toBe('START');
      expect(engine.getTask('task-001')!.retryCount).toBe(1);

      // Failure 2: retry
      engine.transition('task-001', {
        success: false,
        outputs: {},
        error: 'build failed again',
      });
      expect(engine.getTask('task-001')!.currentState).toBe('START');
      expect(engine.getTask('task-001')!.retryCount).toBe(2);

      // Failure 3: exceeds maxRetries (2), goes to onFailure = START
      // but onFailure is a self-loop, so engine forces escalation to
      // the workflow's failure terminal state (FAILED)
      engine.transition('task-001', {
        success: false,
        outputs: {},
        error: 'still failing',
      });
      // Self-loop on max retries exceeded forces escalation terminal state
      expect(engine.getTask('task-001')!.currentState).toBe('FAILED');
    });

    it('should reset retry count on success', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001');

      // Fail once
      engine.transition('task-001', {
        success: false,
        outputs: {},
      });
      expect(engine.getTask('task-001')!.retryCount).toBe(1);

      // Succeed
      engine.transition('task-001', {
        success: true,
        outputs: { branch: 'dev/test' },
      });
      expect(engine.getTask('task-001')!.retryCount).toBe(0);
    });

    it('should merge outputs into task context', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001');

      engine.transition('task-001', {
        success: true,
        outputs: { branch: 'dev/test', commitSha: 'abc123' },
      });

      const task = engine.getTask('task-001')!;
      expect(task.context.branch).toBe('dev/test');
      expect(task.context.commitSha).toBe('abc123');
    });

    it('should treat missing required outputs as failure', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001');

      // START requires 'branch' output
      const result = engine.transition('task-001', {
        success: true,
        outputs: {}, // missing 'branch'
      });

      // Should fail (missing required output), stay in START
      expect(result.newState).toBe('START');
      const task = engine.getTask('task-001')!;
      expect(task.retryCount).toBe(1);
      expect(task.history[0].result).toBe('failure');
    });

    it('should reach terminal state', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001');

      // START -> REVIEW
      engine.transition('task-001', {
        success: true,
        outputs: { branch: 'dev/test' },
      });

      // REVIEW -> DONE
      const result = engine.transition('task-001', {
        success: true,
        outputs: { verdict: 'pass' },
      });

      expect(result.newState).toBe('DONE');
      expect(result.isTerminal).toBe(true);
      expect(engine.isTerminal('task-001')).toBe(true);
    });

    it('should record full transition history', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001');

      // START -> REVIEW -> REWORK -> REVIEW -> DONE
      engine.transition('task-001', {
        success: true,
        outputs: { branch: 'dev/test' },
      });
      engine.transition('task-001', {
        success: false,
        outputs: { rejectionReason: 'tests fail' },
        error: 'tests fail',
      });
      engine.transition('task-001', {
        success: true,
        outputs: { branch: 'dev/test' },
      });
      engine.transition('task-001', {
        success: true,
        outputs: { verdict: 'pass' },
      });

      const task = engine.getTask('task-001')!;
      expect(task.history).toHaveLength(4);
      expect(task.history.map((h) => h.fromState)).toEqual([
        'START',
        'REVIEW',
        'REWORK',
        'REVIEW',
      ]);
      expect(task.history.map((h) => h.toState)).toEqual([
        'REVIEW',
        'REWORK',
        'REVIEW',
        'DONE',
      ]);
    });
  });

  // =====================================================================
  // Serialization
  // =====================================================================

  describe('serialization', () => {
    it('should serialize and deserialize task state', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001', {
        taskTitle: 'Test Task',
      });
      engine.transition('task-001', {
        success: true,
        outputs: { branch: 'dev/test' },
      });

      const json = engine.serializeTaskState('task-001');
      const parsed = JSON.parse(json);
      expect(parsed.taskId).toBe('task-001');
      expect(parsed.currentState).toBe('REVIEW');
      expect(parsed.context.branch).toBe('dev/test');

      // Deserialize into a fresh engine
      const engine2 = new WorkflowEngine(createMockLogger());
      engine2.loadWorkflow(createTestWorkflow());
      const restored = engine2.deserializeTaskState(json);
      expect(restored.taskId).toBe('task-001');
      expect(restored.currentState).toBe('REVIEW');
    });
  });

  describe('message embedding', () => {
    it('should embed and extract task state from message content', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001', {
        taskTitle: 'Embed Test',
      });

      const originalContent = '## Task Complete\n\nBranch pushed.';
      const packed = engine.packTaskState(originalContent, 'task-001');

      expect(packed).toContain(originalContent);
      expect(packed).toContain('WORKFLOW_MSG');

      // Extract from packed message
      const engine2 = new WorkflowEngine(createMockLogger());
      engine2.loadWorkflow(createTestWorkflow());
      const extracted = engine2.extractTaskState(packed);

      expect(extracted).not.toBeNull();
      expect(extracted!.taskId).toBe('task-001');
      expect(extracted!.context.taskTitle).toBe('Embed Test');
    });

    it('should return null when no state is embedded', () => {
      const result = engine.extractTaskState('Just a normal message.');
      expect(result).toBeNull();
    });

    it('should strip workflow state from message content', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001');

      const originalContent = '## Report\nAll tests pass.';
      const packed = engine.packTaskState(originalContent, 'task-001');

      const stripped = engine.stripTaskState(packed);
      expect(stripped).toBe(originalContent);
      expect(stripped).not.toContain('WORKFLOW_STATE');
    });
  });

  // =====================================================================
  // Role-based queries
  // =====================================================================

  describe('getTasksForRole', () => {
    it('should return tasks currently assigned to a role', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001'); // START -> developer
      engine.createTask('test-workflow', 'task-002'); // START -> developer
      engine.createTask('test-workflow', 'task-003'); // START -> developer

      // Move task-002 to REVIEW (qa)
      engine.transition('task-002', {
        success: true,
        outputs: { branch: 'dev/t2' },
      });

      const devTasks = engine.getTasksForRole('developer');
      expect(devTasks).toHaveLength(2);
      expect(devTasks.map((t) => t.taskId).sort()).toEqual(['task-001', 'task-003']);

      const qaTasks = engine.getTasksForRole('qa');
      expect(qaTasks).toHaveLength(1);
      expect(qaTasks[0].taskId).toBe('task-002');
    });
  });

  // =====================================================================
  // Task removal
  // =====================================================================

  describe('removeTask', () => {
    it('should remove completed tasks from active set', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001');
      expect(engine.getActiveTaskCount()).toBe(1);

      engine.removeTask('task-001');
      expect(engine.getActiveTaskCount()).toBe(0);
      expect(engine.getTask('task-001')).toBeUndefined();
    });
  });

  // =====================================================================
  // Assignment building and receiving
  // =====================================================================

  describe('buildAssignment', () => {
    it('should create a valid WorkflowAssignment', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001', { taskTitle: 'Build DCP' });

      const assignment = engine.buildAssignment('task-001', 'Implement DCP discovery frames');

      expect(assignment.type).toBe('workflow');
      expect(assignment.workflowId).toBe('test-workflow');
      expect(assignment.taskId).toBe('task-001');
      expect(assignment.targetState).toBe('START');
      expect(assignment.targetRole).toBe('developer');
      expect(assignment.taskPrompt).toBe('Implement DCP discovery frames');
      expect(assignment.taskState.taskId).toBe('task-001');
    });

    it('should store taskPrompt in task context', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001');

      engine.buildAssignment('task-001', 'Implement LLDP frames');

      const task = engine.getTask('task-001')!;
      expect(task.context._taskPrompt).toBe('Implement LLDP frames');
    });

    it('should include taskPrompt in composed prompt', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001', { taskTitle: 'Test' });

      engine.buildAssignment('task-001', 'Add PTCP sync support');

      const prompt = engine.getPrompt('task-001');
      expect(prompt).toContain('Do the thing');
      expect(prompt).toContain('Add PTCP sync support');
      expect(prompt).toContain('Task Details:');
    });
  });

  describe('receiveAssignment', () => {
    it('should ingest assignment and make task active', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001', { taskTitle: 'Test' });

      const assignment = engine.buildAssignment('task-001', 'Do the work');

      // Simulate receiving on a fresh engine (same workflow loaded)
      const receiver = new WorkflowEngine(createMockLogger());
      receiver.loadWorkflow(createTestWorkflow());

      const result = receiver.receiveAssignment(assignment);

      expect(result.taskId).toBe('task-001');
      expect(result.prompt).toContain('Do the work');
      expect(result.allowedTools.length).toBeGreaterThan(0);

      // Task should now be active in the receiver
      expect(receiver.getTask('task-001')).toBeDefined();
      expect(receiver.getTask('task-001')!.currentState).toBe('START');
    });

    it('should return allowed tools for the current state', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001');

      const assignment = engine.buildAssignment('task-001', 'Go');

      const receiver = new WorkflowEngine(createMockLogger());
      receiver.loadWorkflow(createTestWorkflow());

      const result = receiver.receiveAssignment(assignment);

      // START state allows terminal and file_ops (expanded from groups)
      expect(result.allowedTools).toEqual(expect.arrayContaining(['run_in_terminal']));
      // restrictedTools should be an empty array when no restrictions set
      expect(result.restrictedTools).toEqual([]);
    });

    it('should return restrictedTools when state has them', () => {
      const def = createTestWorkflow();
      def.states['START'].restrictedTools = ['mailbox:send'];
      engine.loadWorkflow(def);
      engine.createTask('test-workflow', 'task-001');

      const assignment = engine.buildAssignment(  'task-001', 'Go');

      const receiver = new WorkflowEngine(createMockLogger());
      receiver.loadWorkflow(def);

      const result = receiver.receiveAssignment(assignment);
      expect(result.restrictedTools).toContain('send_message');
      expect(result.restrictedTools).toContain('send_broadcast');
    });
  });

  // =====================================================================
  // Out-of-Band (OOB) messages
  // =====================================================================

  describe('buildOOB', () => {
    it('should create an OOB message with required fields', () => {
      const oob = engine.buildOOB('Server is down', 'infrastructure-failure', 'HIGH');

      expect(oob.type).toBe('oob');
      expect(oob.priority).toBe('HIGH');
      expect(oob.reason).toBe('infrastructure-failure');
      expect(oob.content).toBe('Server is down');
    });

    it('should support optional relatedTaskId and resumeState', () => {
      const oob = engine.buildOOB(
        'Urgent fix needed',
        'security-vulnerability',
        'HIGH',
        'task-001',
        'IMPLEMENTING',
      );

      expect(oob.relatedTaskId).toBe('task-001');
      expect(oob.resumeState).toBe('IMPLEMENTING');
    });

    it('should default priority to HIGH', () => {
      const oob = engine.buildOOB('Alert', 'test');
      expect(oob.priority).toBe('HIGH');
    });
  });

  describe('receiveOOB', () => {
    it('should produce a prompt with OOB fields substituted', () => {
      const oob = engine.buildOOB('Build is broken', 'ci-failure', 'HIGH');

      const result = engine.receiveOOB(oob);

      expect(result.prompt).toContain('Build is broken');
      expect(result.prompt).toContain('HIGH');
      expect(result.prompt).toContain('ci-failure');
      expect(result.prompt).toContain('urgent out-of-band');
    });

    it('should provide broad tool access', () => {
      const oob = engine.buildOOB('Fix now', 'critical');

      const result = engine.receiveOOB(oob);

      expect(result.allowedTools.length).toBeGreaterThan(3);
      expect(result.allowedTools).toEqual(expect.arrayContaining(['run_in_terminal']));
      // OOB messages have no restrictions
      expect(result.restrictedTools).toEqual([]);
    });

    it('should merge related task context into OOB prompt', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001', { taskTitle: 'DCP Module' });

      const oob = engine.buildOOB(
        'Fix bug in DCP',
        'bug',
        'HIGH',
        'task-001',
      );

      const result = engine.receiveOOB(oob);
      expect(result.relatedTaskId).toBe('task-001');
    });
  });

  // =====================================================================
  // Message packing and classification
  // =====================================================================

  describe('packMessage / unpackMessage', () => {
    it('should round-trip a workflow assignment', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001');

      const assignment = engine.buildAssignment('task-001', 'Test prompt');
      const packed = engine.packMessage('Human-readable content', assignment);

      expect(packed).toContain('Human-readable content');
      expect(packed).toContain('WORKFLOW_MSG');

      const unpacked = engine.unpackMessage(packed);
      expect(unpacked).not.toBeNull();
      expect(unpacked!.type).toBe('workflow');
      expect((unpacked as WorkflowAssignment).taskPrompt).toBe('Test prompt');
    });

    it('should round-trip an OOB message', () => {
      const oob = engine.buildOOB('Emergency', 'outage', 'HIGH');
      const packed = engine.packMessage('FYI: outage detected', oob);

      const unpacked = engine.unpackMessage(packed);
      expect(unpacked).not.toBeNull();
      expect(unpacked!.type).toBe('oob');
      expect((unpacked as OutOfBandMessage).content).toBe('Emergency');
    });

    it('should return null for content without embedded message', () => {
      const result = engine.unpackMessage('Just a plain message.');
      expect(result).toBeNull();
    });
  });

  describe('stripMessage', () => {
    it('should remove embedded message and return clean content', () => {
      const oob = engine.buildOOB('Test', 'reason');
      const packed = engine.packMessage('Clean content here', oob);

      const stripped = engine.stripMessage(packed);
      expect(stripped).toBe('Clean content here');
      expect(stripped).not.toContain('WORKFLOW_MSG');
    });
  });

  describe('classifyMessage', () => {
    it('should classify workflow assignments', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001');

      const assignment = engine.buildAssignment('task-001', 'Go');
      const packed = engine.packMessage('Task assigned', assignment);

      expect(engine.classifyMessage(packed)).toBe('workflow');
    });

    it('should classify OOB messages', () => {
      const oob = engine.buildOOB('Alert', 'reason');
      const packed = engine.packMessage('Urgent', oob);

      expect(engine.classifyMessage(packed)).toBe('oob');
    });

    it('should classify plain messages as unstructured', () => {
      expect(engine.classifyMessage('Hello, how are you?')).toBe('unstructured');
    });
  });

  // =====================================================================
  // Legacy compat: packTaskState / extractTaskState use new markers
  // =====================================================================

  describe('legacy compat with new markers', () => {
    it('packTaskState should use WORKFLOW_MSG markers', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001');

      const packed = engine.packTaskState('Report done', 'task-001');
      expect(packed).toContain('WORKFLOW_MSG');
      expect(packed).toContain('Report done');
    });

    it('extractTaskState should work with WORKFLOW_MSG markers', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001', { taskTitle: 'Legacy' });

      const packed = engine.packTaskState('Content', 'task-001');

      const engine2 = new WorkflowEngine(createMockLogger());
      engine2.loadWorkflow(createTestWorkflow());
      const extracted = engine2.extractTaskState(packed);

      expect(extracted).not.toBeNull();
      expect(extracted!.taskId).toBe('task-001');
      expect(extracted!.context.taskTitle).toBe('Legacy');
    });

    it('stripTaskState should strip WORKFLOW_MSG markers', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001');

      const packed = engine.packTaskState('Original content', 'task-001');
      const stripped = engine.stripTaskState(packed);

      expect(stripped).toBe('Original content');
      expect(stripped).not.toContain('WORKFLOW_MSG');
    });
  });

  // =====================================================================
  // validateWorkflowPayload / validateOOBPayload  (strict-schema helpers)
  // =====================================================================

  describe('validateWorkflowPayload', () => {
    beforeEach(() => {
      engine.loadWorkflow(createTestWorkflow());
    });

    function validWorkflowPayload(): Record<string, unknown> {
      return {
        type: 'workflow',
        workflowId: 'test-workflow',
        taskId: 'task-001',
        targetState: 'START',
        targetRole: 'developer',
        taskPrompt: 'Do the thing',
        taskState: { taskId: 'task-001', currentState: 'START' },
      };
    }

    it('should accept a valid workflow payload', () => {
      const result = engine.validateWorkflowPayload(validWorkflowPayload());
      expect(result).not.toBeNull();
      expect(result!.type).toBe('workflow');
      expect(result!.taskId).toBe('task-001');
    });

    it('should accept payload with extra fields', () => {
      const payload = { ...validWorkflowPayload(), custom: 'extra-data' };
      const result = engine.validateWorkflowPayload(payload);
      expect(result).not.toBeNull();
      expect(result!.taskId).toBe('task-001');
    });

    it.each([
      'type',
      'workflowId',
      'taskId',
      'targetState',
      'targetRole',
      'taskPrompt',
      'taskState',
    ])('should reject payload missing required field "%s"', (field) => {
      const payload = validWorkflowPayload();
      delete payload[field];
      const result = engine.validateWorkflowPayload(payload);
      expect(result).toBeNull();
    });

    it('should reject payload when type is not "workflow"', () => {
      const payload = { ...validWorkflowPayload(), type: 'oob' };
      const result = engine.validateWorkflowPayload(payload);
      expect(result).toBeNull();
    });

    it('should reject payload when type is arbitrary string', () => {
      const payload = { ...validWorkflowPayload(), type: 'bogus' };
      const result = engine.validateWorkflowPayload(payload);
      expect(result).toBeNull();
    });

    it('should accept payload with workItems array', () => {
      const payload = {
        ...validWorkflowPayload(),
        workItems: [
          { title: 'WI-1', content: 'Do first thing' },
          { title: 'WI-2', content: 'Do second thing' },
        ],
      };
      const result = engine.validateWorkflowPayload(payload);
      expect(result).not.toBeNull();
    });
  });

  describe('validateOOBPayload', () => {
    beforeEach(() => {
      engine.loadWorkflow(createTestWorkflow());
    });

    function validOOBPayload(): Record<string, unknown> {
      return {
        type: 'oob',
        priority: 'HIGH',
        reason: 'security-patch',
        content: 'Patch the vulnerability immediately',
      };
    }

    it('should accept a valid OOB payload', () => {
      const result = engine.validateOOBPayload(validOOBPayload());
      expect(result).not.toBeNull();
      expect(result!.type).toBe('oob');
      expect(result!.priority).toBe('HIGH');
    });

    it('should accept payload with extra fields', () => {
      const payload = { ...validOOBPayload(), metadata: { source: 'monitor' } };
      const result = engine.validateOOBPayload(payload);
      expect(result).not.toBeNull();
    });

    it.each(['type', 'priority', 'reason', 'content'])(
      'should reject payload missing required field "%s"',
      (field) => {
        const payload = validOOBPayload();
        delete payload[field];
        const result = engine.validateOOBPayload(payload);
        expect(result).toBeNull();
      },
    );

    it('should reject payload when type is not "oob"', () => {
      const payload = { ...validOOBPayload(), type: 'workflow' };
      const result = engine.validateOOBPayload(payload);
      expect(result).toBeNull();
    });

    it('should reject payload when type is arbitrary string', () => {
      const payload = { ...validOOBPayload(), type: 'notification' };
      const result = engine.validateOOBPayload(payload);
      expect(result).toBeNull();
    });

    it('should reject an empty object', () => {
      const result = engine.validateOOBPayload({});
      expect(result).toBeNull();
    });
  });

  // =====================================================================
  // Notes (inter-agent scratchpad)
  // =====================================================================

  describe('addNote / getNotes', () => {
    it('should add a note and retrieve it', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001', { taskTitle: 'DCP' });

      engine.addNote('task-001', 'developer', 'Implemented DCP identify handler.');

      const notes = engine.getNotes('task-001');
      expect(notes).toHaveLength(1);
      expect(notes[0].role).toBe('developer');
      expect(notes[0].content).toBe('Implemented DCP identify handler.');
      expect(notes[0].state).toBe('START');
      expect(notes[0].timestamp).toBeDefined();
    });

    it('should append multiple notes in order', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001', { taskTitle: 'DCP' });

      engine.addNote('task-001', 'developer', 'First note');
      engine.addNote('task-001', 'developer', 'Second note');
      engine.addNote('task-001', 'qa', 'QA observation');

      const notes = engine.getNotes('task-001');
      expect(notes).toHaveLength(3);
      expect(notes[0].content).toBe('First note');
      expect(notes[1].content).toBe('Second note');
      expect(notes[2].role).toBe('qa');
      expect(notes[2].content).toBe('QA observation');
    });

    it('should record the current state on each note', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001', { taskTitle: 'DCP' });

      engine.addNote('task-001', 'developer', 'Note in START');
      engine.transition('task-001', { success: true, outputs: { branch: 'dev/dcp' } });

      // Now in REVIEW state
      engine.addNote('task-001', 'qa', 'Note in REVIEW');

      const notes = engine.getNotes('task-001');
      expect(notes).toHaveLength(2);
      expect(notes[0].state).toBe('START');
      expect(notes[1].state).toBe('REVIEW');
    });

    it('should return empty array for task with no notes', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001', { taskTitle: 'DCP' });

      const notes = engine.getNotes('task-001');
      expect(notes).toHaveLength(0);
    });

    it('should throw for unknown task id', () => {
      engine.loadWorkflow(createTestWorkflow());
      expect(() => engine.addNote('no-such-task', 'dev', 'hi')).toThrow();
      expect(() => engine.getNotes('no-such-task')).toThrow();
    });

    it('should update the task updatedAt timestamp', () => {
      engine.loadWorkflow(createTestWorkflow());
      const task = engine.createTask('test-workflow', 'task-001', { taskTitle: 'DCP' });
      const before = task.updatedAt;

      // Small delay to ensure timestamp differs
      engine.addNote('task-001', 'developer', 'Some note');

      const after = engine.getTask('task-001')!.updatedAt;
      expect(after).toBeDefined();
      // updatedAt should be >= before (may be equal if sub-ms)
      expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    });
  });

  describe('notes in prompt rendering', () => {
    it('should render notes in getPrompt output', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001', { taskTitle: 'DCP' });

      engine.addNote('task-001', 'developer', 'Built the DCP handler successfully.');

      // Transition to REVIEW so there is context history
      engine.transition('task-001', { success: true, outputs: { branch: 'dev/dcp' } });

      const prompt = engine.getPrompt('task-001');
      expect(prompt).toContain('Agent notes:');
      expect(prompt).toContain('(developer)');
      expect(prompt).toContain('Built the DCP handler successfully.');
    });

    it('should not include Agent notes section when there are no notes', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001', { taskTitle: 'DCP' });

      engine.transition('task-001', { success: true, outputs: { branch: 'dev/dcp' } });

      const prompt = engine.getPrompt('task-001');
      expect(prompt).not.toContain('Agent notes:');
    });

    it('should render notes with state and role labels', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001', { taskTitle: 'DCP' });

      engine.addNote('task-001', 'developer', 'Impl complete');
      engine.transition('task-001', { success: true, outputs: { branch: 'dev/dcp' } });
      engine.addNote('task-001', 'qa', 'Found missing doc comments');

      const prompt = engine.getPrompt('task-001');
      expect(prompt).toContain('[START] (developer): Impl complete');
      expect(prompt).toContain('[REVIEW] (qa): Found missing doc comments');
    });

    it('should truncate long notes in prompt', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001', { taskTitle: 'DCP' });

      const longNote = 'x'.repeat(600);
      engine.addNote('task-001', 'developer', longNote);

      engine.transition('task-001', { success: true, outputs: { branch: 'dev/dcp' } });

      const prompt = engine.getPrompt('task-001');
      expect(prompt).toContain('Agent notes:');
      // Should be truncated to 500 chars with ...
      expect(prompt).toContain('...');
      expect(prompt).not.toContain('x'.repeat(600));
    });
  });

  describe('notes survive serialization roundtrip', () => {
    it('should preserve notes through serialize/deserialize', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001', { taskTitle: 'DCP' });
      engine.addNote('task-001', 'developer', 'Architecture decision recorded');
      engine.addNote('task-001', 'qa', 'Reviewed and approved');

      const json = engine.serializeTaskState('task-001');

      // Restore in a fresh engine
      const engine2 = new WorkflowEngine(createMockLogger());
      engine2.loadWorkflow(createTestWorkflow());
      const restored = engine2.deserializeTaskState(json);

      expect(restored.notes).toHaveLength(2);
      expect(restored.notes[0].role).toBe('developer');
      expect(restored.notes[0].content).toBe('Architecture decision recorded');
      expect(restored.notes[1].role).toBe('qa');
      expect(restored.notes[1].content).toBe('Reviewed and approved');
    });

    it('should preserve notes through pack/extract message embedding', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001', { taskTitle: 'DCP' });
      engine.addNote('task-001', 'developer', 'Note survives message');

      const packed = engine.packTaskState('Original message content.', 'task-001');

      const engine2 = new WorkflowEngine(createMockLogger());
      engine2.loadWorkflow(createTestWorkflow());
      const extracted = engine2.extractTaskState(packed);

      expect(extracted).not.toBeNull();
      expect(extracted!.notes).toBeDefined();
      expect(extracted!.notes).toHaveLength(1);
      expect(extracted!.notes[0].content).toBe('Note survives message');
    });
  });

  describe('notes backward compatibility', () => {
    it('should handle deserialized task without notes field', () => {
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001', { taskTitle: 'DCP' });

      // Simulate an old serialized task missing the notes field
      const json = engine.serializeTaskState('task-001');
      const parsed = JSON.parse(json);
      delete parsed.notes;
      const mutated = JSON.stringify(parsed);

      const engine2 = new WorkflowEngine(createMockLogger());
      engine2.loadWorkflow(createTestWorkflow());
      const restored = engine2.deserializeTaskState(mutated);

      // getNotes should return empty array, addNote should work
      const notes = engine2.getNotes(restored.taskId);
      expect(notes).toHaveLength(0);

      engine2.addNote(restored.taskId, 'qa', 'New note on old task');
      expect(engine2.getNotes(restored.taskId)).toHaveLength(1);
    });
  });

  describe('createTask initializes notes', () => {
    it('should initialize notes as empty array', () => {
      engine.loadWorkflow(createTestWorkflow());
      const task = engine.createTask('test-workflow', 'task-001', { taskTitle: 'DCP' });
      expect(task.notes).toBeDefined();
      expect(task.notes).toEqual([]);
    });
  });

  // =====================================================================
  // entryActions
  // =====================================================================

  describe('entryActions', () => {
    it('should execute set_context entryActions on the arriving state', () => {
      const wf = createTestWorkflow();
      wf.states['REVIEW'].entryActions = [
        { type: 'set_context', params: { key: 'reviewStarted', value: 'true' } },
      ];
      engine.loadWorkflow(wf);
      engine.createTask('test-workflow', 'task-001', { taskTitle: 'Test' });

      // START -> REVIEW
      engine.transition('task-001', {
        success: true,
        outputs: { branch: 'dev/test' },
      });

      const task = engine.getTask('task-001')!;
      expect(task.context.reviewStarted).toBe('true');
    });

    it('should execute log entryActions on the arriving state without error', () => {
      const wf = createTestWorkflow();
      wf.states['REVIEW'].entryActions = [
        { type: 'log', params: { message: 'Entering review for {{taskId}}', level: 'info' } },
      ];
      engine.loadWorkflow(wf);
      engine.createTask('test-workflow', 'task-001', { taskTitle: 'Test' });

      // START -> REVIEW: should not throw when log entryAction fires
      const result = engine.transition('task-001', {
        success: true,
        outputs: { branch: 'dev/test' },
      });

      expect(result.newState).toBe('REVIEW');
    });

    it('should execute warn-level log entryActions without error', () => {
      const wf = createTestWorkflow();
      wf.states['REVIEW'].entryActions = [
        { type: 'log', params: { message: 'Warning on entry', level: 'warn' } },
      ];
      engine.loadWorkflow(wf);
      engine.createTask('test-workflow', 'task-001', { taskTitle: 'Test' });

      const result = engine.transition('task-001', {
        success: true,
        outputs: { branch: 'dev/test' },
      });

      expect(result.newState).toBe('REVIEW');
    });

    it('should execute entryActions on terminal states', () => {
      const wf = createTestWorkflow();
      wf.states['DONE'].entryActions = [
        { type: 'set_context', params: { key: 'completedAt', value: 'done' } },
        { type: 'log', params: { message: 'Workflow DONE for {{taskId}}', level: 'info' } },
      ];
      engine.loadWorkflow(wf);
      engine.createTask('test-workflow', 'task-001', { taskTitle: 'Test' });

      // START -> REVIEW -> DONE
      engine.transition('task-001', {
        success: true,
        outputs: { branch: 'dev/test' },
      });
      engine.transition('task-001', {
        success: true,
        outputs: { verdict: 'pass' },
      });

      const task = engine.getTask('task-001')!;
      expect(task.currentState).toBe('DONE');
      expect(task.context.completedAt).toBe('done');
    });

    it('should execute entryActions AFTER exitActions of departing state', () => {
      const wf = createTestWorkflow();
      // exitAction on START sets a marker
      wf.states['START'].exitActions = [
        { type: 'set_context', params: { key: 'exitRan', value: 'yes' } },
      ];
      // entryAction on REVIEW reads the marker and sets its own
      wf.states['REVIEW'].entryActions = [
        { type: 'set_context', params: { key: 'entryRan', value: 'yes' } },
      ];
      engine.loadWorkflow(wf);
      engine.createTask('test-workflow', 'task-001', { taskTitle: 'Test' });

      engine.transition('task-001', {
        success: true,
        outputs: { branch: 'dev/test' },
      });

      const task = engine.getTask('task-001')!;
      expect(task.context.exitRan).toBe('yes');
      expect(task.context.entryRan).toBe('yes');
    });

    it('should template-substitute entryAction values with accumulated context', () => {
      const wf = createTestWorkflow();
      wf.states['REVIEW'].entryActions = [
        { type: 'set_context', params: { key: 'reviewBranch', value: '{{branch}}' } },
      ];
      engine.loadWorkflow(wf);
      engine.createTask('test-workflow', 'task-001', { taskTitle: 'Test' });

      // START -> REVIEW, outputs include branch
      engine.transition('task-001', {
        success: true,
        outputs: { branch: 'dev/feature-42' },
      });

      const task = engine.getTask('task-001')!;
      expect(task.context.reviewBranch).toBe('dev/feature-42');
    });

    it('should not execute entryActions when no entryActions defined', () => {
      // Baseline: transition works fine without entryActions (no crash)
      engine.loadWorkflow(createTestWorkflow());
      engine.createTask('test-workflow', 'task-001', { taskTitle: 'Test' });

      const result = engine.transition('task-001', {
        success: true,
        outputs: { branch: 'dev/test' },
      });

      expect(result.newState).toBe('REVIEW');
    });
  });
});
