// Tests for exit-evaluation.ts
//
// Verifies the structured exit evaluation logic:
//   - Prompt composition with template substitution
//   - Boolean response parsing (true/false/yes/no + verbose LLM output)
//   - Enum response parsing (exact match, substring scan)
//   - Mapping to success/failure outcomes
//   - Default fallback behavior

import { describe, it, expect } from '@jest/globals';
import {
  composeEvaluationPrompt,
  parseEvaluationResponse,
  deduplicateStreamingRepetition,
  EvaluationParseResult,
} from '../exit-evaluation.js';
import { ExitEvaluation } from '../workflow-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const boolEval: ExitEvaluation = {
  prompt: 'Did all validation tests pass and all REQ annotations exist?',
  responseFormat: 'boolean',
  mapping: { 'true': 'success', 'false': 'failure' },
  defaultOutcome: 'failure',
};

const enumEval: ExitEvaluation = {
  prompt: 'What is the overall verification status for {{requirement}}?',
  responseFormat: 'enum',
  choices: ['pass', 'partial', 'fail'],
  mapping: { pass: 'success', partial: 'failure', fail: 'failure' },
  defaultOutcome: 'failure',
};

// ---------------------------------------------------------------------------
// Prompt composition
// ---------------------------------------------------------------------------

describe('composeEvaluationPrompt', () => {
  it('includes the question text', () => {
    const prompt = composeEvaluationPrompt(boolEval, {});
    expect(prompt).toContain('Did all validation tests pass');
  });

  it('substitutes template variables', () => {
    const prompt = composeEvaluationPrompt(enumEval, { requirement: 'REQ-HCDP-002' });
    expect(prompt).toContain('REQ-HCDP-002');
    expect(prompt).not.toContain('{{requirement}}');
  });

  it('leaves unresolved variables as-is', () => {
    const prompt = composeEvaluationPrompt(enumEval, {});
    expect(prompt).toContain('{{requirement}}');
  });

  it('includes boolean format instructions', () => {
    const prompt = composeEvaluationPrompt(boolEval, {});
    expect(prompt).toMatch(/true.*false/i);
  });

  it('includes enum choices', () => {
    const prompt = composeEvaluationPrompt(enumEval, {});
    expect(prompt).toContain('pass');
    expect(prompt).toContain('partial');
    expect(prompt).toContain('fail');
  });

  it('instructs no extra text', () => {
    const prompt = composeEvaluationPrompt(boolEval, {});
    expect(prompt).toMatch(/do not include any other text/i);
  });
});

// ---------------------------------------------------------------------------
// Boolean parsing - positive cases
// ---------------------------------------------------------------------------

