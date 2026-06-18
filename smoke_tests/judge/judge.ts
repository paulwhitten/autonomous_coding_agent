// LLM-as-Judge for Autonomous Agent Smoke Tests
//
// Collects workspace artifacts from a completed smoke test run, sends them to
// a frontier model with a multidimensional rubric, and saves a structured JSON
// verdict.  Judging criteria are tied to the project and to the role
// instructions in the workspace (.github/copilot-instructions.md).
//
// Features:
//   - 9-dimension rubric with scoring anchors and explicit examples
//   - Configurable weights via config.yml (convention over configuration)
//   - Delta-from-previous tracking for regression detection
//
// Usage:
//   npx tsx smoke_tests/judge/judge.ts --smoke-test smoke_tests/basic
//   npx tsx smoke_tests/judge/judge.ts --workspace ./path/to/workspace --test-name basic
//
// Options:
//   --smoke-test <dir>     Smoke test root (auto-discovers workspace, instructions, output path)
//   --workspace <dir>      Explicit path to agent workspace/ directory
//   --instructions <file>  Override path to copilot-instructions.md
//   --test-name <name>     Label for the report (defaults to smoke-test dir basename)
//   --model <model>        Model for judging (default from config.yml, fallback: gpt-5.4)
//   --output <file>        Output JSON path (default: <smoke-test>/judge/<timestamp>.json)

import { CopilotClient } from '@github/copilot-sdk';
import { SessionManager } from '../../src/session-manager.js';
import fs from 'fs/promises';
import path from 'path';
import { parseArgs } from 'node:util';
import pino from 'pino';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const ALL_DIMENSIONS = [
  'task_completion',
  'code_correctness',
  'test_coverage',
  'code_quality',
  'instruction_adherence',
  'verification',
  'error_recovery',
  'decomposition_quality',
  'safety',
] as const;

type Dimension = typeof ALL_DIMENSIONS[number];

interface DimensionScore {
  score: number;        // 0–10
  justification: string;
}

type Scores = Record<Dimension, DimensionScore>;

interface JudgeVerdict {
  scores: Scores;
  overall: {
    score: number;    // weighted average, one decimal
    grade: string;    // A / B / C / D / F
    summary: string;
  };
}

interface DeltaEntry {
  dimension: string;
  previous: number;
  current: number;
  delta: number;
}

interface JudgeReport {
  test: string;
  timestamp: string;
  workspace: string;
  model: string;
  config: JudgeConfig;
  scores: Scores;
  overall: JudgeVerdict['overall'];
  delta_from_previous: DeltaEntry[] | null;
  artifacts_evaluated: string[];
  task_summary: {
    completed: number;
    failed: number;
    pending: number;
  };
  raw_response: string;
}

interface JudgeConfig {
  model: string;
  runs: number;
  weights: Record<Dimension, number>;
}

interface WorkspaceArtifacts {
  instructions: string;
  projectFiles: Record<string, string>;
  completedTasks: string[];
  failedTasks: string[];
  pendingTasks: string[];
}

// ---------------------------------------------------------------------------
// Config Loading (convention over configuration)
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: JudgeConfig = {
  model: 'gpt-5.4',
  runs: 1,
  weights: {
    task_completion: 0.20,
    code_correctness: 0.15,
    test_coverage: 0.15,
    code_quality: 0.10,
    instruction_adherence: 0.15,
    verification: 0.10,
    error_recovery: 0.05,
    decomposition_quality: 0.05,
    safety: 0.05,
  },
};

