# Current Task

Candidate scoring and selection (`catalog:discover --limit N`).

The command reads a local Open Library works index and writes the top N works by the documented popularity score: a 0–1 Bayesian rating times the log of ratings plus weighted shelf counts. Works with no ratings and no shelf counts are rejected as `no_signal`. `--min-readers` defaults to 10 raw shelf counts and `--min-ratings` defaults to 0. Hard filters also require a cover, a non-empty title, and a `/works/OL<digits>W` key. English is not decided from works; the artifact records `languageCheck` as `pending`. The command does not access PostgreSQL, Prisma, or the network. `--limit` is at most 10000.

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
3. A resolved-artifact bridge
4. A batched, idempotent `--dry-run`/`--apply` import

Book.openLibraryWorkKey is done (PR #32, merged as e1d281d).
#31 catalog:ol-work-index-build is done (merged as 7fbf1ee).
Issue #14 wordmark book icon is done (PR #30, merged as 9ee4596).
Account picture drafts, lint warnings, and avatar fallback are done (PR #29).
Plain `npm test` and ESLint are done (PR #28).
Avatar URL allowlist is done (PR #26).
Legacy profile-picture saves are done: the Account form sends `profilePicture` only when the reader changed it.
Remove Web Push subscriptions on logout is done (PR #21).
Personal rating controls on ShelfForm are done (PR #19).