describe('parseEvaluationResponse — boolean', () => {
  describe('exact matches', () => {
    it('parses "true"', () => {
      const r = parseEvaluationResponse('true', boolEval);
      expect(r.parsed).toBe(true);
      expect(r.parsedValue).toBe('true');
      expect(r.outcome).toBe('success');
      expect(r.fallback).toBe(false);
    });

    it('parses "false"', () => {
      const r = parseEvaluationResponse('false', boolEval);
      expect(r.parsed).toBe(true);
      expect(r.parsedValue).toBe('false');
      expect(r.outcome).toBe('failure');
    });

    it('parses "yes" as true', () => {
      const r = parseEvaluationResponse('yes', boolEval);
      expect(r.parsed).toBe(true);
      expect(r.parsedValue).toBe('true');
      expect(r.outcome).toBe('success');
    });

    it('parses "no" as false', () => {
      const r = parseEvaluationResponse('no', boolEval);
      expect(r.parsed).toBe(true);
      expect(r.parsedValue).toBe('false');
      expect(r.outcome).toBe('failure');
    });
  });

  describe('case insensitive', () => {
    it('parses "TRUE"', () => {
      const r = parseEvaluationResponse('TRUE', boolEval);
      expect(r.outcome).toBe('success');
    });

    it('parses "False"', () => {
      const r = parseEvaluationResponse('False', boolEval);
      expect(r.outcome).toBe('failure');
    });

    it('parses "YES"', () => {
      const r = parseEvaluationResponse('YES', boolEval);
      expect(r.outcome).toBe('success');
    });

    it('parses "No"', () => {
      const r = parseEvaluationResponse('No', boolEval);
      expect(r.outcome).toBe('failure');
    });
  });

  describe('strips formatting', () => {
    it('handles backtick-wrapped: `true`', () => {
      const r = parseEvaluationResponse('`true`', boolEval);
      expect(r.outcome).toBe('success');
    });

    it('handles quoted: "false"', () => {
      const r = parseEvaluationResponse('"false"', boolEval);
      expect(r.outcome).toBe('failure');
    });

    it('handles trailing period: true.', () => {
      const r = parseEvaluationResponse('true.', boolEval);
      expect(r.outcome).toBe('success');
    });

    it('handles whitespace padding', () => {
      const r = parseEvaluationResponse('  false  ', boolEval);
      expect(r.outcome).toBe('failure');
    });
  });

  describe('verbose LLM responses', () => {
    it('finds "true" in verbose affirmative', () => {
      const r = parseEvaluationResponse(
        'Based on my analysis, the answer is true.',
        boolEval,
      );
      expect(r.parsed).toBe(true);
      expect(r.parsedValue).toBe('true');
      expect(r.outcome).toBe('success');
    });

    it('finds "no" in verbose negative', () => {
      const r = parseEvaluationResponse(
        'No, the tests did not all pass. Two REQ annotations were missing.',
        boolEval,
      );
      expect(r.parsed).toBe(true);
      expect(r.parsedValue).toBe('false');
      expect(r.outcome).toBe('failure');
    });

    it('falls back to default when both true and false present', () => {
      const r = parseEvaluationResponse(
        'Some are true and some are false, so I cannot give a single answer.',
        boolEval,
      );
      expect(r.parsed).toBe(false);
      expect(r.fallback).toBe(true);
      expect(r.outcome).toBe('failure'); // defaultOutcome
    });
  });

  describe('empty / unparseable', () => {
    it('empty string falls back to default', () => {
      const r = parseEvaluationResponse('', boolEval);
      expect(r.parsed).toBe(false);
      expect(r.fallback).toBe(true);
      expect(r.outcome).toBe('failure');
    });

    it('gibberish falls back to default', () => {
      const r = parseEvaluationResponse('asdfghjkl', boolEval);
      expect(r.parsed).toBe(false);
      expect(r.outcome).toBe('failure');
    });
  });
});

// ---------------------------------------------------------------------------
// Enum parsing
// ---------------------------------------------------------------------------

describe('parseEvaluationResponse — enum', () => {
  describe('exact matches', () => {
    it('parses "pass"', () => {
      const r = parseEvaluationResponse('pass', enumEval);
      expect(r.parsed).toBe(true);
      expect(r.parsedValue).toBe('pass');
      expect(r.outcome).toBe('success');
    });

    it('parses "fail"', () => {
      const r = parseEvaluationResponse('fail', enumEval);
      expect(r.parsed).toBe(true);
      expect(r.parsedValue).toBe('fail');
      expect(r.outcome).toBe('failure');
    });

    it('parses "partial"', () => {
      const r = parseEvaluationResponse('partial', enumEval);
      expect(r.parsed).toBe(true);
      expect(r.parsedValue).toBe('partial');
      expect(r.outcome).toBe('failure');
    });
  });

  describe('case insensitive', () => {
    it('parses "PASS"', () => {
      const r = parseEvaluationResponse('PASS', enumEval);
      expect(r.outcome).toBe('success');
    });

    it('parses "Fail"', () => {
      const r = parseEvaluationResponse('Fail', enumEval);
      expect(r.outcome).toBe('failure');
    });
  });

  describe('substring scan', () => {
    it('finds "pass" in verbose response', () => {
      const r = parseEvaluationResponse(
        'The overall status is pass based on all tests passing.',
        enumEval,
      );
      expect(r.parsed).toBe(true);
      expect(r.parsedValue).toBe('pass');
      expect(r.outcome).toBe('success');
    });

    it('finds "fail" in verbose response', () => {
      const r = parseEvaluationResponse(
        'After reviewing the evidence, the answer is fail.',
        enumEval,
      );
      expect(r.parsed).toBe(true);
      expect(r.parsedValue).toBe('fail');
    });

    it('prefers longer match (partial_pass before pass)', () => {
      const longEnum: ExitEvaluation = {
        prompt: 'Status?',
        responseFormat: 'enum',
        choices: ['pass', 'partial_pass', 'fail'],
        mapping: { pass: 'success', partial_pass: 'failure', fail: 'failure' },
      };
      const r = parseEvaluationResponse('partial_pass', longEnum);
      expect(r.parsedValue).toBe('partial_pass');
    });
  });

  describe('fallback', () => {
    it('falls back to default on unrecognized value', () => {
      const r = parseEvaluationResponse('scarlet', enumEval);
      expect(r.parsed).toBe(false);
      expect(r.fallback).toBe(true);
      expect(r.outcome).toBe('failure');
    });

    it('falls back to default on empty', () => {
      const r = parseEvaluationResponse('', enumEval);
      expect(r.parsed).toBe(false);
      expect(r.outcome).toBe('failure');
    });
  });
});

