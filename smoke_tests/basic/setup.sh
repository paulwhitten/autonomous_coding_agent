#!/bin/bash
# Setup script for basic smoke test
#
# Uses the test harness CLI (scripts/smoke-test-cli.ts) to create
# mailbox directories and seed messages.  This ensures all messages
# use the same code paths as the agent runtime.

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

HARNESS_ROOT="$(cd ../.. && pwd)"

# Ensure root-level dependencies are installed (smoke-test-cli imports from root src/)
if [ ! -d "${HARNESS_ROOT}/node_modules" ]; then
  echo "Installing root-level dependencies (first run)..."
  ( cd "${HARNESS_ROOT}" && npm install --silent 2>&1 | tail -5 )
fi

echo "Setting up basic smoke test..."

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

# Create mailbox structure using the harness
echo "Creating mailbox structure..."
$CLI init-mailbox --base runtime_mailbox --agent smoke-test-agent --role developer

# Seed messages using the CLI (replaces hand-crafted start_mailbox files)
echo "Seeding task messages..."
$CLI create-message \
  --base runtime_mailbox --agent smoke-test-agent --role developer --queue normal \
  --from "test_manager" \
  --to "smoke-test-agent_developer" \
  --subject "Basic Smoke Test" \
  --body "Simple test to verify agent functionality with basic tasks. Test Tasks: 1. Create a simple TypeScript file 2. Write tests for the file 3. Run the tests 4. Verify results. Expected Duration: ~5 minutes. Success Criteria: All work items completed, no failures, agent processes tasks sequentially, verification passes." \
  --filename "001_basic_task.md"

$CLI create-message \
  --base runtime_mailbox --agent smoke-test-agent --role developer --queue normal \
  --from "test_manager" \
  --to "smoke-test-agent_developer" \
  --subject "Create and Test Simple Code" \
  --body "Create a simple TypeScript utility function, write tests, and verify it works. Requirements: 1. Create a file workspace/utils.ts with a simple utility function: addNumbers that takes two numbers and returns their sum with type annotations. 2. Create a test file workspace/utils.test.ts with 3 test cases (positive numbers, negative numbers, zero). 3. Run the tests and verify they pass. 4. Create a summary file workspace/test_results.txt with test results. Success Criteria: workspace/utils.ts exists with typed function, workspace/utils.test.ts exists with 3 tests, workspace/test_results.txt exists, all tests pass." \
  --filename "002_create_and_test_code.md"

echo ""
echo "Basic smoke test setup complete!"
echo ""
echo "To run the test:"
echo "  cd agent"
echo "  npm start"
