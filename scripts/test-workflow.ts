#!/usr/bin/env tsx
/**
 * Simple Workflow Test Runner
 * 
 * Test workflows locally without full smoke test infrastructure.
 * Single-agent mode with minimal setup.
 * 
 * Usage:
 *   npx tsx scripts/test-workflow.ts workflows/hello-world.workflow.json \
 *     --task "Create a hello.py file" \
 *     --workspace ./test-workspace
 * 
 * This creates a minimal environment, runs the workflow, and reports results.
 * For multi-agent workflows, use the full smoke test infrastructure.
 */

import { readFile, mkdir, writeFile, rm } from 'fs/promises';
import { WorkflowEngine } from '../src/workflow-engine.js';
import { WorkflowAssignment, TaskState } from '../src/workflow-types.js';
import pino from 'pino';
import path from 'path';
import { existsSync } from 'fs';

interface TestOptions {
  workflowFile: string;
  taskPrompt: string;
  workspace: string;
  role?: string;
  verbose?: boolean;
  skipCleanup?: boolean;
  context?: Record<string, string>;
}

/**
 * Parse command line arguments
 */
function parseArgs(): TestOptions | null {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log('');
    console.log('Simple Workflow Test Runner');
    console.log('===========================');
    console.log('');
    console.log('Test workflows locally without full smoke test setup.');
    console.log('');
    console.log('Usage:');
    console.log('  npx tsx scripts/test-workflow.ts <workflow.json> --task "Description" [options]');
    console.log('');
    console.log('Required:');
    console.log('  workflow.json           Path to workflow definition file');
    console.log('  --task "description"    Task description to execute');
    console.log('');
    console.log('Options:');
    console.log('  --workspace <path>      Workspace directory (default: ./test-workspace)');
    console.log('  --role <role>           Agent role to simulate (default: developer)');
    console.log('  --verbose               Show detailed logs');
    console.log('  --skip-cleanup          Keep workspace after test');
    console.log('  --context key=value     Add context variables (can repeat)');
    console.log('');
    console.log('Examples:');
    console.log('  # Basic test');
    console.log('  npx tsx scripts/test-workflow.ts workflows/hello-world.workflow.json \\');
    console.log('    --task "Create hello.py that prints Hello World"');
    console.log('');
    console.log('  # With custom workspace and context');
    console.log('  npx tsx scripts/test-workflow.ts workflows/dev-qa-merge.workflow.json \\');
    console.log('    --task "Add tests for user module" \\');
    console.log('    --workspace ./my-test \\');
    console.log('    --context projectPath=my-test/project \\');
    console.log('    --skip-cleanup');
    console.log('');
    console.log('Notes:');
    console.log('  • Single-agent simulation only (no mailbox coordination)');
    console.log('  • State transitions are automatic (not manual like real workflows)');
    console.log('  • For multi-agent workflows, use smoke tests (smoke_tests/)');
    console.log('');
    return null;
  }

  const workflowFile = args[0];
  if (!workflowFile || !workflowFile.endsWith('.json')) {
    console.error('Error: First argument must be a workflow JSON file');
    return null;
  }

  const taskIndex = args.indexOf('--task');
  if (taskIndex === -1 || taskIndex === args.length - 1) {
    console.error('Error: --task flag required with a description');
    return null;
  }
  const taskPrompt = args[taskIndex + 1];

  const workspaceIndex = args.indexOf('--workspace');
  const workspace = workspaceIndex !== -1 && workspaceIndex < args.length - 1
    ? args[workspaceIndex + 1]
    : './test-workspace';

  const roleIndex = args.indexOf('--role');
  const role = roleIndex !== -1 && roleIndex < args.length - 1
    ? args[roleIndex + 1]
    : 'developer';

  const verbose = args.includes('--verbose');
  const skipCleanup = args.includes('--skip-cleanup');

  // Parse context variables
  const context: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--context' && i < args.length - 1) {
      const contextArg = args[i + 1];
      const [key, ...valueParts] = contextArg.split('=');
      if (key && valueParts.length > 0) {
        context[key] = valueParts.join('=');
      }
    }
  }

  return {
    workflowFile,
    taskPrompt,
    workspace,
    role,
    verbose,
    skipCleanup,
    context
  };
}

/**
 * Setup test workspace
 */
async function setupWorkspace(workspace: string): Promise<void> {
  // Clean if exists
  if (existsSync(workspace)) {
    await rm(workspace, { recursive: true, force: true });
  }

  // Create structure
  await mkdir(path.join(workspace, 'project'), { recursive: true });
  await mkdir(path.join(workspace, 'tasks'), { recursive: true });
  
  console.log(`📁 Created workspace: ${workspace}`);
}

/**
 * Cleanup test workspace
 */
async function cleanupWorkspace(workspace: string): Promise<void> {
  if (existsSync(workspace)) {
    await rm(workspace, { recursive: true, force: true });
    console.log(`🧹 Cleaned up workspace: ${workspace}`);
  }
}

