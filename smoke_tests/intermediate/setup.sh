#!/bin/bash
# Setup script for intermediate smoke test
#
# Uses the test harness CLI (scripts/smoke-test-cli.ts) to create
# mailbox directories and seed messages.

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

HARNESS_ROOT="$(cd ../.. && pwd)"

# Ensure root-level dependencies are installed (smoke-test-cli imports from root src/)
if [ ! -d "${HARNESS_ROOT}/node_modules" ]; then
  echo "Installing root-level dependencies (first run)..."
  ( cd "${HARNESS_ROOT}" && npm install --silent 2>&1 | tail -5 )
fi

echo "Setting up intermediate smoke test..."

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

# Seed the workspace with project scaffolding
echo "Seeding workspace project..."
mkdir -p agent/workspace/project
cat > agent/workspace/project/package.json << 'SEED_PKG'
{
  "name": "smoke-test-project",
  "version": "1.0.0",
  "description": "Intermediate smoke test project",
  "type": "commonjs",
  "main": "src/hello.js",
  "scripts": {
    "start": "node src/hello.js",
    "test": "jest"
  },
  "keywords": [],
  "license": "ISC"
}
SEED_PKG

cat > agent/workspace/project/.gitignore << 'SEED_GIT'
node_modules/
coverage/
dist/
*.log
.env
SEED_GIT

# Initialize isolated git repo in workspace/project
echo "Initializing isolated git repo in workspace/project..."
cd agent/workspace/project
git init
git add -A
git commit -m "Initial project scaffold"
cd "$SCRIPT_DIR"

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
  --subject "Step 1 - Create Hello World function" \
  --body "Please create a simple Hello World function as the foundation for our API project. Requirements: 1. Create a new file src/hello.js with a function named sayHello. 2. The function should return the string Hello, World! 3. Export the function using CommonJS (module.exports). Acceptance Criteria: Function exists and is exported, returns exactly Hello, World!, code is clean and simple. This is step 1 of a 3-step project." \
  --filename "001_step1_hello_function.md"

$CLI create-message \
  --base runtime_mailbox --agent smoke-test-agent --role developer --queue normal \
  --from "test_manager" \
  --to "smoke-test-agent_developer" \
  --subject "Step 2 - Refactor to Express REST API with OpenAPI" \
  --body "Refactor the Hello World function into a full REST API with Express.js and OpenAPI documentation. Requirements: 1. Install express, create src/server.js on port 3000. 2. GET /api/hello returns {message: Hello, World!}. POST /api/hello with {name: Alice} returns {message: Hello, Alice!}. 3. Install swagger-ui-express swagger-jsdoc, create openapi.yaml, serve Swagger UI at /api-docs. Acceptance Criteria: Server starts, both endpoints work, Swagger UI accessible." \
  --filename "002_step2_express_api.md"

$CLI create-message \
  --base runtime_mailbox --agent smoke-test-agent --role developer --queue normal \
  --from "test_manager" \
  --to "smoke-test-agent_developer" \
  --subject "Step 3 - Generate API client and write integration tests" \
  --body "Create an API client from the OpenAPI spec and write comprehensive integration tests using Jest. Requirements: 1. Generate a JavaScript client from openapi.yaml in src/client/. 2. Install jest and supertest, create tests/integration.test.js. 3. Test cases: GET /api/hello returns 200 with Hello, World!; POST /api/hello with name returns personalized greeting; POST with no name defaults to World; GET /api-docs returns 200. Acceptance Criteria: All tests pass, client is generated." \
  --filename "003_step3_client_tests.md"

echo ""
echo "Intermediate smoke test setup complete!"
echo ""
echo "To run the test:"
echo "  cd agent"
echo "  npm start"