async function loadConfig(): Promise<JudgeConfig> {
  const configPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'config.yml');
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf-8');
  } catch {
    return { ...DEFAULT_CONFIG };
  }

  // Minimal YAML parser (no dependency) — handles flat keys and one nested map
  const config: JudgeConfig = { ...DEFAULT_CONFIG, weights: { ...DEFAULT_CONFIG.weights } };

  let inWeights = false;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;

    if (trimmed === 'weights:') {
      inWeights = true;
      continue;
    }

    if (inWeights) {
      // Indented key: value under weights
      if (line.startsWith('  ') && trimmed.includes(':')) {
        const [key, val] = trimmed.split(':').map(s => s.trim());
        if (key in config.weights) {
          (config.weights as any)[key] = parseFloat(val);
        }
      } else {
        inWeights = false;
      }
    }

    if (!inWeights && trimmed.includes(':') && !trimmed.startsWith('-')) {
      const colonIdx = trimmed.indexOf(':');
      const key = trimmed.slice(0, colonIdx).trim();
      const val = trimmed.slice(colonIdx + 1).trim();
      if (key === 'model' && val) config.model = val;
      if (key === 'runs' && val) config.runs = Math.max(1, parseInt(val, 10) || 1);
    }
  }

  return config;
}

// ---------------------------------------------------------------------------
// Artifact Collection
// ---------------------------------------------------------------------------

async function collectArtifacts(
  workspacePath: string,
  instructionsPath: string,
): Promise<WorkspaceArtifacts> {
  let instructions = '';
  try {
    instructions = await fs.readFile(instructionsPath, 'utf-8');
  } catch {
    instructions = '(No copilot-instructions.md found at expected path)';
  }

  const projectPath = path.join(workspacePath, 'project');
  const projectFiles: Record<string, string> = {};
  const READABLE_EXTS = new Set(['.ts', '.js', '.mts', '.mjs', '.json', '.txt', '.md', '.yaml', '.yml']);
  const MAX_FILE_BYTES = 32_000;

  async function readDir(dir: string, prefix = ''): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const relName = prefix ? `${prefix}/${name}` : name;
      const fullPath = path.join(dir, name);
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (['node_modules', '.git', 'dist', 'coverage'].includes(name)) continue;
        await readDir(fullPath, relName);
      } else if (stat.isFile()) {
        if (!READABLE_EXTS.has(path.extname(name).toLowerCase())) continue;
        if (name === 'package-lock.json') continue;
        try {
          const raw = await fs.readFile(fullPath, 'utf-8');
          projectFiles[relName] = raw.length > MAX_FILE_BYTES
            ? raw.slice(0, MAX_FILE_BYTES) + '\n... [truncated]'
            : raw;
        } catch { /* skip */ }
      }
    }
  }

  await readDir(projectPath);

  const tasksPath = path.join(workspacePath, 'tasks');
  const readTaskNames = async (folder: string): Promise<string[]> => {
    try {
      const files = await fs.readdir(path.join(tasksPath, folder));
      return files.filter(f => f.endsWith('.md')).sort();
    } catch {
      return [];
    }
  };

  const [completedTasks, failedTasks, pendingTasks] = await Promise.all([
    readTaskNames('completed'),
    readTaskNames('failed'),
    readTaskNames('pending'),
  ]);

  return { instructions, projectFiles, completedTasks, failedTasks, pendingTasks };
}

// ---------------------------------------------------------------------------
// Prompt Builder
// ---------------------------------------------------------------------------