// ---------------------------------------------------------------------------
// Default outcome configuration
// ---------------------------------------------------------------------------

describe('defaultOutcome', () => {
  it('uses "failure" when defaultOutcome is not set', () => {
    const eval_: ExitEvaluation = {
      prompt: 'Test?',
      responseFormat: 'boolean',
      mapping: { 'true': 'success', 'false': 'failure' },
      // no defaultOutcome
    };
    const r = parseEvaluationResponse('xyzzy', eval_);
    expect(r.outcome).toBe('failure');
  });

  it('uses configured defaultOutcome on fallback', () => {
    const eval_: ExitEvaluation = {
      prompt: 'Test?',
      responseFormat: 'boolean',
      mapping: { 'true': 'success', 'false': 'failure' },
      defaultOutcome: 'success',
    };
    const r = parseEvaluationResponse('xyzzy', eval_);
    expect(r.outcome).toBe('success');
  });
});

// ---------------------------------------------------------------------------
// Mapping flexibility
// ---------------------------------------------------------------------------

describe('custom mappings', () => {
  it('supports inverted boolean logic', () => {
    const inverted: ExitEvaluation = {
      prompt: 'Were there any failures?',
      responseFormat: 'boolean',
      mapping: { 'true': 'failure', 'false': 'success' },
    };
    expect(parseEvaluationResponse('true', inverted).outcome).toBe('failure');
    expect(parseEvaluationResponse('false', inverted).outcome).toBe('success');
  });

  it('supports multi-outcome enum with single success', () => {
    const strictEnum: ExitEvaluation = {
      prompt: 'Color?',
      responseFormat: 'enum',
      choices: ['red', 'green', 'yellow'],
      mapping: { red: 'failure', green: 'success', yellow: 'failure' },
    };
    expect(parseEvaluationResponse('green', strictEnum).outcome).toBe('success');
    expect(parseEvaluationResponse('red', strictEnum).outcome).toBe('failure');
    expect(parseEvaluationResponse('yellow', strictEnum).outcome).toBe('failure');
  });
});

// ---------------------------------------------------------------------------
// The "scarlet vs red" scenario — the whole point of this design
// ---------------------------------------------------------------------------

describe('domain-specific evaluation vs regex scanning', () => {
  it('enum avoids the scarlet/red problem entirely', () => {
    // The workflow author defines constrained choices.  The LLM must
    // pick from them.  There is no ambiguity.
    const colorEval: ExitEvaluation = {
      prompt: 'Is the indicator red or green?',
      responseFormat: 'enum',
      choices: ['red', 'green'],
      mapping: { red: 'failure', green: 'success' },
    };
    // LLM says "red" (direct) -> success
    expect(parseEvaluationResponse('red', colorEval).outcome).toBe('failure');
    // LLM says "green" -> success
    expect(parseEvaluationResponse('green', colorEval).outcome).toBe('success');
    // LLM says "scarlet" -> no match -> fallback (failure)
    const r = parseEvaluationResponse('scarlet', colorEval);
    expect(r.parsed).toBe(false);
    expect(r.outcome).toBe('failure'); // safe default
  });

  it('boolean avoids ambiguous natural language', () => {
    // Instead of scanning output for "FAIL" / "PASS" patterns,
    // we ask a direct question and get true/false.
    const r = parseEvaluationResponse('false', boolEval);
    expect(r.outcome).toBe('failure');
    // No matter what the *work output* said — we asked, we got "false".
  });
});

