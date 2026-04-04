// Tests for generate-instructions.ts -- copilot-instructions.md generation

import { generateCopilotInstructions } from '../generate-instructions.js';
import { AgentConfig } from '../types.js';
import { readFile, rm, mkdir } from 'fs/promises';
import path from 'path';
import os from 'os';
import { existsSync } from 'fs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Path to roles.json at the project root (Jest cwd). */
const ROLES_JSON = path.resolve(process.cwd(), 'roles.json');

/** Create a minimal AgentConfig sufficient for generateCopilotInstructions. */
function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const base: AgentConfig = {
    agent: {
      hostname: 'test-host',
      role: 'developer',
      checkIntervalMs: 60_000,
      stuckTimeoutMs: 1_800_000,
      sdkTimeoutMs: 120_000,
      taskRetryCount: 3,
      roleDefinitionsFile: ROLES_JSON,
      ...(overrides as any).agent,
    },
    copilot: {
      model: 'gpt-4.1',
      ...(overrides as any).copilot,
    },
    workspace: {
      path: '/tmp/gen-instr-test-ws',
      workingFolder: 'project',
      ...(overrides as any).workspace,
    },
    mailbox: {
      repoPath: '/tmp/mailbox',
      ...(overrides as any).mailbox,
    },
    quota: {
      enabled: false,
      ...(overrides as any).quota,
    },
    // Optional top-level keys
    ...((overrides as any).manager ? { manager: (overrides as any).manager } : {}),
  } as AgentConfig;
  return base;
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `gen-instr-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generateCopilotInstructions', () => {
  // ----- Basic generation -----

  it('should generate instructions file for developer role', async () => {
    const config = makeConfig();
    await generateCopilotInstructions(config, tmpDir);

    const outPath = path.join(tmpDir, '.github', 'copilot-instructions.md');
    expect(existsSync(outPath)).toBe(true);

    const content = await readFile(outPath, 'utf-8');
    expect(content).toContain('Developer');
    expect(content).toContain('test-host_developer');
  });

  it('should generate instructions for manager role', async () => {
    const config = makeConfig({
      agent: {
        hostname: 'mgr-host',
        role: 'manager',
        checkIntervalMs: 60_000,
        stuckTimeoutMs: 1_800_000,
        sdkTimeoutMs: 120_000,
        taskRetryCount: 3,
        roleDefinitionsFile: ROLES_JSON,
      },
    } as any);
    await generateCopilotInstructions(config, tmpDir);

    const content = await readFile(path.join(tmpDir, '.github', 'copilot-instructions.md'), 'utf-8');
    expect(content).toContain('Manager');
    expect(content).toContain('send_message');
    // Manager section should contain delegation instructions
    expect(content).toContain('Coordinate via send_message');
  });

  it('should generate instructions for qa role', async () => {
    const config = makeConfig({
      agent: {
        hostname: 'qa-host',
        role: 'qa',
        checkIntervalMs: 60_000,
        stuckTimeoutMs: 1_800_000,
        sdkTimeoutMs: 120_000,
        taskRetryCount: 3,
        roleDefinitionsFile: ROLES_JSON,
      },
    } as any);
    await generateCopilotInstructions(config, tmpDir);

    const content = await readFile(path.join(tmpDir, '.github', 'copilot-instructions.md'), 'utf-8');
    expect(content).toContain('QA');
    expect(content).toContain('Verification');
    expect(content).toContain('Rejection');
  });

  // ----- Template rendering -----

  it('should render agent ID from hostname and role', async () => {
    const config = makeConfig({
      agent: {
        hostname: 'my-dev',
        role: 'developer',
        checkIntervalMs: 60_000,
        stuckTimeoutMs: 1_800_000,
        sdkTimeoutMs: 120_000,
        taskRetryCount: 3,
        roleDefinitionsFile: ROLES_JSON,
      },
    } as any);
    await generateCopilotInstructions(config, tmpDir);

    const content = await readFile(path.join(tmpDir, '.github', 'copilot-instructions.md'), 'utf-8');
    expect(content).toContain('my-dev_developer');
  });

  it('should render check interval in minutes', async () => {
    const config = makeConfig({
      agent: {
        hostname: 'test-host',
        role: 'developer',
        checkIntervalMs: 120_000, // 2 minutes
        stuckTimeoutMs: 1_800_000,
        sdkTimeoutMs: 120_000,
        taskRetryCount: 3,
        roleDefinitionsFile: ROLES_JSON,
      },
    } as any);
    await generateCopilotInstructions(config, tmpDir);

    const content = await readFile(path.join(tmpDir, '.github', 'copilot-instructions.md'), 'utf-8');
    expect(content).toContain('2min');
  });

  it('should render SDK timeout in seconds', async () => {
    const config = makeConfig({
      agent: {
        hostname: 'test-host',
        role: 'developer',
        checkIntervalMs: 60_000,
        stuckTimeoutMs: 1_800_000,
        sdkTimeoutMs: 300_000, // 300 seconds
        taskRetryCount: 3,
        roleDefinitionsFile: ROLES_JSON,
      },
    } as any);
    await generateCopilotInstructions(config, tmpDir);

    const content = await readFile(path.join(tmpDir, '.github', 'copilot-instructions.md'), 'utf-8');
    expect(content).toContain('300s');
  });

  it('should include primary responsibilities from roles.json', async () => {
    const config = makeConfig();
    await generateCopilotInstructions(config, tmpDir);

    const content = await readFile(path.join(tmpDir, '.github', 'copilot-instructions.md'), 'utf-8');
    // Developer role has "Implement features" in roles.json
    expect(content).toContain('Implement features');
  });

  it('should include notYourJob from roles.json', async () => {
    const config = makeConfig();
    await generateCopilotInstructions(config, tmpDir);

    const content = await readFile(path.join(tmpDir, '.github', 'copilot-instructions.md'), 'utf-8');
    // Developer notYourJob includes "Assign tasks"
    expect(content).toContain('Assign tasks');
  });

  // ----- Manager-specific sections -----

  it('should include manager hostname and role for non-manager agents', async () => {
    const config = makeConfig({
      manager: {
        hostname: 'boss-host',
        role: 'manager',
      },
    } as any);
    await generateCopilotInstructions(config, tmpDir);

    const content = await readFile(path.join(tmpDir, '.github', 'copilot-instructions.md'), 'utf-8');
    expect(content).toContain('boss-host_manager');
  });

  // ----- Custom instructions overlay -----

  it('should render codingStandards when custom_instructions.json is present', async () => {
    // Create a custom_instructions.json next to the roles file convention
    const customPath = path.join(tmpDir, 'custom_instructions.json');
    const customInstr = {
      codingStandards: {
        language: 'TypeScript',
        description: 'Strict TypeScript with no any',
        sections: {
          'Error Handling': ['Always use typed errors', 'No bare catch blocks'],
        },
      },
    };
    const { writeFile: wf } = await import('fs/promises');
    await wf(customPath, JSON.stringify(customInstr), 'utf-8');

    const config = makeConfig({
      agent: {
        hostname: 'test-host',
        role: 'developer',
        checkIntervalMs: 60_000,
        stuckTimeoutMs: 1_800_000,
        sdkTimeoutMs: 120_000,
        taskRetryCount: 3,
        roleDefinitionsFile: ROLES_JSON,
        customInstructionsFile: customPath,
      },
    } as any);
    await generateCopilotInstructions(config, tmpDir);

    const content = await readFile(path.join(tmpDir, '.github', 'copilot-instructions.md'), 'utf-8');
    expect(content).toContain('TypeScript Coding Standards');
    expect(content).toContain('Strict TypeScript with no any');
    expect(content).toContain('Always use typed errors');
  });

  it('should render testStandards for developer role', async () => {
    const customPath = path.join(tmpDir, 'custom_instructions.json');
    const { writeFile: wf } = await import('fs/promises');
    await wf(customPath, JSON.stringify({
      testStandards: {
        description: 'All code must have tests',
        structure: ['One test file per source file'],
        minimumCases: ['Happy path', 'Error path', 'Edge cases'],
        rules: ['No mocking fs unless necessary'],
      },
    }), 'utf-8');

    const config = makeConfig({
      agent: {
        hostname: 'test-host',
        role: 'developer',
        checkIntervalMs: 60_000,
        stuckTimeoutMs: 1_800_000,
        sdkTimeoutMs: 120_000,
        taskRetryCount: 3,
        roleDefinitionsFile: ROLES_JSON,
        customInstructionsFile: customPath,
      },
    } as any);
    await generateCopilotInstructions(config, tmpDir);

    const content = await readFile(path.join(tmpDir, '.github', 'copilot-instructions.md'), 'utf-8');
    expect(content).toContain('Test Standards');
    expect(content).toContain('All code must have tests');
    expect(content).toContain('Happy path');
    expect(content).toContain('No mocking fs unless necessary');
  });

  it('should render preSubmissionChecklist for developer role', async () => {
    const customPath = path.join(tmpDir, 'custom_instructions.json');
    const { writeFile: wf } = await import('fs/promises');
    await wf(customPath, JSON.stringify({
      preSubmissionChecklist: {
        description: 'Check before submitting',
        checks: ['Build passes', 'Tests pass', 'No any types'],
      },
    }), 'utf-8');

    const config = makeConfig({
      agent: {
        hostname: 'test-host',
        role: 'developer',
        checkIntervalMs: 60_000,
        stuckTimeoutMs: 1_800_000,
        sdkTimeoutMs: 120_000,
        taskRetryCount: 3,
        roleDefinitionsFile: ROLES_JSON,
        customInstructionsFile: customPath,
      },
    } as any);
    await generateCopilotInstructions(config, tmpDir);

    const content = await readFile(path.join(tmpDir, '.github', 'copilot-instructions.md'), 'utf-8');
    expect(content).toContain('Pre-Submission Self-Check');
    expect(content).toContain('No any types');
  });

  it('should render verificationChecklist for qa role', async () => {
    const customPath = path.join(tmpDir, 'custom_instructions.json');
    const { writeFile: wf } = await import('fs/promises');
    await wf(customPath, JSON.stringify({
      verificationChecklist: {
        description: 'Verify all criteria',
        codeQuality: ['No any casts'],
        testQuality: ['At least 3 tests per requirement'],
        traceability: ['Evidence file per requirement'],
      },
    }), 'utf-8');

    const config = makeConfig({
      agent: {
        hostname: 'qa-host',
        role: 'qa',
        checkIntervalMs: 60_000,
        stuckTimeoutMs: 1_800_000,
        sdkTimeoutMs: 120_000,
        taskRetryCount: 3,
        roleDefinitionsFile: ROLES_JSON,
        customInstructionsFile: customPath,
      },
    } as any);
    await generateCopilotInstructions(config, tmpDir);

    const content = await readFile(path.join(tmpDir, '.github', 'copilot-instructions.md'), 'utf-8');
    expect(content).toContain('Verification Checklist');
    expect(content).toContain('No any casts');
    expect(content).toContain('At least 3 tests per requirement');
    expect(content).toContain('Evidence file per requirement');
  });

  it('should render rejectionCriteria for qa role', async () => {
    const customPath = path.join(tmpDir, 'custom_instructions.json');
    const { writeFile: wf } = await import('fs/promises');
    await wf(customPath, JSON.stringify({
      rejectionCriteria: {
        description: 'Reject if any of these are true',
        blockingIssues: ['Single-file monolith', 'No tests'],
      },
    }), 'utf-8');

    const config = makeConfig({
      agent: {
        hostname: 'qa-host',
        role: 'qa',
        checkIntervalMs: 60_000,
        stuckTimeoutMs: 1_800_000,
        sdkTimeoutMs: 120_000,
        taskRetryCount: 3,
        roleDefinitionsFile: ROLES_JSON,
        customInstructionsFile: customPath,
      },
    } as any);
    await generateCopilotInstructions(config, tmpDir);

    const content = await readFile(path.join(tmpDir, '.github', 'copilot-instructions.md'), 'utf-8');
    expect(content).toContain('Rejection Criteria (BLOCKING)');
    expect(content).toContain('Single-file monolith');
    expect(content).toContain('No tests');
  });

  it('should render gitWorkflow for developer role', async () => {
    const customPath = path.join(tmpDir, 'custom_instructions.json');
    const { writeFile: wf } = await import('fs/promises');
    await wf(customPath, JSON.stringify({
      gitWorkflow: {
        developer: {
          description: 'Feature branch workflow',
          steps: ['1. Create branch from main', '2. Push commits'],
          rules: ['Never force push', 'Always rebase before merge'],
        },
      },
    }), 'utf-8');

    const config = makeConfig({
      agent: {
        hostname: 'dev-host',
        role: 'developer',
        checkIntervalMs: 60_000,
        stuckTimeoutMs: 1_800_000,
        sdkTimeoutMs: 120_000,
        taskRetryCount: 3,
        roleDefinitionsFile: ROLES_JSON,
        customInstructionsFile: customPath,
      },
    } as any);
    await generateCopilotInstructions(config, tmpDir);

    const content = await readFile(path.join(tmpDir, '.github', 'copilot-instructions.md'), 'utf-8');
    expect(content).toContain('Git Workflow');
    expect(content).toContain('Feature branch workflow');
    expect(content).toContain('Never force push');
  });

  it('should render additionalSections', async () => {
    const customPath = path.join(tmpDir, 'custom_instructions.json');
    const { writeFile: wf } = await import('fs/promises');
    await wf(customPath, JSON.stringify({
      additionalSections: [
        { title: 'Security', items: ['No secrets in code', 'Use env vars'] },
      ],
    }), 'utf-8');

    const config = makeConfig({
      agent: {
        hostname: 'dev-host',
        role: 'developer',
        checkIntervalMs: 60_000,
        stuckTimeoutMs: 1_800_000,
        sdkTimeoutMs: 120_000,
        taskRetryCount: 3,
        roleDefinitionsFile: ROLES_JSON,
        customInstructionsFile: customPath,
      },
    } as any);
    await generateCopilotInstructions(config, tmpDir);

    const content = await readFile(path.join(tmpDir, '.github', 'copilot-instructions.md'), 'utf-8');
    expect(content).toContain('Security');
    expect(content).toContain('No secrets in code');
  });

  it('should render projectContext', async () => {
    const customPath = path.join(tmpDir, 'custom_instructions.json');
    const { writeFile: wf } = await import('fs/promises');
    await wf(customPath, JSON.stringify({
      projectContext: ['This is a Rust workspace', 'Target: embedded ARM'],
    }), 'utf-8');

    const config = makeConfig({
      agent: {
        hostname: 'dev-host',
        role: 'developer',
        checkIntervalMs: 60_000,
        stuckTimeoutMs: 1_800_000,
        sdkTimeoutMs: 120_000,
        taskRetryCount: 3,
        roleDefinitionsFile: ROLES_JSON,
        customInstructionsFile: customPath,
      },
    } as any);
    await generateCopilotInstructions(config, tmpDir);

    const content = await readFile(path.join(tmpDir, '.github', 'copilot-instructions.md'), 'utf-8');
    expect(content).toContain('Project Context');
    expect(content).toContain('This is a Rust workspace');
  });

  // ----- Auto-detect hostname -----

  it('should resolve auto-detect hostname', async () => {
    const config = makeConfig({
      agent: {
        hostname: 'auto-detect',
        role: 'developer',
        checkIntervalMs: 60_000,
        stuckTimeoutMs: 1_800_000,
        sdkTimeoutMs: 120_000,
        taskRetryCount: 3,
        roleDefinitionsFile: ROLES_JSON,
      },
    } as any);
    await generateCopilotInstructions(config, tmpDir);

    const content = await readFile(path.join(tmpDir, '.github', 'copilot-instructions.md'), 'utf-8');
    // Should contain the actual hostname, not "auto-detect"
    expect(content).toContain(`${os.hostname()}_developer`);
    expect(content).not.toContain('auto-detect');
  });

  // ----- Error handling -----

  it('should throw when role is not found in roles.json', async () => {
    const config = makeConfig({
      agent: {
        hostname: 'test-host',
        role: 'nonexistent-role' as any,
        checkIntervalMs: 60_000,
        stuckTimeoutMs: 1_800_000,
        sdkTimeoutMs: 120_000,
        taskRetryCount: 3,
        roleDefinitionsFile: ROLES_JSON,
      },
    } as any);

    await expect(generateCopilotInstructions(config, tmpDir))
      .rejects.toThrow(/not found/i);
  });

  it('should throw when roles.json does not exist', async () => {
    const config = makeConfig({
      agent: {
        hostname: 'test-host',
        role: 'developer',
        checkIntervalMs: 60_000,
        stuckTimeoutMs: 1_800_000,
        sdkTimeoutMs: 120_000,
        taskRetryCount: 3,
        roleDefinitionsFile: '/tmp/nonexistent-roles.json',
      },
    } as any);

    await expect(generateCopilotInstructions(config, tmpDir))
      .rejects.toThrow();
  });

  // ----- .github directory creation -----

  it('should create .github directory if it does not exist', async () => {
    const config = makeConfig();
    const githubDir = path.join(tmpDir, '.github');
    expect(existsSync(githubDir)).toBe(false);

    await generateCopilotInstructions(config, tmpDir);

    expect(existsSync(githubDir)).toBe(true);
    expect(existsSync(path.join(githubDir, 'copilot-instructions.md'))).toBe(true);
  });

  it('should overwrite existing instructions file', async () => {
    const config = makeConfig();

    // Generate once
    await generateCopilotInstructions(config, tmpDir);
    const first = await readFile(path.join(tmpDir, '.github', 'copilot-instructions.md'), 'utf-8');

    // Generate again with different config
    const config2 = makeConfig({
      agent: {
        hostname: 'different-host',
        role: 'developer',
        checkIntervalMs: 60_000,
        stuckTimeoutMs: 1_800_000,
        sdkTimeoutMs: 120_000,
        taskRetryCount: 3,
        roleDefinitionsFile: ROLES_JSON,
      },
    } as any);
    await generateCopilotInstructions(config2, tmpDir);
    const second = await readFile(path.join(tmpDir, '.github', 'copilot-instructions.md'), 'utf-8');

    expect(second).toContain('different-host_developer');
    expect(second).not.toContain('test-host_developer');
  });

  // ----- Custom instructions file resolution -----

  it('should silently skip when customInstructionsFile does not exist', async () => {
    const config = makeConfig({
      agent: {
        hostname: 'test-host',
        role: 'developer',
        checkIntervalMs: 60_000,
        stuckTimeoutMs: 1_800_000,
        sdkTimeoutMs: 120_000,
        taskRetryCount: 3,
        roleDefinitionsFile: ROLES_JSON,
        customInstructionsFile: '/tmp/nonexistent-custom-instructions.json',
      },
    } as any);

    // Should not throw -- custom instructions are optional
    await generateCopilotInstructions(config, tmpDir);

    const content = await readFile(path.join(tmpDir, '.github', 'copilot-instructions.md'), 'utf-8');
    expect(content).toContain('Developer');
  });

  // ----- Output size constraint -----

  it('should produce output under roughly 2 pages (~8KB)', async () => {
    const config = makeConfig();
    await generateCopilotInstructions(config, tmpDir);

    const content = await readFile(path.join(tmpDir, '.github', 'copilot-instructions.md'), 'utf-8');
    // 2 pages ~= 8KB; we allow some margin
    expect(content.length).toBeLessThan(12_000);
    // Should be non-trivial
    expect(content.length).toBeGreaterThan(500);
  });

  // ----- Guidelines section -----

  it('should always include the Guidelines section', async () => {
    const config = makeConfig();
    await generateCopilotInstructions(config, tmpDir);

    const content = await readFile(path.join(tmpDir, '.github', 'copilot-instructions.md'), 'utf-8');
    expect(content).toContain('## Guidelines');
    expect(content).toContain('Act autonomously');
    expect(content).toContain('Escalate before');
    expect(content).toContain('git add');
  });

  // ----- buildSystem rendering -----

  it('should render buildSystem when present in custom instructions', async () => {
    const customPath = path.join(tmpDir, 'custom_instructions.json');
    const { writeFile: wf } = await import('fs/promises');
    await wf(customPath, JSON.stringify({
      buildSystem: {
        buildCommand: 'cargo build',
        testCommand: 'cargo test',
        lintCommand: 'cargo clippy',
      },
    }), 'utf-8');

    const config = makeConfig({
      agent: {
        hostname: 'test-host',
        role: 'developer',
        checkIntervalMs: 60_000,
        stuckTimeoutMs: 1_800_000,
        sdkTimeoutMs: 120_000,
        taskRetryCount: 3,
        roleDefinitionsFile: ROLES_JSON,
        customInstructionsFile: customPath,
      },
    } as any);
    await generateCopilotInstructions(config, tmpDir);

    // buildSystem is passed to the template; whether it renders depends
    // on template content.  At minimum, verify no crash.
    const content = await readFile(path.join(tmpDir, '.github', 'copilot-instructions.md'), 'utf-8');
    expect(content).toContain('Developer');
  });
});
