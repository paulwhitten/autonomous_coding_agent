Date: 2025-12-15T14:30:00Z
From: test_manager
To: smoke-test-agent_developer
Subject: Create string utilities with tests
Priority: NORMAL
MessageType: unstructured
---

# Create string utilities with tests

Create a TypeScript module with string utility functions, write Jest tests, and verify the tests pass. Note: a `sum.ts` module already exists in the project from a prior task -- do not duplicate or overwrite it.

## Requirements

1. **Create `string-utils.ts`** in the project root directory:
   - Export `capitalize(s: string): string` -- returns the string with the first character uppercased
   - Export `reverse(s: string): string` -- returns the string reversed

2. **Create `string-utils.test.ts`** in the project root directory:
   - Import both functions from `./string-utils`
   - Test cases for `capitalize`:
     - Lowercase word (e.g., `capitalize("hello")` returns `"Hello"`)
     - Already capitalized (e.g., `capitalize("Hello")` returns `"Hello"`)
     - Empty string returns `""`
   - Test cases for `reverse`:
     - Normal word (e.g., `reverse("hello")` returns `"olleh"`)
     - Palindrome (e.g., `reverse("racecar")` returns `"racecar"`)
     - Empty string returns `""`

3. **Run `npx jest` from the project root** and confirm all tests pass (including any pre-existing tests)

4. **Create `test_results.txt`** in the project root with the Jest console output

## Acceptance Criteria

- `string-utils.ts` exists and exports both functions with type annotations
- `string-utils.test.ts` exists with at least 6 test cases (3 per function)
- `npx jest` exits with code 0 and all test suites pass
- `test_results.txt` contains the actual Jest output showing pass/fail status