// ---------------------------------------------------------------------------
// Result structure
// ---------------------------------------------------------------------------

describe('EvaluationParseResult structure', () => {
  it('rawResponse preserves original text', () => {
    const r = parseEvaluationResponse('  TRUE  ', boolEval);
    expect(r.rawResponse).toBe('TRUE');
  });

  it('parsedValue is null on fallback', () => {
    const r = parseEvaluationResponse('indeterminate', enumEval);
    expect(r.parsedValue).toBeNull();
  });

  it('parsedValue is the matched choice on enum success', () => {
    const r = parseEvaluationResponse('partial', enumEval);
    expect(r.parsedValue).toBe('partial');
  });
});

// ---------------------------------------------------------------------------
// Streaming deduplication
// ---------------------------------------------------------------------------

describe('deduplicateStreamingRepetition', () => {
  it('deduplicates "truetruetrue" to "true"', () => {
    expect(deduplicateStreamingRepetition('truetruetruetrue', ['true', 'false'])).toBe('true');
  });

  it('deduplicates "falsefalsefalse" to "false"', () => {
    expect(deduplicateStreamingRepetition('falsefalsefalse', ['true', 'false'])).toBe('false');
  });

  it('deduplicates a single occurrence (no repetition)', () => {
    expect(deduplicateStreamingRepetition('true', ['true', 'false'])).toBe('true');
  });

  it('is case-insensitive', () => {
    expect(deduplicateStreamingRepetition('TrUeTrUeTrUe', ['true', 'false'])).toBe('true');
  });

  it('returns original string when not a pure repetition', () => {
    expect(deduplicateStreamingRepetition('true but also false', ['true', 'false'])).toBe('true but also false');
  });

  it('returns original string when empty', () => {
    expect(deduplicateStreamingRepetition('', ['true', 'false'])).toBe('');
  });

  it('deduplicates enum choices', () => {
    expect(deduplicateStreamingRepetition('acceptedacceptedaccepted', ['accepted', 'rejected'])).toBe('accepted');
  });

  it('handles long repetitions (16+ repeats from smoke test)', () => {
    const repeated = 'true'.repeat(32);
    expect(deduplicateStreamingRepetition(repeated, ['true', 'false'])).toBe('true');
  });
});

describe('parseEvaluationResponse — streaming repetition (integration)', () => {
  it('parses "truetruetruetrue..." as success', () => {
    const r = parseEvaluationResponse('true'.repeat(16), boolEval);
    expect(r.parsed).toBe(true);
    expect(r.parsedValue).toBe('true');
    expect(r.outcome).toBe('success');
  });

  it('parses "falsefalsefalse..." as failure', () => {
    const r = parseEvaluationResponse('false'.repeat(10), boolEval);
    expect(r.parsed).toBe(true);
    expect(r.parsedValue).toBe('false');
    expect(r.outcome).toBe('failure');
  });

  it('parses enum "passpasspass..." as success', () => {
    const r = parseEvaluationResponse('pass'.repeat(8), enumEval);
    expect(r.parsed).toBe(true);
    expect(r.parsedValue).toBe('pass');
    expect(r.outcome).toBe('success');
  });

  it('parses enum "failfailfail..." as failure', () => {
    const r = parseEvaluationResponse('fail'.repeat(8), enumEval);
    expect(r.parsed).toBe(true);
    expect(r.parsedValue).toBe('fail');
    expect(r.outcome).toBe('failure');
  });
});
