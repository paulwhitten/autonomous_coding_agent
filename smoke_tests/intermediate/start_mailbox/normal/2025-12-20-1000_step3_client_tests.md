Date: 2026-02-01T00:02:00Z
From: localhost_manager
To: smoke-test-agent_developer
Subject: Step 3 - Add OpenAPI documentation
Priority: NORMAL
MessageType: unstructured
---

Add OpenAPI/Swagger documentation to the Express API from step 2.

## Requirements

### 1. Install Swagger dependencies

Run `npm install swagger-ui-express` in the project root. Do **not** install `swagger-jsdoc` -- use a hand-written spec file instead.

### 2. Create `openapi.yaml` in the project root

Write an OpenAPI 3.0 spec documenting both endpoints:

- `GET /api/hello` -- returns `{ "message": "string" }`
- `POST /api/hello` -- accepts `{ "name": "string" }`, returns `{ "message": "string" }`

Include `info.title`, `info.version`, `paths`, request body schema for POST, and response schema for both.

### 3. Mount Swagger UI in `src/app.js`

- Load `openapi.yaml` using `fs.readFileSync` and `yaml` parsing (install `js-yaml` if needed, or use JSON format instead)
- Serve Swagger UI at `/api-docs` using `swagger-ui-express`
- `GET /api-docs` should render the interactive Swagger UI page

## Acceptance Criteria

- `openapi.yaml` (or `openapi.json`) exists in the project root with valid OpenAPI 3.0 content
- Both `GET /api/hello` and `POST /api/hello` are documented in the spec
- `curl -s http://localhost:3000/api-docs/ | head -20` returns HTML containing "swagger"
- Server still starts cleanly with `npm start`

## Notes

Step 3 of 4. Keep the spec simple -- do not over-engineer with components/refs for a two-endpoint API.
