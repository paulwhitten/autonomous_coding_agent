#!/bin/bash
# Setup script for long-running smoke test
#
# Uses the test harness CLI to create mailbox and seed messages.

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

HARNESS_ROOT="$(cd ../.. && pwd)"

# Ensure root-level dependencies are installed (smoke-test-cli imports from root src/)
if [ ! -d "${HARNESS_ROOT}/node_modules" ]; then
  echo "Installing root-level dependencies (first run)..."
  ( cd "${HARNESS_ROOT}" && npm install --silent 2>&1 | tail -5 )
fi

echo "Setting up long-running smoke test..."

# Clean previous test artifacts
echo "Cleaning previous test artifacts..."
rm -rf runtime_mailbox agent/src agent/dist agent/node_modules agent/workspace agent/logs agent/package-lock.json agent/package.json agent/tsconfig.json agent/config.json

# Copy source code from parent
echo "Copying source code..."
cp -r ../../src agent/
cp -r ../../templates agent/
cp ../../package.json agent/
cp ../../tsconfig.json agent/
cp ../../roles.json agent/

# Copy config template
echo "Setting up configuration..."
cp agent/config.template.json agent/config.json

# Install dependencies
echo "Installing dependencies..."
cd agent
npm install
cd ..

# CLI available after npm install
CLI="npx --prefix agent tsx ${HARNESS_ROOT}/scripts/smoke-test-cli.ts"

# Create mailbox structure
echo "Creating mailbox structure..."
$CLI init-mailbox --base runtime_mailbox --agent smoke-test-agent --role researcher

# Seed task messages via CLI
echo "Seeding task messages..."
$CLI create-message \
  --base runtime_mailbox --agent smoke-test-agent --role researcher --queue normal \
  --from "test_manager" \
  --to "smoke-test-agent_researcher" \
  --subject "Borderline Task (125 seconds)" \
  --body "This task should take just over the base timeout of 120 seconds. Expected Behavior: First attempt SDK timeout at 120s, second attempt Tier 1 strategy (2x timeout = 240s) should succeed. Task: Run a 125-second computation and save results." \
  --filename "001_borderline_task.md"

$CLI create-message \
  --base runtime_mailbox --agent smoke-test-agent --role researcher --queue normal \
  --from "test_manager" \
  --to "smoke-test-agent_researcher" \
  --subject "Long-Running Task (250 seconds)" \
  --body "This task exceeds even the doubled timeout and should trigger background process strategy. Expected Behavior: First attempt SDK timeout at 120s, second attempt SDK timeout at 240s (Tier 1), third attempt Tier 2 strategy using background process pattern. Task: Run a 250-second computation." \
  --filename "002_long_running_task.md"

$CLI create-message \
  --base runtime_mailbox --agent smoke-test-agent --role researcher --queue normal \
  --from "test_manager" \
  --to "smoke-test-agent_researcher" \
  --subject "Quick Task (30 seconds)" \
  --body "This task should succeed immediately without any timeout issues. Expected Behavior: First attempt success within 30 seconds, no timeout strategy needed. Task: Run a quick data validation." \
  --filename "003_quick_task.md"

$CLI create-message \
  --base runtime_mailbox --agent smoke-test-agent --role researcher --queue normal \
  --from "test_manager" \
  --to "smoke-test-agent_researcher" \
  --subject "Another Borderline Task (130 seconds)" \
  --body "This task tests pattern detection -- multiple borderline timeouts in succession. Expected Behavior: First attempt SDK timeout at 120s, second attempt Tier 1 (2x = 240s) should succeed, pattern detection may trigger category-specific timeout adjustment." \
  --filename "004_another_borderline_task.md"

$CLI create-message \
  --base runtime_mailbox --agent smoke-test-agent --role researcher --queue normal \
  --from "test_manager" \
  --to "smoke-test-agent_researcher" \
  --subject "Dependency Test - Setup (Will Fail)" \
  --body "This task intentionally fails to test dependency handling. Expected Behavior: Task should fail after timeout or error. Agent should log failure. Subsequent task depends on this task output." \
  --filename "005_dependency_test_setup.md"

$CLI create-message \
  --base runtime_mailbox --agent smoke-test-agent --role researcher --queue normal \
  --from "test_manager" \
  --to "smoke-test-agent_researcher" \
  --subject "Dependency Test - Dependent Task" \
  --body "This task depends on output from the previous task, which failed. Expected Behavior: Agent attempts to read file from previous task, file does not exist (task failed). Agent should detect missing dependency." \
  --filename "006_dependency_test_dependent.md"

echo ""
echo "Long-running smoke test setup complete!"
echo ""
echo "Test configuration:"
echo "  - Base SDK timeout: 120s"
echo "  - Tier 1 multiplier: 2x (240s)"
echo "  - Tier 2 threshold: 2 attempts"
echo "  - Tier 3 threshold: 3 attempts"
echo "  - Pattern detection: 3 timeouts/hour"
echo ""
echo "To run the test:"
echo "  cd agent"
echo "  npm start"
