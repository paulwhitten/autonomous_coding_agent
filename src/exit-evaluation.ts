/**
 * Exit Evaluation — structured transition decision logic.
 *
 * Pure functions for:
 *   1. Composing a constrained evaluation prompt from an ExitEvaluation spec
 *   2. Parsing a free-form LLM response into a constrained value
 *   3. Mapping that value to a success/failure routing outcome
 *
 * These functions are stateless and independently testable.  The agent
 * calls them after work items complete but before the state transition.
 *
 * Design rationale:
 *   The fail-pattern-detector approach hardcodes English patterns
 *   (e.g. /verdict.*fail/) and breaks when the LLM uses different
 *   phrasing.  Exit evaluation replaces that with a two-step approach:
 *     Step 1: Ask the LLM a specific yes/no or multiple-choice question
 *     Step 2: Parse the constrained answer deterministically
 *   The workflow author controls the question. The parsing is mechanical.
 */

import { ExitEvaluation } from './workflow-types.js';

// ---------------------------------------------------------------------------
// Prompt composition
// ---------------------------------------------------------------------------

/**
 * Build the full evaluation prompt sent to the LLM.
 *
 * The prompt includes the author's question, explicit answer format
 * instructions, and for enum types, the valid choices.  This makes
 * parsing reliable regardless of LLM verbosity.
 *
 * @param eval_  The exit evaluation spec from the state definition
 * @param context  Template variables for {{variable}} substitution
 * @returns The complete prompt string to send to the LLM
 */
