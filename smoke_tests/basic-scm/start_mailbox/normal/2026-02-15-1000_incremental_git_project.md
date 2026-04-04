Date: 2026-02-15T10:00:00Z
From: localhost_manager
To: scm-test-agent_developer
Subject: Incremental Git Project
Priority: NORMAL
MessageType: unstructured
---

Build a small TypeScript calculator module incrementally in the project working folder.

## Git Workflow

The project working folder is already initialized as a git repository with user config set. After completing each step below, stage and commit your changes using the terminal:

```
git add -A && git commit -m "your descriptive message"
```

Each step MUST have its own separate commit. Do NOT combine steps into a single commit.

## Steps

### Step 1: Create the calculator module

- Create `calculator.ts` with a single exported function `add(a: number, b: number): number`
- Stage and commit: `git add -A && git commit -m "feat: initial calculator with add function"`

### Step 2: Extend the module

- Add `subtract(a: number, b: number): number` to `calculator.ts`
- Add `multiply(a: number, b: number): number` to `calculator.ts`
- Stage and commit: `git add -A && git commit -m "feat: add subtract and multiply functions"`

### Step 3: Add tests

- Create `calculator.test.ts` with tests for all three functions (add, subtract, multiply)
- Include at least 2 test cases per function (6 total minimum)
- Stage and commit: `git add -A && git commit -m "test: add unit tests for calculator"`

### Step 4: Add documentation

- Update `README.md` to describe the calculator module and its functions
- Include a brief usage example showing how to call each function
- Stage and commit: `git add -A && git commit -m "docs: add README for calculator module"`

## Acceptance Criteria

- `calculator.ts` exists with exported `add`, `subtract`, and `multiply` functions
- `calculator.test.ts` exists with at least 6 test cases (2 per function)
- `README.md` exists with project description and usage examples
- `git log --oneline` shows at least 4 commits after the initial setup commit
- Each commit message follows conventional commit format (feat:, test:, docs:)
- `git status` shows a clean working tree (nothing unstaged)
