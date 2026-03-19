#!/usr/bin/env tsx
/**
 * Config Validator
 * 
 * Validates config.json structure, types, and references.
 * 
 * Usage:
 *   npx tsx scripts/validate-config.ts [path/to/config.json]
 * 
 * If no path provided, validates ./config.json
 * 
 * Exit codes:
 *   0 - Config is valid
 *   1 - Config has errors
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Type Definitions (based on src/types.ts and src/permission-handler.ts)
// ============================================================================

type PermissionPolicy = 'allow' | 'deny' | 'workingDir' | 'allowlist';
type ValidationMode = 'none' | 'spot_check' | 'milestone' | 'always';
type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type Priority = 'HIGH' | 'NORMAL' | 'LOW';
type Role = 'developer' | 'qa' | 'manager' | 'researcher';

// ============================================================================
// Validation State
// ============================================================================

interface ValidationError {
  field: string;
  message: string;
  fix?: string;
}

interface ValidationResult {
  configPath: string;
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
}

// ============================================================================
// Validators
// ============================================================================

function validateConfig(configPath: string): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  
  // Resolve path
  const resolvedPath = path.resolve(configPath);
  
  // Check file exists
  if (!fs.existsSync(resolvedPath)) {
    errors.push({
      field: 'file',
      message: `Config file not found: ${resolvedPath}`,
      fix: 'Create config file: cp config.example.json config.json'
    });
    return { configPath: resolvedPath, valid: false, errors, warnings };
  }
  
  // Read and parse JSON
  let config: any;
  try {
    const content = fs.readFileSync(resolvedPath, 'utf-8');
    // Strip JSON comments more carefully (line by line to preserve strings)
    const lines = content.split('\n');
    const stripped = lines
      .map(line => {
        // Remove // comments (but be careful not to touch URLs)
        // Look for // that's not inside a string
        let inString = false;
        let escapeNext = false;
        let commentStart = -1;
        
        for (let i = 0; i < line.length; i++) {
          const char = line[i];
          const nextChar = i < line.length - 1 ? line[i + 1] : '';
          
          if (escapeNext) {
            escapeNext = false;
            continue;
          }
          
          if (char === '\\') {
            escapeNext = true;
            continue;
          }
          
          if (char === '"') {
            inString = !inString;
          }
          
          if (!inString && char === '/' && nextChar === '/') {
            commentStart = i;
            break;
          }
        }
        
        if (commentStart >= 0) {
          return line.substring(0, commentStart);
        }
        return line;
      })
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, ''); // Remove /* */ comments
    
    config = JSON.parse(stripped);
  } catch (err: any) {
    errors.push({
      field: 'json',
      message: `Failed to parse JSON: ${err.message}`,
      fix: 'Check for syntax errors, trailing commas, or invalid JSON'
    });
    return { configPath: resolvedPath, valid: false, errors, warnings };
  }
  
  // Validate top-level sections
  validateAgent(config.agent, errors, warnings, path.dirname(resolvedPath));
  validateMailbox(config.mailbox, errors, warnings, path.dirname(resolvedPath));
  validateCopilot(config.copilot, errors, warnings);
  validateWorkspace(config.workspace, errors, warnings, path.dirname(resolvedPath));
  validateLogging(config.logging, errors, warnings, path.dirname(resolvedPath));
  validateManager(config.manager, errors, warnings);
  if (config.quota) {
    validateQuota(config.quota, errors, warnings, path.dirname(resolvedPath));
  }
  
  return {
    configPath: resolvedPath,
    valid: errors.length === 0,
    errors,
    warnings
  };
}

