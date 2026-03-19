# Another Borderline Task (130 seconds)

This task tests pattern detection - multiple borderline timeouts in succession.

## Expected Behavior
- First attempt: SDK timeout at 120s
- Second attempt: Tier 1 strategy (2x timeout = 240s) should succeed
- Pattern detection: If Tier 4 threshold is met, should recommend category-specific timeout adjustment

## Task
Run another borderline computation:

```bash
echo "Starting 130-second task at $(date)"
sleep 130
echo "Completed at $(date)" > workspace/borderline_task_2_result.txt
echo "SUCCESS: Second borderline task completed in 130 seconds"
```

## Success Criteria
- File `workspace/borderline_task_2_result.txt` exists
- Task succeeds on second attempt
- If pattern detected, agent logs adaptive adjustment recommendation
