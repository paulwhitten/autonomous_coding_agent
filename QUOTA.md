# Quota Management Guide

## Overview

When running multiple autonomous agents on a **single GitHub Copilot account**, they share one monthly quota pool. Proper quota management prevents all agents from being blocked mid-month.

## Your Shared Quota

**Check your account quota:** https://github.com/settings/billing

### Premium Request Allocation

If you have **Copilot Pro** (individual plan):
- Monthly allowance: **500 premium requests**
- Resets: 1st of each month at 00:00 UTC
- Shared across: VS Code, CLI, all agents, Spark, etc.

If you have **Copilot Business/Enterprise**:
- Check with your org admin for allowance
- May have additional paid usage enabled

## Model Multipliers

**FREE models** (0x - paid plans only):
- `gpt-4.1`, `gpt-4o`, `gpt-5-mini` ← Use these!

**Standard models** (1x):
- `claude-sonnet-4.5`, `gpt-5`, `gemini-3-pro-preview`

**Cheap model** (0.5x):
- `claude-haiku-4.5` - 2 prompts = 1 request

**Premium model** (3x):
- `claude-opus-4.5` - 1 prompt = 3 requests!

## Quota Strategies

### Preset: `conservative` (Default)
```json
{
  "quota": {
    "preset": "conservative"
  }
}
```
- Daily limit: 15 requests
- Switches to cheaper model at 50% monthly quota
- **Good for:** 24/7 operation with 2-3 agents

### Preset: `adaptive` (Recommended for Multi-Agent)
```json
{
  "quota": {
    "preset": "adaptive"
  }
}
```
- Daily limit: 20 requests
- HIGH priority tasks always use primary model
- NORMAL tasks switch at 75% quota
- LOW tasks switch at 50% or skip if daily limit hit
- **Good for:** Mixed workloads with priorities

### Preset: `budget`
```json
{
  "quota": {
    "preset": "budget"
  }
}
```
- Monthly: 300, Daily: 10
- Starts with `gpt-4.1` (free), falls to `claude-haiku-4.5` (cheap)
- Pauses until next day when daily limit hit
- **Good for:** Strict cost control

### Preset: `aggressive`
```json
{
  "quota": {
    "preset": "aggressive"
  }
}
```
- No fallback, uses premium model until exhausted
- **Good for:** Short sprints or demos

### Preset: `development`
```json
{
  "quota": {
    "preset": "development"
  }
}
```
- High daily limit (50)
- Just warns, doesn't block
- **Good for:** Testing and development

## Hybrid Approach - Overriding Presets

Start with a preset, customize with overrides:

```json
{
  "quota": {
    "preset": "adaptive",
    "overrides": {
      "limits": {
        "monthly": 400,
        "daily": 15
      },
      "modelFallback": {
        "primary": "gpt-5",
        "fallback": "gpt-4.1"
      }
    }
  }
}
```

## Multi-Agent Quota Allocation Example

**Scenario:** 500 monthly requests, 3 agents

### Option 1: Equal Split
- **Agent 1 (researcher):** 165/month = ~5/day
- **Agent 2 (developer):** 165/month = ~5/day  
- **Agent 3 (qa):** 165/month = ~5/day
- **Buffer:** 5 for emergencies

Each agent config:
```json
{
  "quota": {
    "preset": "adaptive",
    "overrides": {
      "limits": {
        "monthly": 165,
        "daily": 5
      }
    }
  }
}
```

### Option 2: Priority-Based
- **Researcher (HIGH):** 250/month = ~8/day (needs depth)
- **Developer (NORMAL):** 175/month = ~6/day
- **QA (LOW):** 75/month = ~2/day (lightweight validation)

### Option 3: Use FREE Models
**Best approach:** Configure all agents to use FREE models by default:

```json
{
  "copilot": {
    "model": "gpt-4.1"
  },
  "quota": {
    "enabled": false
  }
}
```

