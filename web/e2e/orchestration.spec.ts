import { test, expect } from '@playwright/test';

// Mock data for orchestration tests
const MOCK_WORKFLOWS = {
  workflows: [
    { file: 'dev-qa-merge.workflow.json', id: 'dev-qa-merge', name: 'Development with QA Gate', description: 'Standard dev-QA workflow', version: '2.0.0' },
    { file: 'hello-world.workflow.json', id: 'hello-world', name: 'Hello World', description: 'Simple test workflow', version: '1.0.0' },
  ],
};

const MOCK_WORKFLOW_DETAIL = {
  id: 'dev-qa-merge',
  name: 'Development with QA Gate',
  description: 'Standard dev-QA workflow',
  version: '2.0.0',
  initialState: 'ASSIGN',
  terminalStates: ['DONE', 'ESCALATED'],
  globalContext: {},
  states: {
    ASSIGN: { name: 'Assignment', role: 'manager', description: 'Task assignment', prompt: '', transitions: { onSuccess: 'IMPLEMENTING', onFailure: 'ESCALATED' } },
    IMPLEMENTING: { name: 'Implementation', role: 'developer', description: 'Dev work', prompt: 'Implement...', transitions: { onSuccess: 'VERIFICATION', onFailure: 'ESCALATED' } },
    VERIFICATION: { name: 'Verification', role: 'qa', description: 'QA check', prompt: 'Verify...', transitions: { onSuccess: 'MERGING', onFailure: 'REWORK' } },
    REWORK: { name: 'Rework', role: 'developer', description: 'Fix issues', prompt: 'Fix...', transitions: { onSuccess: 'VERIFICATION', onFailure: 'ESCALATED' } },
    MERGING: { name: 'Merge', role: 'qa', description: 'Merge to main', prompt: 'Merge...', transitions: { onSuccess: 'DONE', onFailure: 'ESCALATED' } },
    DONE: { name: 'Done', role: 'manager', description: 'Complete', prompt: '' },
    ESCALATED: { name: 'Escalated', role: 'manager', description: 'Needs attention', prompt: '' },
  },
};

const MOCK_TEAM_CONFIGS = {
  workflow: { id: 'dev-qa-merge', name: 'Development with QA Gate', description: 'Standard dev-QA workflow' },
  roles: ['manager', 'developer', 'qa'],
  configs: [
    { role: 'manager', config: { agent: { hostname: 'manager-agent', role: 'manager' }, mailbox: { repoPath: '../mailbox_repo' } } },
    { role: 'developer', config: { agent: { hostname: 'developer-agent', role: 'developer' }, mailbox: { repoPath: '../mailbox_repo' } } },
    { role: 'qa', config: { agent: { hostname: 'qa-agent', role: 'qa' }, mailbox: { repoPath: '../mailbox_repo' } } },
  ],
};

const MOCK_DISCOVERED_AGENTS = {
  agents: [
    { agentId: 'dev-1_developer', hostname: 'dev-1', role: 'developer', pid: 1234, startedAt: '2025-01-15T08:00:00Z', a2aUrl: 'http://localhost:9999' },
    { agentId: 'qa-1_qa', hostname: 'qa-1', role: 'qa', pid: 5678, startedAt: '2025-01-15T08:00:00Z', a2aUrl: 'http://localhost:9998' },
  ],
  total: 2,
  timestamp: new Date().toISOString(),
};

const MOCK_AGENT_CONTEXT = {
  hostname: 'dev-1',
  role: 'developer',
  agentId: 'dev-1_developer',
  a2aUrl: 'http://localhost:9999',
  mailboxRepoPath: '/tmp/test-mailbox',
};

