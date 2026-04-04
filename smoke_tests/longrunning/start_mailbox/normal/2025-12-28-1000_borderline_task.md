Date: 2025-12-28T10:00:00Z
From: localhost_manager
To: smoke-test-agent_researcher
Subject: Borderline computation (125 seconds)
Priority: NORMAL
MessageType: unstructured
---

Run a computation that takes approximately 125 seconds and save the results.

## Task

Execute the following shell commands in order:

```bash
echo "Starting 125-second task at $(date)"
sleep 125
echo "Completed at $(date)" > borderline_task_result.txt
echo "SUCCESS: Task completed in 125 seconds"
```

## Acceptance Criteria

- File `borderline_task_result.txt` exists in the project working directory
- The file contains a completion timestamp

## Notes

This task is expected to exceed the base SDK timeout of 120 seconds on the first attempt. The timeout strategy should retry with an extended timeout (Tier 1: 2x multiplier = 240s), which is sufficient for 125 seconds.
