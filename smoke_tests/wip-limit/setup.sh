#!/bin/bash

# Setup script for WIP limit smoke test
#
# Creates a manager agent with wipLimit: 2, seeds two task messages
# in its mailbox, and prepares developer/qa mailboxes for receiving
# delegated work.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

HARNESS_ROOT="$(cd ../.. && pwd)"

# Ensure root-level dependencies are installed (smoke-test-cli imports from root src/)
if [ ! -d "${HARNESS_ROOT}/node_modules" ]; then
  echo "Installing root-level dependencies (first run)..."
  ( cd "${HARNESS_ROOT}" && npm install --silent 2>&1 | tail -5 )
fi

CLI=""

echo "Setting up WIP limit smoke test..."
echo "This tests the manager's WIP gate with wipLimit=2."
echo ""

# Kill any leftover agent processes
echo "Killing any leftover agent processes..."
pkill -f "node.*dist/index.js.*config.json" 2>/dev/null || true
sleep 1
pkill -9 -f "node.*dist/index.js.*config.json" 2>/dev/null || true

# Clean previous artifacts
echo "Cleaning previous test artifacts..."
rm -rf manager/runtime_mailbox
rm -rf manager/agent/src manager/agent/dist manager/agent/node_modules
rm -rf manager/agent/package*.json manager/agent/tsconfig.json manager/agent/config.json
rm -rf manager/agent/workspace manager/agent/logs manager/agent/templates manager/agent/roles.json
rm -f test.log

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

# CLI is now available
CLI="npx --prefix manager/agent tsx ${HARNESS_ROOT}/scripts/smoke-test-cli.ts"

# Create mailbox structure for all agents
echo "Creating mailbox structure..."
$CLI init-mailbox --base manager/runtime_mailbox --agent smoke-wip-mgr --role manager
$CLI init-mailbox --base manager/runtime_mailbox --agent smoke-wip-dev --role developer
$CLI init-mailbox --base manager/runtime_mailbox --agent smoke-wip-qa --role qa

# Seed TWO task messages in the manager's normal mailbox.
# These are plain messages (not workflow assignments) that the manager
# should break down, create workflow tasks for, and delegate.
echo "Seeding task message 1 of 2..."
$CLI create-message \
  --base manager/runtime_mailbox --agent smoke-wip-mgr --role manager --queue normal \
  --from "user" \
  --to "smoke-wip-mgr_manager" \
  --subject "Task 1: Create constants module" \
  --body "Please implement a constants module in protocol-core that defines protocol-specific constants and basic frame type identifiers. Acceptance criteria: 1) File crates/protocol-core/src/constants.rs exists 2) Contains protocol constants 3) cargo build succeeds" \
  --filename "001_task1_create_constants_module.md"

echo "Seeding task message 2 of 2..."
$CLI create-message \
  --base manager/runtime_mailbox --agent smoke-wip-mgr --role manager --queue normal \
  --from "user" \
  --to "smoke-wip-mgr_manager" \
  --subject "Task 2: Create error types" \
  --body "Please implement error types in protocol-core using thiserror. Define ProtocolError enum with variants: ParseError, FrameError, TimeoutError, InvalidState. Acceptance criteria: 1) File crates/protocol-core/src/error.rs exists 2) ProtocolError enum defined 3) cargo build succeeds" \
  --filename "002_task2_create_error_types.md"

echo ""
echo "WIP limit smoke test setup complete!"
echo ""
echo "Test structure:"
echo "  - Manager agent with wipLimit: 2"
echo "  - 2 task messages seeded in manager's normal mailbox"
echo "  - Developer and QA mailboxes ready to receive delegations"
echo "  - Workflow: ASSIGN -> IMPLEMENTING -> DONE"
echo ""
echo "Run the test with: ./run-test.sh"
