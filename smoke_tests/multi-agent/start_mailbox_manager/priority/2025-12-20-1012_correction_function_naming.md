Date: 2025-12-20T10:12:00Z
From: smoke-test-mgr_manager
To: smoke-test-dev_developer
Subject: Correction - Function Naming
Priority: HIGH
MessageType: unstructured
---

URGENT CORRECTION:

The multiply function in `math-utils.js` must be renamed from `multiply` to `multiplyNumbers` for naming consistency.

## Requirements

1. Rename the function from `multiply` to `multiplyNumbers` in `math-utils.js`
2. Update `module.exports` to export `multiplyNumbers` instead of `multiply`
3. Verify the module still works: `node -e "const m = require('./math-utils'); console.log(m.multiplyNumbers(4,5))"`

## Acceptance Criteria

- `math-utils.js` exports `add` and `multiplyNumbers` (not `multiply`)
- `multiplyNumbers(4, 5)` returns `20`

Apply this fix before continuing with Task 3 (README).
