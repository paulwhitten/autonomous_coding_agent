# Basic SCM Smoke Test

**Purpose:** Verify that the agent can use git incrementally as part of its work — initializing repos, staging, and committing after each logical unit of work.

## What This Tests

1. **git init** — Agent initializes a git repository in the working folder
2. **Incremental commits** — Each work item produces a separate git commit
3. **Progressive file creation** — Files are built up across multiple commits
4. **Clean working tree** — Agent stages and commits everything, no leftover changes
5. **Terminal tool usage** — Agent runs git commands via Copilot's terminal tool

## Test Scenario

**Single mailbox message:** "Build a calculator module incrementally with git"

The agent should break this into work items roughly like:
1. `git init`, create `calculator.ts` with `add()`, commit
2. Extend `calculator.ts` with `subtract()` and `multiply()`, commit
3. Create `calculator.test.ts` with tests, commit
4. Create `README.md`, commit

## Success Criteria

- `.git/` directory exists in project folder
- `calculator.ts` with 3 functions (add, subtract, multiply)
- `calculator.test.ts` with tests
- `README.md` with documentation
- ≥4 separate commits in `git log`
- Commits show progressive work (different files across commits)
- Clean working tree (`git status` shows nothing unstaged)

## Running

### Quick run (automated):
```bash
cd smoke_tests/basic-scm
bash run-test.sh
```

### Manual run:
```bash
cd smoke_tests/basic-scm
./setup.sh
cd agent
nohup npm start > ../test.log 2>&1 &
# Wait for completion, then:
cd ..
bash validate.sh
```

## Expected Duration

~5-10 minutes (git operations add overhead per work item)

## Failure Would Mean

- Agent can't use terminal tools to run git commands
- Agent doesn't commit incrementally (dumps everything in one commit)
- Agent ignores git instructions and just creates files
