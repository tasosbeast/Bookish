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

`npm test` runs the backend unit suite. It preloads `tests/setup.js` and runs test files one at a time, so no extra Node flags are required. `npm run lint` checks the backend and the frontend and fails when ESLint reports a warning. `npm run test:integration` requires `TEST_DATABASE_URL` pointing at a dedicated, migrated test database whose name ends in `_test`; without it the suite is explicitly skipped, which means integration verification is **incomplete**, not passed. Integration tests create and remove only their own fixtures. Never point tests or test migrations at a development or production database; never reset an existing database for verification.

With Docker Desktop running, start the dedicated test server and run in a separate PowerShell session. `compose.test.yaml` uses port 55433 and its own volume, separate from the development database on port 5432:

```powershell
docker compose -f compose.test.yaml up -d --wait
$env:TEST_DATABASE_URL='postgresql://bookish:bookish@localhost:55433/bookish_test'
$env:DATABASE_URL=$env:TEST_DATABASE_URL
npm run db:deploy
npm test
npm run test:integration
```

Stop the test server when finished with `docker compose -f compose.test.yaml stop`. Its data persists in the dedicated test volume. For a separately provisioned test database, use its connection URL instead; the database name must still end in `_test`.

Local verification on 2026-09-06: the initial migration deployed successfully to the dedicated PostgreSQL 17 test server; all 14 unit/HTTP tests and all 12 integration test entries passed, with zero skips. Coverage includes idempotent like/unlike retries, concurrent writes, CORS, literal email/username equality, wildcard-shaped inputs and legacy mixed-case identities. The development database runs separately from the test server.

GitHub Actions provisions PostgreSQL and runs migrations and both suites. The integration suite checks signup/login, logout, refresh replay revocation, filtering/search, rating synchronization, clearing ratings and concurrent likes. It also covers shelf filtering/pagination/user isolation, safe profile restoration after refresh, anonymous and personalized review like states, and invalid/revoked credentials on read endpoints. No GitHub workflow run is implied by local verification.

## Frontend read endpoints

- `GET /api/user-books?status=read&page=1&limit=20` requires a bearer access token and returns only that reader's shelf entries with nested book details and genres. Omit `status` for all shelves. Results sort by `updatedAt` descending, then `bookId` ascending. Existing shelf POST requests are unchanged.
- `GET /api/auth/me` requires a bearer access token (including one issued by refresh) and returns `{ "user": { "id", "username", "email", "profilePicture", "bio" } }` with those five fields only.
- `GET /api/books/:id?page=1&limit=20` includes `likedByMe` on each review. Anonymous readers receive false; authenticated readers receive their own like state. Both book GET routes reject invalid supplied Authorization headers with 401. The catalog route `/api/books/` still returns its existing book list; reviews belong to the detail route.

See [API examples](docs/API.md) for the refresh → profile → shelves flow and full response shapes.

## Like commands

Use authenticated `PUT /api/reviews/:id/like` to ensure a like exists and `DELETE /api/reviews/:id/like` to ensure it is absent. Both return 200 with `{ "data": { "reviewId": "...", "liked": true, "likesCount": 1 } }` (with `liked: false` for DELETE). Repeating the same command preserves that reader's desired state, including concurrent retries. The previous POST toggle now returns 405 with `Allow: PUT, DELETE`; frontend callers must use the new methods. See [like contracts and retry examples](docs/API.md#shelves-and-reviews).

## React frontend

The reading app lives in `frontend/` and uses React, Vite, Tailwind CSS and React Router. It includes discovery, book details, personal shelves, reviews, likes, login and signup. Follow [frontend setup and verification](frontend/README.md) to run both applications.

With the backend configured as above, run `npm run dev` in the project root. In another terminal, run `npm ci --prefix frontend` and `npm run dev --prefix frontend`, then open **http://localhost:5173**. The default API is `http://localhost:3000/api`; configure `VITE_API_BASE_URL` in `frontend/.env` when needed. Use the same browser hostname consistently and keep `CLIENT_ORIGIN` aligned with the frontend origin.

The frontend displays the real catalog, including an empty state when there are no books. No sample books are injected into the development database.

For reliable editing, authenticated `GET /api/user-books/:bookId` returns the reader's exact shelf and review, independently of list pagination. Both are `null` when absent; an unknown book returns 404. See [API contracts](docs/API.md).

## Production deployment

Bookish requires Node.js 22.12+ and PostgreSQL with the `pg_trgm` extension available to the migration role. Configure these backend environment variables in the hosting platform; do not commit a production `.env` file:

