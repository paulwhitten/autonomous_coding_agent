# Smoke Tests

Automated smoke tests for the autonomous Copilot agent.

## Structure

```
smoke_tests/
├── basic/                    # Basic functionality test
│   ├── start_mailbox/        # Template mailbox (committed to git)
│   ├── runtime_mailbox/      # Runtime mailbox (gitignored, created by setup)
│   ├── agent/                # Agent instance (src copied during setup)
│   │   ├── config.template.json  # Configuration template
│   │   └── src/              # (gitignored, copied from ../../src)
│   ├── setup.sh              # Setup script
│   └── README.md
│
├── intermediate/             # Progressive REST API test
│   ├── start_mailbox/        # Template mailbox (committed to git)
│   ├── agent/                # Agent instance (src copied during setup)
│   │   ├── config.template.json  # Configuration template
│   │   └── src/              # (gitignored, copied from ../../src)
│   ├── setup.sh              # Setup script
│   └── README.md
│
└── longrunning/              # Long-running timeout test
    ├── start_mailbox/        # Template mailbox (committed to git)
    ├── runtime_mailbox/      # Runtime mailbox (gitignored, created by setup)
    ├── agent/                # Agent instance (src copied during setup)
    │   ├── config.template.json  # Configuration template
    │   └── src/              # (gitignored, copied from ../../src)
    ├── setup.sh              # Setup script
    └── README.md
```

## Test Suite Overview

| Test | Duration | What It Tests | Automation |
|------|----------|---------------|------------|
| **basic** | ~5 min | Basic task execution, verification | Manual start |
| **basic-scm** | ~5-10 min | Git operations, incremental commits | Manual start |
| **intermediate** | ~30-40 min | Progressive multi-step REST API build | Manual start |
| **longrunning** | ~25-30 min | Adaptive timeout strategies | Manual start |
| **multi-agent** | ~3-5 min | Priority mailbox, agent coordination | Manual start + injection |
| **regulatory** | ~15-30 min<br/>*(60 min timeout)* | V-model workflow, HIPAA traceability, 4-agent | **Automated** (run-test.sh) |
| **tool-delegation** | ~1-2 min | Manager delegation via send_message() | **Automated** (run-test.sh) |
| **wip-limit** | ~5-8 min | WIP limits, delegation backpressure | **Automated** (run-test.sh) |
| **workflow** | ~3-5 min | Workflow engine, state transitions | **Automated** (run-test.sh) |

**Note:** Tests marked "Automated" have run-test.sh scripts that handle setup, execution, and validation. Others require manual `npm start` after setup.

## Running Tests

All smoke tests now use compiled TypeScript (transpiled to JavaScript) for reliable execution.

### Basic Smoke Test

Tests basic agent functionality with simple tasks.

```bash
cd smoke_tests/basic
./setup.sh
cd agent
npm start
```

**Expected duration:** ~5 minutes  
**Tests:** Basic task execution, verification system

**Running in background:**
```bash
cd agent
nohup npm start > ../test.log 2>&1 &
tail -f ../test.log
```

### Intermediate Smoke Test

Tests progressive multi-step project execution with context preservation.

```bash
cd smoke_tests/intermediate
./setup.sh
cd agent
npm start
```

**Expected duration:** ~30-40 minutes  
**Tests:** 3-step progressive REST API build (Hello World → Express API → Client & Tests)

**Running in background:**
```bash
cd agent
nohup npm start > ../test.log 2>&1 &
tail -f ../test.log
```

### Long-Running Smoke Test

Tests adaptive timeout strategy with various timeout scenarios.

```bash
cd smoke_tests/longrunning
./setup.sh
cd agent
npm start
```

**Expected duration:** ~25-30 minutes  
**Tests:** Adaptive timeout tiers, pattern detection, failure handling

To run in background:
```bash
cd agent
nohup npm start > ../test.log 2>&1 &
tail -f ../test.log
```

### Regulatory V-Model Test

Tests 4-agent V-model regulatory evidence pipeline (RA, Developer, QA) with HIPAA traceability.

```bash
cd smoke_tests/regulatory
./run-test.sh  # Automated: setup, build, start agents, seed tasks, validate
```

**Expected duration:** ~15-30 minutes (60 minute timeout)  
**Tests:** V-model workflow, requirements traceability, evidence generation, multi-agent coordination

**Note:** This test runs automatically via run-test.sh (includes setup, execution, validation).

### Multi-Agent Priority Mailbox Test

Tests priority mailbox system with manager and developer agents.

```bash
cd smoke_tests/multi-agent
./setup.sh
cd developer/agent
nohup npm start > ../../test.log 2>&1 &

# In another terminal:
cd smoke_tests/multi-agent
./inject-manager-correction.sh
tail -f test.log
```

**Expected duration:** ~3-5 minutes  
**Tests:** Priority message interruption, mailbox folder routing

## Design Philosophy

### Build Process

