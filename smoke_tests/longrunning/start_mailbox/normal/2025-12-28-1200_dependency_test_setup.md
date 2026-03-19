# Dependency Test - Setup (Will Fail)

This task intentionally fails to test dependency handling.

## Expected Behavior
- Task should fail after timeout or error
- Agent should log failure
- Subsequent task 006 depends on this task's output

## Task
Create a data file, but introduce a failure:

```bash
echo "Starting setup task at $(date)"
sleep 20
# Intentionally fail
exit 1
```

## Success Criteria
- Task fails as expected
- Agent logs the failure
- Moves to next work item despite failure

## Notes
This tests the orchestration question: What happens when task 006 depends on this task's output?
