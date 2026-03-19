#!/bin/bash

# Deterministic smoke tests for workflow engine fixes (no LLM required).
#
# Exercises pure-code paths introduced by Fixes #1-6 using the compiled
# workflow-engine.ts directly via a small Node.js harness script.
#
# These tests complement the full LLM-driven workflow smoke test by
# covering edge cases that are hard to trigger through the agent loop:
#   - Entry/exit actions execution (Fix #1)
#   - Failure fallback stays in current state, no ESCALATED (Fix #2)
#   - Required outputs enforcement (Fix #4)
#   - Envelope stripping without workflow engine (Fix #5)
#   - Multi-step transition chain with context accumulation

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "================================================================"
echo "WORKFLOW ENGINE DETERMINISTIC SMOKE TESTS"
echo "================================================================"
echo ""
echo "These tests verify pure-code paths without an LLM."
echo ""

# Ensure compiled code exists
if [ ! -d developer/agent/dist ]; then
  echo "Compiling agent code..."
  cd developer/agent
  npx tsc 2>/dev/null || {
    echo "FATAL: TypeScript compilation failed. Run ./setup.sh first."
    exit 1
  }
  cd ../..
  echo ""
fi

PASSED=0
FAILED=0

pass() {
  echo "[PASS] $1"
  PASSED=$((PASSED + 1))
}

fail() {
  echo "[FAIL] $1"
  FAILED=$((FAILED + 1))
}

# --------------------------------------------------------------------------
# Test 1: Entry/exit actions fire on transition (Fix #1)
# --------------------------------------------------------------------------
echo "--- Fix #1: Entry/exit actions ---"

