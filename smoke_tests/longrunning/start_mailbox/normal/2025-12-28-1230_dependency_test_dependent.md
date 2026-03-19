# Dependency Test - Dependent Task

This task depends on output from task 005, which failed.

## Expected Behavior
- Agent attempts to read file from task 005
- File doesn't exist (task 005 failed)
- Agent should detect missing dependency
- Question: Does agent skip? Fail? Continue blindly?

## Task
Process the data file created by task 005:

```bash
echo "Starting dependent task at $(date)"
# This should fail because task 005 didn't create the file
if [ -f "workspace/setup_data.txt" ]; then
    cat workspace/setup_data.txt > workspace/dependent_result.txt
    echo "SUCCESS: Processed dependency data"
else
    echo "ERROR: Missing dependency - setup_data.txt not found"
    exit 1
fi
```

## Success Criteria
- Agent detects missing dependency
- Agent behavior on missing dependency is logged

## Notes
This tests: Should dependencies be tracked explicitly? Should agent look backward at failed tasks?
