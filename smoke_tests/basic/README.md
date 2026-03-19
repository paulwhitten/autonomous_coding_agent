# Basic Smoke Test

Quick test of basic agent functionality.

## Purpose

Verify that the agent can:
- Process simple work items
- Execute TypeScript tasks
- Run verification
- Complete tasks successfully

## Test Scenarios

### 001: Basic Task Overview
Introduction to the test suite.

### 002: Create and Test Code
Create a TypeScript utility function with tests:
- Create `workspace/utils.ts` with `addNumbers` function
- Write tests in `workspace/utils.test.ts`
- Verify tests pass
- Generate summary

## Configuration

- **SDK Timeout:** 120s (2 minutes)
- **Check Interval:** 30s
- **Validation Mode:** Always (every item verified)
- **Adaptive Timeout:** Disabled (not needed for basic test)

## Expected Duration

~5 minutes

## Running the Test

```bash
# Setup (copies source, installs dependencies)
./setup.sh

# Run agent
cd agent
npm start
```

**Note:** `npm start` automatically compiles TypeScript and runs the compiled JavaScript.

**Run in background:**
```bash
cd agent
nohup npm start > ../test.log 2>&1 &
tail -f ../test.log

# To stop:
# Find PID: ps aux | grep "node dist/index.js"
# Kill: kill <PID>
```

## Success Criteria

- All work items complete without errors
- Files created in `agent/workspace/`:
  - `utils.ts` - TypeScript utility
  - `utils.test.ts` - Test file
  - `test_results.txt` - Summary
- Verification passes for all items
- No timeout errors

## Monitoring

```bash
# Watch real-time
tail -f agent/logs/agent.log

# Check results
ls -la agent/workspace/
cat agent/workspace/test_results.txt
```

## Troubleshooting

**Agent won't start:**
- Re-run `./setup.sh`
- Check `agent/logs/agent.log` for errors

**Tasks fail:**
- Check workspace permissions
- Verify npm dependencies installed
- Review error in `agent/logs/agent.log`
