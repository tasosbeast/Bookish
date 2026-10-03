# Current Task

## Task

Add an offline Open Library works-index builder (`catalog:ol-work-index-build`) that streams the works dump and attaches ratings and reading-log popularity signals to each work, as the first step of the "give me N more good books" catalog pipeline.

## Scope

Implement the smallest safe offline catalog slice. The builder produces a local, validated, snapshot-identified artifact under `scripts/catalog-cache/` and nothing else.

### Works index builder

Add a new module `scripts/catalog/open-library-works.js`, a thin CLI `scripts/ol-work-index-build.js`, and a `package.json` script:

- `"catalog:ol-work-index-build": "node --experimental-sqlite scripts/ol-work-index-build.js"`
- CLI arguments: `--works <path>` (required), `--ratings <path>` (required), `--reading-log <path>` (required), `--snapshot-id <id>` (required), `--output <dir>` (default `scripts/catalog-cache/open-library-works`), plus optional `--batch-size` / `--progress-interval` (positive integers, same validation style as `scripts/ol-targeted-extract.js`).
- Reject unknown arguments and missing required arguments with a non-zero exit, like the existing catalog CLIs.

Works dump parsing:

- Stream `ol_dump_works` with the existing `readOpenLibraryBulkRecords()` from `scripts/catalog/open-library-bulk.js` (plain text or `.gz`, the 5-column `type, key, revision, last_modified, JSON` format).
- Accept only `/type/work` records that have a non-empty title. Count every other row (malformed rows, invalid JSON, wrong type, missing title) as rejected, by reason. Do not throw on a single bad row.
- For each accepted work, store: work key, title, subtitle, author keys (from `authors[].author.key`, de-duplicated and kept in order), subjects (de-duplicated), cover ids (positive safe integers only), `first_publish_date` as raw text, and description (a plain string or `{ value }`, normalized the same way as `description()` in `open-library-bulk.js`).
- Do not resolve author names, choose editions, determine language, or build cover URLs in this task. Works records do not carry language. English-only is decided in a later step, from editions.
- Duplicate work keys: keep exactly one row, chosen deterministically (highest `revision`, with the input line as tie-breaker), and count the duplicates.

Ratings and reading-log parsing:

- The Open Library ratings dump has the documented columns `Work Key, Edition Key (optional), Rating, Date`. The reading-log dump has `Work Key, Edition Key (optional), Shelf, Date`. These are NOT the 5-column format, so add a small dedicated streaming reader (gzip and plain text, readline, `crlfDelay: Infinity`) instead of bending `readOpenLibraryBulkRecords()`.
- Ratings: accept rows whose work key matches `/works/OL…W` and whose rating is an integer from 1 to 5. Aggregate per work: `ratingsCount` and `ratingsSum` (store the integer sum, not a rounded average).
- Reading log: aggregate per-shelf counts per work (want to read / currently reading / already read). Confirm the exact shelf strings against a real bounded range sample (`catalog:ol-range-sample`) before hard-coding them. Count unknown shelf values as rejected; never map them by guessing.
- Ignore edition keys and dates in this task, except for validating row shape.
- Signals for work keys that are not in the works dump must not create works rows. Count them as `orphanRatings` / `orphanReadingLogEntries`.

### Artifact, storage, and snapshot identity

Reuse the existing patterns from `open-library-bulk.js` and `open-library-targeted.js`:

- Write a SQLite database (`node:sqlite`; same `sqlite_unavailable` error message pattern) into a temporary `*.building-<pid>-<timestamp>` path. Insert in batched transactions and aggregate popularity with SQLite upserts, so memory does not grow with input size.
- Store metadata in a singleton `metadata` row and/or `index.json` with: a format string, index version, `sourceName: 'open-library-bulk'`, `snapshotId`, `generatedAt`, and integer statistics (works input/accepted/rejected/duplicates, ratings input/accepted/rejected/orphans, reading-log input/accepted/rejected/orphans).
- Before replacing the output, validate the built artifact: `PRAGMA integrity_check`, row counts match the metadata, and the metadata is shape- and version-valid. Then do an atomic rename. If the build fails, any existing known-good artifact at the output path must survive unchanged (same guarantee as the existing author-lookup tests).
- Expose a read-only lookup, `createOpenLibraryWorkLookup({ indexPath, snapshotId })`. It rejects a missing, invalid, or snapshot-mismatched artifact instead of falling back, and returns stored work fields plus popularity counts for a work key. Later pipeline steps use it. In this task it is used only by tests.
- Use one `--snapshot-id` for all three inputs and record it. Do not try to infer it from file names.

### Disk and memory guardrails

- Do not change `disk-preflight.js`. Document in README that `npm run catalog:disk-preflight -- -- --directory scripts/catalog-cache --input path/to/ol_dump_works.txt.gz` must be run before a full local build.
- Never collect a whole dump into an array or Map in memory. Streaming plus batched SQLite writes is required.

### Agreed "good book" definition (recorded for later steps; NOT implemented here)

Later pipeline steps will select a "good" book only if it meets all of the following:

- **Popularity:** a meaningful signal from Open Library ratings plus reading-log counts, which this task stores. Thresholds and weighting will be set in the scoring task.
- **English only:** at least one English edition, decided from the editions dump, not from works.
- **Cover required:** the selected edition or work has an Open Library cover.

Existing rules still apply: non-books rejected via `pilotDisqualificationReason`, ISBN-13 edition identity, controlled genre mapping, no fabricated metadata.

### Approved follow-up (separate task; NOT part of this task)