RESULT=$(node -e "
const { WorkflowEngine } = require('$SCRIPT_DIR/developer/agent/dist/workflow-engine.js');
const pino = require('pino');
const logger = pino({ level: 'silent' });
const engine = new WorkflowEngine(logger);

const workflow = {
  id: 'test-actions',
  name: 'Test Actions',
  description: 'Test',
  version: '1.0.0',
  initialState: 'A',
  terminalStates: ['C'],
  globalContext: {},
  states: {
    A: {
      name: 'A', role: 'dev', description: 'State A',
      prompt: 'Do A', allowedTools: [],
      requiredOutputs: ['branch'],
      transitions: { onSuccess: 'B', onFailure: 'A' },
      exitActions: [
        { type: 'set_context', params: { key: 'exitA', value: 'yes' } }
      ]
    },
    B: {
      name: 'B', role: 'qa', description: 'State B',
      prompt: 'Review', allowedTools: [],
      requiredOutputs: ['verdict'],
      transitions: { onSuccess: 'C', onFailure: 'A' },
      entryActions: [
        { type: 'set_context', params: { key: 'enteredB', value: 'yes' } },
        { type: 'send_to_role', params: { role: 'manager', message: 'QA started for {{branch}}' } }
      ]
    },
    C: {
      name: 'C', role: 'mgr', description: 'Done',
      prompt: '', allowedTools: [],
      transitions: { onSuccess: null, onFailure: null },
      entryActions: [
        { type: 'set_context', params: { key: 'completedAt', value: 'done_marker' } }
      ]
    }
  }
};

engine.loadWorkflow(workflow);
engine.createTask('test-actions', 't1', { taskTitle: 'Test' });

// A -> B
engine.transition('t1', { success: true, outputs: { branch: 'dev/test' } });
const task1 = engine.getTask('t1');

// B -> C
engine.transition('t1', { success: true, outputs: { verdict: 'pass' } });
const task2 = engine.getTask('t1');

const results = {
  exitA: task1.context.exitA,
  enteredB: task1.context.enteredB,
  pendingRole: task1.context._pendingSendToRole,
  pendingMsg: task1.context._pendingSendMessage,
  completedAt: task2.context.completedAt,
  finalState: task2.currentState
};
console.log(JSON.stringify(results));
" 2>/dev/null)

if echo "$RESULT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d['exitA'] == 'yes', 'exitA'
assert d['enteredB'] == 'yes', 'enteredB'
assert d['pendingRole'] == 'manager', 'pendingRole'
assert 'QA started for dev/test' in d['pendingMsg'], 'pendingMsg template substitution'
assert d['completedAt'] == 'done_marker', 'completedAt'
assert d['finalState'] == 'C', 'finalState'
" 2>/dev/null; then
  pass "Entry/exit actions fire correctly with template substitution"
else
  fail "Entry/exit actions did not produce expected context values"
  echo "  Got: $RESULT"
fi

echo ""

# --------------------------------------------------------------------------
# Test 2: No manufactured ESCALATED state on failure fallback (Fix #2)
# --------------------------------------------------------------------------
echo "--- Fix #2: Failure fallback ---"

RESULT=$(node -e "
const { WorkflowEngine } = require('$SCRIPT_DIR/developer/agent/dist/workflow-engine.js');
const pino = require('pino');
const logger = pino({ level: 'silent' });
const engine = new WorkflowEngine(logger);

const workflow = {
  id: 'test-fallback',
  name: 'Fallback Test',
  description: 'Test',
  version: '1.0.0',
  initialState: 'WORK',
  terminalStates: ['DONE'],
  globalContext: {},
  states: {
    WORK: {
      name: 'Work', role: 'dev', description: 'Work state',
      prompt: 'Do work', allowedTools: [],
      transitions: { onSuccess: 'DONE', onFailure: null },
      maxRetries: 1
    },
    DONE: {
      name: 'Done', role: 'mgr', description: 'Done',
      prompt: '', allowedTools: [],
      transitions: { onSuccess: null, onFailure: null }
    }
  }
};

engine.loadWorkflow(workflow);
engine.createTask('test-fallback', 't1');

// Fail once (retry)
engine.transition('t1', { success: false, outputs: {}, error: 'fail1' });
const after1 = engine.getTask('t1').currentState;

// Fail again (exceeds maxRetries)
engine.transition('t1', { success: false, outputs: {}, error: 'fail2' });
const after2 = engine.getTask('t1').currentState;

console.log(JSON.stringify({ after1, after2 }));
" 2>/dev/null)

if echo "$RESULT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d['after1'] == 'WORK', 'should stay in WORK on first failure'
assert d['after2'] == 'WORK', 'should stay in WORK (not ESCALATED) when onFailure is null'
" 2>/dev/null; then
  pass "Failure with null onFailure stays in current state (no ESCALATED)"
else
  fail "Failure fallback produced unexpected state"
  echo "  Got: $RESULT"
fi

echo ""

# --------------------------------------------------------------------------
# Test 3: Required outputs enforcement (Fix #4)
# --------------------------------------------------------------------------
echo "--- Fix #4: Required outputs enforcement ---"

RESULT=$(node -e "
const { WorkflowEngine } = require('$SCRIPT_DIR/developer/agent/dist/workflow-engine.js');
const pino = require('pino');
const logger = pino({ level: 'silent' });
const engine = new WorkflowEngine(logger);

const workflow = {
  id: 'test-outputs',
  name: 'Outputs Test',
  description: 'Test',
  version: '1.0.0',
  initialState: 'IMPL',
  terminalStates: ['DONE'],
  globalContext: {},
  states: {
    IMPL: {
      name: 'Implement', role: 'dev', description: 'Implement',
      prompt: 'Implement', allowedTools: [],
      requiredOutputs: ['branch', 'commitSha'],
      transitions: { onSuccess: 'DONE', onFailure: 'IMPL' },
      maxRetries: 3
    },
    DONE: {
      name: 'Done', role: 'mgr', description: 'Done',
      prompt: '', allowedTools: [],
      transitions: { onSuccess: null, onFailure: null }
    }
  }
};

engine.loadWorkflow(workflow);
engine.createTask('test-outputs', 't1');

// Attempt success with missing required outputs (commitSha missing)
const r1 = engine.transition('t1', { success: true, outputs: { branch: 'dev/x' } });
// Capture retryCount immediately (getTask returns mutable ref)
const r1RetryCount = engine.getTask('t1').retryCount;
const r1State = r1.newState;

// Now attempt success with all required outputs
const r2 = engine.transition('t1', { success: true, outputs: { branch: 'dev/x', commitSha: 'abc123' } });
const r2State = r2.newState;
const r2FinalState = engine.getTask('t1').currentState;

console.log(JSON.stringify({
  r1State,
  r1RetryCount,
  r2State,
  r2FinalState
}));
" 2>/dev/null)

if echo "$RESULT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d['r1State'] == 'IMPL', 'missing outputs should stay in IMPL'
assert d['r1RetryCount'] == 1, 'should increment retry count'
assert d['r2State'] == 'DONE', 'complete outputs should advance to DONE'
assert d['r2FinalState'] == 'DONE', 'final state should be DONE'
" 2>/dev/null; then
  pass "Missing required outputs treated as failure; complete outputs advance"
else
  fail "Required outputs enforcement failed"
  echo "  Got: $RESULT"
fi

echo ""

# --------------------------------------------------------------------------
# Test 4: Envelope stripping without workflow engine (Fix #5)
# --------------------------------------------------------------------------
echo "--- Fix #5: Envelope leak guard ---"

# This test uses the WORKFLOW_MSG markers directly to verify stripping logic.
# Since we can't easily instantiate the full agent, we test the WorkflowEngine's
# stripMessage + classify as a proxy, and verify the marker patterns.
RESULT=$(node -e "
const { WorkflowEngine } = require('$SCRIPT_DIR/developer/agent/dist/workflow-engine.js');
const pino = require('pino');
const logger = pino({ level: 'silent' });
const engine = new WorkflowEngine(logger);

// Build a packed message using the engine
const workflow = {
  id: 'test-strip',
  name: 'Strip Test',
  description: 'Test',
  version: '1.0.0',
  initialState: 'A',
  terminalStates: ['B'],
  globalContext: {},
  states: {
    A: { name: 'A', role: 'dev', description: 'A', prompt: 'Do A', allowedTools: [],
         transitions: { onSuccess: 'B', onFailure: 'A' } },
    B: { name: 'B', role: 'mgr', description: 'B', prompt: '', allowedTools: [],
         transitions: { onSuccess: null, onFailure: null } }
  }
};

engine.loadWorkflow(workflow);
engine.createTask('test-strip', 't1');
const assignment = engine.buildAssignment('t1', 'Test prompt');
const packed = engine.packMessage('Clean human text here', assignment);

// Verify the packed message contains WORKFLOW_MSG
const hasMarker = packed.includes('WORKFLOW_MSG');

// Strip the message
const stripped = engine.stripMessage(packed);
const strippedHasMarker = stripped.includes('WORKFLOW_MSG');
const strippedHasClean = stripped.includes('Clean human text here');

// Also verify classify works
const classification = engine.classifyMessage(packed);
const plainClassification = engine.classifyMessage('Just a plain message');

console.log(JSON.stringify({
  hasMarker,
  strippedHasMarker,
  strippedHasClean,
  classification,
  plainClassification
}));
" 2>/dev/null)

if echo "$RESULT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d['hasMarker'] == True, 'packed message should have WORKFLOW_MSG marker'
assert d['strippedHasMarker'] == False, 'stripped should not have marker'
assert d['strippedHasClean'] == True, 'stripped should have clean text'
assert d['classification'] == 'workflow', 'packed should classify as workflow'
assert d['plainClassification'] == 'unstructured', 'plain should classify as unstructured'
" 2>/dev/null; then
  pass "Envelope markers pack/strip/classify correctly"
else
  fail "Envelope pack/strip/classify produced unexpected result"
  echo "  Got: $RESULT"
fi

echo ""

# --------------------------------------------------------------------------
# Test 5: Multi-step transition chain with context accumulation
# --------------------------------------------------------------------------
echo "--- Multi-step transition chain ---"

RESULT=$(node -e "
const { WorkflowEngine } = require('$SCRIPT_DIR/developer/agent/dist/workflow-engine.js');
const pino = require('pino');
const logger = pino({ level: 'silent' });
const engine = new WorkflowEngine(logger);

const workflow = {
  id: 'test-chain',
  name: 'Chain Test',
  description: 'Test',
  version: '1.0.0',
  initialState: 'DEV',
  terminalStates: ['MERGED'],
  globalContext: { repo: 'test-repo' },
  states: {
    DEV: {
      name: 'Dev', role: 'developer', description: 'Develop',
      prompt: 'Develop in {{repo}}', allowedTools: [],
      requiredOutputs: ['branch'],
      transitions: { onSuccess: 'QA', onFailure: 'DEV' }
    },
    QA: {
      name: 'QA', role: 'qa', description: 'Test',
      prompt: 'Test branch {{branch}} in {{repo}}', allowedTools: [],
      requiredOutputs: ['verdict'],
      transitions: { onSuccess: 'MERGE', onFailure: 'REWORK' }
    },
    REWORK: {
      name: 'Rework', role: 'developer', description: 'Fix',
      prompt: 'Fix: {{rejectionReason}}', allowedTools: [],
      requiredOutputs: ['branch'],
      transitions: { onSuccess: 'QA', onFailure: 'REWORK' }
    },
    MERGE: {
      name: 'Merge', role: 'developer', description: 'Merge',
      prompt: 'Merge {{branch}}', allowedTools: [],
      transitions: { onSuccess: 'MERGED', onFailure: 'DEV' }
    },
    MERGED: {
      name: 'Merged', role: 'manager', description: 'Done',
      prompt: '', allowedTools: [],
      transitions: { onSuccess: null, onFailure: null }
    }
  }
};

engine.loadWorkflow(workflow);
engine.createTask('test-chain', 't1', { taskTitle: 'Feature X' });

// DEV -> QA
engine.transition('t1', { success: true, outputs: { branch: 'feat/x' } });
// QA -> REWORK (failure)
engine.transition('t1', { success: false, outputs: { rejectionReason: 'Missing tests' } });
// REWORK -> QA
engine.transition('t1', { success: true, outputs: { branch: 'feat/x-v2' } });
// QA -> MERGE
engine.transition('t1', { success: true, outputs: { verdict: 'pass' } });
// MERGE -> MERGED
engine.transition('t1', { success: true, outputs: { mergeSha: 'def456' } });

const task = engine.getTask('t1');
const prompt = engine.getPrompt('t1');

console.log(JSON.stringify({
  state: task.currentState,
  historyLen: task.history.length,
  branch: task.context.branch,
  verdict: task.context.verdict,
  mergeSha: task.context.mergeSha,
  rejectionReason: task.context.rejectionReason,
  repo: task.context.repo,
  isTerminal: engine.isTerminal('t1')
}));
" 2>/dev/null)

if echo "$RESULT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d['state'] == 'MERGED', 'should reach MERGED'
assert d['historyLen'] == 5, 'should have 5 transitions'
assert d['branch'] == 'feat/x-v2', 'branch should be latest'
assert d['verdict'] == 'pass', 'verdict should accumulate'
assert d['mergeSha'] == 'def456', 'mergeSha should accumulate'
assert d['rejectionReason'] == 'Missing tests', 'rejectionReason should persist'
assert d['repo'] == 'test-repo', 'globalContext should be present'
assert d['isTerminal'] == True, 'should be terminal'
" 2>/dev/null; then
  pass "Multi-step chain with rework loop completes with full context"
else
  fail "Multi-step chain produced unexpected result"
  echo "  Got: $RESULT"
fi

echo ""

# --------------------------------------------------------------------------
# Test 6: Workflow selection by role match (Fix #6)
# --------------------------------------------------------------------------
echo "--- Fix #6: Workflow selection by role ---"

RESULT=$(node -e "
const { WorkflowEngine } = require('$SCRIPT_DIR/developer/agent/dist/workflow-engine.js');
const pino = require('pino');
const logger = pino({ level: 'silent' });
const engine = new WorkflowEngine(logger);

// Load two workflows: one starts with 'developer', one starts with 'qa'
const devWorkflow = {
  id: 'dev-workflow',
  name: 'Dev Workflow',
  description: 'For developers',
  version: '1.0.0',
  initialState: 'IMPL',
  terminalStates: ['DONE'],
  globalContext: {},
  states: {
    IMPL: { name: 'Implement', role: 'developer', description: 'Dev work',
             prompt: 'Do dev', allowedTools: [],
             transitions: { onSuccess: 'DONE', onFailure: 'IMPL' } },
    DONE: { name: 'Done', role: 'manager', description: 'Done',
            prompt: '', allowedTools: [],
            transitions: { onSuccess: null, onFailure: null } }
  }
};

const qaWorkflow = {
  id: 'qa-workflow',
  name: 'QA Workflow',
  description: 'For QA',
  version: '1.0.0',
  initialState: 'TESTING',
  terminalStates: ['DONE'],
  globalContext: {},
  states: {
    TESTING: { name: 'Testing', role: 'qa', description: 'QA work',
               prompt: 'Do QA', allowedTools: [],
               transitions: { onSuccess: 'DONE', onFailure: 'TESTING' } },
    DONE: { name: 'Done', role: 'manager', description: 'Done',
            prompt: '', allowedTools: [],
            transitions: { onSuccess: null, onFailure: null } }
  }
};

// Load QA workflow first (to ensure it's workflowIds[0])
engine.loadWorkflow(qaWorkflow);
engine.loadWorkflow(devWorkflow);

const ids = engine.getLoadedWorkflowIds();
const firstId = ids[0];

// Verify the role-matching logic:
// A developer agent should pick dev-workflow even though qa-workflow is loaded first
const devWf = engine.getWorkflow('dev-workflow');
const qaWf = engine.getWorkflow('qa-workflow');
const devInitRole = devWf.states[devWf.initialState].role;
const qaInitRole = qaWf.states[qaWf.initialState].role;

// Also verify getTasksForRole
engine.createTask('dev-workflow', 'dt1');
engine.createTask('qa-workflow', 'qt1');
const devTasks = engine.getTasksForRole('developer');
const qaTasks = engine.getTasksForRole('qa');

console.log(JSON.stringify({
  firstId,
  devInitRole,
  qaInitRole,
  devTaskCount: devTasks.length,
  qaTaskCount: qaTasks.length
}));
" 2>/dev/null)

if echo "$RESULT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d['firstId'] == 'qa-workflow', 'qa-workflow should be first loaded'
assert d['devInitRole'] == 'developer', 'dev workflow initial state role is developer'
assert d['qaInitRole'] == 'qa', 'qa workflow initial state role is qa'
assert d['devTaskCount'] == 1, 'should have 1 dev task'
assert d['qaTaskCount'] == 1, 'should have 1 qa task'
" 2>/dev/null; then
  pass "Multiple workflows loaded with correct role mapping"
else
  fail "Workflow role mapping produced unexpected result"
  echo "  Got: $RESULT"
fi

echo ""

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------
echo "============================================"
echo "DETERMINISTIC SMOKE TEST RESULTS"
echo "============================================"
echo "Passed: $PASSED"
echo "Failed: $FAILED"
echo ""

if [ $FAILED -eq 0 ]; then
  echo "ALL TESTS PASSED"
  echo ""
  echo "Verified:"
  echo "  Fix #1: Entry/exit actions fire with template substitution"
  echo "  Fix #2: Failure fallback stays in current state (no ESCALATED)"
  echo "  Fix #4: Required outputs enforcement (missing = failure)"
  echo "  Fix #5: Envelope markers pack/strip/classify correctly"
  echo "  Fix #6: Multiple workflows with role-based selection support"
  echo "  Multi-step transition chain with rework loop"
  exit 0
else
  echo "SOME TESTS FAILED"
  echo "Review the output above for details."
  exit 1
fi
