# Borderline Task (125 seconds)

This task should take just over the base timeout of 120 seconds.

## Expected Behavior
- First attempt: SDK timeout at 120s
- Second attempt: Tier 1 strategy (2x timeout = 240s) should succeed

## Task
Run a 125-second computation and save results:

```bash
echo "Starting 125-second task at $(date)"
sleep 125
echo "Completed at $(date)" > workspace/borderline_task_result.txt
echo "SUCCESS: Task completed in 125 seconds"
```

## Success Criteria
- File `workspace/borderline_task_result.txt` exists
- Contains completion timestamp
- Task succeeds on second attempt with doubled timeout
