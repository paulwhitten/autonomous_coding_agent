# Long-Running Smoke Test

Tests adaptive timeout strategy with various SDK timeout scenarios.

## Purpose

Verify that the agent's adaptive timeout system works correctly:
- **Tier 1:** Retry with doubled timeout
- **Tier 2:** Recommend background process pattern
- **Tier 3:** Suggest decomposition
- **Tier 4:** Pattern detection and adaptive adjustment

Also tests:
- Failure handling
- Dependency cascade failures
- Sequential task processing

## Test Scenarios

### 001: Borderline Task (125 seconds)
- Exceeds base timeout (120s) slightly
- Should succeed on retry with 2x timeout (240s)
- **Tests:** Tier 1 (intelligent retry)

### 002: Long-Running Task (250 seconds)
- Exceeds even doubled timeout
- Should trigger Tier 2 (background process recommendation)
- **Tests:** Tier 2 (background process pattern)

### 003: Quick Task (30 seconds)
- Well within timeout
- Should complete immediately
- **Tests:** Baseline (no timeout issues)

### 004: Another Borderline (130 seconds)
- Similar to 001
- Multiple borderline tasks trigger pattern detection
- **Tests:** Tier 4 (pattern detection)

### 005: Failed Setup Task
- Intentionally fails
- Tests failure handling
- **Tests:** Error recovery

### 006: Dependent Task
- Depends on 005 (which failed)
- Should fail due to missing dependency
- **Tests:** Dependency cascade (orchestration issue)

## Configuration

### Adaptive Timeout Strategy

- **Base SDK Timeout:** 120s (2 minutes)
- **Tier 1 Multiplier:** 2x (240s extended timeout)
- **Tier 1 Max Timeout:** 600s (10 minutes)
- **Tier 2 Threshold:** 2 attempts (trigger background)
- **Tier 3 Threshold:** 3 attempts (suggest decomposition)
- **Tier 4 Window:** 3600s (1 hour for pattern detection)
- **Tier 4 Threshold:** 3 timeouts (trigger adaptation)

### Other Settings

- **Check Interval:** 30s
- **Validation Mode:** None (speed up test)
- **Adaptive Timeout:** **ENABLED**

## Expected Timeline

- **0-5 min:** Task 001 (borderline, 2 attempts)
- **5-15 min:** Task 002 (long-running, background pattern)
- **15-16 min:** Task 003 (quick success)
- **16-21 min:** Task 004 (borderline, pattern detection)
- **21-22 min:** Task 005 (failure)
- **22-23 min:** Task 006 (missing dependency failure)

**Total:** ~25-30 minutes

## Running the Test

```bash
# Setup (copies source, installs dependencies)
./setup.sh

# Run agent in foreground (see live output)
cd agent
npm start

# Or run in background
nohup npm start > ../test.log 2>&1 &
```

## Monitoring

```bash
# Watch real-time output
tail -f test.log

# Check detailed logs
tail -f agent/logs/agent.log

# Check timeout events
cat agent/workspace/timeout_events.json | jq

# Check work items
ls -la agent/workspace/work/
ls -la agent/workspace/completed/
ls -la agent/workspace/failed/
```

## Success Criteria

### Tier 1 (Intelligent Retry)
- Task 001 fails first attempt (120s timeout)
- Task 001 succeeds second attempt (240s timeout)
- Log shows: `Using timeout strategy: retry_extended {"timeout":"240s"}`

### Tier 2 (Background Process)
- Task 002 fails first attempt (120s)
- Task 002 fails second attempt (240s)
- Agent provides guidance about background process pattern
- Log mentions nohup or background execution

### Tier 3 (Decomposition)
- May not trigger if agent decomposes tasks automatically
- Would need a truly complex task to test

### Tier 4 (Pattern Detection)
- After 3+ timeouts, pattern analysis logs appear
- Recommendations for category-specific timeout adjustments

### Failure Handling
- Task 005 fails as expected
- Task 006 fails due to missing dependency
- Agent continues processing after failures
- Failures logged clearly

### Timeout Events
- File `agent/workspace/timeout_events.json` created
- Contains timeout records with metadata
- Metrics show success rates by tier

## Expected Results

After test completes, check:

```bash
# Timeout tracking
cat agent/workspace/timeout_events.json | jq '.metrics'

# Should show:
# {
#   "total_events": X,
#   "timeouts": Y,
#   "successes": Z,
#   "tier1_successes": A,
#   "tier2_activations": B,
#   ...
# }

# Completed items
ls agent/workspace/completed/

# Failed items (005, 006)
ls agent/workspace/failed/
```

## Troubleshooting

**Agent exits early:**
- Check for errors in `agent/logs/agent.log`
- listenerCount bug? Re-run `./setup.sh` to get fixed code

**No timeouts occurring:**
- Tasks may be decomposed too small
- Check if agent is using background pattern preemptively
- Review work items created in `agent/workspace/work/`

**Timeout events file missing:**
- TimeoutManager may not be initialized
- Check feature branch is being used
- Verify `timeoutStrategy.enabled: true` in config

## Related Documentation

- `../../ADAPTIVE_TIMEOUT_STRATEGIES.md` - Complete strategy framework
- `../../ORCHESTRATION_ISSUES.md` - Dependency management analysis
- `../../ADAPTIVE_TIMEOUT_IMPLEMENTATION.md` - Implementation details