export function composeEvaluationPrompt(
  eval_: ExitEvaluation,
  context: Record<string, string>,
): string {
  const question = substituteVars(eval_.prompt, context);

  const sections: string[] = [];

  sections.push('You are answering a structured evaluation question.');
  sections.push('Your answer will be parsed programmatically.');
  sections.push('');
  sections.push(`**Question:** ${question}`);
  sections.push('');

  if (eval_.responseFormat === 'boolean') {
    sections.push('**Answer format:** Respond with exactly one word: `true` or `false`.');
    sections.push('Do not include any other text, explanation, or punctuation.');
  } else if (eval_.responseFormat === 'enum') {
    const choices = eval_.choices ?? [];
    sections.push(`**Answer format:** Respond with exactly one of these values:`);
    for (const c of choices) {
      sections.push(`  - \`${c}\``);
    }
    sections.push('Do not include any other text, explanation, or punctuation.');
  }

  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Result of parsing an LLM response against an ExitEvaluation spec.
 */
export interface EvaluationParseResult {
  /** The raw LLM response text (trimmed) */
  rawResponse: string;

  /** The parsed/normalized value, or null if unparseable */
  parsedValue: string | null;

  /** Whether the response was successfully parsed */
  parsed: boolean;

  /** The routing outcome: "success" or "failure" */
  outcome: 'success' | 'failure';

  /** If unparseable, which fallback was used */
  fallback: boolean;
}

/**
 * Parse an LLM response and map it to a routing outcome.
 *
 * For boolean format:
 *   - Recognizes: true, false, yes, no (case-insensitive, trimmed)
 *   - Maps yes->true, no->false
 *   - Strips surrounding quotes, periods, whitespace
 *
 * For enum format:
 *   - Tries exact match first (case-insensitive)
 *   - Falls back to substring scan (first choice found in response)
 *   - This handles LLM responses like "The answer is pass."
 *
 * @param response  Raw LLM response text
 * @param eval_     The exit evaluation spec
 * @returns Parse result with the outcome
 */
export function parseEvaluationResponse(
  response: string,
  eval_: ExitEvaluation,
): EvaluationParseResult {
  const raw = response.trim();
  const defaultOutcome = eval_.defaultOutcome ?? 'failure';

  if (!raw) {
    return {
      rawResponse: raw,
      parsedValue: null,
      parsed: false,
      outcome: defaultOutcome,
      fallback: true,
    };
  }

  if (eval_.responseFormat === 'boolean') {
    return parseBooleanResponse(raw, eval_, defaultOutcome);
  }

  if (eval_.responseFormat === 'enum') {
    return parseEnumResponse(raw, eval_, defaultOutcome);
  }

  // Unknown format — fall back to default
  return {
    rawResponse: raw,
    parsedValue: null,
    parsed: false,
    outcome: defaultOutcome,
    fallback: true,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Detect and deduplicate streaming token repetition.
 *
 * When a constrained prompt produces a single word (e.g. "true"), LLM
 * streaming can emit the same token repeatedly via message_delta events.
 * The accumulator concatenates them: "truetruetruetrue...".
 *
 * This function checks whether the entire response is a single valid
 * token repeated N times, and if so returns that token once.
 *
 * @param raw       The raw accumulated response (already trimmed)
 * @param tokens    Set of valid tokens to check (e.g. ["true","false"])
 * @returns The single token if detected, or the original string unchanged
 */
export function deduplicateStreamingRepetition(
  raw: string,
  tokens: string[],
): string {
  const lower = raw.toLowerCase();
  for (const token of tokens) {
    const tl = token.toLowerCase();
    if (lower.length >= tl.length && lower.length % tl.length === 0) {
      // Check if the entire string is just this token repeated
      const repeated = tl.repeat(lower.length / tl.length);
      if (lower === repeated) {
        return token;
      }
    }
  }
  return raw;
}

/** Normalize a raw response for boolean parsing. */
function normalizeBooleanToken(raw: string): string {
  // Strip markdown backticks, quotes, periods, trailing punctuation
  return raw
    .replace(/^[`'"]+|[`'"]+$/g, '')
    .replace(/[.!]+$/, '')
    .trim()
    .toLowerCase();
}

const BOOLEAN_TRUE_VALUES = new Set(['true', 'yes']);
const BOOLEAN_FALSE_VALUES = new Set(['false', 'no']);

function parseBooleanResponse(
  raw: string,
  eval_: ExitEvaluation,
  defaultOutcome: 'success' | 'failure',
): EvaluationParseResult {
  // De-duplicate streaming repetition: "truetruetrue..." -> "true"
  const deduped = deduplicateStreamingRepetition(
    raw,
    ['true', 'false', 'yes', 'no'],
  );
  const token = normalizeBooleanToken(deduped);

  let parsedValue: string | null = null;

  if (BOOLEAN_TRUE_VALUES.has(token)) {
    parsedValue = 'true';
  } else if (BOOLEAN_FALSE_VALUES.has(token)) {
    parsedValue = 'false';
  } else {
    // Try to find a boolean word anywhere in the response (LLM was verbose)
    const lower = raw.toLowerCase();
    // Check false first — "not true" should map to false
    if (/\b(false|no)\b/.test(lower) && !/\b(true|yes)\b/.test(lower)) {
      parsedValue = 'false';
    } else if (/\b(true|yes)\b/.test(lower) && !/\b(false|no)\b/.test(lower)) {
      parsedValue = 'true';
    }
    // If both or neither found, parsedValue stays null
  }

  if (parsedValue !== null) {
    const outcome = eval_.mapping[parsedValue] ?? defaultOutcome;
    return {
      rawResponse: raw,
      parsedValue,
      parsed: true,
      outcome,
      fallback: false,
    };
  }

  return {
    rawResponse: raw,
    parsedValue: null,
    parsed: false,
    outcome: defaultOutcome,
    fallback: true,
  };
}

function parseEnumResponse(
  raw: string,
  eval_: ExitEvaluation,
  defaultOutcome: 'success' | 'failure',
): EvaluationParseResult {
  const choices = eval_.choices ?? [];
  // De-duplicate streaming repetition: "acceptedacceptedaccepted..." -> "accepted"
  const deduped = deduplicateStreamingRepetition(raw, choices);
  const normalized = normalizeBooleanToken(deduped); // reuse stripping logic

  // 1. Exact match (after normalization)
  for (const choice of choices) {
    if (normalized === choice.toLowerCase()) {
      return {
        rawResponse: raw,
        parsedValue: choice,
        parsed: true,
        outcome: eval_.mapping[choice] ?? defaultOutcome,
        fallback: false,
      };
    }
  }

  // 2. Substring scan — find the first choice that appears in the response
  //    Sort by length descending so "partial_pass" matches before "pass"
  const sortedChoices = [...choices].sort((a, b) => b.length - a.length);
  const lower = raw.toLowerCase();
  for (const choice of sortedChoices) {
    const pattern = new RegExp(`\\b${escapeRegex(choice)}\\b`, 'i');
    if (pattern.test(lower)) {
      return {
        rawResponse: raw,
        parsedValue: choice,
        parsed: true,
        outcome: eval_.mapping[choice] ?? defaultOutcome,
        fallback: false,
      };
    }
  }

  // 3. No match — use default
  return {
    rawResponse: raw,
    parsedValue: null,
    parsed: false,
    outcome: defaultOutcome,
    fallback: true,
  };
}

/** Simple {{variable}} template substitution. */
function substituteVars(
  template: string,
  context: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    return context[key] ?? `{{${key}}}`;
  });
}

/** Escape a string for safe use in a RegExp. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
