Date: 2026-02-01T00:00:00Z
From: localhost_manager
To: smoke-test-agent_developer
Subject: Step 1 - Create Hello World function
Priority: NORMAL
MessageType: unstructured
---

Create a Hello World function as the foundation for our API project.

## Requirements

1. Create `src/hello.js` with a function named `sayHello` that accepts an optional `name` parameter
2. If `name` is provided, return `"Hello, <name>!"` -- otherwise return `"Hello, World!"`
3. Export the function using CommonJS (`module.exports = { sayHello }`)
4. Install no additional dependencies for this step

## Example Usage

```javascript
const { sayHello } = require('./src/hello');
console.log(sayHello());        // "Hello, World!"
console.log(sayHello('Alice')); // "Hello, Alice!"
```

## Acceptance Criteria

- `src/hello.js` exists and exports `sayHello`
- `sayHello()` returns exactly `"Hello, World!"`
- `sayHello('Alice')` returns exactly `"Hello, Alice!"`
- `node -e "const {sayHello}=require('./src/hello'); console.log(sayHello())"` prints `Hello, World!`

## Notes

This is step 1 of a 4-step project. The function accepts an optional name parameter now so step 2 can use it directly without refactoring.