// Standard API mocks
test.beforeEach(async ({ page }) => {
  await page.route('**/api/auth/check', route =>
    route.fulfill({ json: { required: false, authenticated: true } })
  );
  await page.route('**/api/agents/status*', route =>
    route.fulfill({ json: { agents: [] } })
  );
  await page.route('**/api/agents/work-items*', route =>
    route.fulfill({ json: { pending: [], completed: [], review: [], failed: [] } })
  );
  await page.route('**/api/agents/discovered*', route =>
    route.fulfill({ json: MOCK_DISCOVERED_AGENTS })
  );
  await page.route('**/api/agents/health-history*', route =>
    route.fulfill({ json: { history: {}, timestamp: new Date().toISOString() } })
  );
  await page.route('**/api/processes/configs*', route =>
    route.fulfill({ json: { configs: [] } })
  );
  await page.route('**/api/a2a/**', route =>
    route.fulfill({ json: {} })
  );
  await page.route('**/api/config', route =>
    route.fulfill({ json: { configs: ['config.json'] } })
  );
  await page.route('**/api/config/*', route =>
    route.fulfill({ json: { agent: { hostname: 'test', role: 'developer' }, mailbox: { repoPath: '../mailbox' } } })
  );
  await page.route('**/api/workflows', route =>
    route.fulfill({ json: MOCK_WORKFLOWS })
  );
  await page.route('**/api/workflows/dev-qa-merge.workflow.json', async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      await route.fulfill({ json: MOCK_WORKFLOW_DETAIL });
    } else {
      await route.fulfill({ json: { success: true } });
    }
  });
  await page.route('**/api/workflows/*/team-configs', route =>
    route.fulfill({ json: MOCK_TEAM_CONFIGS })
  );
  await page.route('**/api/workflows/*/start-task', route =>
    route.fulfill({ json: { success: true, filename: 'test.md', assignment: { workflowId: 'dev-qa-merge', taskId: 'TASK-001', targetState: 'ASSIGN', targetRole: 'manager', targetAgent: 'mgr_manager' } } })
  );
  await page.route('**/api/workflows/*/states', route =>
    route.fulfill({
      json: {
        workflow: { id: 'dev-qa-merge', name: 'Development with QA Gate' },
        states: Object.entries(MOCK_WORKFLOW_DETAIL.states).map(([id, s]) => ({
          id,
          name: (s as Record<string, unknown>).name,
          role: (s as Record<string, unknown>).role,
          description: (s as Record<string, unknown>).description,
          transitions: (s as Record<string, unknown>).transitions,
        })),
        initialState: 'ASSIGN',
        terminalStates: ['DONE', 'ESCALATED'],
      },
    })
  );
  await page.route('**/api/agents/logs*', route =>
    route.fulfill({ json: { lines: [], total: 0 } })
  );
  await page.route('**/api/agents/log-sources*', route =>
    route.fulfill({ json: { sources: [] } })
  );
  await page.route('**/api/team', route =>
    route.fulfill({ json: { team: { name: 'Test Team' }, agents: [], roles: {} } })
  );
  await page.route('**/api/mailbox', route =>
    route.fulfill({ json: { agents: [] } })
  );
  await page.route('**/api/processes', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { processes: [] } });
    } else {
      await route.fulfill({ json: { id: 'agent-1', pid: 1234, configFile: 'config.json' } });
    }
  });
  await page.route('**/api/processes/batch', route =>
    route.fulfill({ json: { launched: 3, results: [{ configFile: 'config-manager.json', id: 'agent-1', pid: 111 }, { configFile: 'config-developer.json', id: 'agent-2', pid: 222 }, { configFile: 'config-qa.json', id: 'agent-3', pid: 333 }] } })
  );
  // A2A direct endpoints
  await page.route('**/a2a/mailbox', route =>
    route.fulfill({ json: { messages: [] } })
  );
  await page.route('**/a2a/archive', route =>
    route.fulfill({ json: { messages: [] } })
  );
  await page.route('**/a2a/status', route =>
    route.fulfill({ json: { agent: { name: 'dev-1' }, team: [], mailbox: { unread: 0 }, workItems: { pending: [], completed: [], review: [], failed: [] } } })
  );
});

// ─── ConfigPage (Settings): Team Step ────────────────────────────────────────

test.describe('Settings Page — Team step', () => {
  test('should display 8 step tabs including Team', async ({ page }) => {
    await page.goto('/settings');
    const steps = page.locator('button').filter({ hasText: /^(Agent|Mailbox|Copilot|Workspace|Logging|Manager|Team|Quota)$/ });
    await expect(steps).toHaveCount(8);
  });

  test('should navigate to Team step and show empty state', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Team' }).click();
    await expect(page.getByRole('heading', { name: 'Team Members' })).toBeVisible();
    await expect(page.getByText('No team members configured')).toBeVisible();
  });

  test('should add and remove a team member', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Team' }).click();
    await page.getByRole('button', { name: 'Add Member' }).click();
    // Should show form fields for the new member
    await expect(page.getByPlaceholder('agent-hostname')).toBeVisible();
    // Remove it
    const removeBtn = page.locator('button[title="Remove member"]');
    await removeBtn.click();
    await expect(page.getByText('No team members configured')).toBeVisible();
  });

  test('should show workflow selector in Agent step', async ({ page }) => {
    await page.goto('/settings');
    // Agent step is step 0 (default)
    await expect(page.getByText('Workflow File')).toBeVisible();
    // Should have workflow options in the select (first select with 'None')
    const wfSelect = page.locator('select').filter({ hasText: 'None' }).first();
    await expect(wfSelect).toBeVisible();
    const options = wfSelect.locator('option');
    await expect(options).toHaveCount(3); // None + 2 workflows
  });

  test('should show A2A server port field in Agent step', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByText('A2A Server Port')).toBeVisible();
  });
});

// ─── ProjectsPage: Project-First Flow ────────────────────────────────────────

