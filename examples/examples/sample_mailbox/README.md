# Sample Mailbox Structure

This directory demonstrates the recommended structure for a multi-agent mailbox repository.

## Directory Structure

```
sample_mailbox/
├── mailbox/
│   ├── team.json                      # Team roster and agent capabilities
│   ├── to_all/                        # Broadcast messages to all agents
│   ├── to_dev-server-1_developer/     # Messages for dev-server-1
│   │   ├── priority/                  # High priority tasks
│   │   ├── normal/                    # Normal priority tasks
│   │   ├── background/                # Low priority tasks
│   │   └── archive/                   # Completed/processed messages
│   ├── to_dev-server-2_developer/
│   ├── to_qa-server_qa/
│   ├── to_research-server_researcher/
│   └── to_manager-server_manager/
└── attachments/                       # Shared files referenced by messages
    └── README.md
```

## Team Roster (team.json)

The `team.json` file defines:
- Team metadata (name, description, dates)
- All agents with their roles and capabilities
- Role summaries grouping agents by function

### Example Usage by Agents

**Finding specialists:**
```
Agent: I need help with CSV validation. Let me check who can help.
Tool: find_agents_by_capability("csv-analysis")
Result: qa-server_qa with capabilities ["validation", "csv-analysis"]
Agent: I'll send a message to qa-server_qa.
```

**Finding team members by role:**
```
Agent: I need to assign this task to a developer.
Tool: find_agents_by_role("developer")
Result: 2 developers - dev-server-1_developer, dev-server-2_developer
Agent: I'll check their capabilities to pick the right one.
```

**Getting full team roster:**
```
Agent: Let me see who's on the team.
Tool: get_team_roster()
Result: 5 agents across 4 roles
```

## Mailbox Folders

Each agent has their own mailbox with priority levels:
- **priority/** - Urgent tasks requiring immediate attention
- **normal/** - Standard tasks processed in order
- **background/** - Low priority tasks handled when idle
- **archive/** - Completed messages moved here automatically

## Message Format

Messages are markdown files with frontmatter:

```markdown
---
from: manager-server_manager
to: dev-server-1_developer
subject: Implement circuit parser
priority: NORMAL
date: 2026-02-06
---

# Task: Implement circuit parser

Please create a Python script to parse circuit files...

**Acceptance Criteria:**
- [ ] Parses .v files correctly
- [ ] Handles errors gracefully
- [ ] Includes unit tests

**Due:** End of day
```

## Broadcast Messages

Messages in `to_all/` are checked by all agents:
- Team announcements
- Protocol updates
- General information

Example: "New paper published - all agents should review"

## Attachments

Large files or binary data go in `/attachments/`:
- Circuit files
- Test data
- Reference documents
- Generated reports

Messages reference attachments by path:
```markdown
See attached circuit file: /attachments/circuit_001.v
```

## Git Integration

When `gitSync: true` in agent config:
- Agents pull before checking mailbox
- Agents commit and push after archiving messages
- Multiple agents can share the mailbox via Git
- History tracks all message flow

## Setting Up for Your Team

1. **Copy this structure:**
   ```bash
   cp -r examples/sample_mailbox /path/to/your/mailbox
   cd /path/to/your/mailbox
   ```

2. **Initialize Git:**
   ```bash
   git init
   git add .
   git commit -m "Initial mailbox setup"
   ```

3. **Customize team.json:**
   - Update agent IDs to match your hostnames
   - Set correct roles and capabilities
   - Add/remove agents as needed

4. **Create agent mailboxes:**
   ```bash
   for agent in $(jq -r '.agents[].id' mailbox/team.json); do
     mkdir -p mailbox/to_$agent/{priority,normal,background,archive}
   done
   ```

5. **Configure agents:**
   Update each agent's `config.json`:
   ```json
   {
     "mailbox": {
       "repoPath": "/path/to/your/mailbox",
       "gitSync": true,
       "autoCommit": true
     }
   }
   ```

6. **Push to shared repository (optional):**
   ```bash
   git remote add origin git@github.com:your-org/agent-mailbox.git
   git push -u origin main
   ```

## Best Practices

1. **Keep team.json updated** when agents join/leave
2. **Use descriptive agent IDs** (hostname_role format)
3. **Document capabilities** so agents can find specialists
4. **Clear archive folders** periodically (or let Git history handle it)
5. **Use priority levels** appropriately
6. **Reference attachments** by relative path from repo root
7. **Commit messages** should be descriptive for audit trail

## Tools Available to Agents

Agents have these tools for team discovery:
- `get_team_roster()` - Get full team information
- `find_agents_by_role(role)` - Find agents with specific role
- `find_agents_by_capability(capability)` - Find specialists
- `get_agent_info(agentId)` - Get details about specific agent

## Example Workflows

### Task Assignment
```
Manager: Who can handle Python data processing?
-> find_agents_by_capability("python")
-> Result: dev-server-1, dev-server-2
-> Check capabilities: dev-server-1 has "data-analysis"
-> Send task to dev-server-1
```

### Collaboration Request
```
Developer: I need validation help
-> find_agents_by_role("qa")
-> Result: qa-server_qa
-> Send message to qa-server_qa with test data
```

### Team Status Check
```
Manager: Let me see the full team
-> get_team_roster()
-> 5 agents: 2 developers, 1 QA, 1 researcher, 1 manager
```
