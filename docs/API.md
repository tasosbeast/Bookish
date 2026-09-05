# Bookish API

## Structure

```text
src/
  server.js                 # Startup and graceful shutdown
  app.js                    # Express middleware and route registration
  config/env.js             # Validated environment
  routes/                   # auth, books, user-books, reviews
  controllers/              # HTTP responses and refresh cookies
  services/                 # Authentication, tokens, books, ratings/likes
  middleware/               # JWT auth, CSRF, validation, errors
  validators/index.js       # Zod request contracts
  lib/                      # Prisma, error type, transaction retries
  generated/prisma/         # Generated; excluded from Git
prisma/migrations/          # Initial tables, constraints, pg_trgm indexes
tests/                      # Unit/HTTP tests and PostgreSQL integration suite
```

All request bodies are JSON. Unknown body/query fields are rejected. UUID route parameters are validated. Authenticated writes use the access token's user ID; callers cannot supply another user's identity.

## Authentication

Send `X-Bookish-CSRF: 1` on **all auth POST requests**, including signup/login. Browser requests must originate from `CLIENT_ORIGIN` and use `credentials: 'include'`. Production requires HTTPS. Refresh cookies use HttpOnly, Secure in production, SameSite=Strict, and Path=/api/auth. The frontend and API must be deployed on the same site (for example app.example.com and api.example.com); unrelated domains are not supported by this cookie policy.

| Endpoint | JSON body | Result |
| --- | --- | --- |
| POST /api/auth/signup | `{ "username": "reader_1", "email": "reader@example.com", "password": "a long unique passphrase" }` | 201, safe user + access token; refresh cookie |
| POST /api/auth/login | `{ "email": "reader@example.com", "password": "a long unique passphrase" }` | 200, safe user + access token; refresh cookie |
| POST /api/auth/refresh | No body; refresh cookie required | 200, new access token and rotated refresh cookie |
| POST /api/auth/logout | No body; refresh cookie | 204, session revoked and cookie cleared |

Username/email are trimmed and lowercased; username is 3–30 ASCII letters/digits/underscores. Passwords are never trimmed and must be at least 12 characters and at most 72 UTF-8 bytes, avoiding bcrypt's silent truncation. Password hashes use bcrypt cost 12 and never appear in responses.

Access JWTs expire after 15 minutes. Refresh JWTs expire seven days after login; rotation does not extend that absolute lifetime. Only the current token's SHA-256 digest is stored in `refresh_sessions`. Each JWT has a random ID, token type, issuer, audience and session ID; access and refresh use distinct secrets and HS256 verification. Every protected request checks the active session, making logout/replay revocation effective for existing access tokens too.

**Serialize refresh requests on the client.** Reusing an older refresh token, including two simultaneous refresh requests, revokes that device's session and requires login. Keep access tokens in memory; refresh tokens are only sent as cookies. Logout affects the current session, not other devices. Expired session rows can be periodically removed with `DELETE FROM refresh_sessions WHERE expires_at < now()` by an operational cleanup job.

```js
const response = await fetch('http://localhost:3000/api/auth/login', {
  method: 'POST', credentials: 'include',
  headers: { 'Content-Type': 'application/json', 'X-Bookish-CSRF': '1' },
  body: JSON.stringify({ email: 'reader@example.com', password: 'a long unique passphrase' }),
});
const { accessToken } = await response.json();
```

## Books

`GET /api/books?page=1&limit=20&genre=fantasy&sort=rating&order=desc&q=hobbit`

- `page`: 1–10000; `limit`: 1–100 (default 20).
- `genre`: exact genre slug.
- `sort`: `rating` (default) or `publicationYear`; `order`: `asc` or `desc` (default).
- `q`: literal case-insensitive substring of title or author, 1–200 characters. `%`, `_` and backslash are escaped; Prisma uses parameterized PostgreSQL ILIKE, supported by the migration's GIN trigram indexes. Very short searches may still scan.
- Both sorts place null values last and use ID as a deterministic tie-breaker. Pagination is bounded **offset pagination** for this API; use cursor pagination if large-catalog navigation becomes necessary. Concurrent changes between separate requests can move results between pages.

Response: `{ "data": [ ...booksWithGenres ], "pagination": { "page": 1, "limit": 20, "total": 50, "totalPages": 3 } }`. `averageRating` is a JSON number or null. Counts and results within each request share a repeatable-read snapshot.

`GET /api/books/:id?page=1&limit=20` returns `{ "data": { ...book, "genres": [...], "reviews": { "data": [...], "pagination": {...} } } }`. Pagination applies to reviews. Reviews are newest first with ID as tie-breaker. Reviewer data includes only ID, username and profile picture. Unknown books return 404.

## Shelves and reviews

All following routes require `Authorization: Bearer <accessToken>` and return 200 for either create or update.

`POST /api/user-books`

```json
{ "bookId": "11111111-1111-4111-8111-111111111111", "status": "read", "userRating": 5 }
```

Supply `status` and/or `userRating`. Status is `want_to_read`, `currently_reading` or `read`; a new entry defaults to `want_to_read` if omitted. Rating is an integer 1–5 or null. Omitted fields retain previous values. A status-only update never clears a rating. Clearing a rating while a review exists returns 409. An updated rating is copied to any existing review in the same transaction.

`POST /api/reviews`

```json
{ "bookId": "11111111-1111-4111-8111-111111111111", "rating": 4, "reviewText": "Thoughtful and engaging." }
```

Upserts the user's unique review and canonical shelf rating together, preserving an existing shelf status. Text is optional, nullable and at most 10000 characters; omit to preserve it, send null to clear it. Review writes and shelf rating writes recompute `Book.averageRating` and `ratingsCount` from all non-null shelf ratings, counting each reader once. No ratings produces a null average and zero count.

`POST /api/reviews/:id/like` toggles the current user's like. Returns `{ "data": { "reviewId": "...", "liked": true, "likesCount": 1 } }`. The join row and cached count are changed together. This is a **toggle**, so clients must not blindly retry a request after an ambiguous network failure; a second successful request reverses the first.

These writes use serializable transactions and bounded exponential retry with jitter for serialization/deadlock and concurrent-insert conflicts. Each retry reruns the whole transaction. Exhausted serialization contention returns 503 with `Retry-After: 1`. Future deletion routes must also refresh affected aggregates in the same transaction; direct writes bypass these service invariants.

## Errors and operation

Errors have `{ "error": { "code": "...", "message": "..." } }`. Validation errors add `details` with field paths; unexpected errors include a request ID but no internal stack or SQL. Status codes include 400 validation, 401 authentication, 403 CSRF, 404 missing resource, 409 conflict, 413 oversized body, 429 rate limiting and 503 exhausted transaction contention.

`GET /health` is a liveness check. The server connects to the database at startup and drains HTTP connections on SIGINT/SIGTERM. Rate limits currently use per-process memory: use a shared store and deployment-level controls before running multiple replicas. Configure `TRUST_PROXY_HOPS` only for the actual trusted proxy topology. Do not expose the sample database credentials outside local development.

The Prisma generator uses `prisma-client-js` to produce JavaScript for the requested plain `.js` Express backend. Prisma 7's PostgreSQL driver adapter is configured in `src/lib/prisma.js`. Tooling dependency overrides pin patched `deepmerge-ts` and `mysql2` versions; recheck them when upgrading Prisma.

References: [Prisma driver adapters](https://docs.prisma.io/docs/orm/v7/core-concepts/supported-databases/database-drivers), [Prisma transactions and retries](https://www.prisma.io/docs/orm/v6/prisma-client/queries/transactions).
