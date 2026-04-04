Date: 2026-02-01T00:03:00Z
From: localhost_manager
To: smoke-test-agent_developer
Subject: Step 4 - Write integration tests
Priority: NORMAL
MessageType: unstructured
---

Write integration tests for the Express API using Jest and supertest.

## Requirements

### 1. Install test dependencies

Run `npm install --save-dev jest supertest` in the project root.

### 2. Create `tests/integration.test.js`

Use supertest to test the Express app **in-process** (no `.listen()` needed):

```javascript
const request = require('supertest');
const app = require('../src/app');
```

This avoids port conflicts because supertest binds to an ephemeral port internally.

### 3. Test cases

Write at least 4 tests:

| # | Description | Method | Path | Body | Expected status | Expected response body |
|---|-------------|--------|------|------|-----------------|----------------------|
| 1 | Generic hello | GET | /api/hello | -- | 200 | `{ "message": "Hello, World!" }` |
| 2 | Personalized hello | POST | /api/hello | `{ "name": "Alice" }` | 200 | `{ "message": "Hello, Alice!" }` |
| 3 | Missing name defaults to World | POST | /api/hello | `{}` | 200 | `{ "message": "Hello, World!" }` |
| 4 | Swagger UI accessible | GET | /api-docs/ | -- | 200 or 301 | Response contains "swagger" (case-insensitive) |

### 4. Update `package.json` scripts

Ensure these entries exist:

```json
{
  "test": "jest"
}
```

### 5. Run the tests

Execute `npx jest` from the project root. All tests must pass.

## Acceptance Criteria

- `tests/integration.test.js` exists with at least 4 test cases
- `npx jest` exits with code 0
- All 4 tests pass
- No port conflicts or hanging processes after tests complete
- `package.json` scripts.test is set to `"jest"`

## Notes

This completes the 4-step project. Because `src/app.js` exports the app without calling `.listen()`, supertest can test it without starting a real server.
