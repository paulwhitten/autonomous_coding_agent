#!/usr/bin/env tsx
/**
 * Workflow Validation CLI
 * 
 * Usage:
 *   npx tsx scripts/validate-workflow.ts workflows/my-workflow.workflow.json
 *   npx tsx scripts/validate-workflow.ts workflows/*.workflow.json
 * 
 * Validates workflow JSON files against the schema and checks for common errors.
 * Provides helpful, actionable error messages.
 */

import { readFile } from 'fs/promises';
import { WorkflowDefinition, StateDefinition } from '../src/workflow-types.js';
import path from 'path';

interface ValidationError {
  level: 'error' | 'warning';
  field?: string;
  message: string;
  fix?: string;
}

interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
  workflowId?: string;
  workflowName?: string;
}

/**
 * Validate a workflow definition comprehensively
 */
function validateWorkflow(def: any, filepath: string): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  // ============================================================================
  // TOP-LEVEL REQUIRED FIELDS
  // ============================================================================
  const requiredFields = ['id', 'name', 'description', 'version', 'initialState', 'terminalStates', 'globalContext', 'states'];
  for (const field of requiredFields) {
    if (!(field in def)) {
      errors.push({
        level: 'error',
        field,
        message: `Missing required field: "${field}"`,
        fix: `Add "${field}" at the top level of your workflow JSON`
      });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  // ============================================================================
  // ID VALIDATION
  // ============================================================================
  if (typeof def.id !== 'string' || def.id.length === 0) {
    errors.push({
      level: 'error',
      field: 'id',
      message: 'Workflow "id" must be a non-empty string',
      fix: 'Example: "id": "dev-qa-merge"'
    });
  } else if (!/^[a-z0-9][a-z0-9-]*$/.test(def.id)) {
    errors.push({
      level: 'error',
      field: 'id',
      message: `Workflow "id" must be lowercase with hyphens only: "${def.id}"`,
      fix: 'Example: "dev-qa-merge" not "Dev_QA_Merge"'
    });
  }

  // ============================================================================
  // VERSION VALIDATION
  // ============================================================================
  if (typeof def.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(def.version)) {
    errors.push({
      level: 'error',
      field: 'version',
      message: `Version must be semantic version (e.g., "1.0.0"): "${def.version}"`,
      fix: 'Use format: "major.minor.patch" like "1.0.0" or "2.1.3"'
    });
  }

  // ============================================================================
  // STATES VALIDATION
  // ============================================================================
  if (typeof def.states !== 'object' || def.states === null || Array.isArray(def.states)) {
    errors.push({
      level: 'error',
      field: 'states',
      message: '"states" must be an object (not array or null)',
      fix: 'Use: "states": { "STATE_NAME": {...}, "OTHER_STATE": {...} }'
    });
    return { valid: false, errors, warnings };
  }

  const stateNames = Object.keys(def.states);
  if (stateNames.length < 2) {
    errors.push({
      level: 'error',
      field: 'states',
      message: `Workflow must have at least 2 states (found ${stateNames.length})`,
      fix: 'Add at least one working state plus a terminal state (e.g., "DONE")'
    });
  }

  // ============================================================================
  // INITIAL STATE VALIDATION
  // ============================================================================
  if (!stateNames.includes(def.initialState)) {
    errors.push({
      level: 'error',
      field: 'initialState',
      message: `initialState "${def.initialState}" does not exist in states`,
      fix: `Available states: ${stateNames.join(', ')}`
    });
  }

  // ============================================================================
  // TERMINAL STATES VALIDATION
  // ============================================================================
  if (!Array.isArray(def.terminalStates)) {
    errors.push({
      level: 'error',
      field: 'terminalStates',
      message: '"terminalStates" must be an array',
      fix: 'Example: "terminalStates": ["DONE", "ESCALATED"]'
    });
  } else {
    if (def.terminalStates.length === 0) {
      errors.push({
        level: 'error',
        field: 'terminalStates',
        message: 'Must have at least one terminal state',
        fix: 'Add at least one terminal state like "DONE"'
      });
    }

    for (const termState of def.terminalStates) {
      if (!stateNames.includes(termState)) {
        errors.push({
          level: 'error',
          field: 'terminalStates',
          message: `Terminal state "${termState}" does not exist in states`,
          fix: `Available states: ${stateNames.join(', ')}`
        });
      }
    }
  }

  // ============================================================================
  // GLOBAL CONTEXT VALIDATION
  // ============================================================================
  if (typeof def.globalContext !== 'object' || def.globalContext === null || Array.isArray(def.globalContext)) {
    errors.push({
      level: 'error',
      field: 'globalContext',
      message: '"globalContext" must be an object (can be empty: {})',
      fix: 'Use: "globalContext": { "projectPath": "workspace/project" }'
    });
  }

  // ============================================================================
  // PER-STATE VALIDATION
  // ============================================================================
  const stateRequiredFields = ['name', 'role', 'description', 'prompt', 'allowedTools', 'transitions'];
  
  for (const [stateName, state] of Object.entries(def.states)) {
    const stateObj = state as any;
    const isTerminal = def.terminalStates?.includes(stateName);

    // Check required fields
    for (const field of stateRequiredFields) {
      if (!(field in stateObj)) {
        errors.push({
          level: 'error',
          field: `states.${stateName}.${field}`,
          message: `State "${stateName}" missing required field: "${field}"`,
          fix: `Add "${field}" to state "${stateName}"`
        });
      }
    }

    // Validate allowedTools is array
    if ('allowedTools' in stateObj && !Array.isArray(stateObj.allowedTools)) {
      errors.push({
        level: 'error',
        field: `states.${stateName}.allowedTools`,
        message: `State "${stateName}": allowedTools must be an array`,
        fix: 'Use: "allowedTools": ["terminal", "file_ops"] or "allowedTools": []'
      });
    }

    // Validate transitions
    if ('transitions' in stateObj) {
      if (typeof stateObj.transitions !== 'object' || stateObj.transitions === null) {
        errors.push({
          level: 'error',
          field: `states.${stateName}.transitions`,
          message: `State "${stateName}": transitions must be an object`,
          fix: 'Use: "transitions": { "onSuccess": "NEXT_STATE", "onFailure": "ERROR_STATE" }'
        });
      } else {
        // Check onSuccess and onFailure
        if (!('onSuccess' in stateObj.transitions)) {
          errors.push({
            level: 'error',
            field: `states.${stateName}.transitions.onSuccess`,
            message: `State "${stateName}": missing "onSuccess" transition`,
            fix: 'Add: "onSuccess": "NEXT_STATE" or "onSuccess": null for terminal states'
          });
        }
        if (!('onFailure' in stateObj.transitions)) {
          errors.push({
            level: 'error',
            field: `states.${stateName}.transitions.onFailure`,
            message: `State "${stateName}": missing "onFailure" transition`,
            fix: 'Add: "onFailure": "ERROR_STATE" or "onFailure": null for terminal states'
          });
        }

        // Terminal states should have null transitions
        if (isTerminal) {
          if (stateObj.transitions.onSuccess !== null) {
            errors.push({
              level: 'error',
              field: `states.${stateName}.transitions.onSuccess`,
              message: `Terminal state "${stateName}" should have onSuccess: null`,
              fix: 'Change to: "onSuccess": null'
            });
          }
          if (stateObj.transitions.onFailure !== null) {
            errors.push({
              level: 'error',
              field: `states.${stateName}.transitions.onFailure`,
              message: `Terminal state "${stateName}" should have onFailure: null`,
              fix: 'Change to: "onFailure": null'
            });
          }
        } else {
          // Non-terminal states should have non-null transitions
          if (stateObj.transitions.onSuccess === null) {
            warnings.push({
              level: 'warning',
              field: `states.${stateName}.transitions.onSuccess`,
              message: `Non-terminal state "${stateName}" has onSuccess: null (will never transition)`,
              fix: 'Either set a target state or add to terminalStates array'
            });
          }
        }

        // Validate target states exist
        const targets = ['onSuccess', 'onFailure'];
        for (const target of targets) {
          const targetState = stateObj.transitions[target];
          if (targetState !== null && typeof targetState === 'string' && !stateNames.includes(targetState)) {
            errors.push({
              level: 'error',
              field: `states.${stateName}.transitions.${target}`,
              message: `State "${stateName}" transition "${target}" references non-existent state "${targetState}"`,
              fix: `Available states: ${stateNames.join(', ')}`
            });
          }
        }
      }
    }

    // Check for orphaned states (unreachable)
    // We'll do this in a second pass after validating all states
  }

  // ============================================================================
  // REACHABILITY ANALYSIS
  // ============================================================================
  if (errors.length === 0) {
    const reachable = new Set<string>();
    const toVisit = [def.initialState];
    
    while (toVisit.length > 0) {
      const current = toVisit.pop()!;
      if (reachable.has(current)) continue;
      
      reachable.add(current);
      const state = def.states[current];
      
      if (state?.transitions) {
        if (state.transitions.onSuccess && !reachable.has(state.transitions.onSuccess)) {
          toVisit.push(state.transitions.onSuccess);
        }
        if (state.transitions.onFailure && !reachable.has(state.transitions.onFailure)) {
          toVisit.push(state.transitions.onFailure);
        }
      }
    }

    for (const stateName of stateNames) {
      if (!reachable.has(stateName)) {
        warnings.push({
          level: 'warning',
          field: `states.${stateName}`,
          message: `State "${stateName}" is unreachable from initialState`,
          fix: 'Either remove this state or add a transition path to it'
        });
      }
    }
  }

  // ============================================================================
  // SCHEMA REFERENCE VALIDATION
  // ============================================================================
  if (!('$schema' in def)) {
    warnings.push({
      level: 'warning',
      field: '$schema',
      message: 'Missing $schema reference (editor validation disabled)',
      fix: 'Add: "$schema": "./workflow.schema.json" at the top'
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    workflowId: def.id,
    workflowName: def.name
  };
}

/**
 * Pretty print validation results
 */
function printResults(filepath: string, result: ValidationResult): void {
  const filename = path.basename(filepath);
  
  console.log('');
  console.log('═'.repeat(80));
  if (result.workflowName) {
    console.log(`📋 ${result.workflowName} (${result.workflowId})`);
  }
  console.log(`📄 ${filename}`);
  console.log('═'.repeat(80));

  if (result.errors.length === 0 && result.warnings.length === 0) {
    console.log('✅ Workflow is valid!');
    console.log('');
    return;
  }

  // Print errors
  if (result.errors.length > 0) {
    console.log('');
    console.log(`❌ ${result.errors.length} ERROR${result.errors.length > 1 ? 'S' : ''}`);
    console.log('');
    
    for (let i = 0; i < result.errors.length; i++) {
      const err = result.errors[i];
      console.log(`  ${i + 1}. ${err.message}`);
      if (err.field) {
        console.log(`     Field: ${err.field}`);
      }
      if (err.fix) {
        console.log(`     Fix: ${err.fix}`);
      }
      console.log('');
    }
  }

  // Print warnings
  if (result.warnings.length > 0) {
    console.log(`⚠️  ${result.warnings.length} WARNING${result.warnings.length > 1 ? 'S' : ''}`);
    console.log('');
    
    for (let i = 0; i < result.warnings.length; i++) {
      const warn = result.warnings[i];
      console.log(`  ${i + 1}. ${warn.message}`);
      if (warn.field) {
        console.log(`     Field: ${warn.field}`);
      }
      if (warn.fix) {
        console.log(`     Fix: ${warn.fix}`);
      }
      console.log('');
    }
  }

  if (result.valid) {
    console.log('✅ Workflow valid (warnings can be ignored)');
  } else {
    console.log('❌ Workflow has errors - must be fixed before use');
  }
  console.log('');
}

/**
 * Main CLI entry point
 */
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log('');
    console.log('Workflow Validation CLI');
    console.log('=======================');
    console.log('');
    console.log('Usage:');
    console.log('  npx tsx scripts/validate-workflow.ts <workflow-file.json>');
    console.log('  npx tsx scripts/validate-workflow.ts workflows/*.workflow.json');
    console.log('');
    console.log('Examples:');
    console.log('  npx tsx scripts/validate-workflow.ts workflows/dev-qa-merge.workflow.json');
    console.log('  npx tsx scripts/validate-workflow.ts workflows/*.workflow.json');
    console.log('');
    console.log('Validates workflow files against schema and checks for:');
    console.log('  • Missing required fields');
    console.log('  • Invalid field types');
    console.log('  • Non-existent state references');
    console.log('  • Unreachable states');
    console.log('  • Terminal state configuration');
    console.log('');
    process.exit(0);
  }

  let totalValid = 0;
  let totalInvalid = 0;

  for (const filepath of args) {
    try {
      const content = await readFile(filepath, 'utf-8');
      const def = JSON.parse(content);
      const result = validateWorkflow(def, filepath);
      
      printResults(filepath, result);
      
      if (result.valid) {
        totalValid++;
      } else {
        totalInvalid++;
      }
    } catch (error: any) {
      console.log('');
      console.log('═'.repeat(80));
      console.log(`📄 ${path.basename(filepath)}`);
      console.log('═'.repeat(80));
      console.log('');
      console.log('❌ PARSE ERROR');
      console.log('');
      console.log(`  ${error.message}`);
      console.log('');
      if (error.message.includes('JSON')) {
        console.log('  Fix: Check for:');
        console.log('    • Missing or trailing commas');
        console.log('    • Unmatched braces {} or brackets []');
        console.log('    • Unquoted strings');
        console.log('    • Single quotes (use double quotes for JSON)');
        console.log('');
      }
      totalInvalid++;
    }
  }

  // Summary
  if (args.length > 1) {
    console.log('═'.repeat(80));
    console.log(`SUMMARY: ${totalValid} valid, ${totalInvalid} invalid`);
    console.log('═'.repeat(80));
    console.log('');
  }

  process.exit(totalInvalid > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