/**
 * Simulate workflow execution
 */
async function runWorkflowTest(opts: TestOptions): Promise<boolean> {
  const logger = pino({
    level: opts.verbose ? 'debug' : 'info',
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname'
      }
    }
  });

  console.log('');
  console.log('═'.repeat(80));
  console.log('🧪 Workflow Test Runner');
  console.log('═'.repeat(80));
  console.log('');

  try {
    // Load workflow
    console.log(`📋 Loading workflow: ${opts.workflowFile}`);
    const workflowContent = await readFile(opts.workflowFile, 'utf-8');
    const workflowDef = JSON.parse(workflowContent);
    
    const engine = new WorkflowEngine(logger);
    await engine.loadWorkflow(workflowDef);
    
    console.log(`   Workflow: ${workflowDef.name} (${workflowDef.id})`);
    console.log(`   States: ${Object.keys(workflowDef.states).length}`);
    console.log(`   Initial: ${workflowDef.initialState}`);
    console.log('');

    // Setup workspace
    await setupWorkspace(opts.workspace);
    console.log('');

    // Build context
    const context = {
      projectPath: path.join(opts.workspace, 'project'),
      taskDescription: opts.taskPrompt,
      ...opts.context
    };

    // Create task
    console.log('🎯 Creating task...');
    console.log(`   Task: ${opts.taskPrompt}`);
    console.log(`   Role: ${opts.role}`);
    console.log(`   Context: ${JSON.stringify(context, null, 2).replace(/\n/g, '\n   ')}`);
    console.log('');

    const taskState = engine.createTask(
      workflowDef.id,
      '001-test-task',
      opts.taskPrompt,
      context
    );

    console.log('▶️  Executing workflow...');
    console.log('');

    // Simulate state execution
    // NOTE: This is a simplified simulation. Real execution happens in the agent
    // with LLM calls. This just validates the state machine structure.
    
    let currentState = taskState.currentState;
    let iterations = 0;
    const maxIterations = 20; // Prevent infinite loops
    const visitedStates: string[] = [currentState];

    while (iterations < maxIterations) {
      iterations++;
      
      const stateDef = workflowDef.states[currentState];
      if (!stateDef) {
        console.error(`❌ State "${currentState}" not found in workflow!`);
        return false;
      }

      console.log(`  State ${iterations}: ${stateDef.name} (${currentState})`);
      console.log(`    Role: ${stateDef.role}`);
      console.log(`    Tools: ${stateDef.allowedTools.length > 0 ? stateDef.allowedTools.join(', ') : 'none'}`);
      
      // Check if terminal
      if (workflowDef.terminalStates.includes(currentState)) {
        console.log(`    ✓ Terminal state reached`);
        console.log('');
        break;
      }

      // Simulate success transition (in real workflow, LLM determines this)
      const nextState = stateDef.transitions.onSuccess;
      if (!nextState) {
        console.error(`    ❌ No success transition defined`);
        return false;
      }

      console.log(`    → Transition to: ${nextState}`);
      console.log('');

      currentState = nextState;
      visitedStates.push(currentState);

      // Detect loops
      const stateCount = visitedStates.filter(s => s === currentState).length;
      if (stateCount > 3) {
        console.error(`❌ Detected potential infinite loop at state "${currentState}"`);
        return false;
      }
    }

    if (iterations >= maxIterations) {
      console.error(`❌ Exceeded maximum iterations (${maxIterations})`);
      return false;
    }

    // Success
    console.log('═'.repeat(80));
    console.log('✅ Workflow Test PASSED');
    console.log('═'.repeat(80));
    console.log('');
    console.log(`States visited: ${visitedStates.join(' → ')}`);
    console.log(`Total transitions: ${iterations}`);
    console.log('');
    console.log('💡 This was a STRUCTURAL test (state machine validation).');
    console.log('   For actual LLM execution, run the agent with this workflow.');
    console.log('   See: smoke_tests/ for complete examples.');
    console.log('');

    return true;

  } catch (error: any) {
    console.error('');
    console.error('❌ Test FAILED');
    console.error('');
    console.error(`Error: ${error.message}`);
    if (opts.verbose && error.stack) {
      console.error('');
      console.error('Stack trace:');
      console.error(error.stack);
    }
    console.error('');
    return false;
  }
}

/**
 * Main entry point
 */
async function main() {
  const opts = parseArgs();
  if (!opts) {
    process.exit(1);
  }

  try {
    const success = await runWorkflowTest(opts);
    
    if (!opts.skipCleanup) {
      console.log('');
      await cleanupWorkspace(opts.workspace);
    } else {
      console.log('');
      console.log(`📁 Workspace preserved: ${opts.workspace}`);
    }
    console.log('');

    process.exit(success ? 0 : 1);

  } catch (error: any) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
}

main();
