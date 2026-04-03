#!/usr/bin/env tsx
// workflow-to-mermaid.ts
//
// Reads a .workflow.json file and generates a Mermaid state diagram.
// Useful for visually validating workflow definitions.
//
// Usage:
//   npx tsx scripts/workflow-to-mermaid.ts workflows/dev-qa-merge.workflow.json
//   npx tsx scripts/workflow-to-mermaid.ts workflows/*.workflow.json
//   npx tsx scripts/workflow-to-mermaid.ts --all
//
// Output goes to stdout (pipe to .md or paste into a Mermaid renderer).

import { readFile, readdir } from 'fs/promises';
import { resolve, basename, join } from 'path';

// -------------------------------------------------------------------------
// Types (subset of workflow-types.ts -- duplicated here to keep the script
// self-contained and runnable without building the full project)
// -------------------------------------------------------------------------
interface StateTransitions {
  onSuccess: string | null;
  onFailure: string | null;
}

interface StateDefinition {
  name: string;
  role: string;
  description: string;
  allowedTools: string[];
  transitions: StateTransitions;
  maxRetries?: number;
}

interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  version: string;
  initialState: string;
  terminalStates: string[];
  states: Record<string, StateDefinition>;
}

// -------------------------------------------------------------------------
// Role-to-color mapping for state styling
// -------------------------------------------------------------------------
const ROLE_STYLES: Record<string, { fill: string; stroke: string; color: string }> = {
  manager:   { fill: '#4a90d9', stroke: '#2c5f9e', color: '#fff' },
  developer: { fill: '#50c878', stroke: '#2e8b57', color: '#fff' },
  qa:        { fill: '#f0ad4e', stroke: '#c7962c', color: '#000' },
};

function roleStyle(role: string): string {
  const s = ROLE_STYLES[role] ?? { fill: '#999', stroke: '#666', color: '#fff' };
  return `fill:${s.fill},stroke:${s.stroke},color:${s.color}`;
}

// -------------------------------------------------------------------------
// Core generation
// -------------------------------------------------------------------------
export function workflowToMermaid(def: WorkflowDefinition): string {
  const lines: string[] = [];

  lines.push('stateDiagram-v2');
  lines.push(`    direction TB`);
  lines.push('');

  // -- Initial transition
  lines.push(`    [*] --> ${def.initialState}`);
  lines.push('');

  // -- State definitions with descriptions (role annotation)
  const stateKeys = Object.keys(def.states);
  for (const key of stateKeys) {
    const st = def.states[key];
    const retryNote = st.maxRetries != null ? ` [max ${st.maxRetries} retries]` : '';
    lines.push(`    ${key} : ${st.name} (${st.role})${retryNote}`);
  }
  lines.push('');

  // -- Transitions
  const edgesSeen = new Set<string>();
  for (const key of stateKeys) {
    const st = def.states[key];
    const { onSuccess, onFailure } = st.transitions;

    if (onSuccess !== null) {
      const edge = `${key}-->${onSuccess}`;
      if (!edgesSeen.has(edge)) {
        lines.push(`    ${key} --> ${onSuccess} : success`);
        edgesSeen.add(edge);
      }
    }

    if (onFailure !== null && onFailure !== key) {
      const edge = `${key}-->${onFailure}`;
      if (!edgesSeen.has(edge)) {
        lines.push(`    ${key} --> ${onFailure} : failure`);
        edgesSeen.add(edge);
      }
    } else if (onFailure === key) {
      // Self-loop (retry in same state)
      const noteId = `note_${key}`;
      lines.push(`    note right of ${key}`);
      lines.push(`        Retries in same state on failure`);
      lines.push(`    end note`);
    }
  }
  lines.push('');

  // -- Terminal transitions
  for (const terminal of def.terminalStates) {
    if (def.states[terminal]) {
      lines.push(`    ${terminal} --> [*]`);
    }
  }
  lines.push('');

  // -- Styling by role
  const roleGroups: Record<string, string[]> = {};
  for (const key of stateKeys) {
    const role = def.states[key].role;
    (roleGroups[role] ??= []).push(key);
  }

  // classDef and class assignments
  const roles = Object.keys(roleGroups);
  for (const role of roles) {
    const style = roleStyle(role);
    lines.push(`    classDef ${role} ${style}`);
  }
  for (const role of roles) {
    for (const key of roleGroups[role]) {
      lines.push(`    class ${key} ${role}`);
    }
  }

  return lines.join('\n');
}

