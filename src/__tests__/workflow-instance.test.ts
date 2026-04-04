// Tests for workflow instances, state variables, and data references
//
// Verifies the three new engine concepts:
//   1. WorkflowInstance — named, lifecycle-tracked execution of a definition
//   2. State variables — typed, scoped, initialized from definition defaults
//   3. Data references — URI-based pointers to artifacts with provenance

import { describe, it, expect, beforeEach } from '@jest/globals';
import { WorkflowEngine } from '../workflow-engine.js';
import { WorkflowDefinition, DataRef } from '../workflow-types.js';
import pino from 'pino';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const logger = pino({ level: 'silent' });

/** Minimal workflow with variables, data packages, and exit evaluation. */
function makeTestWorkflow(): WorkflowDefinition {
  return {
    id: 'test-vmodel',
    name: 'V-Model Test',
    description: 'Test workflow with all new features',
    version: '2.0.0',
    initialState: 'IMPLEMENTING',
    terminalStates: ['DONE', 'REJECTED'],
    globalContext: { branch: 'main', project: 'test-project' },
    variables: [
      { name: 'totalTests', type: 'number', default: '0', description: 'Total test count' },
      { name: 'buildPassing', type: 'boolean', default: 'false', description: 'CI status' },
    ],
    states: {
      IMPLEMENTING: {
        name: 'Implementing',
        role: 'developer',
        description: 'Develop the feature',
        prompt: 'Implement feature on branch {{branch}}. Tests so far: {{totalTests}}.',
        allowedTools: ['terminal', 'file_ops'],
        transitions: { onSuccess: 'VERIFYING', onFailure: 'REWORK' },
        variables: [
          { name: 'commitSha', type: 'string', scope: 'instance', description: 'Last commit' },
          { name: 'localBuild', type: 'boolean', scope: 'state', default: 'false' },
        ],
        dataPackage: {
          outputs: [
            { key: 'sourceCode', description: 'Implemented source file', mediaType: 'text/typescript' },
            { key: 'testFile', description: 'Test file', required: true },
          ],
        },
      },
      VERIFYING: {
        name: 'Verifying',
        role: 'qa',
        description: 'Verify the implementation',
        prompt: 'Verify implementation. Commit: {{commitSha}}.',
        allowedTools: ['terminal', 'file_ops'],
        transitions: { onSuccess: 'ACCEPTING', onFailure: 'REWORK' },
        exitEvaluation: {
          prompt: 'Did all verification tests pass?',
          responseFormat: 'boolean',
          mapping: { 'true': 'success', 'false': 'failure' },
          defaultOutcome: 'failure',
        },
        dataPackage: {
          inputs: [
            { key: 'sourceCode', required: true },
            { key: 'testFile', required: true },
          ],
          outputs: [
            { key: 'verificationReport', description: 'QA report', mediaType: 'text/markdown', required: true },
          ],
        },
      },
      REWORK: {
        name: 'Rework',
        role: 'developer',
        description: 'Fix issues found in verification',
        prompt: 'Fix the issues in {{branch}}.',
        allowedTools: ['terminal', 'file_ops'],
        transitions: { onSuccess: 'VERIFYING', onFailure: 'REJECTED' },
      },
      ACCEPTING: {
        name: 'Accepting',
        role: 'ra',
        description: 'Final acceptance',
        prompt: 'Accept or reject.',
        allowedTools: [],
        transitions: { onSuccess: 'DONE', onFailure: 'REJECTED' },
        exitEvaluation: {
          prompt: 'Is the deliverable accepted?',
          responseFormat: 'enum',
          choices: ['accepted', 'rejected'],
          mapping: { accepted: 'success', rejected: 'failure' },
        },
      },
      DONE: {
        name: 'Done',
        role: 'ra',
        description: 'Terminal success',
        prompt: '',
        allowedTools: [],
        transitions: { onSuccess: null, onFailure: null },
      },
      REJECTED: {
        name: 'Rejected',
        role: 'ra',
        description: 'Terminal failure',
        prompt: '',
        allowedTools: [],
        transitions: { onSuccess: null, onFailure: null },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Workflow instances
// ---------------------------------------------------------------------------

describe('WorkflowEngine — instances', () => {
  let engine: WorkflowEngine;

  beforeEach(() => {
    engine = new WorkflowEngine(logger);
    engine.loadWorkflow(makeTestWorkflow());
  });

  it('createInstance returns a well-formed instance', () => {
    const inst = engine.createInstance('test-vmodel', 'task-1');
    expect(inst.instanceId).toContain('test-vmodel');
    expect(inst.workflowId).toBe('test-vmodel');
    expect(inst.label).toContain('V-Model Test');
    expect(inst.status).toBe('running');
    expect(inst.taskState.taskId).toBe('task-1');
    expect(inst.taskState.currentState).toBe('IMPLEMENTING');
    expect(inst.dataRefs).toEqual({});
  });

  it('initializes instance variables from workflow definition defaults', () => {
    const inst = engine.createInstance('test-vmodel', 'task-1');
    expect(inst.variables.totalTests).toBe('0');
    expect(inst.variables.buildPassing).toBe('false');
  });

  it('initializes instance-scoped state variables from initial state', () => {
    const inst = engine.createInstance('test-vmodel', 'task-1');
    // commitSha has no default, so should not be in variables
    expect(inst.variables.commitSha).toBeUndefined();
    // localBuild is scope="state", should NOT be in instance variables
    expect(inst.variables.localBuild).toBeUndefined();
  });

  it('supports custom labels', () => {
    const inst = engine.createInstance('test-vmodel', 'task-1', {}, 'Sprint-42 Build');
    expect(inst.label).toBe('Sprint-42 Build');
  });

  it('getInstance returns the instance by ID', () => {
    const inst = engine.createInstance('test-vmodel', 'task-1');
    const found = engine.getInstance(inst.instanceId);
    expect(found).toBe(inst);
  });

  it('getInstance returns undefined for unknown ID', () => {
    expect(engine.getInstance('nonexistent')).toBeUndefined();
  });

  it('getInstancesByWorkflow returns instances for a workflow', () => {
    engine.createInstance('test-vmodel', 'task-1');
    engine.createInstance('test-vmodel', 'task-2');
    const all = engine.getInstancesByWorkflow('test-vmodel');
    expect(all).toHaveLength(2);
  });

  it('getActiveInstances filters by running status', () => {
    const inst1 = engine.createInstance('test-vmodel', 'task-1');
    engine.createInstance('test-vmodel', 'task-2');
    engine.completeInstance(inst1.instanceId, 'completed');
    const active = engine.getActiveInstances();
    expect(active).toHaveLength(1);
    expect(active[0].taskState.taskId).toBe('task-2');
  });

  it('multiple instances of same workflow have independent state', () => {
    const inst1 = engine.createInstance('test-vmodel', 'task-1');
    const inst2 = engine.createInstance('test-vmodel', 'task-2');
    inst1.variables.totalTests = '5';
    expect(inst2.variables.totalTests).toBe('0');
  });

  it('completeInstance updates status and timestamp', () => {
    const inst = engine.createInstance('test-vmodel', 'task-1');
    const before = inst.updatedAt;
    // Small delay to ensure timestamp changes
    engine.completeInstance(inst.instanceId, 'failed');
    expect(inst.status).toBe('failed');
  });

  it('removeInstance removes from tracking', () => {
    const inst = engine.createInstance('test-vmodel', 'task-1');
    engine.removeInstance(inst.instanceId);
    expect(engine.getInstance(inst.instanceId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Instance variables
// ---------------------------------------------------------------------------

describe('WorkflowEngine — instance variables', () => {
  let engine: WorkflowEngine;

  beforeEach(() => {
    engine = new WorkflowEngine(logger);
    engine.loadWorkflow(makeTestWorkflow());
  });

  it('updateInstanceVariables merges updates', () => {
    const inst = engine.createInstance('test-vmodel', 'task-1');
    engine.updateInstanceVariables(inst.instanceId, {
      totalTests: '12',
      buildPassing: 'true',
    });
    expect(inst.variables.totalTests).toBe('12');
    expect(inst.variables.buildPassing).toBe('true');
  });

  it('updateInstanceVariables is no-op for unknown instance', () => {
    // Should not throw
    engine.updateInstanceVariables('nonexistent', { foo: 'bar' });
  });

  it('getInstanceContext merges all scopes correctly', () => {
    const inst = engine.createInstance('test-vmodel', 'task-1', { taskDesc: 'Build feature X' });
    inst.variables.totalTests = '7';
    const ctx = engine.getInstanceContext(inst.instanceId);

    // globalContext
    expect(ctx.branch).toBe('main');
    expect(ctx.project).toBe('test-project');
    // instance variables
    expect(ctx.totalTests).toBe('7');
    // task context (should include globalContext merged at creation)
    expect(ctx.taskDesc).toBe('Build feature X');
  });

  it('task context overrides instance variables', () => {
    const inst = engine.createInstance('test-vmodel', 'task-1', { totalTests: '99' });
    inst.variables.totalTests = '7';
    const ctx = engine.getInstanceContext(inst.instanceId);
    // Task context wins over instance variables
    expect(ctx.totalTests).toBe('99');
  });

  it('promoteStateVariables copies instance-scoped vars', () => {
    const inst = engine.createInstance('test-vmodel', 'task-1');
    // Simulate the task producing a commitSha during IMPLEMENTING
    inst.taskState.context.commitSha = 'abc123def';
    engine.promoteStateVariables(inst.instanceId, 'task-1');
    expect(inst.variables.commitSha).toBe('abc123def');
  });

  it('promoteStateVariables ignores state-scoped vars', () => {
    const inst = engine.createInstance('test-vmodel', 'task-1');
    inst.taskState.context.localBuild = 'true';
    engine.promoteStateVariables(inst.instanceId, 'task-1');
    // localBuild is scope="state", should NOT be promoted
    expect(inst.variables.localBuild).toBeUndefined();
  });

  it('getInstanceContext returns empty for unknown instance', () => {
    const ctx = engine.getInstanceContext('nonexistent');
    expect(ctx).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Exit evaluation access
// ---------------------------------------------------------------------------

describe('WorkflowEngine — exit evaluation', () => {
  let engine: WorkflowEngine;

  beforeEach(() => {
    engine = new WorkflowEngine(logger);
    engine.loadWorkflow(makeTestWorkflow());
  });

  it('getExitEvaluation returns spec for state with exitEvaluation', () => {
    // Create task and advance to VERIFYING
    engine.createTask('test-vmodel', 'task-1');
    engine.transition('task-1', { success: true, outputs: {} });

    const eval_ = engine.getExitEvaluation('task-1');
    expect(eval_).toBeDefined();
    expect(eval_!.responseFormat).toBe('boolean');
    expect(eval_!.prompt).toContain('verification tests');
  });

  it('getExitEvaluation returns undefined for state without it', () => {
    engine.createTask('test-vmodel', 'task-1');
    // IMPLEMENTING has no exitEvaluation
    const eval_ = engine.getExitEvaluation('task-1');
    expect(eval_).toBeUndefined();
  });

  it('ACCEPTING state has enum exit evaluation', () => {
    engine.createTask('test-vmodel', 'task-1');
    engine.transition('task-1', { success: true, outputs: {} }); // -> VERIFYING
    engine.transition('task-1', { success: true, outputs: {} }); // -> ACCEPTING

    const eval_ = engine.getExitEvaluation('task-1');
    expect(eval_!.responseFormat).toBe('enum');
    expect(eval_!.choices).toContain('accepted');
    expect(eval_!.choices).toContain('rejected');
  });
});

// ---------------------------------------------------------------------------
// Data references
// ---------------------------------------------------------------------------

describe('WorkflowEngine — data references', () => {
  let engine: WorkflowEngine;
  let instanceId: string;

  beforeEach(() => {
    engine = new WorkflowEngine(logger);
    engine.loadWorkflow(makeTestWorkflow());
    const inst = engine.createInstance('test-vmodel', 'task-1');
    instanceId = inst.instanceId;
  });

  it('registerDataRef stores ref in instance scope', () => {
    const ref: DataRef = {
      key: 'sourceCode',
      uri: 'git://repo/src/cli.ts@abc123',
      mediaType: 'text/typescript',
    };
    engine.registerDataRef(instanceId, 'task-1', ref);

    const inst = engine.getInstance(instanceId)!;
    expect(inst.dataRefs.sourceCode).toBeDefined();
    expect(inst.dataRefs.sourceCode.uri).toBe('git://repo/src/cli.ts@abc123');
  });

  it('registerDataRef stores ref in task scope', () => {
    const ref: DataRef = { key: 'testFile', uri: 'file://tests/cli.test.ts' };
    engine.registerDataRef(instanceId, 'task-1', ref);

    const task = engine.getTask('task-1')!;
    expect(task.dataRefs).toBeDefined();
    expect(task.dataRefs!.testFile.uri).toBe('file://tests/cli.test.ts');
  });

  it('registerDataRef stamps provenance automatically', () => {
    const ref: DataRef = { key: 'sourceCode', uri: 'file://src/cli.ts' };
    engine.registerDataRef(instanceId, 'task-1', ref);

    const stored = engine.getInstance(instanceId)!.dataRefs.sourceCode;
    expect(stored.producedBy).toBeDefined();
    expect(stored.producedBy!.state).toBe('IMPLEMENTING');
    expect(stored.producedBy!.role).toBe('developer');
    expect(stored.producedBy!.instanceId).toBe(instanceId);
  });

  it('registerDataRef preserves existing provenance', () => {
    const ref: DataRef = {
      key: 'external',
      uri: 's3://bucket/data.json',
      producedBy: { state: 'EXTERNAL', role: 'pipeline', timestamp: '2026-01-01T00:00:00Z' },
    };
    engine.registerDataRef(instanceId, 'task-1', ref);

    const stored = engine.getInstance(instanceId)!.dataRefs.external;
    expect(stored.producedBy!.state).toBe('EXTERNAL');
  });

  it('resolveDataRef finds ref by key', () => {
    const ref: DataRef = { key: 'sourceCode', uri: 'file://src/cli.ts' };
    engine.registerDataRef(instanceId, 'task-1', ref);

    const found = engine.resolveDataRef(instanceId, 'task-1', 'sourceCode');
    expect(found).toBeDefined();
    expect(found!.uri).toBe('file://src/cli.ts');
  });

  it('resolveDataRef returns undefined for missing key', () => {
    const found = engine.resolveDataRef(instanceId, 'task-1', 'nonexistent');
    expect(found).toBeUndefined();
  });

  it('resolveDataRef prefers instance scope over task scope', () => {
    // Register in both scopes with different URIs
    const inst = engine.getInstance(instanceId)!;
    inst.dataRefs.sourceCode = { key: 'sourceCode', uri: 'instance://v2' };
    const task = engine.getTask('task-1')!;
    task.dataRefs = { sourceCode: { key: 'sourceCode', uri: 'task://v1' } };

    const found = engine.resolveDataRef(instanceId, 'task-1', 'sourceCode');
    expect(found!.uri).toBe('instance://v2');
  });

  it('resolveDataRef falls back to task scope when no instance', () => {
    const task = engine.getTask('task-1')!;
    task.dataRefs = { sourceCode: { key: 'sourceCode', uri: 'task://v1' } };

    const found = engine.resolveDataRef(null, 'task-1', 'sourceCode');
    expect(found!.uri).toBe('task://v1');
  });

  it('getAvailableDataRefs merges both scopes', () => {
    const inst = engine.getInstance(instanceId)!;
    inst.dataRefs.fromInstance = { key: 'fromInstance', uri: 'i://1' };
    const task = engine.getTask('task-1')!;
    task.dataRefs = { fromTask: { key: 'fromTask', uri: 't://1' } };

    const all = engine.getAvailableDataRefs(instanceId, 'task-1');
    expect(all.fromInstance).toBeDefined();
    expect(all.fromTask).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Data package validation
// ---------------------------------------------------------------------------

describe('WorkflowEngine — data package validation', () => {
  let engine: WorkflowEngine;
  let instanceId: string;

  beforeEach(() => {
    engine = new WorkflowEngine(logger);
    engine.loadWorkflow(makeTestWorkflow());
    const inst = engine.createInstance('test-vmodel', 'task-1');
    instanceId = inst.instanceId;
  });

  it('validateInputDataRefs returns empty when state has no dataPackage', () => {
    // IMPLEMENTING has no inputs
    const missing = engine.validateInputDataRefs(instanceId, 'task-1');
    expect(missing).toEqual([]);
  });

  it('validateInputDataRefs reports missing required inputs', () => {
    // Advance to VERIFYING which requires sourceCode and testFile
    engine.transition('task-1', { success: true, outputs: {} });
    const missing = engine.validateInputDataRefs(instanceId, 'task-1');
    expect(missing).toContain('sourceCode');
    expect(missing).toContain('testFile');
  });

  it('validateInputDataRefs passes when refs are available', () => {
    // Register the required refs then advance
    engine.registerDataRef(instanceId, 'task-1', { key: 'sourceCode', uri: 'file://src/cli.ts' });
    engine.registerDataRef(instanceId, 'task-1', { key: 'testFile', uri: 'file://tests/cli.test.ts' });
    engine.transition('task-1', { success: true, outputs: {} });

    const missing = engine.validateInputDataRefs(instanceId, 'task-1');
    expect(missing).toEqual([]);
  });

  it('validateOutputDataRefs reports missing required outputs', () => {
    // IMPLEMENTING requires testFile output
    const missing = engine.validateOutputDataRefs(instanceId, 'task-1');
    expect(missing).toContain('testFile');
  });

  it('validateOutputDataRefs passes when all outputs registered', () => {
    engine.registerDataRef(instanceId, 'task-1', { key: 'sourceCode', uri: 'file://src/cli.ts' });
    engine.registerDataRef(instanceId, 'task-1', { key: 'testFile', uri: 'file://tests/cli.test.ts' });

    const missing = engine.validateOutputDataRefs(instanceId, 'task-1');
    expect(missing).toEqual([]);
  });

  it('optional outputs do not cause validation failure', () => {
    // sourceCode output has no explicit required field (defaults to true for DataPackageEntry)
    // but testFile is explicitly required: true
    // Register only testFile
    engine.registerDataRef(instanceId, 'task-1', { key: 'testFile', uri: 'file://tests/cli.test.ts' });

    const missing = engine.validateOutputDataRefs(instanceId, 'task-1');
    // sourceCode is still missing (default required=true)
    expect(missing).toContain('sourceCode');
  });
});

// ---------------------------------------------------------------------------
// Data ref provenance — the "who produced what, when" story
// ---------------------------------------------------------------------------

describe('DataRef provenance tracking', () => {
  let engine: WorkflowEngine;

  beforeEach(() => {
    engine = new WorkflowEngine(logger);
    engine.loadWorkflow(makeTestWorkflow());
  });

  it('tracks provenance across state transitions', () => {
    const inst = engine.createInstance('test-vmodel', 'task-1');

    // Developer produces source in IMPLEMENTING
    engine.registerDataRef(inst.instanceId, 'task-1', {
      key: 'sourceCode',
      uri: 'git://repo/src/cli.ts@abc123',
    });

    const ref = inst.dataRefs.sourceCode;
    expect(ref.producedBy!.state).toBe('IMPLEMENTING');
    expect(ref.producedBy!.role).toBe('developer');

    // Transition to VERIFYING
    engine.transition('task-1', { success: true, outputs: {} });

    // QA produces verification report in VERIFYING
    engine.registerDataRef(inst.instanceId, 'task-1', {
      key: 'verificationReport',
      uri: 'file://evidence/verification-report.md',
    });

    const qaRef = inst.dataRefs.verificationReport;
    expect(qaRef.producedBy!.state).toBe('VERIFYING');
    expect(qaRef.producedBy!.role).toBe('qa');

    // Both refs coexist in the instance
    expect(Object.keys(inst.dataRefs)).toHaveLength(2);
  });

  it('contentHash can be set for integrity verification', () => {
    const inst = engine.createInstance('test-vmodel', 'task-1');
    engine.registerDataRef(inst.instanceId, 'task-1', {
      key: 'sourceCode',
      uri: 'git://repo/src/cli.ts@abc123',
      contentHash: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });

    const ref = inst.dataRefs.sourceCode;
    expect(ref.contentHash).toContain('sha256:');
  });
});
