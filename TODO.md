# Current Task

First Controlled Catalog Audit — Phase A (Preflight).

## Objective

Prepare the first controlled, non-production verification of the real Bookish catalog pipeline using existing local Open Library data and the existing local PostgreSQL audit database.

The eventual pipeline is:

`catalog:enrich → catalog:language-check → catalog:dedup-check → catalog:bridge → catalog:import --dry-run`

**Only Phase A is approved. No pipeline execution is authorized yet.**

## Phase A — Approved scope

Responsible agent: Bookish Catalog Specialist.

Perform preflight checks only and deliver a factual PASS/FAIL report covering:

1. Current repository state, correct merged code, clean working tree, Node tooling and required Prisma client availability.
2. Existing Open Library editions dump: verified path, existence, file type, size, snapshot identity and available integrity evidence. No download or copying.
3. Existing works index, author index and `lookup.sqlite`: existence, consistency and snapshot identity.
4. Existing discover artifact: verify and validate if present; otherwise record that generation would require Phase B authorization.
5. Available disk space, temporary storage and output paths. The existing `catalog:disk-preflight` may run only after confirming that it does not modify existing files or artifacts.
6. Local audit PostgreSQL:
   - Container: `bookish-audit-pg18`
   - Host: `127.0.0.1:55432`
   - Database: `bookish_audit_copy`
   - Role: `audit_ro`
   - Verify actual DB identity, read-only session settings, relevant SELECT privileges, schema/migration compatibility and a read-only baseline of relevant tables.
   - Never rely on the repository's default `.env` database target. Use an explicitly verified local audit connection.
   - Never display credentials or connection strings containing secrets.
7. Safe isolated run directory and explicit output destinations for any later Phase B commands, without overwriting existing artifacts.
8. Run manifest and inventory of reusable versus stale artifacts.

The Phase A report must clearly identify any failure, uncertainty or missing prerequisite.

No existing repository files, database records, roles, grants or catalog artifacts may be modified.

Only a separately located preflight report/manifest may be created.

## Phase B — NOT APPROVED

After the owner reviews and approves the Phase A report, the Catalog Specialist may receive separate authorization for one bounded pipeline run.

Potential steps:

1. Generate or reuse a validated discover artifact.
2. Regenerate enriched data following PR #41.
3. Regenerate language-checked data.
4. Regenerate the dedup report against the approved non-production audit database.
5. Generate and validate the bridged artifact.
6. Execute the resolved import **dry-run only** against the same non-production database.
7. Report counts, rejection reasons, validation outcomes and unchanged database state.

The proposed limit is 500 candidates, but it is NOT approved until the owner explicitly confirms it, along with the time budget and execution parameters.

## Safety boundaries

- No production Neon connection or production credentials.
- No `--apply`, migrations, database writes or schema changes.
- No code, threshold, scoring or ISBN-rule modifications.
- No rebuilding large indexes without separate approval.
- No downloading or duplicating full Open Library dumps.
- No changes to existing artifacts.
- Stop on missing prerequisites, snapshot mismatches, uncertain database identity or unexpected write behavior.

## Phase A acceptance criteria

- A complete preflight report with measured values and PASS/FAIL per check.
- Verified non-production database identity and applicable read-only protections.
- Explicit artifact reuse/regeneration plan.
- No existing repository, database or artifact changes.
- A clear recommendation: READY FOR PHASE B APPROVAL or BLOCKED.

**Completion of Phase A does not automatically authorize Phase B.**

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
3. A resolved-artifact bridge — done (PR #40)
4. A batched, idempotent `--dry-run`/`--apply` import — done
5. Offline enrich from discover to dedup-check (`catalog:enrich`) — done
6. Offline English-language check (`catalog:language-check`) — done
7. English ISBN quality selection in `catalog:enrich` — done (PR #41)

English ISBN quality selection is done (PR #41, merged as e98d097).
Resolved-artifact bridge (`catalog:bridge`) is done (PR #40, merged as 069563f).
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