- Tasos has approved a migration that adds `Book.openLibraryWorkKey` (nullable, unique) to `prisma/schema.prisma`. It becomes its own `TODO.md` task on its own branch, after this task is merged. Tasos applies it himself. The Catalog Specialist must not run migrations (`.agents/agents/bookish-catalog/agent.md` §4).
- Later, separately scoped steps, in order: candidate scoring and selection (`catalog:discover --limit N`), read-only dedup against the database, a resolved-artifact bridge, and a batched, idempotent `--dry-run`/`--apply` import.

## Backend

No backend, API, validator, Prisma schema, migration, or database changes.

- The new module and CLI must not import `src/lib/prisma.js`, must not read `DATABASE_URL`, and must not contact PostgreSQL.
- No network access. The builder reads only local files and must not download dumps.
- No new dependencies. `package.json` changes only by adding the single `catalog:ol-work-index-build` script entry.

## Tests

Add focused, fixture-based tests in `tests/catalog-v3-open-library-works.test.js` with small fixtures:

- `tests/fixtures/open-library-works.txt`
- `tests/fixtures/open-library-ratings.txt`
- `tests/fixtures/open-library-reading-log.txt`

Verify:

- valid works map to the stored fields above. Wrong-type, untitled, malformed-row, and invalid-JSON rows are counted as rejected, not thrown.
- duplicate work keys keep exactly one deterministic row and are counted.
- ratings aggregate count and integer sum per work. Out-of-range, non-integer, and malformed rows are rejected.
- reading-log shelves aggregate per work. Unknown shelves are rejected.
- signals for unknown work keys are counted as orphans and create no works rows.
- `.gz` inputs produce the same artifact as plain text.
- a generated input of several thousand rows streams through without building an input array (same style as the existing "several thousand local edition rows" test in `tests/catalog-v3-open-library-bulk.test.js`).
- the built artifact passes validation. A corrupted or snapshot-mismatched artifact is rejected by `createOpenLibraryWorkLookup` with no fallback.
- a failed build leaves an existing known-good artifact untouched.
- the CLI needs only local files, rejects missing or unknown arguments, and prints a JSON summary.
- tests run with `globalThis.fetch` replaced by a throwing stub (as in `scripts/catalog/bulk-smoke.js`) and need no database.

Do not weaken existing test assertions merely to make the new behavior pass.

## Out of Scope

- any database read or write, including dry-run classification against a database
- Prisma schema or migration changes, including `Book.openLibraryWorkKey` (approved, but a separate follow-up task)
- downloading Open Library dumps, or any network access from the builder or tests
- running a full-size dump build as part of verification
- "good book" scoring, thresholds, ranking, or candidate selection
- joining works to editions or authors, language detection, cover URL construction
- changes to `open-library-bulk.js`, `open-library-targeted.js`, `pilot-planner.js`, `score-editions.js`, `resolve.js`, `import.js`, or `disk-preflight.js`, beyond importing existing exports
- changes to ISBN identity rules, edition scoring thresholds, or genre mapping
- resolved-artifact production or any `catalog:import` changes
- new dependencies, frontend changes, and CI workflow changes

## Acceptance Criteria

1. `npm run catalog:ol-work-index-build -- --works … --ratings … --reading-log … --snapshot-id … [--output …]` builds a validated works index from local plain or `.gz` dumps and prints a JSON summary with statistics.
2. Each indexed work stores the specified works fields plus ratings count/sum and per-shelf reading-log counts. Orphan signals are counted and not indexed.
3. Malformed or invalid rows in any input are counted by reason and never abort the build.
4. Parsing is streaming with batched SQLite writes. No dump is collected into memory, and a several-thousand-row generated test passes.
5. The artifact records `snapshotId`, format, version, and statistics, is validated before an atomic replace, and a failed build preserves an existing good artifact.
6. `createOpenLibraryWorkLookup` returns indexed data and rejects invalid or snapshot-mismatched artifacts without fallback.
7. Outputs are local only: no database access, no Prisma import, and no network access in the builder or tests.
8. The "good book" definition and the approved `Book.openLibraryWorkKey` follow-up are recorded for later steps and not implemented here.
9. New tests pass locally and in CI (`.github/workflows/test.yml`), and no existing tests regress.
10. Only task-required files change: new module, CLI, fixtures, test file, the single `package.json` script entry, and a short README note.

## Verification

Run focused catalog verification first, then broader checks:

- `node --experimental-sqlite --test tests/catalog-v3-open-library-works.test.js`
- `node --experimental-sqlite --test tests/catalog-*.test.js`
- `npm test`
- optionally, a bounded local smoke run of the CLI on a `catalog:ol-range-sample` sample (never a full dump), reporting peak memory if measured

Integration tests and `npm run db:validate` are not required, because no database or schema behavior changes.

## Done When

- acceptance criteria are satisfied
- focused and relevant catalog tests pass, and `npm test` passes
- CI passes on the task branch
- only task-required files changed
- no database, schema, or network access was introduced
- implementation is ready for QA

Issue #14 wordmark book icon is done (PR #30, merged as 9ee4596).
Account picture drafts, lint warnings, and avatar fallback are done (PR #29).
Plain `npm test` and ESLint are done (PR #28).
Avatar URL allowlist is done (PR #26).
Legacy profile-picture saves are done: the Account form sends `profilePicture` only when the reader changed it.
Remove Web Push subscriptions on logout is done (PR #21).
Personal rating controls on ShelfForm are done (PR #19).
