// JSON Schema validation utilities for the API layer

import Ajv from 'ajv';
import { readFile } from 'fs/promises';
import path from 'path';

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });

let workflowSchema: object | null = null;

export async function loadWorkflowSchema(projectRoot: string): Promise<void> {
  const schemaPath = path.join(projectRoot, 'workflows', 'workflow.schema.json');
  const raw = await readFile(schemaPath, 'utf-8');
  workflowSchema = JSON.parse(raw);
  ajv.addSchema(workflowSchema!, 'workflow');
}

export function validateWorkflow(data: unknown): { valid: boolean; errors: string[] } {
  if (!workflowSchema) {
    return { valid: false, errors: ['Workflow schema not loaded'] };
  }
  const validate = ajv.getSchema('workflow');
  if (!validate) {
    return { valid: false, errors: ['Workflow schema not compiled'] };
  }
  const valid = validate(data) as boolean;
  const errors = valid ? [] : (validate.errors ?? []).map(e => `${e.instancePath} ${e.message}`);
  return { valid, errors };
}

export function validateConfig(data: unknown): { valid: boolean; errors: string[] } {
  // Basic structural validation for agent config
  const errors: string[] = [];
  const cfg = data as Record<string, unknown>;
  if (!cfg.agent) errors.push('Missing required field: agent');
  if (!cfg.mailbox) errors.push('Missing required field: mailbox');
  if (!cfg.copilot) errors.push('Missing required field: copilot');
  if (!cfg.workspace) errors.push('Missing required field: workspace');
  if (!cfg.logging) errors.push('Missing required field: logging');
  return { valid: errors.length === 0, errors };
}
