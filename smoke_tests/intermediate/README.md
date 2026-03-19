# Intermediate Smoke Test - Progressive REST API

Tests the agent's ability to build a complete REST API project progressively across multiple work items, maintaining context and building on previous work.

## Test Overview

This test validates:
- **Context Preservation**: Agent remembers work from previous steps
- **Progressive Complexity**: Each step builds on the last
- **Real Dependencies**: Express, Swagger, Jest, OpenAPI tooling
- **Integration Testing**: End-to-end API verification

## Test Scenario

### Step 1: Hello World Function (5-7 min)
Creates a simple Node.js module with a `sayHello()` function.

### Step 2: Express REST API (10-15 min)
Refactors the function into a full REST API with:
- Express.js server on port 3000
- GET /api/hello (generic greeting)
- POST /api/hello (personalized greeting)
- OpenAPI/Swagger documentation at /api-docs

### Step 3: Client & Tests (15-20 min)
Generates an API client and writes comprehensive tests:
- OpenAPI client generation
- Jest integration tests with supertest
- Test coverage for all endpoints
- Server lifecycle management

**Total Duration**: ~30-40 minutes

## Setup

Run the setup script to prepare a fresh test environment:

```bash
./setup.sh
```

This will:
1. Clean previous test artifacts
2. Copy fresh source from `../../src`
3. Copy `package.json` and `tsconfig.json` from parent
4. Seed `workspace/project/` with a `package.json` (`"type": "commonjs"`) and `.gitignore`
5. Initialize an isolated git repo in `workspace/project/` (prevents inheriting the parent repo)
6. Install dependencies
7. Set up mailbox with 3 work items

## Running the Test

```bash
cd agent
npm start
```

**Note:** `npm start` automatically compiles TypeScript and runs the compiled JavaScript.

**Run in background (recommended):**
```bash
cd agent  
nohup npm start > ../test.log 2>&1 &
tail -f ../test.log

# To stop:
# Find PID: ps aux | grep "node dist/index.js"
# Kill: kill <PID>
```

## Expected Behavior

1. **Step 1**: Agent creates `src/hello.js` with `sayHello()` function
2. **Step 2**: Agent:
   - Installs Express and Swagger dependencies
   - Refactors `hello.js` to accept name parameter
   - Creates `server.js` with REST endpoints
   - Creates `openapi.yaml` with API documentation
   - Verifies server starts and endpoints work
3. **Step 3**: Agent:
   - Installs Jest, supertest, openapi-generator
   - Generates API client from OpenAPI spec
   - Creates comprehensive integration tests
   - Runs tests to verify all pass

## Success Criteria

- All 3 work items completed without manager escalation
- Express server starts on port 3000
- GET /api/hello returns `{"message": "Hello, World!"}`
- POST /api/hello with name returns personalized greeting
- Swagger UI accessible at /api-docs
- API client successfully generated
- All Jest integration tests pass
- Context preserved across all 3 steps

## Monitoring

Watch for:
- Proper dependency installation (Express, Swagger, Jest, etc.)
- Port conflicts (if 3000 is in use)
- Server lifecycle in tests (proper beforeAll/afterAll)
- Test execution and pass rate

## What This Tests

1. **Multi-step project execution**: Can the agent complete a 3-phase project?
2. **Context memory**: Does the agent remember what it built in previous steps?
3. **Dependency management**: Can it install and use npm packages correctly?
4. **Testing discipline**: Does it write and run tests properly?
5. **API design**: Can it implement REST APIs following OpenAPI spec?

## Cleanup

The setup script automatically cleans up previous runs. To manually reset:

```bash
cd agent
rm -rf src node_modules workspace .copilot *.log config.json package.json tsconfig.json
rm -rf mailbox/mailbox/to_*/archive/*
mv mailbox/mailbox/to_*/archive/*.md mailbox/mailbox/to_*/
```
