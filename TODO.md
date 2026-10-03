# Current Task

Offline enrich of discover candidates (`catalog:enrich`).

The command reads a discover artifact, streams one local Open Library editions dump, and writes the same artifact shape with `isbns` and `primaryAuthor` on each candidate. Candidates stay in a work-key map. The dump is not loaded into memory, and the command does not access PostgreSQL. ISBN-10 values convert to ISBN-13, invalid checksums are dropped, and ISBNs are deduplicated and capped at 50 per work. `primaryAuthor` is the author-index name for the candidate's first author key, or null when that key is absent. The author index snapshotId must match the input artifact. The command reports matched editions, works with ISBNs, works without ISBNs, and works with an author. `catalog:dedup-check` accepts the enriched file.

Acceptance: `npm run lint` with 0 warnings, `npm test`, integration tests, and `npm test --prefix frontend` green. No database access, migrations, or schema changes.

## Recorded for later

### Agreed "good book" definition (not implemented here)

Later pipeline steps will select a "good" book only if it meets all of the following:

- **Popularity:** a meaningful signal from Open Library ratings plus reading-log counts, which the works index stores. Thresholds and weighting will be set in the scoring task.
- **English only:** at least one English edition, decided from the editions dump, not from works.
- **Cover required:** the selected edition or work has an Open Library cover.

Existing rules still apply: non-books rejected via `pilotDisqualificationReason`, ISBN-13 edition identity, controlled genre mapping, no fabricated metadata.

### Roadmap (in order; not implemented here)

1. Candidate scoring and selection (`catalog:discover --limit N`)
2. Read-only dedup against the database
3. Offline enrich from discover to dedup-check (`catalog:enrich`)
4. A batched, idempotent `--dry-run`/`--apply` import

catalog:dedup-check is done (#34, merged as 3e86b39).
catalog:discover is done (#33, merged as 563cdba).
Book.openLibraryWorkKey is done (PR #32, merged as e1d281d).
#31 catalog:ol-work-index-build is done (merged as 7fbf1ee).
Issue #14 wordmark book icon is done (PR #30, merged as 9ee4596).
Account picture drafts, lint warnings, and avatar fallback are done (PR #29).
Plain `npm test` and ESLint are done (PR #28).
Avatar URL allowlist is done (PR #26).
Legacy profile-picture saves are done: the Account form sends `profilePicture` only when the reader changed it.
Remove Web Push subscriptions on logout is done (PR #21).
Personal rating controls on ShelfForm are done (PR #19).