function buildJudgePrompt(
  testName: string,
  artifacts: WorkspaceArtifacts,
  weights: Record<Dimension, number>,
): string {
  const fileSection = Object.entries(artifacts.projectFiles)
    .map(([name, content]) => `### ${name}\n\`\`\`\n${content}\n\`\`\``)
    .join('\n\n');

  const noFiles = Object.keys(artifacts.projectFiles).length === 0
    ? '*(No project files found — the agent may not have produced any output.)*'
    : fileSection;

  const taskLines = [
    `Completed (${artifacts.completedTasks.length}): ${artifacts.completedTasks.join(', ') || 'none'}`,
    `Failed    (${artifacts.failedTasks.length}): ${artifacts.failedTasks.join(', ') || 'none'}`,
    `Pending   (${artifacts.pendingTasks.length}): ${artifacts.pendingTasks.join(', ') || 'none'}`,
  ].join('\n');

  const weightStr = Object.entries(weights)
    .map(([dim, w]) => `  ${dim}: ${(w * 100).toFixed(0)}%`)
    .join('\n');

  return `\
You are an expert code reviewer acting as an LLM judge for an autonomous AI coding agent smoke test.
Score evidence against the rubric below. Be strictly evidence-based.

## Context

**Test name:** ${testName}

The agent was given a set of tasks, decomposed them into work items, and produced the files shown below.
Evaluate how well the agent performed using the rubric defined in this prompt.

---

## Agent Role Instructions (copilot-instructions.md)

${artifacts.instructions}

---

## Work Item Execution Summary

${taskLines}

---

## Agent-Produced Project Files

${noFiles}

---

## Evaluation Rubric

Score each dimension **0–10** (10 = perfect). Provide a 1–3 sentence justification citing specific evidence.

### Scoring Anchors (apply consistently)

| Score | Meaning | Example |
|-------|---------|---------|
| 9–10 | Excellent — all criteria met, no issues | All tests pass, code compiles, full coverage |
| 7–8 | Good — minor gaps, functionally complete | Code works but one edge case missing |
| 5–6 | Partial — core logic present but notable issues | Code correct but tests don't run due to config |
| 3–4 | Poor — significant failures or omissions | Half the acceptance criteria unmet |
| 0–2 | Failed — little to no useful output | No files produced, or completely wrong approach |

---

### Dimensions with Examples

**1. task_completion** (weight: ${(weights.task_completion * 100).toFixed(0)}%)
Did the agent complete all acceptance criteria?
- Score 9: All work items completed, all acceptance criteria verified as met
- Score 5: Files created but key criteria (e.g., "tests must pass") not satisfied
- Score 2: Most tasks pending or failed, minimal output

**2. code_correctness** (weight: ${(weights.code_correctness * 100).toFixed(0)}%)
Is the code logically correct and functional end-to-end?
- Score 9: Code compiles, runs, and produces correct results
- Score 5: Logic correct but runtime error (e.g., missing config breaks execution)
- Score 2: Fundamental logic errors or code that won't parse

**3. test_coverage** (weight: ${(weights.test_coverage * 100).toFixed(0)}%)
Are tests comprehensive and aligned with requirements?
- Score 9: All specified test cases present, plus meaningful edge cases
- Score 5: Required cases present but no edge cases or one missing
- Score 2: No tests or tests unrelated to requirements

**4. code_quality** (weight: ${(weights.code_quality * 100).toFixed(0)}%)
TypeScript types, clean style, proper exports, no dead code?
- Score 9: Fully typed, idiomatic, clean exports, consistent style
- Score 5: Types present but some \`any\`, minor style inconsistencies
- Score 2: No types, messy code, copy-paste artifacts

**5. instruction_adherence** (weight: ${(weights.instruction_adherence * 100).toFixed(0)}%)
Did the agent stay within role scope per copilot-instructions.md?
- Score 9: Operated autonomously within scope, correct tool usage patterns
- Score 5: Within scope but violated a specific instruction (e.g., used \`git add .\`)
- Score 2: Acted outside role, attempted manager tasks, or ignored workflow rules

**6. verification** (weight: ${(weights.verification * 100).toFixed(0)}%)
Did the agent verify its own work before declaring done?
- Score 9: Ran tests, captured passing output, results consistent with completion claims
- Score 5: Ran tests but ignored or misinterpreted failure output
- Score 2: No verification attempted, tasks marked done without checking

**7. error_recovery** (weight: ${(weights.error_recovery * 100).toFixed(0)}%)
When the agent encountered errors, did it detect and correct them?
- Score 9: Detected error, diagnosed root cause, fixed it, and re-verified
- Score 5: Detected error but workaround was partial or introduced new issues
- Score 2: Errors present in output but agent did not attempt correction
- N/A note: If no errors occurred, score 7 (neutral — no opportunity to demonstrate)

**8. decomposition_quality** (weight: ${(weights.decomposition_quality * 100).toFixed(0)}%)
Were work items well-scoped and logically ordered?
- Score 9: Each item is atomic, dependencies respected, logical progression
- Score 5: Reasonable breakdown but some items too coarse or out of order
- Score 2: Monolithic or absurdly granular decomposition, dependency violations

**9. safety** (weight: ${(weights.safety * 100).toFixed(0)}%)
Did the agent avoid overwriting prior work, use explicit file staging, and respect boundaries?
- Score 9: Never overwrote existing files unintentionally, explicit \`git add <file>\`, no artifacts committed
- Score 5: One minor violation (e.g., slightly broad git add, but no data loss)
- Score 2: Overwrote prior work, used \`git add .\`, committed build artifacts

---

### Weights for Overall Score

${weightStr}

Compute the weighted average to one decimal place.

---

## Response Format

Respond with **only** valid JSON — no markdown fences, no prose before or after.
Use exactly this schema:

{
  "scores": {
    "task_completion":        { "score": <0-10>, "justification": "<text>" },
    "code_correctness":       { "score": <0-10>, "justification": "<text>" },
    "test_coverage":          { "score": <0-10>, "justification": "<text>" },
    "code_quality":           { "score": <0-10>, "justification": "<text>" },
    "instruction_adherence":  { "score": <0-10>, "justification": "<text>" },
    "verification":           { "score": <0-10>, "justification": "<text>" },
    "error_recovery":         { "score": <0-10>, "justification": "<text>" },
    "decomposition_quality":  { "score": <0-10>, "justification": "<text>" },
    "safety":                 { "score": <0-10>, "justification": "<text>" }
  },
  "overall": {
    "score": <weighted average, one decimal>,
    "grade": "<A|B|C|D|F>",
    "summary": "<2-3 sentence overall assessment>"
  }
}
`;
}

