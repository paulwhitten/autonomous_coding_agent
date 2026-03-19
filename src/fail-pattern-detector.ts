/**
 * Detects failure indicators in LLM work output text.
 *
 * Used by the agent after a workflow phase completes to determine whether
 * the state machine should follow the onFailure transition (e.g. REWORK)
 * instead of onSuccess (e.g. ACCEPTANCE).
 *
 * The patterns match common QA/verification language that an LLM agent
 * would produce when reporting a failed verification, failed tests,
 * or missing annotations.
 */

/**
 * Ordered list of fail-indicator patterns (case-insensitive).
 *
 * NOTE: Patterns are designed to match explicit failure verdicts and test
 * runner output, while avoiding false positives from retrospective/narrative
 * descriptions. For example:
 *   - "Verdict: FAIL" → MATCH (explicit verdict)
 *   - "5 tests failed" → MATCH (test runner summary with count)
 *   - "The tests failed initially but I fixed them" → NO MATCH (retrospective)
 */
export const FAIL_PATTERNS: ReadonlyArray<RegExp> = [
  // Explicit verdict/status keywords (high confidence)
  /\bverdict[:\s]*fail\b/i,
  /\bstatus[:\s]*fail\b/i,
  /\bverdict[:\s]*reject(?:ed)?\b/i,

  // Test suite failures (requires "all" quantifier for specificity)
  /\ball\s+test\s+suites?\s+failed\b/i,

  // Numeric test failure counts (test runner output format)
  // Matches: "5 tests failed", "1 test failed", "tests: 3 failed"
  /\b\d+\s+tests?\s+failed/i,
  /\btests?[:\s]+\d+\s+failed/i,

  // Explicit test run failure
  /\btest\s+run[:\s]*(?:failed|fail)\b/i,

  // Annotation issues
  /\bannotation[s]?\s+(?:not\s+found|missing)\b/i,
];

export interface FailDetectionResult {
  /** True if at least one fail pattern matched. */
  detected: boolean;
  /** The first pattern that matched (for logging), or null. */
  matchedPattern: string | null;
  /** The substring that matched, or null. */
  matchedText: string | null;
}

/**
 * Scan text for failure indicators.
 *
 * @param text - The accumulated LLM response text to scan.
 * @returns Detection result with the first matching pattern, if any.
 */
export function detectFailureIndicators(text: string): FailDetectionResult {
  if (!text || text.length === 0) {
    return { detected: false, matchedPattern: null, matchedText: null };
  }

  for (const pattern of FAIL_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      return {
        detected: true,
        matchedPattern: pattern.source,
        matchedText: match[0],
      };
    }
  }

  return { detected: false, matchedPattern: null, matchedText: null };
}
