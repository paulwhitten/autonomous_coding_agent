import { test, expect } from '@playwright/test';

const MOCK_AGENT_CONTEXT = {
  hostname: 'dev-server-1',
  role: 'developer',
  agentId: 'dev-server-1_developer',
  a2aUrl: 'http://localhost:9999',
  mailboxRepoPath: '/tmp/test-mailbox',
};

const MOCK_A2A_MESSAGES = [
  { from: 'qa-server-1_qa', subject: 'Review PR #42', priority: 'HIGH', date: '2025-01-15T10:00:00Z', body: 'Please review the latest PR.' },
  { from: 'manager-1_manager', subject: 'Sprint update', priority: 'NORMAL', date: '2025-01-15T09:30:00Z', body: 'Sprint planning is tomorrow.' },
];

const MOCK_A2A_ARCHIVED = [
  { from: 'qa-server-1_qa', subject: 'Old review request', priority: 'NORMAL', date: '2025-01-14T08:00:00Z', body: 'This was already handled.' },
];

const MOCK_A2A_STATUS = {
  agent: { name: 'dev-server-1', description: 'Developer agent' },
  team: [
    { hostname: 'dev-server-1', role: 'developer' },
    { hostname: 'qa-server-1', role: 'qa', responsibilities: 'Testing and validation' },
  ],
  mailbox: { unread: 2 },
  workItems: { pending: ['implement login form', 'add validation'], completed: ['setup project'], review: [], failed: [] },
};

const MOCK_DISCOVERED_AGENTS = {
  agents: [
    { agentId: 'dev-server-1_developer', hostname: 'dev-server-1', role: 'developer', pid: 1234, startedAt: '2025-01-15T08:00:00Z', a2aUrl: 'http://localhost:9999' },
    { agentId: 'qa-server-1_qa', hostname: 'qa-server-1', role: 'qa', pid: 5678, startedAt: '2025-01-15T08:00:00Z', a2aUrl: 'http://localhost:9998' },
  ],
  total: 2,
  timestamp: new Date().toISOString(),
};

// Mock all API routes + set agent context with A2A URL
test.beforeEach(async ({ page }) => {
  // Auth gate
  await page.route('**/api/auth/check', route =>
    route.fulfill({ json: { required: false, authenticated: true } })
  );
  // Agent status
  await page.route('**/api/agents/status*', route =>
    route.fulfill({ json: { agents: [] } })
  );
  // Work items (enriched titles)
  await page.route('**/api/agents/work-items*', route =>
    route.fulfill({ json: { pending: ['implement login form', 'add validation'], completed: ['setup project'], review: [], failed: [] } })
  );
  // Discovered agents
  await page.route('**/api/agents/discovered*', route =>
    route.fulfill({ json: MOCK_DISCOVERED_AGENTS })
  );
  // Health history
  await page.route('**/api/agents/health-history*', route =>
    route.fulfill({ json: { history: {}, timestamp: new Date().toISOString() } })
  );
  // Process configs
  await page.route('**/api/processes/configs*', route =>
    route.fulfill({ json: { configs: [] } })
  );
  // A2A local API endpoints
  await page.route('**/api/a2a/**', route =>
    route.fulfill({ json: {} })
  );
  // Config
  await page.route('**/api/config', route =>
    route.fulfill({ json: { configs: [] } })
  );
  // Workflows
  await page.route('**/api/workflows', route =>
    route.fulfill({ json: { workflows: [] } })
  );
  // Logs
  await page.route('**/api/agents/logs*', route =>
    route.fulfill({ json: { lines: [], total: 0 } })
  );
  await page.route('**/api/agents/log-sources*', route =>
    route.fulfill({ json: { sources: [] } })
  );
  // Team
  await page.route('**/api/team', route =>
    route.fulfill({ json: { team: { name: 'Test Team' }, agents: [], roles: {} } })
  );
  // Mailbox
  await page.route('**/api/mailbox', route =>
    route.fulfill({ json: { agents: [] } })
  );

  // Mock direct A2A calls to the agent
  await page.route('**/a2a/mailbox', route =>
    route.fulfill({ json: { messages: MOCK_A2A_MESSAGES } })
  );
  await page.route('**/a2a/archive', route =>
    route.fulfill({ json: { messages: MOCK_A2A_ARCHIVED } })
  );
  await page.route('**/a2a/status', route =>
    route.fulfill({ json: MOCK_A2A_STATUS })
  );

  // Set agent context with A2A URL in localStorage
  await page.goto('/');
  await page.evaluate((ctx) => {
    localStorage.setItem('agent-context', JSON.stringify(ctx));
  }, MOCK_AGENT_CONTEXT);
});

test.describe('MailboxPage — A2A mode', () => {
  test('should show A2A indicator', async ({ page }) => {
    await page.goto('/mailbox');
    await expect(page.locator('span').filter({ hasText: 'A2A' }).first()).toBeVisible();
  });

  test('should show inbox messages', async ({ page }) => {
    await page.goto('/mailbox');
    await expect(page.getByText('Review PR #42')).toBeVisible();
    await expect(page.getByText('Sprint update')).toBeVisible();
  });

  test('should show inbox/archive tab counts', async ({ page }) => {
    await page.goto('/mailbox');
    await expect(page.getByText(/Inbox \(2\)/)).toBeVisible();
    await expect(page.getByText(/Processed \(1\)/)).toBeVisible();
  });

  test('should switch to archive tab', async ({ page }) => {
    await page.goto('/mailbox');
    await page.getByText(/Processed/).click();
    await expect(page.getByText('Old review request')).toBeVisible();
  });

  test('should show message content when selected', async ({ page }) => {
    await page.goto('/mailbox');
    await page.getByText('Review PR #42').click();
    await expect(page.getByText('Please review the latest PR.')).toBeVisible();
    await expect(page.getByText(/qa-server-1_qa/).first()).toBeVisible();
  });

  test('should show auto-refresh checkbox', async ({ page }) => {
    await page.goto('/mailbox');
    await expect(page.getByLabel('Auto-refresh')).toBeVisible();
  });

  test('should show composer with agent picker', async ({ page }) => {
    await page.goto('/mailbox');
    await page.getByRole('button', { name: /Compose/ }).click();
    // Should show the select dropdown for recipients
    const select = page.locator('select').first();
    await expect(select).toBeVisible();
    // Should have discovered agents as options
    await expect(select.locator('option')).toHaveCount(4); // placeholder + 2 agents + manual
  });
});

test.describe('TeamPage — A2A panel', () => {
  test('should show A2A team members', async ({ page }) => {
    await page.goto('/team');
    await expect(page.getByText('dev-server-1').first()).toBeVisible();
    await expect(page.getByText('qa-server-1').first()).toBeVisible();
  });

  test('should show auto-refresh checkbox', async ({ page }) => {
    await page.goto('/team');
    await expect(page.getByLabel('Auto-refresh')).toBeVisible();
  });

  test('should show refresh A2A button', async ({ page }) => {
    await page.goto('/team');
    await expect(page.getByRole('button', { name: /Refresh A2A/ })).toBeVisible();
  });
});

test.describe('DashboardPage — work item titles', () => {
  test('should show human-readable work item titles', async ({ page }) => {
    await page.goto('/');
    // Set workspace so work items load
    await page.evaluate(() => localStorage.setItem('agent-workspace', '/tmp/test'));
    await page.reload();
    // The enriched titles should appear (not filenames)
    await expect(page.getByText('implement login form')).toBeVisible();
    await expect(page.getByText('add validation')).toBeVisible();
  });
});
