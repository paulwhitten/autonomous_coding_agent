#!/bin/bash
# Setup script for ad-hoc smoke test
#
# Tests a single agent operating without a workflow engine.  The agent
# receives plain ad-hoc messages via the mailbox and must perform
# deterministic tasks: create TypeScript source files, write tests,
# commit incrementally to a git repo, and verify tests pass.
#
# No workflowFile is configured — the agent processes each message as
# a standalone ad-hoc request with no state machine or entry/exit
# commands governing transitions.

set -eE
trap 'echo "FATAL: setup.sh failed at line $LINENO (exit $?)" >&2' ERR

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

HARNESS_ROOT="$(cd ../.. && pwd)"

# Ensure root-level dependencies are installed (smoke-test-cli imports from root src/)
if [ ! -d "${HARNESS_ROOT}/node_modules" ]; then
  echo "Installing root-level dependencies (first run)..."
  ( cd "${HARNESS_ROOT}" && npm install --silent 2>&1 | tail -5 )
fi

echo "Setting up ad-hoc smoke test..."

# Kill any leftover agent processes from previous runs
echo "Killing any leftover converter-ad-hoc test agent processes..."
pkill -f "node.*smoke_tests/converter-ad-hoc.*/dist/index.js" 2>/dev/null || true
sleep 1
pkill -9 -f "node.*smoke_tests/converter-ad-hoc.*/dist/index.js" 2>/dev/null || true

# Clean previous test artifacts
echo "Cleaning previous test artifacts..."
rm -rf runtime_mailbox
rm -rf agent/src agent/templates agent/dist agent/node_modules agent/workspace agent/logs
rm -f agent/package-lock.json agent/package.json agent/tsconfig.json agent/config.json agent/roles.json
rm -f test.log

# Copy source code from parent
echo "Copying source code..."
cp -r ../../src agent/
cp -r ../../templates agent/
cp ../../package.json agent/
cp ../../package-lock.json agent/
cp ../../tsconfig.json agent/
cp ../../roles.json agent/

# Copy config template (no workflowFile — ad-hoc mode)
echo "Setting up configuration..."
cp agent/config.template.json agent/config.json

# Initialize git repo in the project working folder
echo "Initializing git repo in project folder..."
mkdir -p agent/workspace/project
cd agent/workspace/project
git init
git config user.name "Ad-Hoc Smoke Test Agent"
git config user.email "adhoc-agent@test.local"

# Seed Jest + TypeScript scaffolding so `npx jest` actually runs the TS tests.
# Without this, jest cannot parse TypeScript and the agent's verification step
# silently captures a failure. ts-jest is already present in agent/node_modules.
cat > package.json <<'PKG_EOF'
{
  "name": "converter",
  "version": "1.0.0",
  "scripts": { "test": "jest" }
}
PKG_EOF
cat > jest.config.cjs <<'JEST_EOF'
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
};
JEST_EOF
cat > tsconfig.json <<'TSC_EOF'
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true
  }
}
TSC_EOF
# Note: `npx jest` run from this folder resolves jest/ts-jest by walking up
# the directory tree to agent/node_modules (Node module resolution). No local
# node_modules or symlink is needed.

# Create initial commit so the repo is not bare
# Ignore the .github/ directory the agent runtime generates at startup
# (role-based copilot-instructions.md); it is framework scaffolding, not an
# agent deliverable, so it must not dirty the project working tree.
# Also ignore transpiled TypeScript output (e.g. a compiled converter.js from
# running tsc): it is a build artifact, not a deliverable, and must not be left
# untracked or committed.
cat > .gitignore <<'GITIGNORE_EOF'
.github/

# Transpiled TypeScript output (build artifacts, not deliverables)
converter.js
*.js.map
*.d.ts
dist/
GITIGNORE_EOF
echo "# Ad-Hoc Project" > README.md
git add -A
git commit -m "chore: initial project setup"
cd "$SCRIPT_DIR"

# Install dependencies
echo "Installing dependencies..."
cd agent
npm ci
cd ..

# CLI available after npm ci
CLI="npx --prefix agent tsx ${HARNESS_ROOT}/scripts/smoke-test-cli.ts"

# Create mailbox structure
echo "Creating mailbox structure..."
$CLI init-mailbox --base runtime_mailbox --agent adhoc-test-agent --role developer

# ----------------------------------------------------------------
# Seed ad-hoc messages
#
# Each message is a standalone request — no workflow, no state
# machine.  The agent should process them in order and perform
# the requested work autonomously.
# ----------------------------------------------------------------

echo "Seeding ad-hoc task messages..."

# Message 1: Create a converter module with three functions and commit
$CLI create-message \
  --base runtime_mailbox --agent adhoc-test-agent --role developer --queue normal \
  --from "localhost_manager" \
  --to "adhoc-test-agent_developer" \
  --subject "Create unit converter module" \
  --body "Create a TypeScript unit converter module in the project working folder. The project folder is already a git repo with user config set. You MUST make separate git commits for each step.

