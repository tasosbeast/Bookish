# Bookish Roadmap

This file tracks logical milestones. It is not a detailed implementation specification and should stay short.

## Completed foundation

- [x] Backend application structure
- [x] PostgreSQL / Prisma schema and migrations
- [x] Signup, login, logout, and refresh-session flow
- [x] Security middleware and validation
- [x] Book catalog API
- [x] Search, filtering, sorting, and pagination
- [x] Shelves and personal ratings
- [x] Reviews
- [x] Idempotent review likes/unlikes
- [x] Rating and like aggregate synchronization
- [x] Backend unit/HTTP tests
- [x] Dedicated database integration tests
- [x] React/Vite frontend foundation
- [x] Frontend session restoration and cross-tab coordination
- [x] Discovery UI
- [x] Book detail UI
- [x] My Books UI
- [x] Frontend regression tests and production build verification

## Current milestone

Move from an engineering-complete core toward a product that is polished enough to deploy and actually use.

Focus on user-visible gaps and production readiness. Avoid broad architectural rewrites.

## Near-term roadmap

- [ ] Audit the current user-facing flows and identify the smallest remaining UX/product gaps
- [ ] Finish the highest-value missing user-facing feature or UX gap
- [ ] Improve loading, empty, and error states where they are genuinely weak
- [ ] Perform a focused mobile/responsive pass
- [ ] Perform a focused accessibility pass
- [ ] Prepare production deployment configuration and documentation
- [ ] Perform one final security/data-integrity checkpoint review
- [ ] Perform final end-to-end verification
- [ ] Deploy a usable production version

## Later / only if real use justifies it

- [ ] Richer profile features
- [ ] Additional discovery/recommendation features
- [ ] More advanced search
- [ ] Social features beyond current review interactions
- [ ] Performance work based on measured bottlenecks

## Workflow rule

Only one item should be active in `TODO.md` at a time. Complete, verify, and commit that item before starting the next one.
