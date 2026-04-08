// Runtime JSON Schema validation for agent configuration.
//
// Validates user-supplied config against config.schema.json before
// defaults are applied.  Provides actionable error messages that
// help operators fix typos, invalid values, and unknown fields.

import Ajv, { ErrorObject } from 'ajv';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

// Resolve schema path relative to the project root.
// Returns null when the schema file cannot be found -- validation is skipped.
function resolveSchemaPath(): string | null {
  // Most common: schema lives at the project root (same dir as config.json)
  const fromCwd = path.resolve(process.cwd(), 'config.schema.json');
  if (existsSync(fromCwd)) return fromCwd;

  // Fallback: walk up from the entry script (e.g. dist/index.js -> project root)
  const entryDir = path.dirname(path.resolve(process.argv[1] || '.'));
  let dir = entryDir;
  for (let i = 0; i < 5; i++) {
    const candidate = path.resolve(dir, 'config.schema.json');
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }

  return null;
}

/**
 * Validation result with structured error information.
 */
export interface ConfigValidationResult {
  valid: boolean;
  /** True when schema file was not found and validation was skipped. */
  skipped?: boolean;
  errors: ConfigValidationError[];
}

export interface ConfigValidationError {
  /** Dotted path to the problematic field (e.g., "agent.checkIntervalMs"). */
  path: string;
  /** Human-readable error message. */
  message: string;
  /** The value that failed validation, when available. */
  value?: unknown;
}

/**
 * Format ajv errors into actionable ConfigValidationError objects.
 */
function formatErrors(errors: ErrorObject[]): ConfigValidationError[] {
  return errors.map((err) => {
    // Build a clean dotted path from the instancePath
    const rawPath = err.instancePath.replace(/^\//, '').replace(/\//g, '.');
    const fieldPath = rawPath || '(root)';

    switch (err.keyword) {
      case 'additionalProperties': {
        const extra = (err.params as { additionalProperty: string }).additionalProperty;
        return {
          path: fieldPath ? `${fieldPath}.${extra}` : extra,
          message: `Unknown property "${extra}". Check for typos or refer to config.schema.json.`,
          value: extra,
        };
      }
      case 'enum': {
        const allowed = (err.params as { allowedValues: string[] }).allowedValues;
        return {
          path: fieldPath,
          message: `Invalid value. Allowed values: ${allowed.map(v => `"${v}"`).join(', ')}.`,
          value: err.data,
        };
      }
      case 'type': {
        const expected = (err.params as { type: string }).type;
        return {
          path: fieldPath,
          message: `Expected type "${expected}" but got "${typeof err.data}".`,
          value: err.data,
        };
      }
      case 'minimum': {
        const limit = (err.params as { limit: number }).limit;
        return {
          path: fieldPath,
          message: `Value must be >= ${limit}.`,
          value: err.data,
        };
      }
      case 'required': {
        const missing = (err.params as { missingProperty: string }).missingProperty;
        return {
          path: fieldPath ? `${fieldPath}.${missing}` : missing,
          message: `Required property "${missing}" is missing.`,
        };
      }
      default:
        return {
          path: fieldPath,
          message: err.message || `Validation failed (${err.keyword}).`,
          value: err.data,
        };
    }
  });
}

/**
 * Format validation errors into a multi-line string for logging/display.
 */
export function formatValidationErrors(errors: ConfigValidationError[]): string {
  const lines = errors.map(
    (e, i) => `  ${i + 1}. ${e.path}: ${e.message}${e.value !== undefined ? ` (got: ${JSON.stringify(e.value)})` : ''}`,
  );
  return `Config validation failed:\n${lines.join('\n')}`;
}

// Singleton ajv instance and compiled validator, lazily initialized.
let compiledValidate: ReturnType<Ajv['compile']> | null = null;

/**
 * Load and compile the schema.  Cached after first call.
 * Returns null when config.schema.json is not found.
 */
async function getValidator(): Promise<ReturnType<Ajv['compile']> | null> {
  if (compiledValidate) return compiledValidate;

  const schemaPath = resolveSchemaPath();
  if (!schemaPath) return null;

  const schemaData = await readFile(schemaPath, 'utf-8');
  const schema = JSON.parse(schemaData);

  const ajv = new Ajv({
    allErrors: true,       // Report all errors, not just the first
    verbose: true,         // Include data in error objects
    strict: false,         // Allow draft-07 features like "default"
  });

  compiledValidate = ajv.compile(schema);
  return compiledValidate;
}

/**
 * Validate a user-supplied config object against config.schema.json.
 *
 * Call this BEFORE applyDefaults() -- the schema is designed to validate
 * partial user input (most fields are optional), not the fully merged config.
 *
 * Returns { valid: true, errors: [] } on success, or structured errors
 * that can be formatted with formatValidationErrors().
 */
export async function validateConfig(
  userConfig: Record<string, unknown>,
): Promise<ConfigValidationResult> {
  const validate = await getValidator();

  if (!validate) {
    // Schema file not found -- skip validation gracefully
    return { valid: true, skipped: true, errors: [] };
  }

  const valid = validate(userConfig);

  if (valid) {
    // Run additional semantic checks beyond schema validation
    const semanticErrors = validateSemantics(userConfig);
    if (semanticErrors.length > 0) {
      return { valid: false, errors: semanticErrors };
    }
    return { valid: true, errors: [] };
  }

  return {
    valid: false,
    errors: formatErrors(validate.errors || []),
  };
}

/**
 * Semantic validation checks that go beyond JSON Schema.
 * Validates cross-field consistency, duplicates, and value ranges.
 */
function validateSemantics(config: Record<string, unknown>): ConfigValidationError[] {
  const errors: ConfigValidationError[] = [];

  // Check for duplicate team members
  const teamMembers = config.teamMembers as Array<{ hostname?: string; role?: string }> | undefined;
  if (Array.isArray(teamMembers) && teamMembers.length > 0) {
    const seen = new Set<string>();
    for (let i = 0; i < teamMembers.length; i++) {
      const m = teamMembers[i];
      if (m.hostname && m.role) {
        const key = `${m.hostname}_${m.role}`;
        if (seen.has(key)) {
          errors.push({
            path: `teamMembers[${i}]`,
            message: `Duplicate team member "${m.hostname}" with role "${m.role}".`,
            value: key,
          });
        }
        seen.add(key);
      }
    }
  }

  // Validate A2A server port range
  const communication = config.communication as { a2a?: { serverPort?: number } } | undefined;
  const port = communication?.a2a?.serverPort;
  if (port !== undefined && port !== 0 && (port < 1024 || port > 65535)) {
    errors.push({
      path: 'communication.a2a.serverPort',
      message: 'Server port must be 0 (OS-assigned) or between 1024 and 65535.',
      value: port,
    });
  }

  // Validate agent.wipLimit only applies when role is manager
  const agent = config.agent as { role?: string; wipLimit?: number } | undefined;
  if (agent?.wipLimit && agent.wipLimit > 0 && agent.role && agent.role !== 'manager') {
    errors.push({
      path: 'agent.wipLimit',
      message: `wipLimit is only effective for role "manager" (current role: "${agent.role}").`,
      value: agent.wipLimit,
    });
  }

  return errors;
}

/**
 * Reset the cached validator.  Used in tests to force schema reload.
 */
export function resetValidator(): void {
  compiledValidate = null;
}