Step 1 — Create the source file:
  Create converter.ts in the project root exporting these three functions:
    - celsiusToFahrenheit(c: number): number — returns (c * 9/5) + 32
    - fahrenheitToCelsius(f: number): number — returns (f - 32) * 5/9
    - milesToKilometers(m: number): number — returns m * 1.60934
  Commit with message: feat: add unit converter module

Step 2 — Write tests:
  Create converter.test.ts in the project root with at least 8 test cases:
    - celsiusToFahrenheit(0) returns 32
    - celsiusToFahrenheit(100) returns 212
    - celsiusToFahrenheit(-40) returns -40
    - fahrenheitToCelsius(32) returns 0
    - fahrenheitToCelsius(212) returns 100
    - fahrenheitToCelsius(-40) returns -40
    - milesToKilometers(1) is approximately 1.60934 (use toBeCloseTo)
    - milesToKilometers(0) returns 0
  Commit with message: test: add converter unit tests

Step 3 — Verify tests pass:
  Run npx jest from the project root and confirm all tests pass.
  Create test_output.txt in the project root containing the actual Jest console output.
  Commit with message: docs: capture test output

Acceptance Criteria:
  - converter.ts exports celsiusToFahrenheit, fahrenheitToCelsius, milesToKilometers
  - converter.test.ts has at least 8 test cases
  - test_output.txt contains the actual Jest console output and shows all tests passing
  - git log shows a commit for each step
  - Working tree is clean (everything committed)

Completion check:
  Do NOT consider this task complete until every item under Acceptance Criteria is satisfied. Before you finish, re-read the Acceptance Criteria above and confirm each one. As your final step, run npx jest (it must exit 0) and run git status --porcelain (its output must be empty). If any criterion is unmet, finish the remaining work before ending." \
  --filename "001_create_converter.md"

# Message 2: Extend the module with a fourth function and additional tests
$CLI create-message \
  --base runtime_mailbox --agent adhoc-test-agent --role developer --queue normal \
  --from "localhost_manager" \
  --to "adhoc-test-agent_developer" \
  --subject "Add kilogramsToPounds converter" \
  --body "Extend the existing converter module in the project working folder.  There is already a converter.ts with three functions — do NOT overwrite them.

Step 1 — Add new function:
  Add an exported function kilogramsToPounds(kg: number): number that returns kg * 2.20462.
  Commit with message: feat: add kilogramsToPounds converter

Step 2 — Add tests for the new function:
  Add at least 3 test cases to converter.test.ts:
    - kilogramsToPounds(1) is approximately 2.20462 (use toBeCloseTo)
    - kilogramsToPounds(0) returns 0
    - kilogramsToPounds(100) is approximately 220.462 (use toBeCloseTo)
  Commit with message: test: add kilogramsToPounds tests

Step 3 — Run all tests and confirm they pass:
  Run npx jest and confirm ALL tests pass (the original 8 plus the new ones).
  Update test_output.txt with the new full Jest output.
  Commit with message: docs: update test output with new tests

Acceptance Criteria:
  - converter.ts exports four functions: celsiusToFahrenheit, fahrenheitToCelsius, milesToKilometers, kilogramsToPounds
  - converter.test.ts has at least 11 test cases total
  - npx jest exits 0
  - git log shows incremental commits for each step
  - Working tree is clean (everything committed)

Completion check:
  Do NOT consider this task complete until every item under Acceptance Criteria is satisfied. Before you finish, re-read the Acceptance Criteria above and confirm each one. As your final step, run npx jest (it must exit 0), confirm test_output.txt reflects the full current suite, and run git status --porcelain (its output must be empty). If any criterion is unmet, finish the remaining work before ending." \
  --filename "002_extend_converter.md"

# Message 3: Document the module in the README
$CLI create-message \
  --base runtime_mailbox --agent adhoc-test-agent --role developer --queue normal \
  --from "localhost_manager" \
  --to "adhoc-test-agent_developer" \
  --subject "Update README with converter usage" \
  --body "Document the converter module in the project working folder.  The module in converter.ts now exports all four functions: celsiusToFahrenheit, fahrenheitToCelsius, milesToKilometers, and kilogramsToPounds.

Step 1 — Update README:
  Update README.md in the project root to describe the converter module.
  Include a usage example showing how to import and call EACH of the four functions, including kilogramsToPounds.
  Commit with message: docs: update README with converter usage

Acceptance Criteria:
  - README.md describes the converter module
  - README.md shows a usage example for all four functions
  - git log shows a commit for the README update
  - Working tree is clean (everything committed)

Completion check:
  Do NOT consider this task complete until every item under Acceptance Criteria is satisfied. Before you finish, re-read the Acceptance Criteria above and confirm each one. As your final step, confirm README.md documents all four functions and run git status --porcelain (its output must be empty). If any criterion is unmet, finish the remaining work before ending." \
  --filename "003_update_readme.md"

echo ""
echo "Ad-hoc smoke test setup complete!"
echo ""
echo "To run the test:"
echo "  ./run-test.sh"
