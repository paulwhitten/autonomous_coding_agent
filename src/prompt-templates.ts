// Unified prompt template for work item execution

/**
 * Build execution prompt for any work item.
 * 
 * Replaces the former 3-way classification (code/tools/general) which was
 * a workaround for SDK tool-registration bugs that have since been fixed.
 * Tools are registered via the SDK and documented in copilot-instructions.md.
 */
export function buildWorkItemPrompt(
  workItem: { sequence: number; title: string; content: string },
  contextSummary: string,
  workingDir: string,
  agentRole?: string,
  teamMembers?: Array<{ hostname: string; role: string; responsibilities: string }>
): string {
  // Manager role: delegation-only prompt
  if (agentRole === 'manager') {
    // Provide team info inline as a hint; the agent also has get_team_roster() tool
    const teamHint = teamMembers && teamMembers.length > 0
      ? `\n**Your Team (also available via get_team_roster()):**\n${teamMembers.map(m => `  - hostname: ${m.hostname}, role: ${m.role} -- ${m.responsibilities}`).join('\n')}\n`
      : '\nUse get_team_roster() to discover your team members.\n';

    return `You are a PROJECT MANAGER. Your tool is send_message(). Your output is delegation messages.

**Your workflow for every work item:**
1. Read the work item to understand what needs doing
2. Identify which team member should do it (use get_team_roster() or the list below)
3. Call send_message(toHostname, toRole, subject, content, priority) with:
   - Clear task description and acceptance criteria
   - Which files/crates are involved
   - Instruction to push completed work to origin and include branch name in completion report
4. Once send_message() succeeds, this work item is DELEGATED -- move on to the next one
5. For validation tasks, send_message() to the QA agent
6. Check your mailbox for completion reports from previous delegations
${teamHint}
**Previously completed work items:**
${contextSummary}

**Current work item #${workItem.sequence}:**
Title: ${workItem.title}

Details:
${workItem.content}

**Action:** Delegate this work item now using send_message():`;
  }

  // Non-manager roles: standard execution prompt
  return `You are executing one work item from a decomposed assignment.
The agent runtime decomposed a mailbox/A2A assignment into sequential work items.
Work items are internal to this agent -- other agents cannot see them.
The agent runtime handles completion reporting and state transitions automatically
when all work items finish. Focus only on the current work item.

**CRITICAL: Working Directory**
- ALL project code must be created in: ${workingDir}
- This is your dedicated project output directory
- DO NOT create or modify files outside this directory
- DO NOT modify agent source code (src/ at project root)

**Previously completed work items:**
${contextSummary}

**Current work item #${workItem.sequence}:**
Title: ${workItem.title}

Details:
${workItem.content}

**Instructions:**
1. Work ONLY in the workspace directory: ${workingDir}
2. Build on the work completed in previous items
3. Complete this specific work item thoroughly
4. Use terminal commands freely — git, build tools, test runners, CLI tools
5. Use mailbox tools when the task involves team communication
6. **Test your work before considering it complete:**
   - Run any tests you create
   - Verify code compiles/runs successfully
   - If tests fail, debug and fix the issues
7. Only consider work complete when you've verified it works
8. Do NOT call send_completion_report() -- the agent runtime sends it automatically when all work items for this assignment finish

Begin this work item:`;
}
