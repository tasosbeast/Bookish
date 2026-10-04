# Current Task

Batched, idempotent import of new catalog works (`catalog:import`).

The command reads a `catalog:dedup-check` JSONL report and the enriched artifact that produced it. It joins rows to candidates by `workKey` and requires the report to match that artifact's `snapshotId`. Only `status: new` rows are eligible. `existing` and `ambiguous` rows are skipped and counted. Candidates with no usable title or no `primaryAuthor` are skipped and counted. Non-Latin titles are skipped as `unsupported_script`. Non-books are skipped with `pilotDisqualificationReason` and do not consume the limit. Eligible rows are capped by `--limit` (default 500, maximum 10000) and inserted in batches of `--batch-size` (default 100). Dry-run is the default: it uses the dedup-check read-only client and `default_transaction_read_only`, prints a plan, and writes JSONL plus a summary that records `languageCheck`. `--apply` writes only when `languageCheck` is `passed`, unless `--allow-unchecked-language` is set, which prints a warning. Each batch is its own transaction, carries work keys and ISBNs seen in earlier batches, re-checks `openLibraryWorkKey` and ISBN, and inserts with `createMany` `skipDuplicates`. A failed batch rolls back; the process exits non-zero if any batch fails. Mapped fields are `title`, `author` from `primaryAuthor`, the lowest valid ISBN-13 or null, `openLibraryWorkKey`, the Open Library cover URL, and `publicationYear` when the candidate has a year the schema accepts.

## Recorded for later

### Agreed "good book" definition (not implemented here)

Later pipeline steps will select a "good" book only if it meets all of the following:

- **Popularity:** a meaningful signal from Open Library ratings plus reading-log counts, which the works index stores. Thresholds and weighting will be set in the scoring task.
- **English only:** at least one English edition, decided from the editions dump, not from works.
- **Cover required:** the selected edition or work has an Open Library cover.

Existing rules still apply: non-books rejected via `pilotDisqualificationReason`, ISBN-13 edition identity, controlled genre mapping, no fabricated metadata.

### Roadmap (in order)

1. Candidate scoring and selection (`catalog:discover --limit N`) — done
2. Read-only dedup against the database — done
3. A resolved-artifact bridge — not implemented
4. A batched, idempotent `--dry-run`/`--apply` import — current task
5. Offline enrich from discover to dedup-check (`catalog:enrich`) — done

catalog:enrich is done (#35, merged as aee1a45).
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
