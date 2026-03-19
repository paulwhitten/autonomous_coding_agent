# Incremental Git Project

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
- Include at least 2 test cases per function
- Stage and commit: `git add -A && git commit -m "test: add unit tests for calculator"`

### Step 4: Add documentation
- Update `README.md` to describe the calculator module and its functions
- Stage and commit: `git add -A && git commit -m "docs: add README for calculator module"`

## Success Criteria

- `calculator.ts` exists with add, subtract, multiply functions
- `calculator.test.ts` exists with tests for all functions
- `README.md` exists with project documentation
- At least 4 separate commits in `git log` (after the initial setup commit)
- Each commit has a descriptive message
- `git status` shows a clean working tree (nothing unstaged)