function validateAgent(
  agent: any,
  errors: ValidationError[],
  warnings: ValidationError[],
  configDir: string
): void {
  if (!agent) {
    errors.push({
      field: 'agent',
      message: 'Missing required section: agent',
      fix: 'Add "agent": {...} section to config'
    });
    return;
  }
  
  // Required fields
  requireField('agent.hostname', agent.hostname, 'string', errors);
  requireField('agent.role', agent.role, 'string', errors);
  requireField('agent.checkIntervalMs', agent.checkIntervalMs, 'number', errors);
  requireField('agent.stuckTimeoutMs', agent.stuckTimeoutMs, 'number', errors);
  requireField('agent.sdkTimeoutMs', agent.sdkTimeoutMs, 'number', errors);
  
  // Validate role enum
  if (agent.role) {
    const validRoles: Role[] = ['developer', 'qa', 'manager', 'researcher'];
    if (!validRoles.includes(agent.role)) {
      errors.push({
        field: 'agent.role',
        message: `Invalid role: "${agent.role}"`,
        fix: `Must be one of: ${validRoles.join(', ')}`
      });
    }
  }
  
  // Validate intervals and timeouts
  if (typeof agent.checkIntervalMs === 'number') {
    if (agent.checkIntervalMs < 20000) {
      warnings.push({
        field: 'agent.checkIntervalMs',
        message: `checkIntervalMs is ${agent.checkIntervalMs}ms (below recommended 20000ms)`,
        fix: 'May cause SDK rate-limit errors (HTTP 429). Recommended: 60000ms (60s)'
      });
    }
    if (agent.checkIntervalMs < 1000) {
      errors.push({
        field: 'agent.checkIntervalMs',
        message: `checkIntervalMs too low: ${agent.checkIntervalMs}ms`,
        fix: 'Minimum: 1000ms (1 second)'
      });
    }
  }
  
  if (typeof agent.stuckTimeoutMs === 'number' && agent.stuckTimeoutMs < 60000) {
    warnings.push({
      field: 'agent.stuckTimeoutMs',
      message: `stuckTimeoutMs is ${agent.stuckTimeoutMs}ms (below typical 300000ms)`,
      fix: 'May cause premature stuck detection. Recommended: 300000ms (5 minutes)'
    });
  }
  
  if (typeof agent.sdkTimeoutMs === 'number' && agent.sdkTimeoutMs < 60000) {
    warnings.push({
      field: 'agent.sdkTimeoutMs',
      message: `sdkTimeoutMs is ${agent.sdkTimeoutMs}ms (may be too low for complex tasks)`,
      fix: 'May timeout on long-running operations. Recommended: 300000ms (5 minutes)'
    });
  }
  
  // Validate optional fields
  if (agent.taskRetryCount !== undefined) {
    requireType('agent.taskRetryCount', agent.taskRetryCount, 'number', errors);
    if (typeof agent.taskRetryCount === 'number' && agent.taskRetryCount < 0) {
      errors.push({
        field: 'agent.taskRetryCount',
        message: 'taskRetryCount cannot be negative',
        fix: 'Set to 0 or higher (default: 3)'
      });
    }
  }
  
  if (agent.minWorkItems !== undefined) {
    requireType('agent.minWorkItems', agent.minWorkItems, 'number', errors);
    if (typeof agent.minWorkItems === 'number' && agent.minWorkItems < 1) {
      errors.push({
        field: 'agent.minWorkItems',
        message: 'minWorkItems must be at least 1',
        fix: 'Set to 1 or higher (default: 5)'
      });
    }
  }
  
  if (agent.maxWorkItems !== undefined) {
    requireType('agent.maxWorkItems', agent.maxWorkItems, 'number', errors);
    if (typeof agent.maxWorkItems === 'number' && typeof agent.minWorkItems === 'number') {
      if (agent.maxWorkItems < agent.minWorkItems) {
        errors.push({
          field: 'agent.maxWorkItems',
          message: `maxWorkItems (${agent.maxWorkItems}) < minWorkItems (${agent.minWorkItems})`,
          fix: 'maxWorkItems must be >= minWorkItems'
        });
      }
    }
  }
  
  // Validate roleDefinitionsFile
  if (agent.roleDefinitionsFile) {
    const rolesPath = path.resolve(configDir, agent.roleDefinitionsFile);
    if (!fs.existsSync(rolesPath)) {
      errors.push({
        field: 'agent.roleDefinitionsFile',
        message: `File not found: ${agent.roleDefinitionsFile}`,
        fix: `Create roles file at ${rolesPath}`
      });
    }
  }
  
  // Validate customRolesFile
  if (agent.customRolesFile) {
    const customRolesPath = path.resolve(configDir, agent.customRolesFile);
    if (!fs.existsSync(customRolesPath)) {
      warnings.push({
        field: 'agent.customRolesFile',
        message: `File not found: ${agent.customRolesFile}`,
        fix: `Create custom roles file at ${customRolesPath} or remove this field`
      });
    }
  }
  
  // Validate workflowFile
  if (agent.workflowFile) {
    const workflowPath = path.resolve(configDir, agent.workflowFile);
    if (!fs.existsSync(workflowPath)) {
      errors.push({
        field: 'agent.workflowFile',
        message: `Workflow file not found: ${agent.workflowFile}`,
        fix: `Create workflow file at ${workflowPath} or remove this field`
      });
    } else if (!agent.workflowFile.endsWith('.workflow.json')) {
      warnings.push({
        field: 'agent.workflowFile',
        message: `Workflow file doesn't have .workflow.json extension`,
        fix: 'Rename to use .workflow.json extension for consistency'
      });
    }
  }
  
  // Validate validation section
  if (agent.validation) {
    const val = agent.validation;
    requireField('agent.validation.mode', val.mode, 'string', errors);
    
    if (val.mode) {
      const validModes: ValidationMode[] = ['none', 'spot_check', 'milestone', 'always'];
      if (!validModes.includes(val.mode)) {
        errors.push({
          field: 'agent.validation.mode',
          message: `Invalid validation mode: "${val.mode}"`,
          fix: `Must be one of: ${validModes.join(', ')}`
        });
      }
      
      // Mode-specific validation
      if (val.mode === 'spot_check') {
        requireField('agent.validation.reviewEveryNthItem', val.reviewEveryNthItem, 'number', errors);
        if (typeof val.reviewEveryNthItem === 'number' && val.reviewEveryNthItem < 1) {
          errors.push({
            field: 'agent.validation.reviewEveryNthItem',
            message: 'reviewEveryNthItem must be at least 1',
            fix: 'Set to 1 or higher'
          });
        }
      }
      
      if (val.mode === 'milestone') {
        if (!val.milestones || !Array.isArray(val.milestones)) {
          errors.push({
            field: 'agent.validation.milestones',
            message: 'milestones array required for milestone mode',
            fix: 'Add "milestones": [5, 10, 15] or similar'
          });
        } else if (val.milestones.length === 0) {
          warnings.push({
            field: 'agent.validation.milestones',
            message: 'milestones array is empty',
            fix: 'Add milestone numbers or change mode to "none"'
          });
        }
      }
    }
  }
  
  // Validate timeoutStrategy
  if (agent.timeoutStrategy) {
    const ts = agent.timeoutStrategy;
    if (ts.enabled !== undefined) {
      requireType('agent.timeoutStrategy.enabled', ts.enabled, 'boolean', errors);
    }
    if (ts.tier1_multiplier !== undefined) {
      requireType('agent.timeoutStrategy.tier1_multiplier', ts.tier1_multiplier, 'number', errors);
      if (typeof ts.tier1_multiplier === 'number' && ts.tier1_multiplier <= 1.0) {
        warnings.push({
          field: 'agent.timeoutStrategy.tier1_multiplier',
message: 'tier1_multiplier <= 1.0 will not increase timeout on retry',
          fix: 'Typically 1.5 or higher'
        });
      }
    }
  }
  
  // Validate backpressure
  if (agent.backpressure) {
    const bp = agent.backpressure;
    if (bp.enabled !== undefined) {
      requireType('agent.backpressure.enabled', bp.enabled, 'boolean', errors);
    }
    if (bp.maxPendingWorkItems !== undefined) {
      requireType('agent.backpressure.maxPendingWorkItems', bp.maxPendingWorkItems, 'number', errors);
    }
    if (bp.maxRecipientMailbox !== undefined) {
      requireType('agent.backpressure.maxRecipientMailbox', bp.maxRecipientMailbox, 'number', errors);
    }
  }
}

