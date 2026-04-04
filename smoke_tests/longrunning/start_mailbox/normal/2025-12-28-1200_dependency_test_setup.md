Date: 2025-12-28T12:00:00Z
From: localhost_manager
To: smoke-test-agent_researcher
Subject: Dependency test - create setup data
Priority: NORMAL
MessageType: unstructured
---

Create a data file for the next task to consume. This task intentionally fails to test how the agent handles downstream dependency failures.

## Task

Execute the following shell commands:

```bash
echo "Starting setup task at $(date)"
sleep 20
# Intentionally fail - do NOT create setup_data.txt
exit 1
```

## Acceptance Criteria

- The shell command exits with a non-zero status
- The agent logs the failure and moves on to the next work item
- File `setup_data.txt` does NOT exist (confirming the intentional failure)

## Notes

This task is designed to fail. The next task depends on `setup_data.txt` which this task does not produce. The purpose is to observe how the agent handles a failed prerequisite.
