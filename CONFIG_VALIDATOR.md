# Config Validator

The config validator is a development tool that validates `config.json` files before running the agent.

## Purpose

The validator checks your configuration for:
- **Structural errors**: Missing required sections or fields
- **Type errors**: Wrong field types (string vs number vs boolean)
- **Value errors**: Invalid enums, out-of-range numbers
- **Reference errors**: Missing files (roles.json, workflow files, mailbox path)
- **Policy errors**: Invalid permission policies

This catches configuration mistakes before runtime, saving debugging time.

## Usage

```bash
# Validate config.json (default)
npx tsx scripts/validate-config.ts

# Validate custom config
npx tsx scripts/validate-config.ts path/to/custom-config.json

# Use in CI/CD pipeline
npx tsx scripts/validate-config.ts || exit 1
```

## What It Checks

### Agent Section

- **Required fields**: hostname, role, checkIntervalMs, stuckTimeoutMs, sdkTimeoutMs
- **Role enum**: Must be `developer`, `qa`, `manager`, or `researcher`
- **Intervals**: checkIntervalMs >= 20000ms (warns if < 20000ms for rate limit safety)
- **Validation mode**: Must be `none`, `spot_check`, `milestone`, or `always`
- **File references**: roleDefinitionsFile, customRolesFile, workflowFile must exist
- **Work item range**: minWorkItems >= 1, maxWorkItems >= minWorkItems
- **Retry count**: taskRetryCount >= 0
- **Timeout strategy**: Validates multiplier > 1.0, threshold values
- **Backpressure**: Validates enabled flag and limits

### Mailbox Section

- **Required fields**: repoPath, gitSync, autoCommit, commitMessage, supportBroadcast, supportAttachments
- **Path validation**: Checks if mailbox directory exists
- **Git validation**: Warns if gitSync enabled but not a git repository

### Copilot Section

- **Required fields**: model, allowedTools
- **AllowedTools**: Must be `"all"` or an array of tool names
- **Permissions**: Validates shell, write, read, url, mcp policies
- **Permission policies**: 
  - shell: `allow`, `deny`, `workingDir`, or `allowlist`
  - write/read: `allow`, `deny`, or `workingDir`
  - url/mcp: `allow` or `deny`
- **shellAllowAdditional**: Must be an array if present

### Workspace Section

- **Required fields**: path, persistContext
- **Path validation**: Warns if workspace doesn't exist (will be created on first run)
- **Task subfolders**: Validates custom subfolder names if specified

### Logging Section

- **Required fields**: level, path, maxSizeMB
- **Level enum**: Must be `debug`, `info`, `warn`, or `error`
- **maxSizeMB**: Must be >= 1, warns if < 10MB (may rotate frequently)
- **Path validation**: Warns if log directory doesn't exist (will be created)

### Manager Section

- **Required fields**: hostname, role, escalationPriority
- **Priority enum**: Must be `HIGH`, `NORMAL`, or `LOW`

### Quota Section (optional)

- **Required fields**: enabled, preset
- **Presets file**: Validates presetsFile path exists if specified
- **Shared quota URL**: Validates type if present

## Output Format

### Valid Config

```
════════════════════════════════════════════════════════════════════════════════
📋 Config Validation
📄 /path/to/config.json
════════════════════════════════════════════════════════════════════════════════

✅ Config is valid!
```

Exit code: 0

### Invalid Config

```
════════════════════════════════════════════════════════════════════════════════
📋 Config Validation
📄 /path/to/config.json
════════════════════════════════════════════════════════════════════════════════

❌ 3 ERRORS

  Field: agent.role
  Error: Invalid role: "devloper"
  Fix:   Must be one of: developer, qa, manager, researcher

  Field: agent.checkIntervalMs
  Error: checkIntervalMs too low: 5000ms
  Fix:   Minimum: 1000ms (1 second)

  Field: mailbox.repoPath
  Error: Mailbox path not found: ../missing-mailbox
  Fix:   Create mailbox directory at /path/to/missing-mailbox

⚠️  2 WARNINGS

  Field: agent.checkIntervalMs
  Warning: checkIntervalMs is 15000ms (below recommended 20000ms)
  Suggestion: May cause SDK rate-limit errors (HTTP 429). Recommended: 60000ms (60s)

  Field: logging.maxSizeMB
  Warning: maxSizeMB is 5MB (may rotate frequently)
  Suggestion: Recommended: 100MB or higher for autonomous agents
```

