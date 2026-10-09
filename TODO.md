# Current Task

Resolved-artifact bridge (implemented; verification and review pending).

The offline `catalog:bridge` now selects verified English ISBN-13 editions from the language-checked / dedup-checked works path and writes validated v2 artifacts for the existing resolved importer. Next up after that lands: the first real pipeline run (enrich → language-check → dedup-check → bridge → resolved import dry-run) on production Open Library dump files. Database verification requires a separately authorized safe target; do not use production as a test database.

Bridge verification is recorded in its pull request. Acceptance remains `npm run lint` with 0 warnings, `npm test`, integration tests on a dedicated test database, and `npm test --prefix frontend` green. No migrations or schema changes.

## Recorded for later

### Agreed "good book" definition (not implemented here)

Later pipeline steps will select a "good" book only if it meets all of the following:

- **Popularity:** a meaningful signal from Open Library ratings plus reading-log counts, which the works index stores. Thresholds and weighting will be set in the scoring task.
- **English only:** at least one English edition, decided by `catalog:language-check` from the editions dump, not from works.
- **Cover required:** the selected edition or work has an Open Library cover.

Existing rules still apply: non-books rejected via `pilotDisqualificationReason`, ISBN-13 edition identity, controlled genre mapping, no fabricated metadata.

### Roadmap (in order)

1. Candidate scoring and selection (`catalog:discover --limit N`) — done
2. Read-only dedup against the database — done
3. A resolved-artifact bridge — implemented, awaiting review
4. A batched, idempotent `--dry-run`/`--apply` import — done
5. Offline enrich from discover to dedup-check (`catalog:enrich`) — done
6. Offline English-language check (`catalog:language-check`) — done

Catalog pipeline cleanup is done (PR #38, merged as 7caec6b).
catalog:language-check is done (#37, merged as 989a1d2).
catalog:import is done (#36, merged as 19f07b2).
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
