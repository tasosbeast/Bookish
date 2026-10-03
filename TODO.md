# Current Task

Read-only dedup check of discover output against the Bookish database (`catalog:dedup-check`).

The command reads a discover artifact JSON file and writes one JSONL report line per candidate: `{workKey, title, status, matchedBookIds, matchedBy}`. `status` is `new`, `existing`, or `ambiguous`. Matching priority is `openLibraryWorkKey` (validated as `/works/OL\d+W`, empty strings rejected), then any normalized ISBN-10 or ISBN-13, then normalized title plus `primaryAuthor` when present on the candidate. `ambiguous` means more than one book matched on the chosen path, or a lower-priority match disagrees with a higher-priority one. The command prints summary counts per status.

Acceptance: `npm run lint` with 0 warnings, `npm test`, integration tests, and `npm test --prefix frontend` green. The command uses read-only Prisma access only (`book.findMany`, `$disconnect`) with a PostgreSQL read-only transaction backstop. No writes, migrations, or schema changes.

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
