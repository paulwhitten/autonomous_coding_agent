# Role-Based Configuration System

## Overview

The autonomous agent uses a **role-based configuration system** that automatically generates GitHub Copilot instructions based on your agent's role.

## How It Works

```
roles.json          →  Agent loads role definition
     ↓
config.json         →  Specifies role + settings  
     ↓
generate-instructions.ts → Generates copilot-instructions.md
     ↓
.github/copilot-instructions.md → Copilot reads this!
```

## Available Roles

### Developer
- **Focus:** Code implementation, testing, documentation
- **Responsibilities:** Write scripts, process data, debug, maintain version control
- **Escalate when:** Blocked by dependencies, unclear scope, stuck >30 min

### QA
- **Focus:** Validation, testing, protocol compliance
- **Responsibilities:** Verify deliverables, run tests, report bugs, audit compliance
- **Escalate when:** Critical bugs found, unclear acceptance criteria

### Manager
- **Focus:** Coordination, task assignment, decision making
- **Responsibilities:** Assign tasks, handle escalations, track progress, allocate resources
- **Escalate when:** User conflicts, multiple agents blocked, timeline at risk

### Researcher
- **Focus:** Literature review, SOTA analysis, methodology guidance
- **Responsibilities:** Survey papers, analyze methods, provide recommendations, critical evaluation
- **Working style:** Depth over speed - thorough analysis with citations
- **Escalate when:** Paywalled papers needed, contradictory findings, insufficient timeline

## Configuration Files

### `config.json`
Your agent's active configuration:
```json
{
  "agent": {
    "hostname": "auto-detect",
    "role": "researcher",
    "roleDefinitionsFile": "./roles.json"
  }
}
```

### `roles.json`
Role definitions with responsibilities, typical tasks, escalation triggers, and working styles.

### `.github/copilot-instructions.md` (Generated)
GitHub Copilot reads this file to understand your agent's role. **Automatically regenerated** on agent startup.

## Using the System

### 1. Choose Your Role

Edit `config.json`:
```json
{
  "agent": {
    "role": "researcher"  // developer, qa, manager, or researcher
  }
}
```

### 2. Generate Instructions

```bash
npm run generate-instructions
```

Or the agent generates it automatically on startup.

### 3. Verify Output

Check `.github/copilot-instructions.md` - this is what Copilot sees!

## Adding New Roles

Edit `roles.json` and add your role:

```json
{
  "your_role": {
    "name": "Your Role Name",
    "description": "What this role does",
    "primaryResponsibilities": [...],
    "typicalTasks": [...],
    "notYourJob": [...],
    "escalationTriggers": [...]
  }
}
```

Then regenerate instructions.

## Best Practices

Following [GitHub's official guidelines](https://docs.github.com/en/copilot/customizing-copilot/adding-custom-instructions-for-github-copilot):

**Do:**
- Keep instructions under 2 pages
- Be specific about responsibilities
- Provide concrete examples
- Define clear escalation rules
- Reference actual tools available

**Avoid:**
- Vague descriptions ("be helpful")
- Contradictory priorities
- Micromanaging every detail
- Task-specific instructions (should be general)

## Integration with Mailbox

The generated instructions include:
- Your mailbox path
- Git sync workflow
- Communication format
- Available tools
- Manager escalation target

Everything Copilot needs to work autonomously!

## Debugging

**Instructions not working?**

1. Check `.github/copilot-instructions.md` was generated
2. Verify `roles.json` has your role defined
3. Restart Copilot session (if using CLI interactively)
4. Check Copilot is loading repo-level instructions

**Role info not showing up?**

The autonomous agent loads it on startup. Check logs:
```bash
tail -f logs/agent.log
```

You should see: `Copilot instructions generated`