test.describe('ProjectsPage — Project-First Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/projects', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: { projects: [] } });
      } else {
        // POST — create project
        const body = JSON.parse(route.request().postData() || '{}');
        await route.fulfill({ json: { id: body.name?.toLowerCase().replace(/\s+/g, '_') || 'test', name: body.name, description: body.description || '', projectContext: body.projectContext || [], buildSystem: body.buildSystem || {}, techStack: body.techStack || [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
      }
    });
    await page.route('**/api/projects/*/apply', route =>
      route.fulfill({ json: { success: true, filesWritten: ['custom_instructions.json', 'config-manager.json', 'config-developer.json', 'config-qa.json'], teamConfigs: [{ role: 'manager', configFile: 'config-manager.json' }, { role: 'developer', configFile: 'config-developer.json' }, { role: 'qa', configFile: 'config-qa.json' }], customInstructionsPath: 'custom_instructions.json' } })
    );
    await page.route('**/api/projects/*', async (route) => {
      if (route.request().method() === 'PUT') {
        await route.fulfill({ json: { id: 'test_project', name: 'Test Project', description: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), projectContext: [], buildSystem: {} } });
      } else {
        await route.fulfill({ json: { id: 'test_project', name: 'Test Project' } });
      }
    });
  });

  test('should show empty state with New Project button', async ({ page }) => {
    await page.goto('/projects');
    await expect(page.getByText('No projects yet')).toBeVisible();
    await expect(page.getByRole('button', { name: /New Project/ })).toBeVisible();
  });

  test('should open wizard on New Project click', async ({ page }) => {
    await page.goto('/projects');
    await page.getByRole('button', { name: /New Project/ }).click();
    await expect(page.getByText('Step 1 of 4')).toBeVisible();
    await expect(page.getByRole('button', { name: /Project Setup/ })).toBeVisible();
  });

  test('should show project setup form fields', async ({ page }) => {
    await page.goto('/projects');
    await page.getByRole('button', { name: /New Project/ }).click();
    await expect(page.getByText('Project Name')).toBeVisible();
    await expect(page.getByText('Description')).toBeVisible();
    await expect(page.getByText('Git Repository URL')).toBeVisible();
    await expect(page.locator('label').filter({ hasText: 'Language' })).toBeVisible();
    await expect(page.getByText('Project Context')).toBeVisible();
    await expect(page.getByText('Build Commands')).toBeVisible();
  });

  test('should advance to workflow step after filling project name', async ({ page }) => {
    await page.goto('/projects');
    await page.getByRole('button', { name: /New Project/ }).click();
    await page.getByPlaceholder('My Awesome Project').fill('Test Project');
    await page.getByRole('button', { name: /Next/ }).click();
    await expect(page.getByText('Select a Workflow')).toBeVisible();
  });
});

// ─── MailboxPage: Workflow Task Composer ──────────────────────────────────────

test.describe('MailboxPage — Workflow Task Composer', () => {
  test.beforeEach(async ({ page }) => {
    // Set agent context so A2A mode activates
    await page.goto('/');
    await page.evaluate((ctx) => {
      localStorage.setItem('agent-context', JSON.stringify(ctx));
    }, MOCK_AGENT_CONTEXT);
  });

  test('should show Compose button', async ({ page }) => {
    await page.goto('/mailbox');
    await expect(page.getByRole('button', { name: /Compose/ })).toBeVisible();
  });

  test('should show Message and Workflow Task mode tabs in composer', async ({ page }) => {
    await page.goto('/mailbox');
    await page.getByRole('button', { name: /Compose/ }).click();
    await expect(page.getByRole('button', { name: /Message/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Workflow Task/ })).toBeVisible();
  });

  test('should switch to Workflow Task mode', async ({ page }) => {
    await page.goto('/mailbox');
    await page.getByRole('button', { name: /Compose/ }).click();
    await page.getByRole('button', { name: /Workflow Task/ }).click();
    await expect(page.getByRole('heading', { name: 'Send Workflow Task' })).toBeVisible();
  });

  test('should show workflow and agent selectors in workflow mode', async ({ page }) => {
    await page.goto('/mailbox');
    await page.getByRole('button', { name: /Compose/ }).click();
    await page.getByRole('button', { name: /Workflow Task/ }).click();
    await expect(page.getByText('Task ID', { exact: true })).toBeVisible();
    await expect(page.getByText('Task Title', { exact: true })).toBeVisible();
    await expect(page.getByText('Task Description', { exact: true })).toBeVisible();
    await expect(page.getByText('Acceptance Criteria', { exact: true })).toBeVisible();
  });

  test('should have workflow options in dropdown', async ({ page }) => {
    await page.goto('/mailbox');
    await page.getByRole('button', { name: /Compose/ }).click();
    await page.getByRole('button', { name: /Workflow Task/ }).click();
    // Workflow dropdown should have options
    const workflowSelect = page.locator('select').filter({ hasText: 'Select workflow' });
    await expect(workflowSelect).toBeVisible();
  });
});
