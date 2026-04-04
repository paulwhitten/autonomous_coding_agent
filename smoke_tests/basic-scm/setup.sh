#!/bin/bash
# Setup script for basic-scm smoke test
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

echo "Setting up basic-scm smoke test..."

# Clean previous test artifacts
echo "Cleaning previous test artifacts..."
rm -rf runtime_mailbox agent/src agent/templates agent/dist agent/node_modules agent/workspace agent/logs agent/package-lock.json agent/package.json agent/tsconfig.json agent/config.json agent/roles.json agent/.github agent/.npmrc
rm -f test.log

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

# Initialize git repo in the project working folder
echo "Initializing git repo in project folder..."
mkdir -p agent/workspace/project
cd agent/workspace/project
git init
git config user.name "Smoke Test Agent"
git config user.email "agent@test.local"
# Create an initial commit so the repo is not empty
echo "# Project" > README.md
git add -A
git commit -m "chore: initial project setup"
cd "$SCRIPT_DIR"

# Install dependencies
echo "Installing dependencies..."
cd agent
npm install
cd ..

# CLI available after npm install
CLI="npx --prefix agent tsx ${HARNESS_ROOT}/scripts/smoke-test-cli.ts"

# Create mailbox structure
echo "Creating mailbox structure..."
$CLI init-mailbox --base runtime_mailbox --agent scm-test-agent --role developer

# Seed message via CLI
echo "Seeding task message..."
$CLI create-message \
  --base runtime_mailbox --agent scm-test-agent --role developer --queue normal \
  --from "localhost_manager" \
  --to "scm-test-agent_developer" \
  --subject "Incremental Git Project" \
  --body "Build a small TypeScript calculator module incrementally in the project working folder. Git Workflow: The project folder is already a git repo with user config set. After each step, stage and commit changes. Each step MUST have its own separate commit. Do NOT combine steps. Steps: 1. Create calculator.ts with exported add(a: number, b: number): number function, commit with feat: initial calculator with add function. 2. Add exported subtract(a,b) and multiply(a,b) functions to calculator.ts, commit with feat: add subtract and multiply functions. 3. Create calculator.test.ts with tests for all three functions (at least 2 cases per function, 6 total minimum), commit with test: add unit tests for calculator. 4. Update README.md to describe the calculator module with usage examples, commit with docs: add README for calculator module. Acceptance Criteria: calculator.ts exists with exported add, subtract, multiply; calculator.test.ts has 6+ test cases; README.md has description and usage examples; git log --oneline shows 4+ commits after setup; git status shows clean working tree." \
  --filename "001_incremental_git_project.md"

echo ""
echo "basic-scm smoke test setup complete!"
echo ""
echo "To run the test:"
echo "  cd agent"
echo "  nohup npm start > ../test.log 2>&1 &"
echo ""
echo "Or use the full runner:"
echo "  cd .."
echo "  bash run-test.sh"
