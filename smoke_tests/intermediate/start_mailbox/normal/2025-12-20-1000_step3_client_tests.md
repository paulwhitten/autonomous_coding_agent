Date: 2026-02-01T00:02:00Z
From: test_manager
To: developer
Subject: Step 3 - Generate API client and write integration tests
Priority: NORMAL

Please create an API client from the OpenAPI spec and write comprehensive integration tests using Jest.

## Requirements

### 1. Generate API Client
- Install openapi-generator-cli: `npm install --save-dev @openapitools/openapi-generator-cli`
- Generate a JavaScript client from openapi.yaml
- Place generated client in `src/client/` directory
- Document how to use the generated client

### 2. Integration Tests with Jest
- Install Jest: `npm install --save-dev jest`
- Install supertest for HTTP testing: `npm install --save-dev supertest`
- Create `tests/integration.test.js`

### 3. Test Cases
Write tests that verify:

**Test 1: Generic Hello Endpoint**
- GET /api/hello returns 200 status
- Response contains {"message": "Hello, World!"}

**Test 2: Personalized Hello Endpoint**
- POST /api/hello with {"name": "Alice"} returns 200 status
- Response contains {"message": "Hello, Alice!"}

**Test 3: Personalized Hello with Empty Name**
- POST /api/hello with no name defaults to "World"
- Response contains {"message": "Hello, World!"}

**Test 4: OpenAPI Documentation**
- GET /api-docs returns 200 status
- Swagger UI is accessible

**Test 5: Using Generated Client**
- Import generated client
- Make requests using client methods
- Verify responses match expected format

### 4. Package.json Scripts
Add these scripts:
```json
{
  "test": "jest",
  "test:watch": "jest --watch",
  "test:coverage": "jest --coverage"
}
```

## Acceptance Criteria
- API client successfully generated from OpenAPI spec
- All 5 integration tests pass
- Tests use supertest for HTTP assertions
- Tests run with `npm test`
- Code coverage includes all endpoints
- Tests are readable and well-documented

## Notes
This completes the 3-step project. Make sure the server is properly started/stopped in test lifecycle (beforeAll/afterAll hooks).
