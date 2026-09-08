# Bookish Product Spec

Bookish is a web application for discovering books and managing personal reading activity.

## Product goals

Bookish should let a reader:

- create an account and sign in securely
- discover and search books
- view book details and public reviews
- maintain personal reading shelves
- rate books
- write and edit reviews where supported
- like and unlike reviews
- manage their own profile and reading state without leaking or mixing another user's data

The product should feel reliable, simple, and fast enough for normal personal use before additional features are added.

## Current core capabilities

- Signup, login, logout, refresh-based session restoration
- Secure access-token handling with rotating refresh cookies
- Book discovery with search, filtering, sorting, and pagination
- Book detail pages with paginated reviews
- Personal shelves: want to read, reading, read
- Personal ratings
- Reviews and review likes
- User profile retrieval
- Cross-tab account/session coordination in the frontend
- Backend validation, security middleware, transaction handling, and integration tests

## Current stack

### Backend

- Node.js 22+
- Express 5
- PostgreSQL
- Prisma 7
- Zod
- JWT authentication
- bcrypt

### Frontend

- React 19
- Vite
- React Router
- Tailwind CSS

### Verification

- Node test runner
- Supertest
- Frontend jsdom tests
- Dedicated PostgreSQL integration test environment
- GitHub Actions

## Engineering priorities

In order:

1. Correctness
2. Security and user isolation
3. Data integrity
4. Preserve working behavior
5. Simplicity
6. Good UX
7. Performance where it matters
8. Maintainability

## Non-goals for routine feature work

Do not do these unless a specific task requires them:

- rewrite the application to another framework
- replace Express, Prisma, PostgreSQL, React, or Vite without a strong product reason
- redesign the authentication architecture merely for novelty
- add infrastructure or abstractions for hypothetical scale
- pursue perfect test coverage
- refactor stable code only for stylistic consistency
- add features that are not part of the current milestone

## Product-development rule

Prefer shipping a small, correct, user-visible improvement over spending the same effort polishing architecture that is already working.
