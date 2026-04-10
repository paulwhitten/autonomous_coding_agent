---
title: Quick Start Guide - Autonomous Copilot Agent
description: Step-by-step setup for getting an autonomous agent running with minimal configuration
ms.date: 2026-04-07
---

## 1. Initial Setup

```bash
cd autonomous_copilot_agent
npm install
```

## 2. Scaffold Your Project (Fastest Path)

```bash
npm run init
```

This creates `config.json`, a mailbox folder, and seeds a hello-world task.
Run `npm start` and the agent processes the task immediately.

For CI or Docker, use `npm run init -- --non-interactive`.

To start fresh (remove workspace, mailbox, logs, and session state):

```bash
npm run reset
```

Reset prompts for confirmation. Use `--yes` to skip the prompt, or
`--full` to also remove `config.json` for a complete re-scaffold.

## 3. Manual Configuration (Alternative)

If you prefer to create `config.json` by hand, you need only two fields.
Everything else has sensible defaults (see `src/config-defaults.ts`).

**Minimal config:**

```json
{
  "agent": { "role": "developer" },
  "mailbox": { "repoPath": "./shared-mailbox" }
}
```

The mailbox is a plain folder. No git repository is required.
The agent auto-detects your hostname, polls the mailbox every
60 seconds, uses `gpt-4.1`, and configures all workspace
folders with sensible defaults. The full effective configuration (defaults
merged with your overrides) is logged on every startup and hot-reload.

**Override only what you need:**

```json
{
  "agent": {
    "role": "developer",
    "checkIntervalMs": 1800000
  },
  "mailbox": {
    "repoPath": "./shared-mailbox"
  },
  "copilot": {
    "model": "gpt-5"
  }
}
```

See `config.example.json` for every available option with comments.

> **WARNING:** Do not set `checkIntervalMs` below `20000` (20 seconds).
> Lower values may trigger SDK rate-limit errors (HTTP 429).
> Use `60000` (1 min) for active development.

## 4. Test Mailbox Connection

```bash
npm run check-mailbox
```

Should show: `No new messages` (or list any existing messages)

## 5. Start the Agent

```bash
npm run start
```

You'll see:
```
Autonomous Copilot Agent
================================
Agent ID: your-hostname_developer
Mailbox: ./mailbox
Git Sync: disabled
================================

[INFO] Initializing autonomous agent
[INFO] Agent initialized successfully
[INFO] Starting autonomous agent loop
[INFO] Checking mailbox for new messages
[INFO] No new messages in mailbox
[INFO] Sleeping for 60s until next mailbox check
```

If you used `npm run init`, the seeded hello-world task will be picked up
on the first check.

## 6. Send a Test Task

Create a message file in the agent's inbox:

```bash
cd shared-mailbox/mailbox/to_your-hostname_developer/
nano 2026-01-30-2100_test_task.md
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

Save the file. If `gitSync` is enabled, also commit and push:
```bash
git add . && git commit -m "Test task" && git push
```

The agent will:
1. Pick up the message on next check
2. Process the task
3. Execute the work
4. Send completion report
5. Archive the message

## 7. Monitor Agent Activity

**Watch logs in real-time:**
```bash
tail -f logs/agent.log
```

**Check session context:**
```bash
cat workspace/session_context.json
```

## 8. Stop the Agent

Press `Ctrl+C` in the terminal running the agent.

You'll see:
```
Received SIGINT, shutting down gracefully...
[INFO] Stopping autonomous agent
```

## Configuration Examples

All examples below show only the overrides -- defaults fill in the rest.

### Slow Polling (30 minute checks)

```json
{
  "agent": { "role": "developer", "checkIntervalMs": 1800000 },
  "mailbox": { "repoPath": "../shared-mailbox" }
}
```

### Use a Different Model

```json
{
  "agent": { "role": "developer" },
  "mailbox": { "repoPath": "../shared-mailbox" },
  "copilot": { "model": "gpt-5" }
}
```

### Enable Git Sync (multi-agent collaboration)

```json
{
  "agent": { "role": "developer" },
  "mailbox": { "repoPath": "../shared-mailbox", "gitSync": true }
}
```

## Troubleshooting

### "Failed to load config"

* Make sure `config.json` exists in the project root
* Only `agent.role` and `mailbox.repoPath` are required; everything else defaults
* Validate JSON syntax: `node -e "JSON.parse(require('fs').readFileSync('config.json'))"`
* Check startup logs for the effective configuration dump

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

# Reset runtime state (workspace, mailbox, logs)
npm run reset

# Full reset including config.json
npm run reset -- --full

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