function validateMailbox(
  mailbox: any,
  errors: ValidationError[],
  warnings: ValidationError[],
  configDir: string
): void {
  if (!mailbox) {
    errors.push({
      field: 'mailbox',
      message: 'Missing required section: mailbox',
      fix: 'Add "mailbox": {...} section to config'
    });
    return;
  }
  
  // Required fields
  requireField('mailbox.repoPath', mailbox.repoPath, 'string', errors);
  requireField('mailbox.gitSync', mailbox.gitSync, 'boolean', errors);
  requireField('mailbox.autoCommit', mailbox.autoCommit, 'boolean', errors);
  requireField('mailbox.commitMessage', mailbox.commitMessage, 'string', errors);
  requireField('mailbox.supportBroadcast', mailbox.supportBroadcast, 'boolean', errors);
  requireField('mailbox.supportAttachments', mailbox.supportAttachments, 'boolean', errors);
  
  // Check mailbox path exists
  if (mailbox.repoPath) {
    const mailboxPath = path.resolve(configDir, mailbox.repoPath);
    if (!fs.existsSync(mailboxPath)) {
      errors.push({
        field: 'mailbox.repoPath',
        message: `Mailbox path not found: ${mailbox.repoPath}`,
        fix: `Create mailbox directory at ${mailboxPath}`
      });
    } else {
      // Check if it's a git repo
      const gitPath = path.join(mailboxPath, '.git');
      if (!fs.existsSync(gitPath) && mailbox.gitSync) {
        warnings.push({
          field: 'mailbox.repoPath',
          message: `Mailbox path is not a git repository but gitSync is enabled`,
          fix: `Run: cd ${mailboxPath} && git init`
        });
      }
    }
  }
  
  // Validate optional fields
  if (mailbox.supportPriority !== undefined) {
    requireType('mailbox.supportPriority', mailbox.supportPriority, 'boolean', errors);
  }
}

