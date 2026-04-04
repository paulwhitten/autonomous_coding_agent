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
  --from "localhost_manager" \
  --to "smoke-test-agent_developer" \
  --subject "Step 1 - Create Hello World function" \
  --body "Create a Hello World function as the foundation for our API project. Requirements: 1. Create src/hello.js with a function named sayHello that accepts an optional name parameter. 2. If name is provided, return Hello, <name>! -- otherwise return Hello, World! 3. Export the function using CommonJS (module.exports = { sayHello }). Acceptance Criteria: src/hello.js exists and exports sayHello; sayHello() returns Hello, World!; sayHello('Alice') returns Hello, Alice!; node -e \"const {sayHello}=require('./src/hello'); console.log(sayHello())\" prints Hello, World! Notes: Step 1 of 4. The function accepts an optional name parameter now so step 2 can use it directly." \
  --filename "001_step1_hello_function.md"

$CLI create-message \
  --base runtime_mailbox --agent smoke-test-agent --role developer --queue normal \
  --from "localhost_manager" \
  --to "smoke-test-agent_developer" \
  --subject "Step 2 - Express REST API" \
  --body "Wrap the existing sayHello function in an Express REST API. Requirements: 1. Run npm install express. 2. Create src/app.js exporting an Express app (do NOT call app.listen() in this file). Define GET /api/hello returning {message: Hello, World!} and POST /api/hello accepting {name: string} returning {message: Hello, <name>!}. Use express.json() middleware. Both routes call sayHello from ./hello.js. 3. Create src/server.js importing app from ./app.js, calling app.listen(3000). Export app for testing. 4. Set package.json start script to node src/server.js. Acceptance Criteria: npm start starts server on port 3000; GET /api/hello returns {message:Hello, World!}; POST /api/hello with {name:Bob} returns {message:Hello, Bob!}; src/app.js exports app without calling .listen(). Notes: Step 2 of 4. Separating app.js from server.js lets step 4 test with supertest without port conflicts." \
  --filename "002_step2_express_api.md"

$CLI create-message \
  --base runtime_mailbox --agent smoke-test-agent --role developer --queue normal \
  --from "localhost_manager" \
  --to "smoke-test-agent_developer" \
  --subject "Step 3 - Add OpenAPI documentation" \
  --body "Add OpenAPI/Swagger documentation to the Express API from step 2. Requirements: 1. Run npm install swagger-ui-express. Do not install swagger-jsdoc -- use a hand-written spec file. 2. Create openapi.yaml (or openapi.json) in the project root with an OpenAPI 3.0 spec documenting GET /api/hello and POST /api/hello, including request body schema for POST and response schemas. 3. Mount Swagger UI at /api-docs in src/app.js using swagger-ui-express. Acceptance Criteria: openapi.yaml or openapi.json exists with valid OpenAPI 3.0 content; both endpoints documented; GET /api-docs/ returns HTML containing swagger; server still starts with npm start. Notes: Step 3 of 4. Keep the spec simple." \
  --filename "003_step3_openapi_docs.md"

$CLI create-message \
  --base runtime_mailbox --agent smoke-test-agent --role developer --queue normal \
  --from "localhost_manager" \
  --to "smoke-test-agent_developer" \
  --subject "Step 4 - Write integration tests" \
  --body "Write integration tests for the Express API using Jest and supertest. Requirements: 1. Run npm install --save-dev jest supertest. 2. Create tests/integration.test.js. Use supertest with const app = require('../src/app') -- no .listen() needed, supertest binds to an ephemeral port. 3. Write at least 4 tests: (a) GET /api/hello returns 200 with {message:Hello, World!}; (b) POST /api/hello with {name:Alice} returns 200 with {message:Hello, Alice!}; (c) POST /api/hello with {} returns 200 with {message:Hello, World!}; (d) GET /api-docs/ returns 200 or 301 with response containing swagger. 4. Set package.json scripts.test to jest. 5. Run npx jest, all tests must pass. Acceptance Criteria: tests/integration.test.js exists with 4+ tests; npx jest exits with code 0; no port conflicts or hanging processes; package.json scripts.test is jest. Notes: Step 4 of 4. Completes the project." \
  --filename "004_step4_integration_tests.md"

echo ""
echo "Intermediate smoke test setup complete!"
echo ""
echo "To run the test:"
echo "  cd agent"
echo "  npm start"
