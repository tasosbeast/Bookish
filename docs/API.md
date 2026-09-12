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

Send `X-Bookish-CSRF: 1` on **all auth POST requests**, including signup/login. Browser requests must originate from `CLIENT_ORIGIN` and use `credentials: 'include'`. Production requires HTTPS. Refresh cookies use HttpOnly, Secure in production, SameSite=None, and Path=/api/auth for the current split-origin Render deployment (where frontend and API run on distinct `*.onrender.com` origins). `CLIENT_ORIGIN` must match the exact frontend URL; no wildcard CORS is permitted. A custom-domain production deployment (for example `app.example.com` and `api.example.com`) can later use a stricter same-site cookie policy. No `Domain` attribute targeting `onrender.com` should be set, as `onrender.com` is a public suffix.

| Endpoint | JSON body | Result |
| --- | --- | --- |
| POST /api/auth/signup | `{ "username": "reader_1", "email": "reader@example.com", "password": "a long unique passphrase" }` | 201, safe user + access token; refresh cookie |
| POST /api/auth/login | `{ "email": "reader@example.com", "password": "a long unique passphrase" }` | 200, safe user + access token; refresh cookie |
| POST /api/auth/refresh | No body; refresh cookie required | 200, new access token and rotated refresh cookie |
| POST /api/auth/logout | No body; refresh cookie | 204, session revoked and cookie cleared |
| GET /api/auth/me | No body; bearer access token required | 200, `{ "user": { "id": "...", "username": "reader_1", "email": "reader@example.com", "profilePicture": null, "bio": null } }` |
| PATCH /api/auth/me | Optional `{ "bio": "...", "profilePicture": "https://..." }`; bearer access token required | 200, `{ "user": { "id": "...", "username": "reader_1", "email": "reader@example.com", "profilePicture": "...", "bio": "..." } }` |

Username/email are trimmed and lowercased; username is 3–30 ASCII letters/digits/underscores. Passwords are never trimmed and must be at least 12 characters and at most 72 UTF-8 bytes, avoiding bcrypt's silent truncation. Password hashes use bcrypt cost 12 and never appear in responses.

Authentication identity lookups use parameterized `lower(column) = lower(value)` equality, matching the existing lower-case unique indexes and supporting legacy mixed-case records. Underscores are literal: `a_b@example.com` and `axb@example.com` identify different accounts, and a username containing `_` does not conflict with a different character in its place. These lookups intentionally avoid Prisma's insensitive `equals`, which generates PostgreSQL `ILIKE` pattern matching. Email/username validation rules are unchanged; the book search API still uses escaped ILIKE for substring searches.

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

To restore a frontend session after reload, rotate the refresh cookie first, then use the new access token for profile and shelf reads. `/me` selects exactly the same five safe user fields as signup/login; it never returns password hashes or refresh-session data. It requires no CSRF header because it is a bearer-authenticated GET. Missing, invalid, expired or revoked credentials return 401. Profile and shelf responses use `Cache-Control: no-store`.

```js
const refreshed = await fetch('http://localhost:3000/api/auth/refresh', {
  method: 'POST', credentials: 'include', headers: { 'X-Bookish-CSRF': '1' },
});
if (!refreshed.ok) throw new Error('Please sign in again');
const { accessToken } = await refreshed.json();
const headers = { Authorization: `Bearer ${accessToken}` };
const profileResponse = await fetch('http://localhost:3000/api/auth/me', { headers });
const { user } = await profileResponse.json();
const shelvesResponse = await fetch('http://localhost:3000/api/user-books?status=read&page=1&limit=20', { headers });
const shelves = await shelvesResponse.json();
```

## Books

`GET /api/genres`

Public endpoint returning all genres currently assigned to at least one book, sorted deterministically by `name` ascending:

```json
{
  "data": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "name": "Fantasy",
      "slug": "fantasy"
    }
  ]
}
```

`GET /api/books?page=1&limit=20&genre=fantasy&author=Jane%20Austen&sort=rating&order=desc&q=hobbit`

