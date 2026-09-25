# Bookish AI Development Workflow

This document governs the controlled AI development lifecycle for the Bookish repository. It defines how work is scoped, implemented, verified, reviewed, and merged, ensuring predictable quality and safety.

## 1. Core Principles

- **Repository state is the source of truth**: All plans, tasks, code, and documentation live in and derive from the GitHub repository. Uncommitted external assumptions or hidden agent state do not count.
- **Single active task**: Exactly one task may be active in `TODO.md` at any time. A task must be fully completed, verified, and integrated before the next task begins (see Section 6 for the narrow AI Workflow Meta-Work Exception).
- **Scope before code**: Product ideas, bug reports, and features must be explicitly analyzed and scoped before any implementation starts.
- **Isolated execution**: Implementation happens exclusively on a dedicated git branch or worktree, never directly on `main`.
- **Separation of implementation and review**: The Builder (implementer) and Reviewer must normally be distinct agents or models to ensure an unbiased audit.
- **Rigorous verification**: Every change must pass appropriate automated checks. User-facing changes must additionally undergo manual or browser-flow verification where practical.
- **Structured pull requests**: Pull requests must summarize what changed, verification performed, and any genuine remaining risks.
- **Strict human-in-the-loop gates**: AI agents must never merge into `main` or deploy to production without explicit human approval.
- **Critical operations require explicit human sign-off**: Destructive database operations, secrets/credential changes, production migrations, and major architectural revisions always require explicit human approval.
- **No speculative scope**: Agents must never perform drive-by formatting, unrelated refactors, or unrequested future roadmap work.

## 2. Document Hierarchy

| Document | Purpose & Authority |
| :--- | :--- |
| `SPEC.md` | Defines core product capabilities, target user experience, technical stack, and engineering priorities. |
| `PLAN.md` | Tracks high-level roadmap milestones and completed progression. |
| `TODO.md` | Contains exactly one active implementation or audit task with clear acceptance criteria. |
| `AGENTS.md` | Shared engineering instruction manual: coding standards, safety rules, security constraints, and testing protocols. |
| `AI_WORKFLOW.md` | Operational workflow: stages, role responsibilities, transitions, and human approval checkpoints. |

## 3. Workflow Lifecycle

```
Product idea / bug / task
  │
  ▼
[Orchestrator scopes task]
  │
  ▼
[Human approves scope]
  │
  ▼
[Dedicated branch / worktree created]
  │
  ▼
[Builder implements scoped change]
  │
  ▼
[QA verifies (automated + manual/browser)]
  │
  ▼
[Independent Reviewer reviews diff]
  │
  ▼
[Builder addresses genuine findings] ──► (Re-verify as needed)
  │
  ▼
[CI suite passes]
  │
  ▼
[Human approves merge to main]
```

### Stage Details

1. **Intake & Scoping**:
   - An incoming idea, issue, or roadmap item is analyzed against `SPEC.md` and `PLAN.md`.
   - The Orchestrator produces a tightly bounded task description with explicit deliverables and acceptance criteria in `TODO.md`.
2. **Scope Approval**:
   - The human operator reviews and approves the scoped task in `TODO.md`.
3. **Workspace Isolation**:
   - Work begins on a dedicated feature branch or isolated worktree created from `main`. No direct edits on `main`.
4. **Implementation**:
   - The Builder executes the minimum necessary changes satisfying the task per `AGENTS.md`. Unrelated code remains untouched.
5. **Quality Assurance**:
   - QA runs focused and suite-level automated tests based on risk (backend, database, frontend, auth).
   - For user-visible UI changes, manual browser interaction verifies layout, responsiveness, and state handling.
6. **Independent Review**:
   - An independent Reviewer agent audits the git diff against correctness, regression risk, security, concurrency, and simplicity.
7. **Resolution**:
   - The Builder fixes confirmed issues identified by QA or the Reviewer. Unrelated suggestions are omitted.
8. **CI & Integration**:
   - Automated CI passes cleanly. Pull request or patch summary clearly outlines changes, verification evidence, and residual risks.
9. **Merge & Deployment Gate**:
   - Human operator inspects the PR and explicitly approves the merge into `main` and any production deployment.

## 4. Planned Roles

These roles define specific responsibilities across the workflow. (Agent definition files will be added separately.)

