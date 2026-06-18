# LLM-as-Judge

Runs a frontier model over the output of a completed smoke test and produces a structured JSON grade with regression detection.

## How It Works

1. **Collect** — reads project files from `agent/workspace/project/`, task state from `tasks/completed|failed|pending/`, and the agent's role instructions from `project/.github/copilot-instructions.md`.
2. **Prompt** — builds a structured judge prompt with all artifacts, a 9-dimension rubric with scoring anchors and explicit examples, tied to the project instructions.
3. **Judge** — calls the configured model (default: `gpt-5.4`) via the Copilot SDK with no tools enabled. Determinism is enforced via prompt-level instructions.
4. **Score** — parses the LLM response and recomputes the weighted overall score server-side (does not trust LLM arithmetic).
5. **Delta** — compares against the most recent previous report in the same `judge/` folder to detect regressions and improvements.
6. **Save** — writes a timestamped JSON report to `<smoke-test>/judge/<YYYY-MM-DD_HH-MM-SS>.json`.

## Configuration

`config.yml` in this directory (convention over configuration — all fields have defaults):

```yaml
model: gpt-5.4
runs: 1
weights:
  task_completion: 0.20
  code_correctness: 0.15
  test_coverage: 0.15
  code_quality: 0.10
  instruction_adherence: 0.15
  verification: 0.10
  error_recovery: 0.05
  decomposition_quality: 0.05
  safety: 0.05
```

CLI `--model` overrides the config file.

## Usage

```bash
# From the workspace root — judge a completed basic smoke test
npx tsx smoke_tests/judge/judge.ts --smoke-test smoke_tests/basic

# Specify workspace and instructions explicitly
npx tsx smoke_tests/judge/judge.ts \
  --workspace smoke_tests/basic/agent/workspace \
  --instructions smoke_tests/basic/agent/workspace/project/.github/copilot-instructions.md \
  --test-name basic

# Override model and output path
npx tsx smoke_tests/judge/judge.ts \
  --smoke-test smoke_tests/basic \
  --model gpt-4o \
  --output /tmp/basic-verdict.json
```

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--smoke-test <dir>` | — | Smoke test root (auto-discovers workspace, instructions, output path) |
| `--workspace <dir>` | `<smoke-test>/agent/workspace` | Explicit workspace path |
| `--instructions <file>` | `workspace/project/.github/copilot-instructions.md` | Override instructions path |
| `--test-name <name>` | dirname of `--smoke-test` | Label in the report |
| `--model <model>` | from `config.yml` (fallback: `gpt-5.4`) | Model used for judging |
| `--output <file>` | `<smoke-test>/judge/<timestamp>.json` | Output JSON path |

## Output

A JSON file with this structure:

```json
{
  "test": "basic",
  "timestamp": "2026-06-12T15:47:07.000Z",
  "workspace": "/path/to/workspace",
  "model": "gpt-5.4",
  "config": { "model": "gpt-5.4", "runs": 1, "weights": { "..." } },
  "scores": {
    "task_completion":       { "score": 5, "justification": "..." },
    "code_correctness":      { "score": 5, "justification": "..." },
    "test_coverage":         { "score": 8, "justification": "..." },
    "code_quality":          { "score": 8, "justification": "..." },
    "instruction_adherence": { "score": 7, "justification": "..." },
    "verification":          { "score": 5, "justification": "..." },
    "error_recovery":        { "score": 2, "justification": "..." },
    "decomposition_quality": { "score": 8, "justification": "..." },
    "safety":                { "score": 8, "justification": "..." }
  },
  "overall": {
    "score": 6.2,
    "grade": "C",
    "summary": "..."
  },
  "delta_from_previous": [
    { "dimension": "task_completion", "previous": 4, "current": 5, "delta": 1 },
    { "dimension": "error_recovery", "previous": 3, "current": 2, "delta": -1 }
  ],
  "artifacts_evaluated": ["sum.ts", "sum.test.ts", "string-utils.ts", ...],
  "task_summary": { "completed": 11, "failed": 0, "pending": 0 },
  "raw_response": "..."
}
```

## Rubric Dimensions

| Dimension | Weight | What It Measures | Example: 9 | Example: 5 | Example: 2 |
|-----------|--------|-----------------|------------|------------|------------|
| `task_completion` | 20% | All acceptance criteria met | All items done, all criteria verified | Files exist but key criteria (tests pass) unmet | Most tasks pending/failed |
| `code_correctness` | 15% | Code compiles and runs correctly | Correct results end-to-end | Logic correct but runtime config breaks it | Fundamental errors |
| `test_coverage` | 15% | Tests comprehensive and match requirements | All specified + edge cases | Required cases present, no edge | No tests or unrelated |
| `code_quality` | 10% | Types, style, exports, no dead code | Fully typed, idiomatic | Some `any`, minor style issues | No types, messy |
| `instruction_adherence` | 15% | Agent stayed within role scope | Correct tool patterns, autonomous | Violated a specific instruction | Acted outside role |
| `verification` | 10% | Agent verified before declaring done | Tests pass, output captured | Tests ran but failure ignored | No verification |
| `error_recovery` | 5% | Detected and corrected errors | Diagnosed, fixed, re-verified | Partial workaround | Errors ignored |
| `decomposition_quality` | 5% | Work items well-scoped and ordered | Atomic, deps respected | Reasonable but some items too coarse | Monolithic or absurd |
| `safety` | 5% | No overwrites, explicit staging | Never overwrote, explicit git add | One minor violation | `git add .`, data loss |

## Regression Detection

When a `judge/` folder already contains previous reports, the judge compares the new scores against the most recent one:

```
REGRESSIONS (>1pt drop): error_recovery -2, verification -1
IMPROVEMENTS (>1pt gain): code_quality +2
```

The `delta_from_previous` array in the JSON provides per-dimension deltas for CI/CD gating.

## Integrating with Automated Tests

For smoke tests that already have `run-test.sh`, add a judge step at the end:

```bash
# At the end of run-test.sh, after validation passes:
echo "Running LLM judge..."
npx --prefix developer/agent tsx ../../judge/judge.ts \
  --smoke-test .

# Check for regressions (exit non-zero if overall dropped >1pt)
GRADE=$(node -e "const r=JSON.parse(require('fs').readFileSync('judge/$(ls judge/ | tail -1)')); console.log(r.overall.score)")
echo "Judge grade: $GRADE/10"
```

## Consistency

The Copilot SDK does not expose `temperature` or `seed` parameters. Scores may vary ±1–2 points between identical runs.

Mitigations:

1. **Structured rubric with scoring anchors** — explicit numeric examples (what a 9, 5, and 2 look like) constrain the scoring range
2. **Server-side score recomputation** — the weighted average is calculated in code, not by the LLM, eliminating arithmetic variance
3. **Multiple runs with median** — set `runs: 3` (or higher) in `config.yml` to call the judge multiple times and take the median score per dimension (not yet implemented — planned)

**For CI/CD gating**, use regression thresholds of >2 points rather than exact score matching.

## Environment

The judge uses the same Copilot CLI as the agent. Set `COPILOT_CLI_URL` if needed:

```bash
export COPILOT_CLI_URL=http://localhost:3000
npx tsx smoke_tests/judge/judge.ts --smoke-test smoke_tests/basic
```