Exit code: 1

## JSON Comment Support

The validator supports JSON with comments (JSONC):

```json
{
  "agent": {
    // This is a comment
    "hostname": "auto-detect",
    "role": "developer",  // inline comment
    /* Block comment */
    "checkIntervalMs": 60000
  }
}
```

Comments are automatically stripped before validation.

## Common Errors and Fixes

### Missing Required Section

```
❌ ERROR
Field: agent
Error: Missing required section: agent
Fix:   Add "agent": {...} section to config
```

**Fix**: Add the missing top-level section.

### Invalid Enum Value

```
❌ ERROR
Field: agent.role
Error: Invalid role: "developer123"
Fix:   Must be one of: developer, qa, manager, researcher
```

**Fix**: Use exact enum value (case-sensitive).

### File Not Found

```
❌ ERROR
Field: agent.roleDefinitionsFile
Error: File not found: ./roles.json
Fix:   Create roles file at /path/to/roles.json
```

**Fix**: Create the referenced file or update the path.

### Invalid Timeout

```
⚠️  WARNING
Field: agent.checkIntervalMs
Warning: checkIntervalMs is 15000ms (below recommended 20000ms)
Suggestion: May cause SDK rate-limit errors (HTTP 429). Recommended: 60000ms (60s)
```

**Fix**: Increase to 20000ms or higher to avoid rate limits.

### Invalid Type

```
❌ ERROR
Field: agent.checkIntervalMs
Error: Invalid type for agent.checkIntervalMs: expected number, got string
Fix:   Change to number type
```

**Fix**: Remove quotes around number values.

### Invalid Permission Policy

```
❌ ERROR
Field: copilot.permissions.shell
Error: Invalid permission policy: "maybe"
Fix:   Must be one of: allow, deny, workingDir, allowlist
```

**Fix**: Use valid permission policy value.

## Integration with Development Workflow

### Before First Run

```bash
# 1. Copy example config
cp config.example.json config.json

# 2. Edit config
nano config.json

# 3. Validate before running
npx tsx scripts/validate-config.ts

# 4. Fix any errors
# ... edit config.json ...

# 5. Validate again
npx tsx scripts/validate-config.ts

# 6. Run agent
npm start
```

### In CI/CD Pipeline

```yaml
# .github/workflows/validate.yml
name: Validate Config

on: [push, pull_request]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm install
      - run: npx tsx scripts/validate-config.ts config.json
```

### With npm Scripts

```json
{
  "scripts": {
    "validate:config": "tsx scripts/validate-config.ts",
    "validate:workflows": "tsx scripts/validate-workflow.ts workflows/*.workflow.json",
    "validate:all": "npm run validate:config && npm run validate:workflows",
    "prestart": "npm run validate:all"
  }
}
```

This runs validation automatically before `npm start`.

## Comparison to Other Tools

| Tool | Purpose | When to Use |
|------|---------|-------------|
| **validate-config.ts** | Validate config.json structure and values | Before running agent, in CI/CD |
| **validate-workflow.ts** | Validate workflow JSON files | Before using workflows |
| **test-workflow.ts** | Test workflow state machine logic | Before deploying workflows |
| **TypeScript compiler** | Type-check agent source code | During development |

All tools are complementary - use them together for comprehensive validation.

## Exit Codes

- **0**: Config is valid (no errors)
- **1**: Config has errors (validation failed)

Warnings do not cause non-zero exit codes - only errors.

## Related Documentation

- [README.md](../README.md) - Main documentation
- [WORKFLOW_HELLO_WORLD.md](../WORKFLOW_HELLO_WORLD.md) - Workflow tutorial
- [workflows/README.md](../workflows/README.md) - Workflow documentation
- [src/types.ts](../src/types.ts) - Type definitions
- [src/permission-handler.ts](../src/permission-handler.ts) - Permission policies

## Implementation Details

The validator is implemented in TypeScript using Node.js fs module:

- **Comment stripping**: Line-by-line parsing to handle // comments safely
- **Type checking**: Runtime validation against TypeScript interface definitions
- **Path resolution**: Resolves relative paths from config directory
- **Enum validation**: Checks against allowed values for each field
- **Range validation**: Ensures numeric values are within safe limits
- **Reference checking**: Verifies file paths exist before agent starts

Source: [scripts/validate-config.ts](../scripts/validate-config.ts)