### Bookish Orchestrator
- **Responsibility**: Scopes incoming requests, maintains alignment across `SPEC.md`, `PLAN.md`, and `TODO.md`, and coordinates stage handoffs.
- **Constraints**: Does not implement code or modify application logic. Ensures only one task is active in `TODO.md`.

### Bookish Builder
- **Responsibility**: Implements the active `TODO.md` task within a dedicated branch/worktree, respecting `AGENTS.md` coding standards.
- **Constraints**: Confined to the assigned task scope. Does not perform opportunistic refactoring or self-approve merges.

### Bookish QA
- **Responsibility**: Validates implementation correctness using automated tests (`npm test`, integration tests, frontend builds) and browser/manual flow inspection for UI work.
- **Constraints**: Reports reproducible defects and regressions without modifying implementation code directly.

### Bookish Reviewer
- **Responsibility**: Performs independent code review on the final diff; checks security, auth/session safety, user isolation, data integrity, and contract preservation.
- **Constraints**: Must be an independent agent/model invocation from the Builder. Focuses strictly on introduced risks.

### Bookish Catalog Specialist
- **Responsibility**: Handles domain-specific catalog data tasks: Open Library bulk dumps, targeted extraction, ISBN matching, publisher evidence verification, offline index maintenance, and preparing/validating production-ready catalog artifacts. May work with local files, dumps, artifacts, fixtures, local databases, test databases, and approved non-production environments.
- **Constraints**: Must never connect to, modify, migrate, or write to the production database. May perform dry-run classification only against non-production databases unless a future workflow explicitly introduces a separate production read-only mechanism. Human approval of a production catalog write means the specialist stops and hands off the validated artifacts, dry-run results, exact proposed command/procedure, risks, and expected data impact to the human operator or an explicitly authorized production execution process; actual production execution is strictly outside the Catalog Specialist role.

## 5. Explicit Human Approval Gates

The following actions strictly require explicit human confirmation:

1. **Scope sign-off**: Moving a proposed task from ideation into an active `TODO.md`.
2. **Merging to `main`**: Committing to or merging into the primary repository branch.
3. **Deployments**: Any rollout to production or staging environments.
4. **Database schema & migrations**: Executing migrations or modifying persistent schema definitions.
5. **Destructive database operations**: Any operation that truncates, drops, or alters production data.
6. **Secrets & credentials**: Introducing, updating, or rotating API keys, JWT secrets, or environment credentials.
7. **Architectural deviations**: Proposing framework replacements, major dependency additions, or fundamental redesigns.

## 6. AI Workflow Meta-Work Exception

To allow necessary repository governance and AI workflow infrastructure to evolve without disrupting in-flight product roadmaps, a narrow exception to the single-active-TODO rule is permitted for workflow configuration.

### Qualification Criteria
Explicitly human-approved repository-governance or AI-workflow configuration work may occur without replacing or modifying the current product `TODO.md` **ONLY** when all of the following conditions are met:

1. **Explicit Human Approval**: A human operator explicitly approved the workflow/meta-work task.
2. **File Boundary**: Changes are strictly confined to AI workflow and governance files:
   - `AI_WORKFLOW.md`
   - `AGENTS.md`
   - `.agents/**`
3. **No Application Behavior Change**: No Bookish application runtime behavior, logic, or contracts are modified.
4. **No Source Code Changes**: No application source code files (under `src/`, `frontend/src/`, `scripts/`, etc.) are modified.
5. **No Database or Schema Changes**: No database migrations, `schema.prisma`, SQL scripts, or database configurations are modified.
6. **No Dependency Changes**: No packages, dependencies, or lockfiles (`package.json`, `package-lock.json`, etc.) are added, updated, or modified.
7. **No Secrets or Production Data**: No environment variables, secrets, credentials, or production data are touched or exposed.
8. **Isolated Branch**: The work is conducted on a dedicated branch or worktree and submitted as a dedicated pull request.
9. **Explicit Identification**: The pull request and branch clearly identify themselves as workflow/meta-work.

### Invariants Preserved
- This exception must **NOT** weaken the normal one-active-TODO rule for product, feature, bug-fix, catalog, infrastructure, or application work.
- The active product `TODO.md` remains completely unchanged while approved meta-work is performed.
- Any change touching application code, database schema, or dependencies automatically voids qualification for this exception and must be rejected as an unapproved scope violation.
