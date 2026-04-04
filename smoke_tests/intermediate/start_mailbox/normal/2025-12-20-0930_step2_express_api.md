Date: 2026-02-01T00:01:00Z
From: localhost_manager
To: smoke-test-agent_developer
Subject: Step 2 - Express REST API
Priority: NORMAL
MessageType: unstructured
---

Wrap the existing `sayHello` function in an Express REST API.

## Requirements

### 1. Install Express

Run `npm install express` in the project root.

### 2. Create `src/app.js`

Export an Express app (do **not** call `app.listen()` in this file -- that goes in `src/server.js`). Define two routes:

**GET /api/hello**
- Response: `{ "message": "Hello, World!" }` (status 200)

**POST /api/hello**
- Accepts JSON body `{ "name": "<string>" }`
- Response: `{ "message": "Hello, <name>!" }` (status 200)
- If body is missing or `name` is empty/absent, respond with `{ "message": "Hello, World!" }`
- Use `express.json()` middleware for body parsing

Both routes must call `sayHello` from `./hello.js`.

### 3. Create `src/server.js`

Import `app` from `./app.js` and call `app.listen(3000)`. Add a console.log confirming the port. Set `module.exports = app` for testing.

### 4. Update `package.json`

Set `"start": "node src/server.js"` in scripts.

## Acceptance Criteria

- `npm start` starts the server on port 3000 without errors
- `curl http://localhost:3000/api/hello` returns `{"message":"Hello, World!"}`
- `curl -X POST -H "Content-Type: application/json" -d '{"name":"Bob"}' http://localhost:3000/api/hello` returns `{"message":"Hello, Bob!"}`
- `src/app.js` exports the Express app without calling `.listen()`

## Notes

Step 2 of 4. Separating `app.js` from `server.js` lets step 4 test the app with supertest without port conflicts.
