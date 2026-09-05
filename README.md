# Bookish backend

Express 5 API with JWT authentication, rotating refresh cookies, bcrypt, Zod validation, and PostgreSQL/Prisma 7. See [API documentation](docs/API.md) for the directory structure, endpoint contracts, examples, security behavior and transaction semantics.

## Run locally

1. Install Node.js 22.12+ and run `npm ci`.
2. Copy `.env.example` to `.env`. Set `DATABASE_URL` and generate two different random JWT secrets using the command in the example file.
3. Start PostgreSQL (optionally `docker compose up -d db`). The sample Compose credentials are for local development only.
4. Run `npm run db:generate`, `npm run db:validate`, then `npm run db:deploy` against a **new, empty database**.
5. Run `npm run dev` or `npm start`. Default API URL: `http://localhost:3000`.

The committed initial migration creates all tables, including refresh sessions, and applies the SQL checks and trigram indexes. The database role must be able to install `pg_trgm`. If you already deployed the original schema, baseline that database and generate a forward migration for refresh sessions; do not apply the initial CREATE TABLE migration over existing tables.

## Verification

`npm test` runs validation, HTTP security, JWT and retry tests without a database. `npm run test:integration` requires `TEST_DATABASE_URL` pointing at a migrated test database; without it the suite is explicitly skipped. For example in PowerShell, set `$env:TEST_DATABASE_URL='postgresql://bookish:bookish@localhost:5432/bookish_test'`, deploy migrations to that database using `DATABASE_URL`, then run the integration suite. Integration tests create and remove only their own fixtures.

GitHub Actions provisions PostgreSQL and runs migrations and both suites. The integration suite checks signup/login, logout, refresh replay revocation, filtering/search, rating synchronization, clearing ratings and concurrent likes. No GitHub workflow run is implied by local verification.

## Database design

Target: Node.js, Express, PostgreSQL, Prisma ORM 7. Prisma field names are camelCase; `@map` / `@@map` expose snake_case database columns and tables. UUIDs identify entities; join tables use compound primary keys. All timestamps include time zones.

## Files and setup

- `prisma/schema.prisma`: models, foreign keys, unique constraints, and B-tree indexes.
- `prisma.config.ts`: Prisma 7 connection configuration; set `DATABASE_URL` in your environment (or `.env`, excluded from version control).
- `prisma/constraints-and-search.sql`: additional PostgreSQL constraints and search indexes.

The SQL supplement is already included in the committed initial migration. Keep it as a reference; do not run it again after deploying the migration. For later model changes, create forward migrations with `prisma migrate dev` in development and deploy committed migrations with `prisma migrate deploy`.

The Express runtime uses `@prisma/adapter-pg` and `pg`; the generated Prisma client is initialized with the PostgreSQL adapter.

## Relations and semantics

- A user has many reviews and shelf entries; a book has many reviews and shelf entries. Each user/book pair has at most one review and one shelf entry.
- `UserBook.status` represents three mutually exclusive built-in shelves. A book can be rated without a written review; `null` means unrated. These are not custom, overlapping shelves.
- `BookGenre` implements the many-to-many book/genre relation and prevents duplicate assignments.
- `ReviewLike` records individual likes, prevents duplicate likes, and provides a source of truth for `Review.likesCount`.
- Deleting a user or book cascades to its dependent rows. Deleting a genre only removes its assignments, not books. Deleting a review removes its likes.
- A book is an edition, with an optional unique ISBN-13. Normalize ISBN-10 input to ISBN-13, strip separators, and validate its checksum before storing it. The database checks the format only. Missing ISBNs are NULL, never empty strings. For multiple authors or work/edition grouping, extend with Author, BookAuthor, and Work entities; author is currently a display string as requested.

## Integrity rules for the service layer

The SQL supplement enforces 1–5 ratings, nonnegative counts, and cache shape. Prisma relations alone do not enforce agreement between duplicated ratings or maintain cached aggregates.

`UserBook.userRating` is the canonical rating. Keep the requested `Review.rating` as a synchronized copy. Creating or editing a review must upsert its shelf entry and write both ratings in the same transaction. Changing a shelf rating must also update an existing review. Reject clearing a rating or deleting a shelf entry while a review remains, or explicitly delete that review in the same transaction. Deleting a review alone retains the shelf rating.

Compute `Book.averageRating` and `ratingsCount` from non-null UserBook ratings, counting each reader once. An unrated book has a NULL average and count zero. After each rating change or deletion, recompute the affected book's aggregate in the same transaction. Use serializable transactions with retries on serialization conflicts for all rating-writing paths to prevent concurrent writes from leaving stale aggregates. Avoid computing the average from rounded previous averages.

Maintain likesCount from ReviewLike rows in the like/unlike transaction, with the same concurrency protection. User deletion must collect affected book and review IDs before cascading and refresh surviving book averages/counts and review like counts in the same transaction. Direct database writes bypass these service rules; use database triggers instead if multiple independent writers will modify these tables.

Hash passwords with a password-hashing library; never store plaintext or expose passwordHash in public API responses. Trim identity input and use a consistent email/username normalization policy. The lower-case expression indexes reject case-only duplicates; Prisma's ordinary `findUnique` remains case-sensitive unless input is normalized consistently. `@updatedAt` is maintained by Prisma; direct SQL updates must set updated_at themselves.

## Indexes and query patterns

| Index | Purpose |
| --- | --- |
| Unique username, email, ISBN, genre name/slug | Identity and exact lookups; uniqueness also creates indexes |
| Review(userId, bookId) unique | One review per reader/book; direct lookup |
| Review(bookId, createdAt DESC, id) | Recent reviews on a book page |
| Review(userId, createdAt DESC, id) | A reader's review history |
| UserBook(userId, status, updatedAt DESC, bookId) | Filter a reader's shelf and paginate by recency |
| UserBook(bookId) | Aggregate book ratings and locate readers of a book |
| BookGenre(bookId, genreId) primary key | Genres assigned to a book |
| BookGenre(genreId, bookId) | Books in a genre |
| Book(publicationYear, id) | Publication-year filtering |
| Book(averageRating DESC, id) | Rating sorting; explicitly use NULLS LAST |
| ReviewLike(userId, reviewId) primary key; ReviewLike(reviewId) | Duplicate-like prevention and counting likes per review |
| GIN trigram indexes on title and author | Case-insensitive substring searches, such as ILIKE '%hobbit%' |

The API uses bounded offset pagination with deterministic ID tie-breakers; keyset pagination is a future optimization for large catalogs. Trigram indexes work best with search strings of at least three characters; very short searches can still scan. Plain B-tree indexes are not sufficient for arbitrary substring matching. Genre-plus-rating queries may still require a sort after joining: inspect realistic query plans before adding further indexes. Add PostgreSQL full-text search separately if ranked description/content search becomes a requirement.

Use the verification commands above to validate the schema and exercise the API against your environment.
