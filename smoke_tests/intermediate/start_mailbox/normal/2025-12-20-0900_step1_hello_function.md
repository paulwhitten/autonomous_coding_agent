Date: 2026-02-01T00:00:00Z
From: test_manager
To: developer
Subject: Step 1 - Create Hello World function
Priority: NORMAL

Please create a simple Hello World function as the foundation for our API project.

## Requirements

1. Create a new file `src/hello.js` with a function named `sayHello`
2. The function should return the string "Hello, World!"
3. Export the function using CommonJS (`module.exports`)

## Example Usage
```javascript
const { sayHello } = require('./hello');
console.log(sayHello()); // Should output: "Hello, World!"
```

## Acceptance Criteria
- Function exists and is exported
- Returns exactly "Hello, World!"
- Code is clean and simple

## Notes
This is step 1 of a 3-step project. Keep it simple - we'll expand it in the next steps.
