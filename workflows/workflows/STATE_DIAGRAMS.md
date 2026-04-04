# Workflow State Diagrams

Generated: 2026-02-24

## Development with QA Gate

**ID:** `dev-qa-merge`  
**Version:** 2.0.0  
**Description:** Standard workflow: Manager assigns task, Developer implements on feature branch, QA validates and merges to main.

### Role Legend

| Color | Role |
|-------|------|
| ![manager](https://via.placeholder.com/15/4a90d9/4a90d9.png) | manager |
| ![developer](https://via.placeholder.com/15/50c878/50c878.png) | developer |
| ![qa](https://via.placeholder.com/15/f0ad4e/f0ad4e.png) | qa |

### States

| State | Role | Description | Success -> | Failure -> | Retries |
|-------|------|-------------|-----------|-----------|---------|
| ASSIGN | manager | Manager delegates a single task to the developer with clear acceptance criteria | IMPLEMENTING | ESCALATED | - |
| IMPLEMENTING | developer | Developer implements the task on a feature branch from latest main | VALIDATING | IMPLEMENTING | 2 |
| VALIDATING | qa | QA checks out the feature branch and runs build, test, and lint | MERGING | REWORK | 1 |
| REWORK | developer | Developer fixes QA-reported issues on the same feature branch | VALIDATING | ESCALATED | 2 |
| MERGING | qa | QA merges the validated feature branch to main and cleans up | DONE | MERGING | 2 |
| DONE | manager | Task is complete | (terminal) | (terminal) | - |
| ESCALATED | manager | Task failed after max retries | (terminal) | (terminal) | - |

### State Diagram

```mermaid
stateDiagram-v2
    direction TB

    [*] --> ASSIGN

    ASSIGN : Task Assignment (manager)
    IMPLEMENTING : Implementation (developer) [max 2 retries]
    VALIDATING : QA Validation (qa) [max 1 retries]
    REWORK : Rework (developer) [max 2 retries]
    MERGING : Merge to Main (qa) [max 2 retries]
    DONE : Complete (manager)
    ESCALATED : Escalated (manager)

    ASSIGN --> IMPLEMENTING : success
    ASSIGN --> ESCALATED : failure
    IMPLEMENTING --> VALIDATING : success
    note right of IMPLEMENTING
        Retries in same state on failure
    end note
    VALIDATING --> MERGING : success
    VALIDATING --> REWORK : failure
    REWORK --> VALIDATING : success
    REWORK --> ESCALATED : failure
    MERGING --> DONE : success
    note right of MERGING
        Retries in same state on failure
    end note

    DONE --> [*]
    ESCALATED --> [*]

    classDef manager fill:#4a90d9,stroke:#2c5f9e,color:#fff
    classDef developer fill:#50c878,stroke:#2e8b57,color:#fff
    classDef qa fill:#f0ad4e,stroke:#c7962c,color:#000
    class ASSIGN manager
    class DONE manager
    class ESCALATED manager
    class IMPLEMENTING developer
    class REWORK developer
    class VALIDATING qa
    class MERGING qa
```

---

## Regulated Development Pipeline

**ID:** `regulatory`  
**Version:** 2.0.0  
**Description:** Industry safety standards compliant pipeline (e.g., IEC 62304, ISO 26262, DO-178C) with static analysis, coverage gates, code review, requirement traceability, and regulatory sign-off.

### Role Legend

| Color | Role |
|-------|------|
| ![manager](https://via.placeholder.com/15/4a90d9/4a90d9.png) | manager |
| ![developer](https://via.placeholder.com/15/50c878/50c878.png) | developer |
| ![qa](https://via.placeholder.com/15/f0ad4e/f0ad4e.png) | qa |

### States

| State | Role | Description | Success -> | Failure -> | Retries |
|-------|------|-------------|-----------|-----------|---------|
| ASSIGN | manager | Manager assigns a task with regulatory requirements and traceability IDs | IMPLEMENTING | ESCALATED | - |
| IMPLEMENTING | developer | Developer implements on a feature branch with safety-critical coding standards | STATIC_ANALYSIS | IMPLEMENTING | 2 |
| STATIC_ANALYSIS | qa | QA runs pedantic static analysis on the feature branch | UNIT_TESTING | REWORK_STATIC | 1 |
| REWORK_STATIC | developer | Developer fixes static analysis issues | STATIC_ANALYSIS | ESCALATED | 2 |
| UNIT_TESTING | qa | QA runs unit tests with coverage verification | CODE_REVIEW | REWORK_TESTS | 1 |
| REWORK_TESTS | developer | Developer adds tests to meet coverage threshold | UNIT_TESTING | ESCALATED | 2 |
| CODE_REVIEW | qa | QA performs detailed code review against coding standards | REQUIREMENT_TRACE | REWORK_REVIEW | - |
| REWORK_REVIEW | developer | Developer addresses code review findings | CODE_REVIEW | ESCALATED | 2 |
| REQUIREMENT_TRACE | qa | QA verifies requirement IDs are traced through code, tests, and commits | REGULATORY_SIGNOFF | REWORK_TRACE | - |
| REWORK_TRACE | developer | Developer adds missing requirement traceability annotations | REQUIREMENT_TRACE | ESCALATED | 1 |
| REGULATORY_SIGNOFF | manager | Manager reviews the full evidence package and signs off for regulatory compliance | MERGING | ESCALATED | - |
| MERGING | qa | QA merges the approved branch to main after manager sign-off | DONE | MERGING | 2 |
| DONE | manager | Task is complete | (terminal) | (terminal) | - |
| ESCALATED | manager | Task failed a regulatory gate after max retries | (terminal) | (terminal) | - |

### State Diagram

```mermaid
stateDiagram-v2
    direction TB

    [*] --> ASSIGN

    ASSIGN : Task Assignment (manager)
    IMPLEMENTING : Implementation (developer) [max 2 retries]
    STATIC_ANALYSIS : Static Analysis Gate (qa) [max 1 retries]
    REWORK_STATIC : Rework (Static Analysis) (developer) [max 2 retries]
    UNIT_TESTING : Unit Testing Gate (qa) [max 1 retries]
    REWORK_TESTS : Rework (Test Coverage) (developer) [max 2 retries]
    CODE_REVIEW : Code Review (qa)
    REWORK_REVIEW : Rework (Code Review) (developer) [max 2 retries]
    REQUIREMENT_TRACE : Requirement Traceability (qa)
    REWORK_TRACE : Rework (Traceability) (developer) [max 1 retries]
    REGULATORY_SIGNOFF : Regulatory Sign-Off (manager)
    MERGING : Merge to Main (qa) [max 2 retries]
    DONE : Complete (manager)
    ESCALATED : Escalated (manager)

    ASSIGN --> IMPLEMENTING : success
    ASSIGN --> ESCALATED : failure
    IMPLEMENTING --> STATIC_ANALYSIS : success
    note right of IMPLEMENTING
        Retries in same state on failure
    end note
    STATIC_ANALYSIS --> UNIT_TESTING : success
    STATIC_ANALYSIS --> REWORK_STATIC : failure
    REWORK_STATIC --> STATIC_ANALYSIS : success
    REWORK_STATIC --> ESCALATED : failure
    UNIT_TESTING --> CODE_REVIEW : success
    UNIT_TESTING --> REWORK_TESTS : failure
    REWORK_TESTS --> UNIT_TESTING : success
    REWORK_TESTS --> ESCALATED : failure
    CODE_REVIEW --> REQUIREMENT_TRACE : success
    CODE_REVIEW --> REWORK_REVIEW : failure
    REWORK_REVIEW --> CODE_REVIEW : success
    REWORK_REVIEW --> ESCALATED : failure
    REQUIREMENT_TRACE --> REGULATORY_SIGNOFF : success
    REQUIREMENT_TRACE --> REWORK_TRACE : failure
    REWORK_TRACE --> REQUIREMENT_TRACE : success
    REWORK_TRACE --> ESCALATED : failure
    REGULATORY_SIGNOFF --> MERGING : success
    REGULATORY_SIGNOFF --> ESCALATED : failure
    MERGING --> DONE : success
    note right of MERGING
        Retries in same state on failure
    end note

    DONE --> [*]
    ESCALATED --> [*]

    classDef manager fill:#4a90d9,stroke:#2c5f9e,color:#fff
    classDef developer fill:#50c878,stroke:#2e8b57,color:#fff
    classDef qa fill:#f0ad4e,stroke:#c7962c,color:#000
    class ASSIGN manager
    class REGULATORY_SIGNOFF manager
    class DONE manager
    class ESCALATED manager
    class IMPLEMENTING developer
    class REWORK_STATIC developer
    class REWORK_TESTS developer
    class REWORK_REVIEW developer
    class REWORK_TRACE developer
    class STATIC_ANALYSIS qa
    class UNIT_TESTING qa
    class CODE_REVIEW qa
    class REQUIREMENT_TRACE qa
    class MERGING qa
```

---

## V-Model Regulated Development Pipeline

**ID:** `v-model-regulatory`  
**Version:** 2.0.0  
**Description:** Industry safety standards compliant V-model (e.g., IEC 62304, ISO 26262, DO-178C). Left side descends through requirements, design, and implementation. Right side ascends through unit testing, static analysis, integration testing, and acceptance testing -- each level validating the corresponding left-side artifact.

### Role Legend

| Color | Role |
|-------|------|
| ![manager](https://via.placeholder.com/15/4a90d9/4a90d9.png) | manager |
| ![developer](https://via.placeholder.com/15/50c878/50c878.png) | developer |
| ![qa](https://via.placeholder.com/15/f0ad4e/f0ad4e.png) | qa |

### States

| State | Role | Description | Success -> | Failure -> | Retries |
|-------|------|-------------|-----------|-----------|---------|
| ASSIGN | manager | Manager assigns a task with requirement IDs, acceptance criteria, and security classification | REQUIREMENTS_ANALYSIS | ESCALATED | - |
| REQUIREMENTS_ANALYSIS | developer | V-model left side (Level 1) | DESIGN | REQUIREMENTS_ANALYSIS | 1 |
| DESIGN | developer | V-model left side (Level 2) | IMPLEMENTING | DESIGN | 1 |
| IMPLEMENTING | developer | V-model bottom | UNIT_TESTING | IMPLEMENTING | 2 |
| UNIT_TESTING | qa | V-model right side (Level 3) | STATIC_ANALYSIS | REWORK_UNIT | 1 |
| REWORK_UNIT | developer | Developer adds missing unit tests or fixes failing tests | UNIT_TESTING | ESCALATED | 2 |
| STATIC_ANALYSIS | qa | QA runs pedantic static analysis, checks unsafe usage, and audits dependencies | INTEGRATION_TESTING | REWORK_STATIC | 1 |
| REWORK_STATIC | developer | Developer fixes static analysis issues | STATIC_ANALYSIS | ESCALATED | 2 |
| INTEGRATION_TESTING | qa | V-model right side (Level 2) | ACCEPTANCE_TESTING | REWORK_INTEGRATION | 1 |
| REWORK_INTEGRATION | developer | Developer fixes integration issues found when modules interact | INTEGRATION_TESTING | ESCALATED | 2 |
| ACCEPTANCE_TESTING | qa | V-model right side (Level 1) | REGULATORY_SIGNOFF | REWORK_ACCEPTANCE | - |
| REWORK_ACCEPTANCE | developer | Developer fixes issues that caused acceptance test failures against requirements | ACCEPTANCE_TESTING | ESCALATED | 2 |
| REGULATORY_SIGNOFF | manager | Manager reviews the full V-model evidence package and signs off for regulatory compliance | MERGING | ESCALATED | - |
| MERGING | qa | QA merges the fully validated branch to main after regulatory sign-off | DONE | MERGING | 2 |
| DONE | manager | Task complete | (terminal) | (terminal) | - |
| ESCALATED | manager | Task failed a V-model gate after max retries | (terminal) | (terminal) | - |

### State Diagram

```mermaid
stateDiagram-v2
    direction TB

    [*] --> ASSIGN

    ASSIGN : Task Assignment (manager)
    REQUIREMENTS_ANALYSIS : Requirements Analysis (developer) [max 1 retries]
    DESIGN : System and Detailed Design (developer) [max 1 retries]
    IMPLEMENTING : Implementation (developer) [max 2 retries]
    UNIT_TESTING : Unit Testing (qa) [max 1 retries]
    REWORK_UNIT : Rework (Unit Tests) (developer) [max 2 retries]
    STATIC_ANALYSIS : Static Analysis (qa) [max 1 retries]
    REWORK_STATIC : Rework (Static Analysis) (developer) [max 2 retries]
    INTEGRATION_TESTING : Integration Testing (qa) [max 1 retries]
    REWORK_INTEGRATION : Rework (Integration) (developer) [max 2 retries]
    ACCEPTANCE_TESTING : Acceptance Testing (qa)
    REWORK_ACCEPTANCE : Rework (Acceptance) (developer) [max 2 retries]
    REGULATORY_SIGNOFF : Regulatory Sign-Off (manager)
    MERGING : Merge to Main (qa) [max 2 retries]
    DONE : Complete (manager)
    ESCALATED : Escalated (manager)

    ASSIGN --> REQUIREMENTS_ANALYSIS : success
    ASSIGN --> ESCALATED : failure
    REQUIREMENTS_ANALYSIS --> DESIGN : success
    note right of REQUIREMENTS_ANALYSIS
        Retries in same state on failure
    end note
    DESIGN --> IMPLEMENTING : success
    note right of DESIGN
        Retries in same state on failure
    end note
    IMPLEMENTING --> UNIT_TESTING : success
    note right of IMPLEMENTING
        Retries in same state on failure
    end note
    UNIT_TESTING --> STATIC_ANALYSIS : success
    UNIT_TESTING --> REWORK_UNIT : failure
    REWORK_UNIT --> UNIT_TESTING : success
    REWORK_UNIT --> ESCALATED : failure
    STATIC_ANALYSIS --> INTEGRATION_TESTING : success
    STATIC_ANALYSIS --> REWORK_STATIC : failure
    REWORK_STATIC --> STATIC_ANALYSIS : success
    REWORK_STATIC --> ESCALATED : failure
    INTEGRATION_TESTING --> ACCEPTANCE_TESTING : success
    INTEGRATION_TESTING --> REWORK_INTEGRATION : failure
    REWORK_INTEGRATION --> INTEGRATION_TESTING : success
    REWORK_INTEGRATION --> ESCALATED : failure
    ACCEPTANCE_TESTING --> REGULATORY_SIGNOFF : success
    ACCEPTANCE_TESTING --> REWORK_ACCEPTANCE : failure
    REWORK_ACCEPTANCE --> ACCEPTANCE_TESTING : success
    REWORK_ACCEPTANCE --> ESCALATED : failure
    REGULATORY_SIGNOFF --> MERGING : success
    REGULATORY_SIGNOFF --> ESCALATED : failure
    MERGING --> DONE : success
    note right of MERGING
        Retries in same state on failure
    end note

    DONE --> [*]
    ESCALATED --> [*]

    classDef manager fill:#4a90d9,stroke:#2c5f9e,color:#fff
    classDef developer fill:#50c878,stroke:#2e8b57,color:#fff
    classDef qa fill:#f0ad4e,stroke:#c7962c,color:#000
    class ASSIGN manager
    class REGULATORY_SIGNOFF manager
    class DONE manager
    class ESCALATED manager
    class REQUIREMENTS_ANALYSIS developer
    class DESIGN developer
    class IMPLEMENTING developer
    class REWORK_UNIT developer
    class REWORK_STATIC developer
    class REWORK_INTEGRATION developer
    class REWORK_ACCEPTANCE developer
    class UNIT_TESTING qa
    class STATIC_ANALYSIS qa
    class INTEGRATION_TESTING qa
    class ACCEPTANCE_TESTING qa
    class MERGING qa
```

---