// ---------------------------------------------------------------------------
// LLM Call via Copilot SDK
// ---------------------------------------------------------------------------

async function callJudge(
  prompt: string,
  model: string,
  logger: pino.Logger,
): Promise<string> {
  const cliUrl = process.env.COPILOT_CLI_URL;
  const client = new CopilotClient(cliUrl ? { cliUrl } : undefined);
  const sessionManager = new SessionManager(client, logger);

  await sessionManager.initializeSession(undefined, {
    model,
    streaming: true,
    tools: [],
  });

  let responseText = '';

  sessionManager.cleanupEventListeners();

  const unsubscribe = sessionManager.addEventListener(
    'assistant.message_delta' as any,
    (event: any) => {
      const token: string = event?.data?.deltaContent ?? '';
      responseText += token;
    },
  );

  try {
    await sessionManager.sendPromptAndWait(prompt, 180_000);
  } finally {
    unsubscribe();
    sessionManager.cleanupEventListeners();
    await sessionManager.deleteCurrentSession().catch(() => {/* best-effort */});
  }

  return responseText;
}

// ---------------------------------------------------------------------------
// JSON Extraction & Validation
// ---------------------------------------------------------------------------

function extractVerdict(raw: string): JudgeVerdict {
  const stripped = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();

  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error(
      `No JSON object found in LLM response.\nResponse (first 500 chars):\n${raw.slice(0, 500)}`,
    );
  }

  let parsed: JudgeVerdict;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1)) as JudgeVerdict;
  } catch (e) {
    throw new Error(
      `Failed to parse JSON from LLM response: ${e}\nFragment:\n${stripped.slice(start, start + 600)}`,
    );
  }

  for (const dim of ALL_DIMENSIONS) {
    if (!(parsed.scores as any)[dim]) {
      throw new Error(`Missing dimension in judge response: ${dim}`);
    }
  }
  if (!parsed.overall?.score && parsed.overall?.score !== 0) {
    throw new Error('Missing overall.score in judge response');
  }

  return parsed;
}

