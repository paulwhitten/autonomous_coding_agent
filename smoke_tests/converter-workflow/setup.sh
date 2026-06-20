#!/bin/bash
# Setup script for converter-workflow smoke test
#
# Workflow-driven counterpart to converter-ad-hoc. A single developer
# agent is driven through a deterministic state machine (workflow.json)
# that builds the SAME unit converter module. The LLM only writes source
# and test code; the workflow engine performs every git commit and Jest
# run via onExitCommands.
#
# Seeds ONE WorkflowAssignment at the initial state (CREATE_MODULE) using
# the harness pack-workflow CLI. All subsequent states are reached by the
# engine re-queuing self-loop assignments — no further mailbox seeding.

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

echo "Setting up converter-workflow smoke test..."

# Kill any leftover agent processes from previous runs
echo "Killing any leftover converter-workflow test agent processes..."
pkill -f "node.*smoke_tests/converter-workflow.*/dist/index.js" 2>/dev/null || true
sleep 1
pkill -9 -f "node.*smoke_tests/converter-workflow.*/dist/index.js" 2>/dev/null || true

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

# Copy config template (workflowFile configured — workflow-driven mode)
echo "Setting up configuration..."
cp agent/config.template.json agent/config.json

# Initialize git repo in the project working folder
echo "Initializing git repo in project folder..."
mkdir -p agent/workspace/project
cd agent/workspace/project
git init
git config user.name "Converter Workflow Smoke Test Agent"
git config user.email "converter-wf-agent@test.local"

# Seed Jest + TypeScript scaffolding so the workflow's `npx jest` exit
# commands actually run the TS tests. Without this, jest cannot parse
# TypeScript and the deterministic test gate would fail. ts-jest is already
# present in agent/node_modules (copied via package-lock + npm ci).
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
cat > .gitignore <<'GITIGNORE_EOF'
.github/
GITIGNORE_EOF
echo "# Converter Workflow Project" > README.md
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
$CLI init-mailbox --base runtime_mailbox --agent converter-wf-dev --role developer

# ----------------------------------------------------------------
# Seed the initial WorkflowAssignment (CREATE_MODULE state)
#
# Only ONE message is seeded. The workflow engine drives every
# subsequent state by re-queuing self-loop assignments to the same
# agent. The per-state prompts in workflow.json carry the specific
# instructions; this taskPrompt is just high-level context.
# ----------------------------------------------------------------

echo "Seeding initial workflow assignment..."
$CLI pack-workflow \
  --base runtime_mailbox --agent converter-wf-dev --role developer --queue normal \
  --workflow-id converter-workflow \
  --task-id converter-build-001 \
  --state CREATE_MODULE \
  --target-role developer \
  --prompt "Build a TypeScript unit converter module incrementally. Follow the instructions for the current workflow state. The workflow engine performs all git commits and test runs for you — you only write source and test code." \
  --from converter-wf-dev_developer \
  --to converter-wf-dev_developer \
  --subject "Workflow Assignment: CREATE_MODULE" \
  --filename "001_converter_build.md"

echo ""
echo "converter-workflow smoke test setup complete!"
echo ""
echo "To run the test:"
echo "  ./run-test.sh"
