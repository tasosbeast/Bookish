# Bookish Agent Instructions

Read this file before making changes.

## General rules

- Make the smallest change that correctly solves the current task.
- Do not refactor unrelated working code.
- Do not add dependencies unless necessary.
- Preserve existing API contracts unless the task explicitly changes them.
- Preserve existing security, authorization, session, concurrency, and data-integrity guarantees.
- Prefer existing project patterns over introducing new abstractions.
- Never expose secrets or credentials.
- Never weaken tests just to make them pass.
- Do not start work on future tasks unless the current task explicitly requires it.

## Before coding

1. Read `TODO.md`.
2. Read only the relevant parts of `SPEC.md` and `PLAN.md` when needed.
3. Inspect only files relevant to the current task.
4. Search the repository before assuming how something works.
5. If a relevant contract exists in `docs/API.md`, `README.md`, or `frontend/README.md`, inspect only the relevant section.
6. Form a short implementation plan before editing.

Do not scan the entire repository unless the task genuinely requires it.

## While coding

- Keep scope limited to the current task.
- Reuse existing helpers, services, validators, hooks, components, and conventions.
- Avoid speculative improvements.
- Avoid drive-by formatting, renaming, dependency upgrades, or unrelated cleanup.
- Preserve backward compatibility unless the task explicitly changes a contract.
- For security-sensitive code, prefer explicit and boring code over clever abstractions.

## Verification

Choose verification based on the risk of the change.

### Backend-only UI-independent changes

Run focused tests first. Run `npm test` when the change can affect shared backend behavior.

### Prisma/schema/database changes

Run relevant tests, `npm run db:validate`, and integration tests when database behavior or transaction semantics are affected.

### Frontend changes

Run relevant frontend tests. Run `npm test --prefix frontend` when shared frontend behavior is affected. Run `npm run build --prefix frontend` for production-build verification.

### Security/auth/concurrency changes

Run the relevant focused tests plus the broad suites required to verify the affected guarantees. Use integration tests when behavior crosses the HTTP/database boundary.

Do not run expensive full integration verification for trivial copy, styling, or isolated presentational changes unless there is a concrete reason.

## Self-review

Before finishing:

1. Review your own git diff.
2. Check for:
   - correctness bugs
   - regressions
   - security issues
   - authentication/session mistakes
   - authorization or user-isolation mistakes
   - data-integrity problems
   - race/concurrency problems where relevant
   - stale-state or request-cancellation problems where relevant
   - unnecessary complexity
3. Fix issues you introduced.
4. Do not make unrelated improvements discovered during review.

## Documentation

Update documentation only when behavior, setup, contracts, or verification instructions actually changed. Do not rewrite large documentation sections unnecessarily.

## Final response

Report only:

- what changed
- files changed
- verification run
- any genuine remaining risk
- suggested next TODO item

Keep the response concise.
