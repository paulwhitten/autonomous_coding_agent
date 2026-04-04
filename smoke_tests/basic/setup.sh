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
  --from "localhost_manager" \
  --to "smoke-test-agent_developer" \
  --subject "Create sum module with tests" \
  --body "Create a TypeScript module that exports a sum function, write Jest tests for it, and verify the tests pass. Requirements: 1. Create sum.ts in the project root directory. Export a function sum(a: number, b: number): number that returns the sum of a and b. 2. Update package.json so the test script runs Jest: set scripts.test to jest. 3. Create sum.test.ts in the project root directory. Import sum from ./sum. Test cases: two positive numbers (sum(2,3) returns 5), mixed positive and negative (sum(-2,3) returns 1), two negative numbers (sum(-2,-3) returns -5), zero as argument (sum(0,5) returns 5). 4. Run npx jest from the project root and confirm all tests pass. Acceptance Criteria: sum.ts exists and exports a typed sum function; sum.test.ts exists with at least 4 test cases; npx jest exits with code 0; package.json scripts.test is jest." \
  --filename "001_basic_task.md"

$CLI create-message \
  --base runtime_mailbox --agent smoke-test-agent --role developer --queue normal \
  --from "localhost_manager" \
  --to "smoke-test-agent_developer" \
  --subject "Create string utilities with tests" \
  --body "Create a TypeScript module with string utility functions, write Jest tests, and verify the tests pass. Note: a sum.ts module already exists in the project from a prior task -- do not duplicate or overwrite it. Requirements: 1. Create string-utils.ts in the project root directory. Export capitalize(s: string): string (first char uppercased) and reverse(s: string): string (string reversed). 2. Create string-utils.test.ts in the project root directory. Test cases for capitalize: lowercase word (capitalize('hello') returns 'Hello'), already capitalized ('Hello' returns 'Hello'), empty string returns ''. Test cases for reverse: normal word (reverse('hello') returns 'olleh'), palindrome (reverse('racecar') returns 'racecar'), empty string returns ''. 3. Run npx jest from the project root and confirm all tests pass (including pre-existing tests). 4. Create test_results.txt in the project root with the actual Jest console output. Acceptance Criteria: string-utils.ts exists and exports both functions with type annotations; string-utils.test.ts exists with at least 6 test cases; npx jest exits with code 0; test_results.txt contains actual Jest output showing pass/fail status." \
  --filename "002_create_and_test_code.md"

echo ""
echo "Basic smoke test setup complete!"
echo ""
echo "To run the test:"
echo "  cd agent"
echo "  npm start"
