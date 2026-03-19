#!/bin/bash

# Setup tool delegation smoke test

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Setting up tool delegation smoke test..."
echo "This tests if mailbox tools (send_message, get_team_roster) actually work"
echo ""

# Kill any leftover agent processes from previous runs
echo "Killing any leftover agent processes..."
pkill -f "node.*dist/index.js.*config.json" 2>/dev/null || true
sleep 1
# Force kill if still running
pkill -9 -f "node.*dist/index.js.*config.json" 2>/dev/null || true

HARNESS_ROOT="$(cd ../.. && pwd)"

# Ensure root-level dependencies are installed (smoke-test-cli imports from root src/)
if [ ! -d "${HARNESS_ROOT}/node_modules" ]; then
  echo "Installing root-level dependencies (first run)..."
  ( cd "${HARNESS_ROOT}" && npm install --silent 2>&1 | tail -5 )
fi

# Clean previous test run completely
echo "Cleaning previous test run..."
rm -rf manager shared-mailbox team.json test.log roles.json

# Create directory structure
mkdir -p manager/agent
mkdir -p shared-mailbox/mailbox_archive/outbox
mkdir -p shared-mailbox/attachments

# Create manager workspace
mkdir -p manager/workspace/{tasks/{pending,completed,review,failed},.github}

# Create team roster
cat > team.json <<'EOF'
{
  "agents": [
    {
      "hostname": "test-mgr",
      "role": "manager",
      "capabilities": ["coordination", "planning", "delegation"],
      "specializations": ["Project management", "Task assignment"]
    },
    {
      "hostname": "test-protocol",
      "role": "developer",
      "capabilities": ["networking", "protocol-stack", "systems"],
      "specializations": ["Network protocol implementation"]
    },
    {
      "hostname": "test-sdk",
      "role": "developer",
      "capabilities": ["sdk-integration", "ipc", "systems"],
      "specializations": ["SDK integration"]
    },
    {
      "hostname": "test-qa",
      "role": "qa",
      "capabilities": ["testing", "validation", "automation"],
      "specializations": ["Test infrastructure"]
    },
    {
      "hostname": "test-hal",
      "role": "developer",
      "capabilities": ["hal", "drivers", "real-time", "c-cpp"],
      "specializations": ["Hardware abstraction layer"]
    }
  ]
}
EOF

# Create manager config
cat > manager/agent/config.json <<EOF
{
  "agent": {
    "hostname": "test-mgr",
    "role": "manager",
    "roleDefinitionsFile": "../../roles.json",
    "checkIntervalMs": 5000,
    "stuckTimeoutMs": 300000,
    "sdkTimeoutMs": 120000
  },
  "manager": {
    "hostname": "test-mgr",
    "role": "manager"
  },
  "mailbox": {
    "repoPath": "../../shared-mailbox",
    "gitSync": false,
    "autoCommit": false,
    "supportPriority": true,
    "supportBroadcast": true,
    "supportAttachments": false,
    "teamRosterFile": "../../team.json"
  },
  "copilot": {
    "model": "gpt-4.1",
    "temperature": 0.7,
    "streaming": false
  },
  "workspace": {
    "path": "../workspace"
  },
  "logging": {
    "path": "../logs",
    "level": "info"
  }
}
EOF

# Copy roles.json
cp ../../roles.json .

# Copy source code from parent (like other smoke tests)
echo "Copying source code..."
cp -r ../../src manager/agent/
cp -r ../../templates manager/agent/
cp ../../package.json manager/agent/
cp ../../tsconfig.json manager/agent/

# Install dependencies
echo "Installing dependencies..."
cd manager/agent
npm install
cd ../..

# CLI available after npm install
CLI="npx --prefix manager/agent tsx ${HARNESS_ROOT}/scripts/smoke-test-cli.ts"

# Create mailbox structure for all agents using the harness
echo "Creating mailbox structure..."
$CLI init-mailbox --base shared-mailbox --agent test-mgr       --role manager   --broadcast
$CLI init-mailbox --base shared-mailbox --agent test-protocol  --role developer
$CLI init-mailbox --base shared-mailbox --agent test-sdk       --role developer
$CLI init-mailbox --base shared-mailbox --agent test-qa        --role qa
$CLI init-mailbox --base shared-mailbox --agent test-hal       --role developer

# Seed the initial task message using the CLI
echo "Seeding task message..."
$CLI create-message \
  --base shared-mailbox --agent test-mgr --role manager --queue priority \
  --from "system" \
  --to "test-mgr_manager" \
  --subject "Test Tool Usage - Delegation" \
  --priority HIGH \
  --body "CRITICAL: Tool Functionality Test. Your task is to USE the mailbox tools. Do NOT create tasks, do NOT plan work. Required Actions: 1. Call get_team_roster() to list all agents. 2. Call send_message() FOUR times, one to each team member: test-protocol_developer, test-sdk_developer, test-qa_qa, test-hal_developer. 3. Message content: Hello from manager, testing send_message tool. Success Criteria: Called get_team_roster() returning 5 agents, called send_message() 4 times, 4 message files created in recipient mailboxes with proper format. Do NOT create planning tasks, write documentation, or break work into subtasks. Just call the tools directly." \
  --filename "001_test_tool_usage.md"

echo ""
echo "✅ Setup complete!"
echo ""
echo "Directory structure:"
echo "  manager/agent/           - Manager agent (test-mgr_manager)"
echo "  manager/workspace/       - Agent workspace"
echo "  shared-mailbox/          - Shared mailbox for all agents"
echo "  team.json                - Team roster (5 agents)"
echo ""
echo "Initial message created:"
echo "  shared-mailbox/mailbox/to_test-mgr_manager/priority/2026-02-13-2000_Test_Tool_Usage.md"
echo ""
echo "To run the test:"
echo "  cd manager/agent"
echo "  nohup npm start > ../../test.log 2>&1 &"
echo ""
echo "To monitor:"
echo "  tail -f test.log"
echo ""
echo "To validate:"
echo "  ./validate.sh"
echo ""