function validateCopilot(
  copilot: any,
  errors: ValidationError[],
  warnings: ValidationError[]
): void {
  if (!copilot) {
    errors.push({
      field: 'copilot',
      message: 'Missing required section: copilot',
      fix: 'Add "copilot": {...} section to config'
    });
    return;
  }
  
  // Required fields
  requireField('copilot.model', copilot.model, 'string', errors);
  requireField('copilot.allowedTools', copilot.allowedTools, ['array', 'string'], errors);
  
  // Validate allowedTools
  if (copilot.allowedTools !== undefined) {
    if (typeof copilot.allowedTools === 'string' && copilot.allowedTools !== 'all') {
      errors.push({
        field: 'copilot.allowedTools',
        message: `Invalid allowedTools string: "${copilot.allowedTools}"`,
        fix: 'Use "all" or provide array of tool names: ["tool1", "tool2"]'
      });
    }
    if (Array.isArray(copilot.allowedTools) && copilot.allowedTools.length === 0) {
      warnings.push({
        field: 'copilot.allowedTools',
        message: 'allowedTools array is empty - agent will have no tools',
        fix: 'Add tool names or use "all"'
      });
    }
  }
  
  // Validate permissions
  if (copilot.permissions) {
    const perms = copilot.permissions;
    const validPolicies: PermissionPolicy[] = ['allow', 'deny', 'workingDir', 'allowlist'];
    
    if (perms.shell !== undefined) {
      if (!validPolicies.includes(perms.shell)) {
        errors.push({
          field: 'copilot.permissions.shell',
          message: `Invalid permission policy: "${perms.shell}"`,
          fix: `Must be one of: ${validPolicies.join(', ')}`
        });
      }
    }
    
    if (perms.write !== undefined) {
      if (!['allow', 'deny', 'workingDir'].includes(perms.write)) {
        errors.push({
          field: 'copilot.permissions.write',
          message: `Invalid write policy: "${perms.write}"`,
          fix: 'Must be one of: allow, deny, workingDir'
        });
      }
    }
    
    if (perms.read !== undefined) {
      if (!['allow', 'deny', 'workingDir'].includes(perms.read)) {
        errors.push({
          field: 'copilot.permissions.read',
          message: `Invalid read policy: "${perms.read}"`,
          fix: 'Must be one of: allow, deny, workingDir'
        });
      }
    }
    
    if (perms.url !== undefined) {
      if (!['allow', 'deny'].includes(perms.url)) {
        errors.push({
          field: 'copilot.permissions.url',
          message: `Invalid url policy: "${perms.url}"`,
          fix: 'Must be one of: allow, deny'
        });
      }
    }
    
    if (perms.mcp !== undefined) {
      if (!['allow', 'deny'].includes(perms.mcp)) {
        errors.push({
          field: 'copilot.permissions.mcp',
          message: `Invalid mcp policy: "${perms.mcp}"`,
          fix: 'Must be one of: allow, deny'
        });
      }
    }
    
    if (perms.shellAllowAdditional !== undefined) {
      if (!Array.isArray(perms.shellAllowAdditional)) {
        errors.push({
          field: 'copilot.permissions.shellAllowAdditional',
          message: 'shellAllowAdditional must be an array',
          fix: 'Use: ["command1", "command2"]'
        });
      }
    }
  }
}

