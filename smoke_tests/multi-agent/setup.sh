#!/bin/bash
# Setup script for multi-agent priority mailbox smoke test
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

echo "Setting up multi-agent priority mailbox smoke test..."

# Clean previous test artifacts
echo "Cleaning previous test artifacts..."
rm -rf developer/agent/src developer/agent/dist developer/agent/node_modules developer/agent/package*.json developer/agent/tsconfig.json
rm -rf developer/agent/workspace developer/agent/logs
rm -rf developer/runtime_mailbox

# Copy source code to developer agent
echo "Copying source code to developer agent..."
cp -r ../../src developer/agent/
cp -r ../../templates developer/agent/
cp ../../package.json developer/agent/
cp ../../tsconfig.json developer/agent/
cp ../../roles.json developer/agent/

# Setup developer configuration
echo "Setting up developer configuration..."
cp developer/agent/config.template.json developer/agent/config.json

# Install dependencies
echo "Installing dependencies..."
cd developer/agent && npm install && cd ../..

# CLI available after npm install
CLI="npx --prefix developer/agent tsx ${HARNESS_ROOT}/scripts/smoke-test-cli.ts"

# Create mailbox structure
echo "Creating mailbox structure..."
$CLI init-mailbox --base developer/runtime_mailbox --agent smoke-test-dev --role developer
$CLI init-mailbox --base developer/runtime_mailbox --agent smoke-test-mgr --role manager

# Seed 3 NORMAL tasks in developer's mailbox
echo "Seeding initial task queue (3 NORMAL tasks)..."
$CLI create-message \
  --base developer/runtime_mailbox --agent smoke-test-dev --role developer --queue normal \
  --from "smoke-test-mgr_manager" \
  --to "smoke-test-dev_developer" \
  --subject "Task 1 - Create Hello World" \
  --body "Please create a simple Hello World program. Requirements: Create a file hello.js that prints Hello, World! using console.log(). Keep it simple. This task should complete quickly and successfully." \
  --filename "001_task1_hello_world.md"

$CLI create-message \
  --base developer/runtime_mailbox --agent smoke-test-dev --role developer --queue normal \
  --from "smoke-test-mgr_manager" \
  --to "smoke-test-dev_developer" \
  --subject "Task 2 - Add Math Function" \
  --body "Create a math utility function. Requirements: Create file math-utils.js. Add function add(a, b) that returns sum. Add function multiply(a, b) that returns product. Export both functions. This task has a deliberate issue -- the multiply function should be called multiplyNumbers not multiply. You will need manager help to fix this." \
  --filename "002_task2_math_function.md"

$CLI create-message \
  --base developer/runtime_mailbox --agent smoke-test-dev --role developer --queue normal \
  --from "smoke-test-mgr_manager" \
  --to "smoke-test-dev_developer" \
  --subject "Task 3 - Create README" \
  --body "Create documentation for the code. Requirements: Create README.md file. Document the hello.js program. Document the math-utils.js functions. Include usage examples. This task should be straightforward." \
  --filename "003_task3_create_readme.md"

echo ""
echo "Multi-agent smoke test setup complete!"
echo ""
echo "Test structure:"
echo "  - Developer agent: 3 NORMAL tasks in queue"
echo "  - Manager correction: Inject via ./inject-manager-correction.sh"
echo ""
echo "Expected flow:"
echo "  1. Developer processes Task 1 (hello world)"
echo "  2. Developer starts Task 2 (math function)"
echo "  3. Run ./inject-manager-correction.sh"
echo "  4. Developer IMMEDIATELY processes HIGH priority correction"
echo "  5. Developer skips ahead, fixes Task 2"
echo "  6. Developer returns to Task 3"
echo ""
echo "To run the test:"
echo "  cd developer/agent"
echo "  npm start"
echo ""
echo "In another terminal:"
echo "  cd smoke_tests/multi-agent"
echo "  ./inject-manager-correction.sh"