- `page`: 1–10000; `limit`: 1–100 (default 20).
- `genre`: exact genre slug.
- `author`: literal case-insensitive substring of the author display string, 1–200 characters. It is combined with `q` and `genre` when supplied.
- `sort`: `rating` (default) or `publicationYear`; `order`: `asc` or `desc` (default).
- `q`: literal case-insensitive substring of title or author, 1–200 characters. `%`, `_` and backslash are escaped; Prisma uses parameterized PostgreSQL ILIKE, supported by the migration's GIN trigram indexes. Very short searches may still scan.
- Both sorts place null values last and use ID as a deterministic tie-breaker. Pagination is bounded **offset pagination** for this API; use cursor pagination if large-catalog navigation becomes necessary. Concurrent changes between separate requests can move results between pages.

Response: `{ "data": [ ...booksWithGenres ], "pagination": { "page": 1, "limit": 20, "total": 50, "totalPages": 3 } }`. `averageRating` is a JSON number or null. Counts and results within each request share a repeatable-read snapshot.

`GET /api/books/:id?page=1&limit=20` returns `{ "data": { ...book, "genres": [...], "reviews": { "data": [...], "pagination": {...} } } }`. Pagination applies to reviews. Reviews are newest first with ID as tie-breaker. Reviewer data includes only ID, username and profile picture. Unknown books return 404.

Each review also has `likedByMe: true | false`. Without an Authorization header it is always false, even if the browser has a refresh cookie. Supply `Authorization: Bearer <accessToken>` to obtain the current reader's state. Both `/api/books/` and `/api/books/:id` validate any supplied Authorization header and active session; malformed, empty, expired or revoked credentials return 401 instead of falling back to anonymous access. The catalog's response shape is unchanged and does not embed reviews.

For example, `GET /api/books/:id?limit=1` can return a review containing:

```json
{
  "id": "11111111-1111-4111-8111-111111111111",
  "rating": 4,
  "reviewText": "Thoughtful and engaging.",
  "likesCount": 2,
  "likedByMe": true,
  "user": { "id": "22222222-2222-4222-8222-222222222222", "username": "reader_1", "profilePicture": null }
}
```

Like states are fetched in one query restricted to the current reader and returned review IDs, inside the same repeatable-read transaction. No liker identities or session fields are exposed. Detail responses use `Cache-Control: no-store` and `Vary: Authorization` to prevent sharing personalized responses.

## Shelves and reviews

All following routes require `Authorization: Bearer <accessToken>`. Successful operations return 200, including an already-satisfied like/unlike request.

`GET /api/user-books?status=read&q=dune&page=1&limit=20`

Returns only bookshelf entries where `status` is not null for the user identified by the verified access token. `status` is optional and accepts `want_to_read`, `currently_reading` or `read`. `q` is an optional trimmed search string (1–200 characters) that filters entries by literal case-insensitive substring match on book title or author. `page` is 1–10000 (default 1); `limit` is 1–100 (default 20). Entries sort by `updatedAt` descending, then `bookId` ascending, including when timestamps tie. Count and page share a repeatable-read snapshot. Unknown parameters, including a caller-supplied `userId`, return 400. An empty or out-of-range page returns an empty `data` array with accurate pagination metadata.

