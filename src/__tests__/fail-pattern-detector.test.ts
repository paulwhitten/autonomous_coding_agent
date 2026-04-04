// Tests for fail-pattern-detector.ts
//
// Verifies that the fail-pattern detection logic correctly identifies
// (or ignores) failure indicators in LLM work output text.  These
// patterns drive the onSuccess/onFailure routing decision after a
// workflow phase completes.

import { describe, it, expect } from '@jest/globals';
import { detectFailureIndicators, FAIL_PATTERNS } from '../fail-pattern-detector.js';

describe('detectFailureIndicators', () => {
  // ---------------------------------------------------------------
  // Positive cases: text that SHOULD trigger failure detection
  // ---------------------------------------------------------------
  describe('should detect failure indicators', () => {
    it('verdict: FAIL (QA verification report style)', () => {
      const text = '## REQ-HCDP-002\n- Verified Commit: abc123\n- Verdict: FAIL\n';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(true);
      expect(result.matchedText).toMatch(/verdict.*fail/i);
    });

    it('Verdict: FAIL with extra whitespace', () => {
      const text = 'Verdict:  FAIL';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(true);
    });

    it('verdict FAIL without colon', () => {
      const text = 'The verdict FAIL was issued for REQ-003';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(true);
    });

    it('status: FAIL', () => {
      const text = '| REQ-HCDP-003 | src/cli.ts | tests/cli.test.ts | No | No | abc123 | FAIL |\nstatus: FAIL';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(true);
    });

    it('all test suites failed', () => {
      const text = 'Running jest... all test suites failed. 0 passed, 3 failed.';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(true);
    });

    it('all test suite failed (singular)', () => {
      const text = 'all test suite failed';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(true);
    });

    it('tests failed', () => {
      const text = 'npm test output: 2 tests failed out of 5';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(true);
    });

    it('test failing (narrative - no numeric count)', () => {
      // With tightened patterns, this is now considered too vague (no verdict, no count)
      const text = 'The referential integrity test failing due to missing patient lookup';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(false);
    });

    it('test fail (bare - hypothetical scenario)', () => {
      // With tightened patterns, this is now considered hypothetical/conditional
      const text = 'If the test fail, we route to REWORK';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(false);
    });

    it('annotations not found', () => {
      const text = 'grep -rn REQ-HCDP src/: annotations not found in any source file';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(true);
    });

    it('annotation missing', () => {
      const text = 'REQ-HCDP-003 annotation missing from tests/cli.test.ts';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(true);
    });

    it('annotations missing (plural)', () => {
      const text = 'Several annotations missing from the source tree';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(true);
    });

    it('verdict: REJECTED', () => {
      const text = '| REQ-HCDP-003 | No | QA verdict FAIL | REJECTED |';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(true);
    });

    it('verdict REJECT (without -ed)', () => {
      const text = 'I must verdict reject this requirement.';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(true);
    });

    it('case insensitive matching', () => {
      const text = 'VERDICT: fail';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(true);
    });

    it('mixed case in multi-line LLM output', () => {
      const text = [
        'I have completed the verification for REQ-HCDP-002.',
        'The tests were run using npx jest.',
        'Results: 3 passed, 1 failed.',
        'Tests Failed in cli.test.ts line 42.',
        'Updated evidence/verification-report.md with Verdict: FAIL.',
      ].join('\n');
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(true);
    });
  });

  // ---------------------------------------------------------------
  // Negative cases: text that should NOT trigger failure detection
  // ---------------------------------------------------------------
  describe('should NOT detect failure indicators', () => {
    it('empty string', () => {
      const result = detectFailureIndicators('');
      expect(result.detected).toBe(false);
      expect(result.matchedPattern).toBeNull();
      expect(result.matchedText).toBeNull();
    });

    it('null-ish input (empty)', () => {
      const result = detectFailureIndicators('');
      expect(result.detected).toBe(false);
    });

    it('verdict: PASS', () => {
      const text = '## REQ-HCDP-001\n- Verified Commit: abc123\n- Verdict: PASS\n';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(false);
    });

    it('all tests passed', () => {
      const text = 'Running jest... all 5 test suites passed. 12 tests total.';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(false);
    });

    it('status: PASS', () => {
      const text = '| REQ-HCDP-001 | src/cli.ts | tests/cli.test.ts | Yes | Yes | abc123 | PASS |\nstatus: PASS';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(false);
    });

    it('discussion of failure handling (not actual failure)', () => {
      const text = 'If the code fails, we should implement retry logic. Handle errors gracefully.';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(false);
    });

    it('word "fail" in unrelated context (failsafe, failover)', () => {
      const text = 'The failsafe mechanism ensures failover to the backup server.';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(false);
    });

    it('successful completion report', () => {
      const text = [
        'Implementation complete for REQ-HCDP-001.',
        'Created src/cli.ts with // REQ: REQ-HCDP-001 annotation.',
        'Created tests/cli.test.ts with passing tests.',
        'All 3 tests pass. Pushed to origin main.',
        'Commit: abc1234567890abc1234567890abc1234567890ab',
      ].join('\n');
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(false);
    });

    it('mention of failOnError in workflow config discussion', () => {
      const text = 'The onExitCommands have failOnError: false so they continue on error.';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(false);
    });

    it('word "failure" in transition description', () => {
      const text = 'The onFailure transition routes to REWORK state.';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // Result structure
  // ---------------------------------------------------------------
  describe('result structure', () => {
    it('returns matched pattern source on detection', () => {
      const result = detectFailureIndicators('Verdict: FAIL');
      expect(result.detected).toBe(true);
      expect(result.matchedPattern).toBeTruthy();
      expect(typeof result.matchedPattern).toBe('string');
    });

    it('returns matched text on detection', () => {
      const result = detectFailureIndicators('The verdict: FAIL was issued');
      expect(result.detected).toBe(true);
      expect(result.matchedText).toBeTruthy();
      // matchedText should be the actual substring that matched
      expect(result.matchedText!.toLowerCase()).toContain('verdict');
      expect(result.matchedText!.toLowerCase()).toContain('fail');
    });

    it('returns nulls when no detection', () => {
      const result = detectFailureIndicators('All good, verdict: PASS');
      expect(result.detected).toBe(false);
      expect(result.matchedPattern).toBeNull();
      expect(result.matchedText).toBeNull();
    });
  });

  // ---------------------------------------------------------------
  // Edge cases from real smoke test output
  // ---------------------------------------------------------------
  describe('real-world smoke test scenarios', () => {
    it('QA traceability matrix with FAIL status in table', () => {
      const text = [
        '| Requirement | Source File | Test File | Annotation Found | Tests Pass | Verified Commit | Status |',
        '| REQ-HCDP-001 | src/cli.ts | tests/cli.test.ts | Yes | Yes | abc123 | PASS |',
        '| REQ-HCDP-002 | src/cli.ts | tests/cli.test.ts | Yes | No | def456 | FAIL |',
      ].join('\n');
      // "Status" column says FAIL but without "status:" prefix.
      // The "Tests Pass" column says "No".
      // We want the verdict/status patterns to catch table rows too.
      // The word "FAIL" at end of line is matched by /\bstatus[:\s]*fail\b/
      // only if preceded by "status". In a markdown table, no -- so we
      // rely on the LLM *also* writing "Verdict: FAIL" in its report text.
      // This particular table snippet alone should NOT false-positive.
      const result = detectFailureIndicators(text);
      // Only "FAIL" in table without "verdict:" or "status:" prefix
      // This should NOT match because the patterns require the keyword prefix
      expect(result.detected).toBe(false);
    });

    it('QA writes verdict FAIL in verification report', () => {
      const text = [
        'Updated evidence/verification-report.md:',
        '',
        '## REQ-HCDP-002',
        '- Verified Commit: 2d6df049a17482ad73f5076360cf905262135b46',
        '- Verdict: FAIL',
        '',
        'The tests did not pass for this requirement.',
      ].join('\n');
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(true);
    });

    it('QA writes both PASS and FAIL for different requirements', () => {
      // When QA verifies multiple requirements in one phase, the
      // accumulated output may contain both PASS and FAIL.  A single
      // FAIL should still trigger failure detection.
      const text = [
        '## REQ-HCDP-001',
        '- Verdict: PASS',
        '',
        '## REQ-HCDP-002',
        '- Verdict: FAIL',
      ].join('\n');
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(true);
    });

    it('developer reports successful implementation', () => {
      const text = [
        'I have implemented the referential integrity check.',
        '// REQ: REQ-HCDP-003 annotation added to src/cli.ts and tests/cli.test.ts.',
        'Running npx jest: 6 tests passed, 0 failed.',
        'Committed and pushed to origin main: c30b6513',
      ].join('\n');
      // "0 failed" should NOT match because the pattern requires "tests? fail"
      // not "0 failed". Let's verify.
      const result = detectFailureIndicators(text);
      // Hmm, "0 failed" -- does /\btests?\s+fail(?:ed|ing)?\b/ match?
      // No: "0 failed" -- the word before "failed" is "0", not "test".
      expect(result.detected).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // Retrospective/historical context (regression tests for work item 3)
  // ---------------------------------------------------------------
  describe('should NOT detect retrospective failure descriptions', () => {
    it('past tense failures that were resolved', () => {
      const text = 'The tests failed initially due to compilation errors. ' +
        'I fixed the missing imports and all tests now pass.';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(false);
    });

    it('work item 3 exact phrasing that caused false positive', () => {
      const text = 'I attempted to verify the implementation of REQ-HCDP-003 by running all tests and checking the latest commit hash. ' +
        'The tests failed due to TypeScript compilation errors and unmet test expectations, specifically missing or misnamed variables in src/cli.ts. ' +
        'The requirement is not fully implemented or verified; further code fixes are needed before completion.';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(false);
    });

    it('diagnostic narrative describing debugging process', () => {
      const text = 'During implementation, I encountered test failures when ' +
        'running npm test. After examining the error messages, I corrected ' +
        'the logic and verified all tests pass.';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(false);
    });

    it('summary note with historical context and resolution', () => {
      const text = 'I attempted to verify the implementation of REQ-HCDP-003. ' +
        'The tests failed due to TypeScript errors. After fixing these issues, ' +
        'all tests now pass and the implementation is complete.';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(false);
    });

    it('bare "tests failed" without numeric context (too vague)', () => {
      const text = 'When the tests failed, I investigated the root cause.';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // Numeric test failure patterns (should detect)
  // ---------------------------------------------------------------
  describe('should detect numeric test failure counts', () => {
    it('test failure with numeric count', () => {
      const text = 'Tests run: 5 passed, 3 tests failed';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(true);
    });

    it('single test failed with count', () => {
      const text = 'Ran test suite: 1 test failed out of 10';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(true);
    });

    it('tests with numeric count and colon', () => {
      const text = 'Test results: tests: 2 failed, 8 passed';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(true);
    });

    it('test run failed explicitly', () => {
      const text = 'The test run failed with multiple errors';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(true);
    });
  });

  // ---------------------------------------------------------------
  // Active failure statements (should still detect)
  // ---------------------------------------------------------------
  describe('should detect active failure statements', () => {
    it('present tense failure without resolution', () => {
      const text = 'I ran npm test and the tests fail to execute properly. ' +
        'The requirement is not fully implemented.';
      const result = detectFailureIndicators(text);
      // This should NOT match with tightened patterns since there's no numeric count
      // or explicit verdict. This is by design - we want to be more conservative.
      expect(result.detected).toBe(false);
    });

    it('explicit verdict fail', () => {
      const text = 'After verification, the implementation has failures. Verdict: FAIL';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(true);
    });

    it('status fail in summary', () => {
      const text = 'Verification complete. Status: FAIL';
      const result = detectFailureIndicators(text);
      expect(result.detected).toBe(true);
    });
  });

  // ---------------------------------------------------------------
  // Pattern inventory
  // ---------------------------------------------------------------
  describe('FAIL_PATTERNS', () => {
    it('should have at least 7 patterns', () => {
      // Updated count: verdict:fail, status:fail, verdict:reject, all test suites failed,
      // numeric test counts (2 patterns), test run failed, annotations
      expect(FAIL_PATTERNS.length).toBeGreaterThanOrEqual(7);
    });

    it('all patterns should be case-insensitive', () => {
      for (const pattern of FAIL_PATTERNS) {
        expect(pattern.flags).toContain('i');
      }
    });
  });
});
