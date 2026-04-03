# Team Discovery and Collaboration

Agents working in multi-agent teams can discover and coordinate with other team members.

## Available Tools

### get_team_roster()
Get the complete team roster with all agents, roles, and capabilities.

**When to use:**
- Starting a new session (familiarize yourself with the team)
- Need an overview of available resources
- Planning task delegation

**Example:**
```
I'm new to this team. Let me see who's available.
[calls get_team_roster()]
Team has 5 agents: 2 developers, 1 QA, 1 researcher, 1 manager
```

### find_agents_by_role(role)
Find all agents with a specific role.

**When to use:**
- Need to delegate to a specific role type
- Looking for peers with same role
- Manager assigning role-specific tasks

**Example:**
```
I need to assign this coding task to a developer.
[calls find_agents_by_role("developer")]
Found 2 developers: dev-server-1_developer, dev-server-2_developer
```

### find_agents_by_capability(capability)
Find agents with specific skills or specializations.

**When to use:**
- Need specialist help (e.g., "python", "validation")
- Task requires specific expertise
- Looking for the right person for the job

**Example:**
```
I need help validating CSV data.
[calls find_agents_by_capability("csv-analysis")]
Found qa-server_qa with validation expertise
I'll send them the data for review.
```

### get_agent_info(agentId)
Get detailed information about a specific agent.

**When to use:**
- Need to know more about an agent before delegating
- Checking timezone for coordination
- Verifying capabilities

**Example:**
```
Let me check dev-server-1's capabilities before assigning.
[calls get_agent_info("dev-server-1_developer")]
Capabilities: python, circuit-processing, csv-generation
Perfect for this task!
```

## Collaboration Patterns

### Pattern 1: Task Delegation (Manager)
```
1. Receive task from user
2. Determine what skills are needed
3. find_agents_by_capability(needed_skill)
4. Select best match
5. Send message to selected agent's mailbox
```

### Pattern 2: Requesting Help (Developer)
```
1. Encounter a blocker or need expertise
2. find_agents_by_capability(skill_needed)
3. Send message requesting assistance
4. Continue with other work while waiting
```

### Pattern 3: Peer Review (QA)
```
1. Receive completion report from developer
2. Review the work
3. If issues found:
   - find_agents_by_role("developer")  
   - Send findings back to original developer
```

### Pattern 4: Team Coordination
```
1. Complex task requires multiple agents
2. get_team_roster()
3. Identify agents needed for different parts
4. Send coordinated messages to each
5. Track progress via mailbox
```

## When NOT to Use Team Tools

- **Solo agent** - If team.json doesn't exist, you're working alone
- **Direct instructions** - User tells you exactly who to contact
- **Self-sufficient** - Task is within your own capabilities
- **Already know** - You remember from previous team roster check

## Team Awareness in Role Definitions

Each role should understand team dynamics:

**Developer:**
- Can ask QA for validation help
- Can coordinate with other developers on large tasks
- Reports to manager on blockers

**QA:**
- Reviews work from developers
- Can escalate quality issues to manager
- May request clarification from developers

**Manager:**
- Assigns tasks based on agent capabilities
- Coordinates between agents
- Handles escalations from any team member

**Researcher:**
- Provides methodology guidance to developers
- Shares findings with whole team (broadcast)
- Can request specific literature from other researchers

## Automatic Team Discovery

Agents should check team roster:
1. **On startup** - Know who's on the team
2. **When delegating** - Find the right agent
3. **When stuck** - Find help
4. **Periodically** - Team composition may change

The roster is cached for 5 minutes to avoid repeated file reads.
