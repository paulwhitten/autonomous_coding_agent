import { test, expect } from '@playwright/test';

// Mock API responses so tests work without the Express server running
test.beforeEach(async ({ page }) => {
  // Auth gate — always authenticated
  await page.route('**/api/auth/check', route =>
    route.fulfill({ json: { required: false, authenticated: true } })
  );
  // Agent status
  await page.route('**/api/agents/status*', route =>
    route.fulfill({ json: { agents: [] } })
  );
  // Work items
  await page.route('**/api/agents/work-items*', route =>
    route.fulfill({ json: { pending: [], completed: [], review: [], failed: [] } })
  );
  // Discovered agents
  await page.route('**/api/agents/discovered*', route =>
    route.fulfill({ json: { agents: [], total: 0, timestamp: new Date().toISOString() } })
  );
  // Health history
  await page.route('**/api/agents/health-history*', route =>
    route.fulfill({ json: { history: {}, timestamp: new Date().toISOString() } })
  );
  // Process configs
  await page.route('**/api/processes/configs*', route =>
    route.fulfill({ json: { configs: [] } })
  );
  // A2A endpoints
  await page.route('**/api/a2a/**', route =>
    route.fulfill({ json: {} })
  );
  // Config endpoints (for config page)
  await page.route('**/api/config', route =>
    route.fulfill({ json: { configs: [] } })
  );
  // Workflows
  await page.route('**/api/workflows', route =>
    route.fulfill({ json: { workflows: [] } })
  );
  // Agents logs
  await page.route('**/api/agents/logs*', route =>
    route.fulfill({ json: { lines: [], total: 0 } })
  );
  // Agents log sources
  await page.route('**/api/agents/log-sources*', route =>
    route.fulfill({ json: { sources: [] } })
  );
});

test.describe('Dashboard Page', () => {
  test('should render dashboard heading', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  });

  test('should show stat cards', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Pending')).toBeVisible();
    await expect(page.getByText('In Review')).toBeVisible();
    await expect(page.getByText('Completed')).toBeVisible();
    await expect(page.getByText('Failed')).toBeVisible();
  });

  test('should show quick start when no workspace attached', async ({ page }) => {
    await page.goto('/');
    // Clear any stored workspace
    await page.evaluate(() => localStorage.removeItem('agent-workspace'));
    await page.reload();
    await expect(page.getByText('Get Started')).toBeVisible();
  });

  test('should toggle workspace attach panel', async ({ page }) => {
    await page.goto('/');
    // Target the header button (not the Quick Start card button)
    await page.getByRole('button', { name: /Attach Workspace|Change/ }).first().click();
    await expect(page.getByPlaceholder(/absolute.*path/i)).toBeVisible();
  });

  test('should show discovered agents section', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Discovered Agents')).toBeVisible();
  });

  test('should show refresh button for agent discovery', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Refresh/ })).toBeVisible();
  });

  test('should show empty state when no agents discovered', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText(/No agents discovered|Scanning for agents/)).toBeVisible();
  });
});

test.describe('Navigation', () => {
  test('should have nav links', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: /Dashboard/i })).toBeVisible();
  });

  test('should navigate to settings page', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: /Configuration/i })).toBeVisible();
  });

  test('should navigate to workflows page', async ({ page }) => {
    await page.goto('/workflows');
    await expect(page.getByRole('heading', { name: /Workflow/i })).toBeVisible();
  });

  test('should navigate to monitor page', async ({ page }) => {
    await page.goto('/monitor');
    await expect(page.getByRole('heading', { name: /Monitor/i })).toBeVisible();
  });
});

test.describe('Dark Mode', () => {
  test('should apply dark class from localStorage', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.setItem('agent-theme', 'dark'));
    await page.reload();
    const html = page.locator('html');
    await expect(html).toHaveClass(/dark/);
  });

  test('should apply light mode without dark class', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.setItem('agent-theme', 'light'));
    await page.reload();
    const html = page.locator('html');
    await expect(html).not.toHaveClass(/dark/);
  });
});

test.describe('Error Handling', () => {
  test('should not show error boundary on normal load', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Something went wrong')).not.toBeVisible();
  });
});
