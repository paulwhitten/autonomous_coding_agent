#!/bin/bash
# Setup script for the dependency-gating smoke test
#
# Tests that the workflow engine correctly:
#   1. Blocks a task whose dependencies are not yet satisfied
#   2. Unblocks the task when its dependency completes (via markTaskDone)
#   3. Persists manifest status to disk
#
# Uses a single manager agent with a 2-task manifest:
#   task-A: no dependencies (independent)
#   task-B: dependsOn task-A (should be blocked until task-A completes)

set -eE
trap 'echo "FATAL: setup.sh failed at line $LINENO (exit $?)" >&2' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

HARNESS_ROOT="$(cd ../.. && pwd)"

# Ensure root-level dependencies are installed (smoke-test-cli imports from root src/)
if [ ! -d "${HARNESS_ROOT}/node_modules" ]; then
  echo "Installing root-level dependencies (first run)..."
  ( cd "${HARNESS_ROOT}" && npm install --silent 2>&1 | tail -5 )
fi

echo "Setting up dependency-gating smoke test..."

# Kill any leftover agent processes from previous runs
echo "Killing any leftover agent processes..."
pkill -f "node.*dist/index.js.*config.json" 2>/dev/null || true
sleep 1
pkill -9 -f "node.*dist/index.js.*config.json" 2>/dev/null || true

# Clean previous test artifacts
echo "Cleaning previous test artifacts..."
rm -rf manager/runtime_mailbox
rm -rf manager/agent/src manager/agent/dist manager/agent/node_modules
rm -rf manager/agent/package*.json manager/agent/tsconfig.json manager/agent/config.json
rm -rf manager/agent/workspace manager/agent/logs manager/agent/templates manager/agent/roles.json
rm -f test.log
rm -f dep-gate-test.task-manifest.status.json

# Copy source code from parent project
echo "Copying source code..."
cp -r ../../src manager/agent/
cp -r ../../templates manager/agent/
cp ../../package.json manager/agent/
cp ../../tsconfig.json manager/agent/
cp ../../roles.json manager/agent/

# Copy config template to active config
echo "Setting up configuration..."
cp manager/agent/config.template.json manager/agent/config.json

# Install dependencies
echo "Installing dependencies..."
cd manager/agent
npm install
cd ../..

# Now that tsx is available, define the CLI command
CLI="npx --prefix manager/agent tsx ${HARNESS_ROOT}/scripts/smoke-test-cli.ts"

# Create mailbox structure
echo "Creating mailbox structure..."
$CLI init-mailbox --base manager/runtime_mailbox --agent smoke-dep-mgr --role manager

# Seed task-B FIRST (the one with a dependency on task-A).
# This verifies the agent blocks it because task-A is not done yet.
echo "Seeding task-B (has dependency on task-A -- should be BLOCKED)..."
$CLI pack-workflow \
  --base manager/runtime_mailbox --agent smoke-dep-mgr --role manager --queue normal \
  --workflow-id dep-gate-test \
  --task-id task-B \
  --state ASSIGN \
  --target-role manager \
  --prompt "Task B: Create task-b_proof.txt. This task depends on task-A completing first." \
  --from smoke-dep-mgr_manager \
  --to smoke-dep-mgr_manager \
  --subject "Workflow Assignment: task-B"

echo ""
echo "Dependency-gating smoke test setup complete!"
echo ""
echo "Test structure:"
echo "  - Single manager agent with task manifest (task-A, task-B)"
echo "  - task-B seeded first (should be BLOCKED by dependency gate)"
echo "  - task-A seeded during run-test.sh after confirming task-B is blocked"
echo "  - Workflow: ASSIGN -> BLOCKED (gate) or ASSIGN -> IMPLEMENTING -> DONE"
echo ""
echo "Run the test:"
echo "  ./run-test.sh"