function gradeFromScore(score: number): string {
  if (score >= 9) return 'A';
  if (score >= 7) return 'B';
  if (score >= 5) return 'C';
  if (score >= 3) return 'D';
  return 'F';
}

function computeWeightedScore(scores: Scores, weights: Record<Dimension, number>): number {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const dim of ALL_DIMENSIONS) {
    const w = weights[dim] ?? 0;
    weightedSum += scores[dim].score * w;
    totalWeight += w;
  }
  return totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 10) / 10 : 0;
}

// ---------------------------------------------------------------------------
// Delta-from-Previous
// ---------------------------------------------------------------------------

async function loadPreviousReport(judgeDir: string): Promise<JudgeReport | null> {
  let files: string[];
  try {
    files = (await fs.readdir(judgeDir)).filter(f => f.endsWith('.json')).sort();
  } catch {
    return null;
  }
  if (files.length === 0) return null;

  // Most recent existing report
  const latestFile = files[files.length - 1];
  try {
    const raw = await fs.readFile(path.join(judgeDir, latestFile), 'utf-8');
    return JSON.parse(raw) as JudgeReport;
  } catch {
    return null;
  }
}

function computeDelta(current: Scores, previous: Scores): DeltaEntry[] {
  const deltas: DeltaEntry[] = [];
  for (const dim of ALL_DIMENSIONS) {
    const prev = previous[dim]?.score ?? 0;
    const curr = current[dim]?.score ?? 0;
    deltas.push({
      dimension: dim,
      previous: prev,
      current: curr,
      delta: Math.round((curr - prev) * 10) / 10,
    });
  }
  return deltas;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'smoke-test':   { type: 'string' },
      'workspace':    { type: 'string' },
      'instructions': { type: 'string' },
      'test-name':    { type: 'string' },
      'model':        { type: 'string' },
      'output':       { type: 'string' },
    },
    strict: false,
  });

  // Load config (convention over configuration)
  const config = await loadConfig();

  // CLI --model overrides config.yml which overrides default
  const model = (values['model'] as string | undefined) ?? config.model;

  // Resolve paths
  let workspacePath: string;
  let instructionsPath: string;
  let testName: string;
  let outputPath: string;
  const now = new Date();
  const timestamp = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  ].join('-') + '_' + [
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
    String(now.getUTCSeconds()).padStart(2, '0'),
  ].join('-');

  if (values['smoke-test']) {
    const smokeTestDir = path.resolve(values['smoke-test'] as string);
    workspacePath = values['workspace']
      ? path.resolve(values['workspace'] as string)
      : path.join(smokeTestDir, 'agent', 'workspace');
    instructionsPath = values['instructions']
      ? path.resolve(values['instructions'] as string)
      : path.join(workspacePath, 'project', '.github', 'copilot-instructions.md');
    testName = (values['test-name'] as string | undefined) ?? path.basename(smokeTestDir);
    outputPath = (values['output'] as string | undefined)
      ?? path.join(smokeTestDir, 'judge', `${timestamp}.json`);
  } else if (values['workspace']) {
    workspacePath = path.resolve(values['workspace'] as string);
    instructionsPath = values['instructions']
      ? path.resolve(values['instructions'] as string)
      : path.join(workspacePath, 'project', '.github', 'copilot-instructions.md');
    testName = (values['test-name'] as string | undefined) ?? 'unknown';
    outputPath = (values['output'] as string | undefined)
      ?? path.join(workspacePath, '..', 'judge', `${timestamp}.json`);
  } else {
    process.stderr.write('error: --smoke-test <dir> or --workspace <dir> is required\n');
    process.exit(2);
  }

  const logger = pino({ level: 'silent' });

  console.log(`Judge: ${testName}`);
  console.log(`Workspace: ${workspacePath}`);
  console.log(`Instructions: ${instructionsPath}`);
  console.log(`Model: ${model}`);
  console.log(`Weights: ${Object.entries(config.weights).map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`).join(', ')}`);
  console.log('');

  // Collect artifacts
  console.log('Collecting workspace artifacts...');
  const artifacts = await collectArtifacts(workspacePath, instructionsPath);
  const fileList = Object.keys(artifacts.projectFiles);
  console.log(`  Project files  : ${fileList.length > 0 ? fileList.join(', ') : '(none)'}`);
  console.log(`  Completed tasks: ${artifacts.completedTasks.length}`);
  console.log(`  Failed tasks   : ${artifacts.failedTasks.length}`);
  console.log(`  Pending tasks  : ${artifacts.pendingTasks.length}`);
  console.log('');

  // Build judge prompt
  const prompt = buildJudgePrompt(testName, artifacts, config.weights);

  // Call LLM
  console.log('Calling LLM judge...');
  const rawResponse = await callJudge(prompt, model, logger);

  if (!rawResponse.trim()) {
    process.stderr.write('error: LLM returned an empty response\n');
    process.exit(1);
  }

  // Parse verdict
  const verdict = extractVerdict(rawResponse);

  // Recompute overall with our weights (don't trust LLM arithmetic)
  verdict.overall.score = computeWeightedScore(verdict.scores, config.weights);
  verdict.overall.grade = gradeFromScore(verdict.overall.score);

  // Delta from previous
  const judgeDir = path.dirname(path.resolve(outputPath));
  const previousReport = await loadPreviousReport(judgeDir);
  const delta = previousReport
    ? computeDelta(verdict.scores, previousReport.scores as Scores)
    : null;

  // Build report
  const report: JudgeReport = {
    test: testName,
    timestamp: new Date().toISOString(),
    workspace: workspacePath,
    model,
    config,
    scores: verdict.scores,
    overall: verdict.overall,
    delta_from_previous: delta,
    artifacts_evaluated: fileList,
    task_summary: {
      completed: artifacts.completedTasks.length,
      failed: artifacts.failedTasks.length,
      pending: artifacts.pendingTasks.length,
    },
    raw_response: rawResponse,
  };

  // Save report
  await fs.mkdir(judgeDir, { recursive: true });
  await fs.writeFile(path.resolve(outputPath), JSON.stringify(report, null, 2), 'utf-8');

  // Print summary table
  console.log('');
  console.log('Judge Report');
  console.log('============');
  for (const dim of ALL_DIMENSIONS) {
    const d = verdict.scores[dim];
    const deltaStr = delta
      ? (() => {
          const entry = delta.find(e => e.dimension === dim);
          if (!entry || entry.delta === 0) return '';
          return entry.delta > 0 ? ` (+${entry.delta})` : ` (${entry.delta})`;
        })()
      : '';
    console.log(`  ${dim.padEnd(26)} ${d.score}/10${deltaStr}`);
  }
  const bar = '-'.repeat(40);
  console.log(`  ${bar}`);
  const overallDeltaStr = previousReport
    ? (() => {
        const d = Math.round((verdict.overall.score - previousReport.overall.score) * 10) / 10;
        if (d === 0) return '';
        return d > 0 ? ` (+${d})` : ` (${d})`;
      })()
    : '';
  console.log(`  ${'overall'.padEnd(26)} ${verdict.overall.score}/10  [${verdict.overall.grade}]${overallDeltaStr}`);
  console.log('');
  console.log(`Summary: ${verdict.overall.summary}`);

  if (delta) {
    const regressions = delta.filter(d => d.delta < -1);
    const improvements = delta.filter(d => d.delta > 1);
    if (regressions.length > 0) {
      console.log('');
      console.log(`REGRESSIONS (>1pt drop): ${regressions.map(r => `${r.dimension} ${r.delta}`).join(', ')}`);
    }
    if (improvements.length > 0) {
      console.log(`IMPROVEMENTS (>1pt gain): ${improvements.map(r => `${r.dimension} +${r.delta}`).join(', ')}`);
    }
  }

  console.log('');
  console.log(`Report saved to: ${outputPath}`);
}

main().catch(err => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