**TypeScript Compilation:**
- Tests use compiled JavaScript (`dist/`) not TypeScript source
- `npm start` automatically builds TypeScript before running
- Build step: `npm run build` (runs `tsc`)
- Benefits: Type safety, reliable background execution, production-ready code

**Setup Process:**
1. Copy source (`src/`), `package.json`, `tsconfig.json` from parent
2. Run `npm install` to get dependencies (including TypeScript)
3. First `npm start` triggers build, creating `dist/`
4. Compiled JavaScript runs with Node.js (no tsx/ESM issues)

### Version Control Strategy

**Committed to Git:**
- `start_mailbox/` - Template messages for test scenarios
- `setup.sh` - Setup scripts
- `config.template.json` - Configuration templates
- Documentation (README files)

**Excluded from Git (via .gitignore):**
- `runtime_mailbox/` - Created during setup, contains test execution state
- `agent/src/` - Copied from `../../src` during setup (ensures fresh code)
- `agent/dist/` - Compiled JavaScript (build output)
- `agent/package.json` - Copied from `../../package.json` during setup
- `agent/tsconfig.json` - Copied from `../../tsconfig.json` during setup
- `agent/config.json` - Generated from `config.template.json` during setup
- `agent/node_modules/` - npm dependencies
- `agent/workspace/` - Agent working directory
- `agent/logs/` - Test logs

### Why This Structure?

1. **Fresh Code on Every Setup**
   - Source, package.json, and tsconfig.json copied from parent during `./setup.sh`
   - Each test builds from scratch (type checking + compilation)
   - Ensures smoke tests use latest code with type safety
   - No stale copies in version control
   - Single source of truth in parent directory

2. **Reproducible Tests**
   - `start_mailbox/` templates are committed
   - `setup.sh` creates clean environment every time
   - Independent of previous test runs
   - Consistent dependency versions

3. **Type Safety**
   - Compilation step catches type errors before runtime
   - Verified code runs in production mode (compiled JS)
   - Same build process as production deployment

3. **Clean Git History**
   - Test artifacts don't clutter git
   - Only test definitions and setup scripts are tracked
   - Easy to see what tests exist and what they do
   - No duplicate package.json management

4. **Easy Iteration**
   - Modify source in `../../src`
   - Update dependencies in parent `../../package.json`
   - Re-run `./setup.sh` to get fresh copies
   - No manual copying or cleanup needed

## Setup Script Details

Each `setup.sh` script:

1. **Cleans previous artifacts**
   - Removes `agent/src/`, `agent/package.json`, `agent/tsconfig.json`, `agent/node_modules/`, etc.
   
2. **Copies fresh source code**
   - `../../src/` → `agent/src/`
   - `../../package.json` → `agent/package.json`
   - `../../tsconfig.json` → `agent/tsconfig.json`

3. **Sets up test configuration**
   - `config.template.json` → `config.json`
   
4. **Builds and prepares**
   - Installs dependencies: `npm install`
   - Builds TypeScript: `npm run build`

5. **Sets up mailbox**
   - `start_mailbox/*.md` → `agent/mailbox/mailbox/to_<role>/`

5. **Installs dependencies**
   - Runs `npm install` in agent directory

## Modifying Tests

### To Add New Test Messages

Edit files in `start_mailbox/`:
```bash
cd smoke_tests/basic/start_mailbox
nano 003_new_test.md
```

Then re-run setup:
```bash
cd ..
./setup.sh
```

### To Change Test Configuration

Edit `agent/config.template.json`, then re-run `./setup.sh`

### To Add New Test Suite

1. Create new directory: `smoke_tests/newtest/`
2. Create subdirectories: `start_mailbox/`, `agent/`
3. Add test messages to `start_mailbox/`
4. Create `agent/config.template.json`
5. Create `setup.sh` (copy and modify from existing)
6. Update this README

## Test Results

After running tests, check:

- `agent/workspace/` - Work items and results
- `agent/logs/agent.log` - Detailed log
- `test.log` (if ran with nohup) - Console output
- `agent/workspace/timeout_events.json` - Timeout tracking (longrunning test)

## Troubleshooting

### Tests won't start

1. Re-run setup: `./setup.sh`
2. Check node version: `node --version` (need v18+)
3. Check npm install succeeded

### Agent exits immediately

1. Check `agent/logs/agent.log` for errors
2. Verify mailbox structure: `ls -R runtime_mailbox/`
3. Check config: `cat agent/config.json`

### listenerCount errors

Source code needs the fix from commit 3003072. Re-run `./setup.sh` to get fresh code.

### Node module errors

```bash
cd agent
rm -rf node_modules package-lock.json
npm cache clean --force
npm install
```

## Related Documentation

- `ADAPTIVE_TIMEOUT_STRATEGIES.md` - Timeout strategy framework
- `ORCHESTRATION_ISSUES.md` - Dependency and mailbox management
- `LISTENERCOUNT_BUG_FIX.md` - Recent bug fix documentation