| Variable | Required production value |
| --- | --- |
| `NODE_ENV` | `production` |
| `PORT` | The port assigned to the API process; defaults to `3000` |
| `DATABASE_URL` | The production PostgreSQL connection URL, including the provider's required TLS options |
| `JWT_ACCESS_SECRET` | A unique random secret of at least 48 characters |
| `JWT_REFRESH_SECRET` | A different unique random secret of at least 48 characters |
| `CLIENT_ORIGIN` | Exact public HTTPS frontend origin, with no path or trailing slash |
| `TRUST_PROXY_HOPS` | Exact number of trusted reverse proxies between the client and Express; `0` only when traffic reaches Express directly |

`AVATAR_ALLOWED_HOSTS` is optional. It is a comma-separated list of exact hosts allowed for new profile picture URLs. A `*.example.com` entry allows subdomains of that host and not the host itself. When unset, Bookish allows Gravatar (`gravatar.com`, `www.gravatar.com`, `secure.gravatar.com`, `s.gravatar.com`, `0.gravatar.com`, `1.gravatar.com`, `2.gravatar.com`) and `lh3.googleusercontent.com` through `lh6.googleusercontent.com`. New pictures must use HTTPS. Gravatar URLs must use `/avatar/` plus an MD5 or SHA-256 hex hash, with an optional file extension. The web build reads `VITE_AVATAR_ALLOWED_HOSTS` with the same parser and the same rules. Keep the API value and the web value identical, or the API can store a picture the browser will not show.

Build and release the backend from the repository root. `npm ci` must include dev dependencies for the Prisma CLI during this release phase because the generated client is intentionally not committed:

```sh
npm ci
npm run db:generate
npm run db:validate
npm run db:deploy
npm start
```

Build the frontend with its public API URL, including `/api`:

```powershell
$env:VITE_API_BASE_URL='https://api.example.com/api'
npm ci --prefix frontend
npm run build --prefix frontend
```

Serve `frontend/dist` as static files with SPA fallback to `index.html`. The frontend and API may use separate origins, but they must remain on the same HTTPS site for the Strict refresh cookie, such as `app.example.com` and `api.example.com`. Set `CLIENT_ORIGIN=https://app.example.com`; only that one origin receives credentialed CORS access. The API verifies PostgreSQL before opening its port. `/health` is the process liveness probe and `/ready` checks PostgreSQL, returning 503 if connectivity is later lost. Configure shutdown grace for at least 10 seconds. The current in-memory rate limiter assumes one API replica; add a shared rate-limit store before scaling to multiple replicas.

## Database design

Target: Node.js, Express, PostgreSQL, Prisma ORM 7. Prisma field names are camelCase; `@map` / `@@map` expose snake_case database columns and tables. UUIDs identify entities; join tables use compound primary keys. All timestamps include time zones.

## Files and setup

- `prisma/schema.prisma`: models, foreign keys, unique constraints, and B-tree indexes.
- `prisma.config.ts`: Prisma 7 connection configuration; set `DATABASE_URL` in your environment (or `.env`, excluded from version control).
- `prisma/constraints-and-search.sql`: additional PostgreSQL constraints and search indexes.

The SQL supplement is already included in the committed initial migration. Keep it as a reference; do not run it again after deploying the migration. For later model changes, create forward migrations with `prisma migrate dev` in development and deploy committed migrations with `prisma migrate deploy`.

`npm run db:deploy` runs `prisma migrate deploy`. Render starts `bookish-api` with `npm run db:deploy && npm start` and auto-deploys `main`, so the production migration runs automatically on the Render deploy after merge. The product owner's merge decision is the apply step. `Book.openLibraryWorkKey` is additive only: a nullable column and a unique index, with no backfill. Existing rows stay null, and PostgreSQL still allows multiple nulls. Rolling back this migration requires a manual `DROP COLUMN` on `books.open_library_work_key`.

The Express runtime uses `@prisma/adapter-pg` and `pg`; the generated Prisma client is initialized with the PostgreSQL adapter.

## Catalog import

`scripts/catalog-source.json` is the curated source. In the v3 canonical policy, `preferredIsbn13` is a scoring preference and `allowAlternateIsbn` defaults to `false`, so a different ISBN requires review; set it to `true` only when a source may safely use another edition. `pinnedIsbn13` is reserved for the 30 existing production books, forbids alternates, and prevents the ISBN-based database identity from changing silently.

Catalog Pipeline v3 can build a local, offline canonical snapshot index from NDJSON canonical candidate records. The generated index is cache data under `scripts/catalog-cache/` and is excluded from version control. It does not contact providers or PostgreSQL:

