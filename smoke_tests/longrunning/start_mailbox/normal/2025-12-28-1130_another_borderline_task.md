Date: 2025-12-28T11:30:00Z
From: localhost_manager
To: smoke-test-agent_researcher
Subject: Second borderline computation (130 seconds)
Priority: NORMAL
MessageType: unstructured
---

Run a second borderline computation that takes approximately 130 seconds and save the results.

## Task

Execute the following shell commands in order:

```bash
echo "Starting 130-second task at $(date)"
sleep 130
echo "Completed at $(date)" > borderline_task_2_result.txt
echo "SUCCESS: Second borderline task completed in 130 seconds"
```

## Acceptance Criteria

- File `borderline_task_2_result.txt` exists in the project working directory
- The file contains a completion timestamp

## Notes

Like the first borderline task, this exceeds the base SDK timeout (120s) and should succeed on retry with the Tier 1 extended timeout (240s). Running multiple borderline tasks in sequence exercises the adaptive timeout pattern detector (Tier 4), which may recommend category-specific timeout adjustments after seeing repeated borderline timeouts.