**Unlimited requests with `gpt-4.1`, `gpt-4o`, `gpt-5-mini`!**

Only use premium models for specific high-value tasks.

## Monitoring Shared Quota

### Check Manually
```bash
# Visit GitHub
open https://github.com/settings/billing
```

### Set Budget Alerts
1. Go to: https://github.com/settings/billing
2. Click "Set a budget"
3. Set alerts at 75%, 90%, 100%

### Agent-Level Tracking
Each agent tracks its own usage in `workspace/quota_state.json`:

```json
{
  "month": "2026-01",
  "used": {
    "monthly": 42,
    "today": 3,
    "byModel": {
      "claude-sonnet-4.5": 30,
      "gpt-4.1": 12
    }
  }
}
```

**Note:** This is LOCAL tracking. The true quota is on GitHub's side.

## Best Practices for Multi-Agent

### 1. **Use FREE models** (`gpt-4.1`) for routine work
- Unlimited on paid plans
- Good performance for most tasks
- Save premium requests for complex work

### 2. **Stagger agent check intervals**
- Agent 1: Check every 20 min
- Agent 2: Check every 25 min
- Agent 3: Check every 30 min
- Prevents quota spikes

### 3. **Set conservative daily limits**
- Better to pause one agent than block all
- Daily limits act as circuit breakers

### 4. **Use priority-aware strategies**
- `adaptive` preset respects task priority
- HIGH priority bypasses some limits
- LOW priority tasks can be skipped

### 5. **Monitor regularly**
```bash
# Weekly check
open https://github.com/settings/billing
```

### 6. **Coordinate offline**
- Temporarily disable non-critical agents mid-month
- Save quota for end-of-month deadlines

## Behavior on Limit Reached

### Daily Limit
- `"pause"` - Pause agent for N hours
- `"pauseUntilNextDay"` - Wait until midnight UTC
- `"warn"` - Log but continue (uses monthly quota)
- `"fallback"` - Switch to cheaper model

### Monthly Limit
- `"stop"` - Shutdown agent until next month
- `"warn"` - Continue with warnings
- `"fallback"` - Use FREE models only

## Example Configs for Common Scenarios

### 24/7 Researcher (Deep Analysis)
```json
{
  "copilot": { "model": "claude-sonnet-4.5" },
  "quota": {
    "preset": "adaptive",
    "overrides": {
      "limits": { "monthly": 250, "daily": 8 },
      "priorityRules": {
        "HIGH": { "alwaysUsePrimary": true }
      }
    }
  }
}
```

### Lightweight QA Agent
```json
{
  "copilot": { "model": "gpt-4.1" },
  "quota": {
    "enabled": false
  }
}
```

### Developer with Fallback
```json
{
  "copilot": { "model": "claude-sonnet-4.5" },
  "quota": {
    "preset": "adaptive",
    "overrides": {
      "limits": { "monthly": 200, "daily": 6 },
      "modelFallback": {
        "fallback": "gpt-4.1",
        "switchAt": 0.6
      }
    }
  }
}
```

## Troubleshooting

**"Premium requests rejected"**
- Check: https://github.com/settings/billing
- Likely hit monthly limit
- Solution: Wait until month resets or use FREE models

**"Multiple agents blocked simultaneously"**
- Shared quota exhausted
- Solution: Disable some agents, use FREE models

**"Can't track who used what"**
- GitHub doesn't show per-agent breakdown
- Solution: Each agent tracks locally in `quota_state.json`

## Resources

- **Your billing page:** https://github.com/settings/billing
- **Premium requests docs:** https://docs.github.com/en/copilot/managing-copilot/monitoring-usage-and-entitlements/about-premium-requests
- **Model comparison:** https://docs.github.com/en/copilot/reference/ai-models/model-comparison

---

**Recommendation:** Start all agents with `gpt-4.1` (FREE), only use premium models for specific high-value research or complex coding tasks.