```powershell
npm run catalog:snapshot-build -- --input path/to/snapshot.ndjson --output scripts/catalog-cache/canonical-snapshot-index --source-name open-library-bulk --snapshot-id 2026-09
npm run catalog:snapshot-status -- --index scripts/catalog-cache/canonical-snapshot-index
```

The snapshot index is not yet wired into resolved-artifact production. Database import remains artifact-only.

### Open Library bulk editions

Download matching local editions and authors dumps manually from [Open Library's Data Dumps documentation](https://openlibrary.org/developers/dumps). The parser accepts the documented tab-separated dump rows (`type`, `key`, `revision`, `last_modified`, JSON payload) as either plain text or `.gz` files. Build the canonical local author index, derive its SQLite lookup accelerator, then build the editions index with the same local snapshot identifier:

```powershell
npm run catalog:ol-author-index-build -- --input path/to/ol_dump_authors.txt.gz --output scripts/catalog-cache/open-library-authors --snapshot-id local-snapshot-id
npm run catalog:ol-author-lookup-build -- --index scripts/catalog-cache/open-library-authors --snapshot-id local-snapshot-id
npm run catalog:ol-snapshot-build -- --input path/to/ol_dump_editions.txt.gz --author-index scripts/catalog-cache/open-library-authors --output scripts/catalog-cache/open-library-index --snapshot-id local-snapshot-id
```

The derived `lookup.sqlite` is built beside `index.json` through a validated temporary database and atomic rename; the NDJSON author index remains canonical. The editions parser uses indexed exact-key SQLite lookups when that file exists and rejects an invalid or snapshot-mismatched database instead of falling back. Small fixture indexes without `lookup.sqlite` retain the NDJSON fallback. These commands are entirely local: they do not download files, contact providers, or access PostgreSQL.

### Open Library works index

The works index is a separate local artifact. It streams an Open Library works dump and attaches ratings and reading-log counts for works in that dump. Use works, ratings, and reading-log dumps from the same Open Library dump date as the existing editions and author artifacts. For those artifacts the snapshot id is `open-library-2026-08-31`. Run the disk preflight against the works dump before a full local build:

```powershell
npm run catalog:disk-preflight -- --directory scripts/catalog-cache --input path/to/ol_dump_works.txt.gz
npm run catalog:ol-work-index-build -- --works path/to/ol_dump_works.txt.gz --ratings path/to/ol_dump_ratings.txt.gz --reading-log path/to/ol_dump_reading-log.txt.gz --snapshot-id open-library-2026-08-31
```

The builder reads only those local files. It writes a validated SQLite database and `index.json` under `scripts/catalog-cache/open-library-works` (override with `--output`). It does not download dumps, contact providers, or access PostgreSQL.

Rank candidates from that index with `catalog:discover`. The command reads the local works index only and writes a validated JSON artifact. It records `languageCheck` as `pending` because English editions are decided later from the editions dump. The score is `((bayesian - 1) / 4) * ln(1 + weightedReaders + ratingsCount)`. `bayesian` is the average pulled toward 20 prior ratings at 3.5. `weightedReaders` is `1 * alreadyRead + 0.75 * currentlyReading + 0.25 * wantToRead`. A work with no ratings and no shelf counts scores 0 and is rejected as `no_signal`. Ties break by work key.

```powershell
npm run catalog:discover -- --works-index scripts/catalog-cache/open-library-works --snapshot-id open-library-2026-08-31 --limit 500 --output scripts/catalog-cache/catalog-discover.json
```

`--output` defaults to `scripts/catalog-cache/catalog-discover.json`. `--min-ratings` defaults to 0 and `--min-readers` defaults to 10 raw shelf counts across all three shelves. There is no minimum Bayesian score. `--limit` must be from 1 through 10000. `--exclude-keys` is an optional file of `/works/OL…W` keys, one per line.

Classify discover candidates against the Bookish database with `catalog:dedup-check`. The command requires `DATABASE_URL`, reads a discover artifact JSON file, performs read-only Prisma lookups, and writes one JSONL report line per candidate: `{workKey, title, status, matchedBookIds, matchedBy}`. `status` is `new`, `existing`, or `ambiguous`. Matching priority is `openLibraryWorkKey` (validated as `/works/OL\d+W`, empty strings rejected), then any normalized ISBN-10 or ISBN-13, then normalized title plus `primaryAuthor` when present on the candidate. `ambiguous` means more than one book matched on the chosen path, or a lower-priority match disagrees with a higher-priority one. The command prints summary counts per status and never writes to PostgreSQL.

The CLI exposes only `book.findMany` and `$disconnect`, and connects with `default_transaction_read_only=on` appended to `DATABASE_URL`. That session flag is a backstop only: raw SQL such as `$queryRaw` can override it. For production or shared databases, point `DATABASE_URL` at a read-only PostgreSQL role instead of the application writer role; the role grant is the real guarantee. Run `catalog:enrich` first when candidates should carry edition ISBNs and `primaryAuthor`.

```powershell
npm run catalog:dedup-check -- --input scripts/catalog-cache/catalog-enriched.json --output scripts/catalog-cache/catalog-dedup-report.jsonl
```

Attach those fields with `catalog:enrich`. The command reads a discover artifact, streams a local Open Library editions dump once, and looks up each candidate's first author key in the local author index. It writes the same artifact shape with `isbns` and `primaryAuthor` on each candidate. ISBN-10 values convert to ISBN-13, invalid checksums are dropped, and the ISBN list is deduplicated and capped at 50 per work. `primaryAuthor` is null when that author key is missing. The author index `snapshotId` must match the discover artifact. Candidates stay in a work-key map, so the dump itself is not loaded. The command prints matched editions, works with ISBNs, works without ISBNs, and works with an author. It does not download dumps or access PostgreSQL. `catalog:dedup-check` accepts the enriched file.

```powershell
npm run catalog:enrich -- --input scripts/catalog-cache/catalog-discover.json --editions path/to/ol_dump_editions_2026-08-31.txt.gz --authors-index scripts/catalog-cache/open-library-authors --output scripts/catalog-cache/catalog-enriched.json
```

Before a large local bulk build, check the target volume. The preflight uses an intentionally conservative 8× input-size temporary-space estimate plus a reserve; it refuses the check with a non-zero exit status when that requirement exceeds free space. Override the amplification only with measurements from a comparable local build.

```powershell
npm run catalog:disk-preflight -- --directory scripts/catalog-cache --input path/to/ol_dump_editions.txt.gz
```

For a bounded local dump sample, `catalog:bulk-smoke` builds disposable author and edition indexes, samples process memory and temporary-directory use, verifies local ISBN/title-author lookups with `fetch` disabled, then removes its generated data:

```powershell
npm run catalog:bulk-smoke -- --authors path/to/authors-sample.txt.gz --editions path/to/editions-sample.txt.gz --workdir $env:TEMP --snapshot-id sample-2026-08
```

For a controlled source sample without downloading an entire archive, `catalog:ol-range-sample` requires a server-honored HTTP range and writes only complete decompressed rows to the requested local path. It is explicitly separate from the local index builders:

```powershell
npm run catalog:ol-range-sample -- --url https://openlibrary.org/data/ol_dump_authors_latest.txt.gz --bytes 33554432 --rows 50000 --output $env:TEMP/authors-sample.txt
```

`catalog:import` reads only the validated Catalog Pipeline v2 artifact at `scripts/catalog-resolved.json`; it never contacts Open Library or Google Books. Use `--artifact <path>` to inspect or import another resolved artifact. Provider resolution is a separate step and production database writes never depend on live metadata services.

Run a no-write database classification first:

```powershell
npm run catalog:import -- --dry-run
# Override the artifact when needed:
npm run catalog:import -- --dry-run --artifact path/to/catalog-resolved.json
```

Write only after reviewing that output:

```powershell
npm run catalog:import -- --apply
```

Exactly one mode is required. `--dry-run` reads PostgreSQL and reports `created`, `updated`, `unchanged`, `skipped`, `failed` and `resolved` without writing. `--apply` updates or creates books by ISBN and adds missing controlled genre links. Invalid, stale or duplicate-ISBN artifacts are rejected before writes; `needs_review` and `failed` entries are skipped. Existing Book IDs, optional metadata when the artifact value is null, stronger Open Library covers, ratings, rating aggregates, shelves, reviews and likes are preserved. Re-running the same artifact is idempotent.

The resolved artifact may contain Open Library or exact-ISBN Google Books cover URLs; no image files are copied into this repository. The UI footer credits [Open Library](https://openlibrary.org/). Genre assignment remains limited to Bookish's controlled mapping. Imported ratings always begin empty: Bookish ratings come only from Bookish readers.

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

Hash passwords with a password-hashing library; never store plaintext or expose passwordHash in public API responses. Trim identity input and use a consistent email/username normalization policy. Signup and login use parameterized `lower(column) = lower(value)` identity equality, aligned with the lower-case expression indexes that reject case-only duplicates. This supports legacy mixed-case identities and treats underscores literally, unlike Prisma's insensitive `equals` filter, which generates ILIKE. `@updatedAt` is maintained by Prisma; direct SQL updates must set updated_at themselves.

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