function validateWorkspace(
  workspace: any,
  errors: ValidationError[],
  warnings: ValidationError[],
  configDir: string
): void {
  if (!workspace) {
    errors.push({
      field: 'workspace',
      message: 'Missing required section: workspace',
      fix: 'Add "workspace": {...} section to config'
    });
    return;
  }
  
  // Required fields
  requireField('workspace.path', workspace.path, 'string', errors);
  requireField('workspace.persistContext', workspace.persistContext, 'boolean', errors);
  
  // Check workspace path
  if (workspace.path) {
    const workspacePath = path.resolve(configDir, workspace.path);
    if (!fs.existsSync(workspacePath)) {
      warnings.push({
        field: 'workspace.path',
        message: `Workspace path not found: ${workspace.path}`,
        fix: `Will be created at ${workspacePath} on first run`
      });
    }
  }
  
  // Validate optional fields
  if (workspace.tasksFolder !== undefined) {
    requireType('workspace.tasksFolder', workspace.tasksFolder, 'string', errors);
  }
  
  if (workspace.workingFolder !== undefined) {
    requireType('workspace.workingFolder', workspace.workingFolder, 'string', errors);
  }
  
  if (workspace.taskSubfolders) {
    const subs = workspace.taskSubfolders;
    if (subs.pending !== undefined) requireType('workspace.taskSubfolders.pending', subs.pending, 'string', errors);
    if (subs.completed !== undefined) requireType('workspace.taskSubfolders.completed', subs.completed, 'string', errors);
    if (subs.review !== undefined) requireType('workspace.taskSubfolders.review', subs.review, 'string', errors);
    if (subs.failed !== undefined) requireType('workspace.taskSubfolders.failed', subs.failed, 'string', errors);
  }
}

function validateLogging(
  logging: any,
  errors: ValidationError[],
  warnings: ValidationError[],
  configDir: string
): void {
  if (!logging) {
    errors.push({
      field: 'logging',
      message: 'Missing required section: logging',
      fix: 'Add "logging": {...} section to config'
    });
    return;
  }
  
  // Required fields
  requireField('logging.level', logging.level, 'string', errors);
  requireField('logging.path', logging.path, 'string', errors);
  requireField('logging.maxSizeMB', logging.maxSizeMB, 'number', errors);
  
  // Validate level enum
  if (logging.level) {
    const validLevels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    if (!validLevels.includes(logging.level)) {
      errors.push({
        field: 'logging.level',
        message: `Invalid log level: "${logging.level}"`,
        fix: `Must be one of: ${validLevels.join(', ')}`
      });
    }
  }
  
  // Validate maxSizeMB
  if (typeof logging.maxSizeMB === 'number') {
    if (logging.maxSizeMB < 1) {
      errors.push({
        field: 'logging.maxSizeMB',
        message: 'maxSizeMB must be at least 1',
        fix: 'Set to 1 or higher'
      });
    }
    if (logging.maxSizeMB < 10) {
      warnings.push({
        field: 'logging.maxSizeMB',
        message: `maxSizeMB is ${logging.maxSizeMB}MB (may rotate frequently)`,
        fix: 'Recommended: 100MB or higher for autonomous agents'
      });
    }
  }
  
  // Check log directory exists
  if (logging.path) {
    const logPath = path.resolve(configDir, logging.path);
    const logDir = path.dirname(logPath);
    if (!fs.existsSync(logDir)) {
      warnings.push({
        field: 'logging.path',
        message: `Log directory not found: ${path.dirname(logging.path)}`,
        fix: `Will be created at ${logDir} on first run`
      });
    }
  }
}

