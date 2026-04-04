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
  --from "localhost_manager" \
  --to "smoke-test-agent_researcher" \
  --subject "Borderline computation (125 seconds)" \
  --body "Run a computation that takes approximately 125 seconds and save the results. Task: Execute these commands: echo Starting 125-second task at \$(date); sleep 125; echo Completed at \$(date) > borderline_task_result.txt; echo SUCCESS: Task completed in 125 seconds. Acceptance Criteria: File borderline_task_result.txt exists in the project working directory and contains a completion timestamp. Notes: This task exceeds the base SDK timeout (120s). The timeout strategy should retry with Tier 1 extended timeout (2x = 240s)." \
  --filename "001_borderline_task.md"

$CLI create-message \
  --base runtime_mailbox --agent smoke-test-agent --role researcher --queue normal \
  --from "localhost_manager" \
  --to "smoke-test-agent_researcher" \
  --subject "Long-running computation (250 seconds)" \
  --body "Run a computation that takes approximately 250 seconds and save the results. Task: Execute these commands: echo Starting 250-second task at \$(date); sleep 250; echo Completed at \$(date) > long_running_task_result.txt; echo SUCCESS. If the task times out on direct execution, run it as a background process: nohup bash -c 'sleep 250 && echo Completed at \$(date) > long_running_task_result.txt' > long_task_log.txt 2>&1 & echo \$! Then poll for completion by checking whether long_running_task_result.txt exists. Acceptance Criteria: File long_running_task_result.txt exists and contains a completion timestamp. Notes: Exceeds both base (120s) and Tier 1 (240s) timeouts. Agent should use background process pattern (Tier 2)." \
  --filename "002_long_running_task.md"

$CLI create-message \
  --base runtime_mailbox --agent smoke-test-agent --role researcher --queue normal \
  --from "localhost_manager" \
  --to "smoke-test-agent_researcher" \
  --subject "Quick validation (30 seconds)" \
  --body "Run a quick data validation that completes within 30 seconds. Task: Execute these commands: echo Starting quick task at \$(date); sleep 30; echo Validation complete at \$(date) > quick_task_result.txt; echo SUCCESS. Acceptance Criteria: File quick_task_result.txt exists, contains a completion timestamp, and task completes on first attempt without triggering any timeout strategy." \
  --filename "003_quick_task.md"

$CLI create-message \
  --base runtime_mailbox --agent smoke-test-agent --role researcher --queue normal \
  --from "localhost_manager" \
  --to "smoke-test-agent_researcher" \
  --subject "Second borderline computation (130 seconds)" \
  --body "Run a second borderline computation that takes approximately 130 seconds. Task: Execute these commands: echo Starting 130-second task at \$(date); sleep 130; echo Completed at \$(date) > borderline_task_2_result.txt; echo SUCCESS. Acceptance Criteria: File borderline_task_2_result.txt exists and contains a completion timestamp. Notes: Like the first borderline task, exceeds base SDK timeout (120s) and should succeed on retry with Tier 1 extended timeout (240s). Running multiple borderline tasks exercises the adaptive timeout pattern detector (Tier 4)." \
  --filename "004_another_borderline_task.md"

$CLI create-message \
  --base runtime_mailbox --agent smoke-test-agent --role researcher --queue normal \
  --from "localhost_manager" \
  --to "smoke-test-agent_researcher" \
  --subject "Dependency test - create setup data" \
  --body "Create a data file for the next task to consume. This task intentionally fails. Task: Execute these commands: echo Starting setup task at \$(date); sleep 20; exit 1. Do NOT create setup_data.txt. Acceptance Criteria: The shell command exits with non-zero status. The agent logs the failure and moves on. File setup_data.txt does NOT exist. Notes: Designed to fail. The next task depends on setup_data.txt which this task does not produce." \
  --filename "005_dependency_test_setup.md"

$CLI create-message \
  --base runtime_mailbox --agent smoke-test-agent --role researcher --queue normal \
  --from "localhost_manager" \
  --to "smoke-test-agent_researcher" \
  --subject "Dependency test - process setup data" \
  --body "Process the data file created by the previous create setup data task. Task: Execute: if [ -f setup_data.txt ]; then cat setup_data.txt > dependent_result.txt; echo SUCCESS; else echo ERROR: Missing dependency - setup_data.txt not found | tee dependent_result.txt; exit 1; fi. Acceptance Criteria: Because the previous task failed, setup_data.txt does not exist. The script exits with code 1 and writes an error to dependent_result.txt. The agent logs the failure. Notes: Tests agent behavior when a dependency chain is broken." \
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
