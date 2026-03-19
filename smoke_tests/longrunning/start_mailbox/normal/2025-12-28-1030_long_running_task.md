# Long-Running Task (250 seconds)

This task exceeds even the doubled timeout and should trigger background process strategy.

## Expected Behavior
- First attempt: SDK timeout at 120s
- Second attempt: SDK timeout at 240s (Tier 1)
- Third attempt: Tier 2 strategy - Agent should use background process pattern

## Task
Run a 250-second data processing job:

```bash
echo "Starting 250-second task at $(date)"
sleep 250
echo "Completed at $(date)" > workspace/long_running_task_result.txt
echo "SUCCESS: Long task completed in 250 seconds"
```

## Success Criteria
- Agent recognizes need for background processing
- Uses nohup pattern: `nohup sleep 250 > log.txt 2>&1 & echo $!`
- Creates monitoring work item to check status
- Eventually confirms successful completion