```json
{
  "data": [{
    "bookId": "11111111-1111-4111-8111-111111111111",
    "status": "read",
    "userRating": 4,
    "createdAt": "2026-09-06T00:00:00.000Z",
    "updatedAt": "2026-09-06T00:00:00.000Z",
    "book": {
      "id": "11111111-1111-4111-8111-111111111111",
      "title": "Example Book",
      "author": "Example Author",
      "coverImageUrl": null,
      "averageRating": 4.25,
      "genres": [{ "id": "22222222-2222-4222-8222-222222222222", "name": "Fantasy", "slug": "fantasy" }]
    }
  }],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

The nested book also includes its other existing scalar fields (description, ISBN, publication year, ratings count and timestamps). `userRating` and `averageRating` can be null; the latter is serialized as a JSON number when rated. Only the current reader's shelf is returned, and no user/session relation is included.

`POST /api/user-books`

```json
{ "bookId": "11111111-1111-4111-8111-111111111111", "status": "read", "userRating": 5 }
```

Supply `status` and/or `userRating`. Status is `want_to_read`, `currently_reading` or `read`; if omitted when creating a new record, `status` defaults to `null`. Rating is an integer 1–5 or null. Omitted fields retain previous values. A status-only update never clears a rating. Clearing a rating while a review exists returns 409. An updated rating is copied to any existing review in the same transaction.

`DELETE /api/user-books/:bookId`

Removes the book from the authenticated reader's bookshelf (setting `status` to `null` if a rating or review exists, or removing the `UserBook` record if neither exists) and returns `{ "data": { "bookId": "...", "removed": true } }`. The reader's rating and review are preserved. The Book's average rating and rating count remain unchanged since the rating is preserved. A missing personal shelf entry (where no `UserBook` record exists) returns `404 SHELF_NOT_FOUND`.

`POST /api/reviews`

```json
{ "bookId": "11111111-1111-4111-8111-111111111111", "rating": 4, "reviewText": "Thoughtful and engaging." }
```

Upserts the user's unique review and canonical shelf rating together, preserving an existing shelf status. Text is optional, nullable and at most 10000 characters; omit to preserve it, send null to clear it. Review writes and shelf rating writes recompute `Book.averageRating` and `ratingsCount` from all non-null shelf ratings, counting each reader once. No ratings produces a null average and zero count.

`DELETE /api/reviews/:id`

Deletes the review only when it belongs to the authenticated reader and returns `{ "data": { "reviewId": "...", "deleted": true } }`. A missing review or a review owned by another reader returns `404 REVIEW_NOT_FOUND`. The reader's `UserBook`, shelf status and canonical `userRating` remain unchanged, so the book's `averageRating` and `ratingsCount` also remain unchanged. Likes attached to the deleted review are removed by the existing database cascade.

Likes use explicit, idempotent state-setting commands (no request body):

| Endpoint | Effect | Response |
| --- | --- | --- |
| PUT /api/reviews/:id/like | Ensure the current reader's like exists | `{ "data": { "reviewId": "...", "liked": true, "likesCount": 1 } }` |
| DELETE /api/reviews/:id/like | Ensure the current reader's like is absent | `{ "data": { "reviewId": "...", "liked": false, "likesCount": 0 } }` |

Repeated or simultaneous PUT requests create at most one like for the reader; repeated DELETE requests succeed even when their like is already absent. Neither operation modifies another reader's like. The join row and cached count are maintained together in a serializable transaction. `likesCount` reflects that transaction's snapshot and can differ between retries when other readers act. Unknown reviews return 404 for both methods; invalid UUIDs return 400, and missing/invalid/revoked access tokens return 401.

**Contract change:** the old `POST /api/reviews/:id/like` toggle has been removed. Authenticated requests using POST receive 405 with `Allow: PUT, DELETE`; they do not change a like. Frontend callers must send the desired state explicitly:

```js
const response = await fetch(`http://localhost:3000/api/reviews/${reviewId}/like`, {
  method: desiredLiked ? 'PUT' : 'DELETE',
  headers: { Authorization: `Bearer ${accessToken}` },
});
if (!response.ok) throw new Error('Could not save like state');
const { data: { liked, likesCount } } = await response.json();
```

After a lost response, the client can retry the **same desired state** safely. Serialize state changes per review and cancel stale retries when the user changes their intent: a delayed PUT after an intentional DELETE would legitimately set the like again. Opposite concurrent commands are applied in the database's serialization order. CORS permits PUT and DELETE from the configured frontend origin.

These writes use serializable transactions and bounded exponential retry with jitter for serialization/deadlock and concurrent-insert conflicts. Each retry reruns the whole transaction. Exhausted serialization contention returns 503 with `Retry-After: 1`. Future deletion routes must also refresh affected aggregates in the same transaction; direct writes bypass these service invariants.

## Errors and operation

Errors have `{ "error": { "code": "...", "message": "..." } }`. Validation errors add `details` with field paths; unexpected errors include a request ID but no internal stack or SQL. Status codes include 400 validation, 401 authentication, 403 CSRF, 404 missing resource, 409 conflict, 413 oversized body, 429 rate limiting and 503 exhausted transaction contention.

`GET /health` is a process liveness check. `GET /ready` verifies PostgreSQL connectivity and returns `200 { "status": "ready" }` or `503 { "status": "unavailable" }` without exposing connection details. The server executes a database probe before listening and drains HTTP connections on SIGINT/SIGTERM. Rate limits currently use per-process memory: use a shared store and deployment-level controls before running multiple replicas. Configure `TRUST_PROXY_HOPS` only for the actual trusted proxy topology. Do not expose the sample database credentials outside local development.

The Prisma generator uses `prisma-client-js` to produce JavaScript for the requested plain `.js` Express backend. Prisma 7's PostgreSQL driver adapter is configured in `src/lib/prisma.js`. Tooling dependency overrides pin patched `deepmerge-ts` and `mysql2` versions; recheck them when upgrading Prisma.

References: [Prisma driver adapters](https://docs.prisma.io/docs/orm/v7/core-concepts/supported-databases/database-drivers), [Prisma transactions and retries](https://www.prisma.io/docs/orm/v6/prisma-client/queries/transactions).
## Exact personal book state

`GET /api/user-books/:bookId` requires a verified access token and active session. The UUID identifies an existing book; identity always comes from the token. Query parameters are not accepted. The response has `Cache-Control: no-store`.

```http
GET /api/user-books/11111111-1111-4111-8111-111111111111
Authorization: Bearer <access-token>
```

```json
{
  "data": {
    "bookId": "11111111-1111-4111-8111-111111111111",
    "shelf": {
      "bookId": "11111111-1111-4111-8111-111111111111",
      "status": "currently_reading",
      "userRating": 4,
      "createdAt": "2026-09-06T10:00:00.000Z",
      "updatedAt": "2026-09-06T10:00:00.000Z"
    },
    "review": {
      "id": "22222222-2222-4222-8222-222222222222",
      "bookId": "11111111-1111-4111-8111-111111111111",
      "rating": 4,
      "reviewText": "A thoughtful read.",
      "likesCount": 0,
      "createdAt": "2026-09-06T10:00:00.000Z",
      "updatedAt": "2026-09-06T10:00:00.000Z"
    }
  }
}
```

`shelf` and `review` are independently `null` when the current reader has no corresponding record. No user credentials or session fields are returned. Invalid UUID/query input returns 400, missing/invalid/revoked credentials return 401, and an unknown book returns 404. The read uses a consistent transaction snapshot. Use this endpoint to initialize editing forms: neither a paginated shelf nor a public review page can establish that personal data is absent. Existing POST shelf/review contracts remain unchanged.

## Notifications

All notification routes require `Authorization: Bearer <accessToken>`. Responses use `Cache-Control: no-store`.

`GET /api/notifications?limit=10`

Returns the authenticated recipient's notifications, ordered by `createdAt` descending. `limit` is an optional integer from 1 to 50 (default 10). `unreadCount` reflects all unread notifications belonging to the recipient across the entire dataset, not only those in the paginated response.

```json
{
  "data": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "type": "review_like",
      "readAt": null,
      "createdAt": "2026-09-12T00:00:00.000Z",
      "friendshipId": null,
      "actor": {
        "id": "22222222-2222-4222-8222-222222222222",
        "username": "maria",
        "profilePicture": null
      },
      "review": {
        "id": "33333333-3333-4333-8333-333333333333",
        "bookId": "44444444-4444-4444-8444-444444444444",
        "book": {
          "title": "The Hobbit"
        }
      }
    },
    {
      "id": "55555555-5555-4555-8555-555555555555",
      "type": "friend_request",
      "readAt": null,
      "createdAt": "2026-09-14T00:00:00.000Z",
      "friendshipId": "66666666-6666-4666-8666-666666666666",
      "actor": {
        "id": "77777777-7777-4777-8777-777777777777",
        "username": "alex",
        "profilePicture": null
      },
      "review": null
    }
  ],
  "unreadCount": 2
}
```

`PUT /api/notifications/:id/read`

Marks a single notification belonging to the authenticated recipient as read. Idempotent. Returns `{ "data": { "id": "...", "readAt": "..." } }`. Missing notifications or notifications owned by another recipient return 404.

`PUT /api/notifications/read-all`

Marks all unread notifications belonging to the authenticated recipient as read. Idempotent. Returns `{ "data": { "updatedCount": 1 } }`.

### Social Notification Rules
- When user B likes user A's review (`PUT /api/reviews/:id/like`), a `review_like` notification is generated for user A.
- Liking one's own review (`B === A`) creates no notification.
- Removing a like (`DELETE /api/reviews/:id/like`) automatically removes the corresponding `review_like` notification.
- When user B sends a friend request to user A (`POST /api/friends/requests`), a `friend_request` notification is generated for user A.
- When a pending request is canceled or declined (`DELETE /api/friends/requests/:id`), the corresponding `friend_request` notification is automatically removed.
- When an incoming friend request is accepted (`POST /api/friends/requests/:id/accept`), the corresponding `friend_request` notification is removed.
- Notifications rely on client-initiated fetches when the app header mounts or the notification popover opens (v1 has no WebSocket/SSE push).

## Recommendations

All recommendation routes require `Authorization: Bearer <accessToken>`. Responses use `Cache-Control: no-store`. No external recommendation providers or external ML services are used.

`GET /api/recommendations/top-picks?limit=6`

Returns personalized book recommendations calculated in-memory from the user's full historical ratings (`UserBook.userRating`). `limit` is an optional integer from 1 to 12 (default 6).

- **Candidate Exclusions**: Excludes all books for which the authenticated user has a `UserBook` record (including `want_to_read`, `currently_reading`, `read`, or rating-only entries).
- **Genre & Author Signal**: 5-star ratings add +2 genre points and +3 author points; 4-star ratings add +1 genre point and +2 author points; 3-star ratings add 0 points; 1-2 star ratings add 0 genre points (low ratings do not globally suppress genres) and penalty points to the specific author (-2 for 2-star, -3 for 1-star).
- **Minimum Signal**: Requires at least 3 rated books (`ratedBooks >= 3`). If fewer than 3 rated books exist, returns `data: []` with `meta.personalized: false`.

## Friends

All friends routes require `Authorization: Bearer <accessToken>`. Responses use `Cache-Control: no-store`.

`GET /api/friends/suggestions?limit=12`

Returns personalized reader suggestions based on genre profile similarity, rating agreement, and shared reading history. `limit` is an optional integer from 1 to 24 (default 12). Requires at least 5 eligible taste books (`status === "read"`, `status === "currently_reading"`, or `userRating != null`). If fewer than 5 eligible books exist, returns `data: []` with `meta.personalized: false`.

`GET /api/friends/search?q=<username>&limit=10`

Searches readers by username only. `q` is required, case-insensitive, supports partial matches, and must contain 2–30 characters; `limit` is 1–20 (default 10). The authenticated reader is excluded. Each result returns safe reader fields (`id`, `username`, `profilePicture`, `bio`) and its relationship state: `none`, `accepted` with `friendshipId`, or `pending` with an `incoming`/`outgoing` direction and `requestId`. This authenticated response is private and uses `Cache-Control: no-store`.

`GET /api/friends`

Returns list of accepted friends for the authenticated user.

`GET /api/friends/requests`

Returns `{ "data": { "incoming": [...], "sent": [...] } }` listing pending incoming and sent friend requests.

`POST /api/friends/requests`

Body: `{ "userId": "uuid" }`
Sends a friend request to the target user. Returns 201. Self-requests, nonexistent users, duplicate pending requests, or existing friends return 400/404/409 errors.

`POST /api/friends/requests/:id/accept`

Only the recipient of a pending friend request may accept it. Marks status as `accepted`.

`DELETE /api/friends/requests/:id`

Cancels a sent pending request or declines an incoming pending request.

`DELETE /api/friends/:id`

Removes an accepted friendship between the authenticated user and the target friend.