// -------------------------------------------------------------------------
// Markdown wrapper (renders nice output with title, description, legend)
// -------------------------------------------------------------------------
export function workflowToMarkdown(def: WorkflowDefinition): string {
  const diagram = workflowToMermaid(def);

  const sections: string[] = [];
  sections.push(`## ${def.name}`);
  sections.push('');
  sections.push(`**ID:** \`${def.id}\`  `);
  sections.push(`**Version:** ${def.version}  `);
  sections.push(`**Description:** ${def.description}`);
  sections.push('');

  // Legend
  sections.push('### Role Legend');
  sections.push('');
  sections.push('| Color | Role |');
  sections.push('|-------|------|');
  const rolesUsed = [...new Set(Object.values(def.states).map(s => s.role))];
  for (const role of rolesUsed) {
    const s = ROLE_STYLES[role];
    const swatch = s ? s.fill : '#999';
    sections.push(`| ![${role}](https://via.placeholder.com/15/${swatch.slice(1)}/${swatch.slice(1)}.png) | ${role} |`);
  }
  sections.push('');

  // State table
  sections.push('### States');
  sections.push('');
  sections.push('| State | Role | Description | Success -> | Failure -> | Retries |');
  sections.push('|-------|------|-------------|-----------|-----------|---------|');
  for (const [key, st] of Object.entries(def.states)) {
    const suc = st.transitions.onSuccess ?? '(terminal)';
    const fail = st.transitions.onFailure ?? '(terminal)';
    const retries = st.maxRetries ?? '-';
    sections.push(`| ${key} | ${st.role} | ${st.description.split('.')[0]} | ${suc} | ${fail} | ${retries} |`);
  }
  sections.push('');

  // Mermaid diagram
  sections.push('### State Diagram');
  sections.push('');
  sections.push('```mermaid');
  sections.push(diagram);
  sections.push('```');

  return sections.join('\n');
}

// -------------------------------------------------------------------------
// CLI
// -------------------------------------------------------------------------
async function loadWorkflow(filePath: string): Promise<WorkflowDefinition> {
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content) as WorkflowDefinition;
}

async function findAllWorkflows(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries
    .filter(e => e.endsWith('.workflow.json'))
    .map(e => join(dir, e))
    .sort();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const scriptDir = new URL('.', import.meta.url).pathname;
  const workflowsDir = resolve(scriptDir, '..', 'workflows');

  let files: string[] = [];

  if (args.length === 0 || args.includes('--all')) {
    files = await findAllWorkflows(workflowsDir);
    if (files.length === 0) {
      console.error(`No .workflow.json files found in ${workflowsDir}`);
      process.exit(1);
    }
  } else {
    for (const arg of args) {
      files.push(resolve(arg));
    }
  }

  const outputs: string[] = [];
  outputs.push('# Workflow State Diagrams');
  outputs.push('');
  outputs.push(`Generated: ${new Date().toISOString().slice(0, 10)}`);
  outputs.push('');

  for (const filePath of files) {
    try {
      const def = await loadWorkflow(filePath);
      outputs.push(workflowToMarkdown(def));
      outputs.push('');
      outputs.push('---');
      outputs.push('');
    } catch (err) {
      console.error(`Error processing ${basename(filePath)}: ${err}`);
      process.exit(1);
    }
  }

  console.log(outputs.join('\n'));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
