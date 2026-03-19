# Quick Start Guide - Autonomous Copilot Agent

## 1. Initial Setup (5 minutes)

```bash
cd autonomous_copilot_agent
npm install
cp config.example.json config.json
```

## 2. Configure Your Agent

Edit `config.json`:

```json
{
  "agent": {
    "hostname": "auto-detect",     // Will auto-detect, or set manually
    "role": "developer",           // Your role: developer, qa, manager
    "checkIntervalMs": 1800000     // Check every 30 minutes
  },
  "mailbox": {
    "repoPath": "../2025-12-external-mailbox",  // Path to mailbox git repo
    "gitSync": true                 // Enable git operations
  }
}
```

> **WARNING:** Do not set `checkIntervalMs` below `20000` (20 seconds). Lower values may trigger SDK rate-limit errors (HTTP 429). Use `60000` (1 min) for active development.

## 3. Test Mailbox Connection

```bash
npm run check-mailbox
```

Should show: `No new messages` (or list any existing messages)

## 4. Start the Agent

```bash
npm run start
```

You'll see:
```
Autonomous Copilot Agent
================================
Agent ID: your-hostname_developer
Mailbox: ../2025-12-external-mailbox
Git Sync: enabled
================================

[INFO] Initializing autonomous agent
[INFO] Performing initial git sync...
[INFO] Git sync successful
[INFO] Agent initialized successfully
[INFO] Starting autonomous agent loop
[INFO] Checking mailbox for new messages
[INFO] Syncing from git remote...
[INFO] No new messages in mailbox
[INFO] Sleeping for 1800s until next mailbox check
```

## 5. Send a Test Task

While agent is running, create a test message in another terminal:

```bash
cd 2025-12-external-mailbox/mailbox
# Filename: Use UTC timestamp (recommended) or sequence number
nano to_your-hostname_developer/2026-01-30-2100_test_task.md
```

Content:
```markdown
Date: 2026-01-30 21:00 UTC
From: i9_manager
To: your-hostname_developer
Subject: Test Task

Your assignment:
- Create a simple "Hello, World!" program in the workspace
- Save it as hello.py
- Send completion report when done
```

**Naming Convention:** Message files can use UTC timestamps (`YYYY-MM-DD-HHMM_subject.md`) for automatic chronological ordering, or sequential prefixes (`001_subject.md`, `002_subject.md`) for simplicity.

Save and commit:
```bash
git add . && git commit -m "Test task" && git push
```

The agent will:
1. Pull the message on next check (or wait up to 30 min)
2. Process the task
3. Execute the work
4. Send completion report
5. Archive the message
6. Push changes to git

## 6. Monitor Agent Activity

**Watch logs in real-time:**
```bash
tail -f logs/agent.log
```

**Check session context:**
```bash
cat workspace/session_context.json
```

## 7. Stop the Agent

Press `Ctrl+C` in the terminal running the agent.

You'll see:
```
Received SIGINT, shutting down gracefully...
[INFO] Stopping autonomous agent
```

## Configuration Examples

### Fast Polling (1 minute checks)
```json
{
  "agent": {
    "checkIntervalMs": 60000
  }
}
```

### Different Mailbox Repo
```json
{
  "mailbox": {
    "repoPath": "/path/to/your/mailbox-repo"
  }
}
```

### Use Different Model
```json
{
  "copilot": {
    "model": "gpt-5"
  }
}
```

### Disable Git Sync (local testing)
```json
{
  "mailbox": {
    "gitSync": false,
    "autoCommit": false
  }
}
```

## Troubleshooting

### "Failed to load config"
- Make sure `config.json` exists in the project root
- Validate JSON syntax: `node -e "JSON.parse(require('fs').readFileSync('config.json'))"`

### "Git sync failed"
- Check that mailbox repo path is correct
- Ensure git repo is initialized: `cd <repoPath> && git status`
- Check you have push permissions

### "No new messages" but I sent one
- Agent checks every N minutes (default 30)
- Wait for next check or restart agent to check immediately
- Verify message is in correct folder: `mailbox/to_<hostname>_<role>/`

### Agent crashes on task
- Check logs: `tail logs/agent.log`
- Agent should auto-escalate failures to manager
- Session context is preserved across restarts

## Next Steps

- Read full documentation: `README.md`
- Explore mailbox tools: `src/tools/mailbox-tools.ts`
- Customize for your project: Edit config.json
- Add custom tools: See Copilot SDK docs

## Common Commands

```bash
# Start with custom config
npm run start my-config.json

# Development mode (auto-reload)
npm run dev

# Check mailbox manually
npm run check-mailbox

# View logs
tail -f logs/agent.log

# Check git status of mailbox
cd ../2025-12-external-mailbox && git status
```

## Integration with Multi-Agent Workflows

This agent is compatible with the git external mailbox protocol:
- Uses same mailbox protocol
- Supports `to_all/` broadcasts
- Archives processed messages
- Git-based coordination

For setup details, see: `../2025-12-external-mailbox/START_HERE.md`
