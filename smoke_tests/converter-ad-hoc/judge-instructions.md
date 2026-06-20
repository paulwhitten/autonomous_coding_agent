# Ad-Hoc Smoke Test — Task Specification

This document is the authoritative task specification the agent was asked to
fulfil. The LLM-as-Judge uses it as the reference rubric when characterizing the
agent's output for the ad-hoc smoke test.

The agent operated **without a workflow engine** — it received two plain ad-hoc
mailbox messages and had to perform the work autonomously, committing
incrementally to a git repository.

## Expected Deliverables

### Source module — `converter.ts`

Exports exactly these four functions:

- `celsiusToFahrenheit(c: number): number` — returns `(c * 9/5) + 32`
- `fahrenheitToCelsius(f: number): number` — returns `(f - 32) * 5/9`
- `milesToKilometers(m: number): number` — returns `m * 1.60934`
- `kilogramsToPounds(kg: number): number` — returns `kg * 2.20462`

The first three come from message 1; `kilogramsToPounds` is added by message 2.
The agent must **extend** the existing module without overwriting the original
three functions.

### Tests — `converter.test.ts`

At least **11 test cases** total covering all four functions, including:

- `celsiusToFahrenheit(0)` is `32`, `(100)` is `212`, `(-40)` is `-40`
- `fahrenheitToCelsius(32)` is `0`, `(212)` is `100`, `(-40)` is `-40`
- `milesToKilometers(1)` is approximately `1.60934`, `(0)` is `0`
- `kilogramsToPounds(1)` is approximately `2.20462`, `(0)` is `0`,
  `(100)` is approximately `220.462`

### Verification — `test_output.txt`

Contains the **actual** `npx jest` console output, demonstrating all tests pass
(exit code 0). The agent must run the tests, not fabricate the output.

### Documentation — `README.md`

Describes the converter module and includes a usage example showing how to
import and call each of the four functions, including `kilogramsToPounds`.

## Process Requirements

- **Incremental commits:** a separate git commit for each step, with the
  specified messages (`feat: add unit converter module`,
  `test: add converter unit tests`, `docs: capture test output`,
  `feat: add kilogramsToPounds converter`, `test: add kilogramsToPounds tests`,
  `docs: update test output with new tests`,
  `docs: update README with converter usage`). At least **5 commits** beyond the
  initial setup commit.
- **Clean working tree:** everything committed at the end (no uncommitted
  changes).
- **No overwriting:** message 2's work must preserve message 1's functions and
  tests.

## What "Good" Looks Like

A high-scoring run produces all four files with correct implementations,
≥11 passing tests, captured Jest output, a documented README, and a clean git
history of small, well-messaged commits — all accomplished autonomously from the
two ad-hoc messages with no workflow scaffolding.
