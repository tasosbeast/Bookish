# Current Task

Add `Book.openLibraryWorkKey` to the Prisma schema as a nullable unique string, plus an additive migration.

The field is `openLibraryWorkKey String? @unique @map("open_library_work_key") @db.Text`. The migration adds that nullable column and a unique index only. There is no data backfill and no change to other columns. Existing rows stay NULL. PostgreSQL allows multiple NULLs in the unique index.

Book create and update APIs do not accept Open Library fields, so validators and routes stay unchanged. `serializeBook` omits the column so current response shapes stay the same.

`npm run db:deploy` runs `prisma migrate deploy`. Render's bookish-api start command is `npm run db:deploy && npm start`, and the service auto-deploys `main`. The production migration runs automatically on the Render deploy after merge, so the product owner's merge decision is the apply step.

#31 catalog:ol-work-index-build is done (merged as 7fbf1ee).
Issue #14 wordmark book icon is done (PR #30, merged as 9ee4596).
Account picture drafts, lint warnings, and avatar fallback are done (PR #29).
Plain `npm test` and ESLint are done (PR #28).
Avatar URL allowlist is done (PR #26).
Legacy profile-picture saves are done: the Account form sends `profilePicture` only when the reader changed it.
Remove Web Push subscriptions on logout is done (PR #21).
Personal rating controls on ShelfForm are done (PR #19).
