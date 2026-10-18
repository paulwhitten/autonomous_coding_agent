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
 *   - Falls back to a word scan that accepts a choice only if it is the
 *     only choice present and is not negated ("The answer is pass." ->
 *     pass; "not accepted" or "accepted ... rejected" -> default)
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
    // Try to find a boolean word anywhere in the response (LLM was verbose).
    // Accept only an unambiguous answer: exactly one polarity present and
    // never negated ("not true" is ambiguous, so it falls to the default).
    const trueHits = findChoiceOccurrences(raw, 'true').concat(findChoiceOccurrences(raw, 'yes'));
    const falseHits = findChoiceOccurrences(raw, 'false').concat(findChoiceOccurrences(raw, 'no'));
    const anyNegated = [...trueHits, ...falseHits].some((h) => h.negated);
    if (!anyNegated) {
      if (falseHits.length > 0 && trueHits.length === 0) {
        parsedValue = 'false';
      } else if (trueHits.length > 0 && falseHits.length === 0) {
        parsedValue = 'true';
      }
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

  // 2. Word scan — accept only when exactly one choice appears and none
  //    of its occurrences is negated.  "not accepted", or a response that
  //    names both "accepted" and "rejected", is ambiguous and falls to the
  //    default outcome rather than passing the gate.
  //    Longer choices are matched first and masked out so "partial_pass"
  //    does not also count as "pass".
  const sortedChoices = [...choices].sort((a, b) => b.length - a.length);
  let masked = raw;
  const found: string[] = [];
  let anyNegated = false;
  for (const choice of sortedChoices) {
    const hits = findChoiceOccurrences(masked, choice);
    if (hits.length === 0) continue;
    found.push(choice);
    if (hits.some((h) => h.negated)) anyNegated = true;
    for (const h of hits) {
      masked = masked.slice(0, h.index) + ' '.repeat(h.length) + masked.slice(h.index + h.length);
    }
  }
  if (found.length === 1 && !anyNegated) {
    const choice = found[0];
    return {
      rawResponse: raw,
      parsedValue: choice,
      parsed: true,
      outcome: eval_.mapping[choice] ?? defaultOutcome,
      fallback: false,
    };
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

/**
 * Words that negate a following answer token, allowing one intervening
 * word ("not accepted", "not fully accepted", "isn't true").
 */
const NEGATION_BEFORE = /\b(?:not|no|never|cannot|without|\w+n['’]t)\W+(?:\w+\W+)?$/i;

interface ChoiceOccurrence {
  index: number;
  length: number;
  negated: boolean;
}

/** Find whole-word occurrences of `word` in `text`, flagging negated ones. */
function findChoiceOccurrences(text: string, word: string): ChoiceOccurrence[] {
  const pattern = new RegExp(`\\b${escapeRegex(word)}\\b`, 'gi');
  const hits: ChoiceOccurrence[] = [];
  for (const m of text.matchAll(pattern)) {
    const index = m.index ?? 0;
    const before = text.slice(Math.max(0, index - 40), index);
    hits.push({ index, length: m[0].length, negated: NEGATION_BEFORE.test(before) });
  }
  return hits;
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
