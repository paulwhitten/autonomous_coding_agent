// Generate .github/copilot-instructions.md from role definitions and config
// CRITICAL: Follow GitHub Copilot best practices - instructions must be "no longer than 2 pages"
// Source: https://docs.github.com/en/copilot/customizing-copilot/adding-custom-instructions-for-github-copilot

import { readFile, writeFile, mkdir, access } from 'fs/promises';
import path from 'path';
import Handlebars from 'handlebars';
import { AgentConfig } from './types.js';

interface RoleDefinition {
  name: string;
  description: string;
  primaryResponsibilities?: string[];
  typicalTasks?: string[];
  notYourJob?: string[];
  escalationTriggers?: string[];
  workingStyle?: {
    principle: string;
    guidelines: string[];
  };
  communicationFormat?: string[];
  // QA-specific fields (from roles.json)
  coreWorkflow?: string[];
  whatBelongsOnTheBranch?: {
    commitToRepo: string[];
    doesNotBelongInTheRepo: string[];
  };
}

/**
 * Schema for optional custom_instructions.json overlay.
 * Fields are per-project / per-agent customizations that get
 * merged on top of the base role definition from roles.json.
 */
interface CustomInstructions {
  gitWorkflow?: {
    [role: string]: {
      description: string;
      steps: string[];
      rules: string[];
    };
  };
  codingStandards?: {
    language: string;
    description?: string;
    preCommitChecklist?: string[];
    sections?: Record<string, string[]>;
  };
  buildSystem?: {
    buildCommand?: string;
    testCommand?: string;
    lintCommand?: string;
    formatCommand?: string;
  };
  projectContext?: string[];
  additionalSections?: Array<{
    title: string;
    items: string[];
  }>;
  testStandards?: {
    description?: string;
    structure?: string[];
    minimumCases?: string[];
    rules?: string[];
  };
  preSubmissionChecklist?: {
    description?: string;
    checks?: string[];
  };
  verificationChecklist?: {
    description?: string;
    codeQuality?: string[];
    testQuality?: string[];
    traceability?: string[];
  };
  rejectionCriteria?: {
    description?: string;
    blockingIssues?: string[];
  };
  rustQualityGates?: {
    description: string;
    steps: Array<{
      command: string;
      interpret: string;
    }>;
    coverageReview?: string[];
    codingStandardChecks?: string[];
  };
}

/**
 * Load role definitions from roles.json
 */
async function loadRoleDefinitions(rolesFile: string): Promise<Record<string, RoleDefinition>> {
  const content = await readFile(rolesFile, 'utf-8');
  return JSON.parse(content);
}

/**
 * Load optional custom_instructions.json.
 * Returns null if the file does not exist.
 */
async function loadCustomInstructions(customPath: string): Promise<CustomInstructions | null> {
  try {
    await access(customPath);
    const content = await readFile(customPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;  // File not found or invalid -- custom instructions are optional
  }
}

/**
 * Resolve the path to custom_instructions.json.
 * Priority: config.agent.customInstructionsFile > convention (same dir as roleDefinitionsFile).
 */
function resolveCustomInstructionsPath(config: AgentConfig): string {
  if (config.agent.customInstructionsFile) {
    return path.resolve(config.agent.customInstructionsFile);
  }
  // Convention: look for custom_instructions.json next to the config
  // (i.e., the directory that contains roles.json or the agent config dir)
  const rolesFile = config.agent.roleDefinitionsFile || './roles.json';
  return path.resolve(path.dirname(rolesFile), 'custom_instructions.json');
}

/**
 * Generate .github/copilot-instructions.md for the agent's role
 * Following GitHub Copilot best practices: "no longer than 2 pages"
 */
export async function generateCopilotInstructions(
  config: AgentConfig,
  projectRoot: string = '.'
): Promise<void> {
  
  // Load role definitions (path should be set by caller or use default)
  const rolesFile = config.agent.roleDefinitionsFile || path.resolve('./roles.json');
  const roles = await loadRoleDefinitions(rolesFile);
  const role = config.agent.role;
  const roleInfo = roles[role];
  
  if (!roleInfo) {
    throw new Error(`Role '${role}' not found in ${rolesFile}`);
  }
  
  // Load optional custom instructions overlay
  const customPath = resolveCustomInstructionsPath(config);
  const custom = await loadCustomInstructions(customPath);
  
  const hostname = config.agent.hostname === 'auto-detect' 
    ? (await import('os')).hostname()
    : config.agent.hostname;
  const agentId = `${hostname}_${role}`;
  
  // Load concise template.
  // Resolve relative to the package root using process.cwd().
  // The agent process always launches from the package directory, and
  // the Jest runner does the same, so this is reliable in both contexts.
  const templatePath = path.resolve(
    process.cwd(),
    'templates/concise-instructions.md',
  );
  const templateContent = await readFile(templatePath, 'utf-8');
  const template = Handlebars.compile(templateContent, { noEscape: true });
  
  // Extract role-specific git workflow from custom instructions
  const gitWorkflow = custom?.gitWorkflow?.[role] || null;
  
  // Prepare template data
  const data = {
    agentRole: roleInfo.name,
    agentId: agentId,
    hostname: hostname,
    managerHostname: config.manager?.hostname ?? hostname,
    managerRole: config.manager?.role ?? 'manager',
    checkIntervalMinutes: config.agent.checkIntervalMs / 60000,
    stuckTimeoutMinutes: config.agent.stuckTimeoutMs / 60000,
    sdkTimeoutSeconds: config.agent.sdkTimeoutMs / 1000,
    mailboxPath: config.mailbox.repoPath,
    primaryResponsibilities: roleInfo.primaryResponsibilities || roleInfo.coreWorkflow || [],
    notYourJob: roleInfo.notYourJob || [],
    whatBelongsOnTheBranch: roleInfo.whatBelongsOnTheBranch || null,
    isManager: role === 'manager',
    isQA: role === 'qa',
    isDeveloper: role === 'developer',
    taskDescription: 'your-task',
    // Custom instructions overlay (project-specific)
    gitWorkflow: gitWorkflow,
    codingStandards: custom?.codingStandards || null,
    testStandards: custom?.testStandards || null,
    preSubmissionChecklist: custom?.preSubmissionChecklist || null,
    buildSystem: custom?.buildSystem || null,
    projectContext: custom?.projectContext || null,
    additionalSections: custom?.additionalSections || null,
    verificationChecklist: custom?.verificationChecklist || null,
    rejectionCriteria: custom?.rejectionCriteria || null,
    rustQualityGates: custom?.rustQualityGates || null,
  };
  
  const instructions = template(data);
  
  // Write to .github/copilot-instructions.md
  const githubDir = path.resolve(projectRoot, '.github');
  const instructionsFile = path.join(githubDir, 'copilot-instructions.md');
  
  await mkdir(githubDir, { recursive: true });
  await writeFile(instructionsFile, instructions, 'utf-8');
  
  const customLabel = custom ? ` + custom_instructions from ${customPath}` : '';
  console.log(`Generated: ${instructionsFile} (concise, under 2 pages${customLabel})`);
}
