Date: 2025-12-28T10:30:00Z
From: localhost_manager
To: smoke-test-agent_researcher
Subject: Long-running computation (250 seconds)
Priority: NORMAL
MessageType: unstructured
---

Run a computation that takes approximately 250 seconds and save the results.

## Task

Execute the following shell commands in order:

```bash
echo "Starting 250-second task at $(date)"
sleep 250
echo "Completed at $(date)" > long_running_task_result.txt
echo "SUCCESS: Long task completed in 250 seconds"
```

If the task times out on direct execution, run it as a background process:

```bash
nohup bash -c 'sleep 250 && echo "Completed at $(date)" > long_running_task_result.txt' > long_task_log.txt 2>&1 &
echo $!
```

Then poll for completion by checking whether `long_running_task_result.txt` exists.

## Acceptance Criteria

- File `long_running_task_result.txt` exists in the project working directory
- The file contains a completion timestamp

## Notes

This task exceeds both the base SDK timeout (120s) and the Tier 1 extended timeout (240s). The agent is expected to use a background process pattern (Tier 2) to complete it.
