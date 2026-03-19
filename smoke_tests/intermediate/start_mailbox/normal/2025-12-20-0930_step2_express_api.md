Date: 2026-02-01T00:01:00Z
From: test_manager
To: developer
Subject: Step 2 - Refactor to Express REST API with OpenAPI
Priority: NORMAL

Please refactor the Hello World function into a full REST API with Express.js and OpenAPI documentation.

## Requirements

### 1. Express.js API
- Install express (`npm install express`)
- Create `src/server.js` with an Express server on port 3000
- Refactor the `sayHello` function to support both generic and personalized greetings

### 2. API Endpoints

**Endpoint 1: Generic Hello (GET)**
- Path: `GET /api/hello`
- Response: `{"message": "Hello, World!"}`

**Endpoint 2: Personalized Hello (POST)**
- Path: `POST /api/hello`
- Request body: `{"name": "Alice"}`
- Response: `{"message": "Hello, Alice!"}`
- If no name provided, default to "World"

### 3. OpenAPI Documentation
- Install swagger dependencies: `npm install swagger-ui-express swagger-jsdoc`
- Create `openapi.yaml` or use JSDoc annotations
- Document both endpoints with request/response schemas
- Serve Swagger UI at `/api-docs`

### 4. Project Structure
```
src/
  hello.js       (refactored to support name parameter)
  server.js      (Express app with routes)
openapi.yaml     (API documentation)
package.json     (with start script: "node src/server.js")
```

## Acceptance Criteria
- Server starts and responds on port 3000
- GET /api/hello returns generic greeting
- POST /api/hello with {"name": "Bob"} returns "Hello, Bob!"
- OpenAPI docs accessible at /api-docs
- All endpoints documented in OpenAPI spec

## Notes
Build on your existing hello.js from Step 1. The function should now accept an optional name parameter.