function validateManager(
  manager: any,
  errors: ValidationError[],
  warnings: ValidationError[]
): void {
  if (!manager) {
    errors.push({
      field: 'manager',
      message: 'Missing required section: manager',
      fix: 'Add "manager": {...} section to config'
    });
    return;
  }
  
  // Required fields
  requireField('manager.hostname', manager.hostname, 'string', errors);
  requireField('manager.role', manager.role, 'string', errors);
  requireField('manager.escalationPriority', manager.escalationPriority, 'string', errors);
  
  // Validate escalation priority
  if (manager.escalationPriority) {
    const validPriorities: Priority[] = ['HIGH', 'NORMAL', 'LOW'];
    if (!validPriorities.includes(manager.escalationPriority)) {
      errors.push({
        field: 'manager.escalationPriority',
        message: `Invalid priority: "${manager.escalationPriority}"`,
        fix: `Must be one of: ${validPriorities.join(', ')}`
      });
    }
  }
}

function validateQuota(
  quota: any,
  errors: ValidationError[],
  warnings: ValidationError[],
  configDir: string
): void {
  // Fields
  requireField('quota.enabled', quota.enabled, 'boolean', errors);
  requireField('quota.preset', quota.preset, 'string', errors);
  
  // Check presets file if specified
  if (quota.presetsFile) {
    const presetsPath = path.resolve(configDir, quota.presetsFile);
    if (!fs.existsSync(presetsPath)) {
      errors.push({
        field: 'quota.presetsFile',
        message: `Presets file not found: ${quota.presetsFile}`,
        fix: `Create presets file at ${presetsPath} or remove this field`
      });
    }
  } else if (quota.enabled) {
    // No presets file but quota enabled
    const defaultPresetsPath = path.resolve(configDir, 'quota-presets.json');
    if (!fs.existsSync(defaultPresetsPath)) {
      warnings.push({
        field: 'quota.presetsFile',
        message: 'quota.enabled but no presetsFile specified',
        fix: 'Add "presetsFile": "./quota-presets.json" or set enabled to false'
      });
    }
  }
  
  // Validate sharedQuotaUrl if present
  if (quota.sharedQuotaUrl !== undefined) {
    requireType('quota.sharedQuotaUrl', quota.sharedQuotaUrl, 'string', errors);
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function requireField(
  field: string,
  value: any,
  type: string | string[],
  errors: ValidationError[]
): void {
  if (value === undefined || value === null) {
    errors.push({
      field,
      message: `Missing required field: ${field}`,
      fix: `Add "${field}" to config`
    });
    return;
  }
  
  requireType(field, value, type, errors);
}

function requireType(
  field: string,
  value: any,
  type: string | string[],
  errors: ValidationError[]
): void {
  const types = Array.isArray(type) ? type : [type];
  const actualType = Array.isArray(value) ? 'array' : typeof value;
  
  if (!types.includes(actualType)) {
    errors.push({
      field,
      message: `Invalid type for ${field}: expected ${types.join(' or ')}, got ${actualType}`,
      fix: `Change to ${types[0]} type`
    });
  }
}

// ============================================================================
// Output Formatting
// ============================================================================

function printResults(result: ValidationResult): void {
  console.log('═'.repeat(80));
  console.log(`📋 Config Validation`);
  console.log(`📄 ${result.configPath}`);
  console.log('═'.repeat(80));
  console.log();
  
  if (result.errors.length === 0 && result.warnings.length === 0) {
    console.log('✅ Config is valid!');
    console.log();
    return;
  }
  
  // Print errors
  if (result.errors.length > 0) {
    console.log(`❌ ${result.errors.length} ERROR${result.errors.length > 1 ? 'S' : ''}`);
    console.log();
    
    for (const error of result.errors) {
      console.log(`  Field: ${error.field}`);
      console.log(`  Error: ${error.message}`);
      if (error.fix) {
        console.log(`  Fix:   ${error.fix}`);
      }
      console.log();
    }
  }
  
  // Print warnings
  if (result.warnings.length > 0) {
    console.log(`⚠️  ${result.warnings.length} WARNING${result.warnings.length > 1 ? 'S' : ''}`);
    console.log();
    
    for (const warning of result.warnings) {
      console.log(`  Field: ${warning.field}`);
      console.log(`  Warning: ${warning.message}`);
      if (warning.fix) {
        console.log(`  Suggestion: ${warning.fix}`);
      }
      console.log();
    }
  }
}

// ============================================================================
// Main
// ============================================================================

function main(): void {
  const args = process.argv.slice(2);
  const configPath = args[0] || './config.json';
  
  console.log();
  const result = validateConfig(configPath);
  printResults(result);
  
  // Exit with appropriate code
  process.exit(result.valid ? 0 : 1);
}

main();
