# Frontend usability verification — 2026-09-06–07

## Automated checks executed

| Check | Latest result |
| --- | --- |
| `npm test --prefix frontend` | 9 passed, 0 failed, 0 skipped |
| `npm run build --prefix frontend` | Production bundle built successfully |
| `npm test` | 14 passed, 0 failed, 0 skipped |
| `npm run test:integration` | Retry after Docker repair: 16 passed, 0 failed, 0 skipped |

The integration retry explicitly targeted `bookish_test` on port 55433 after Docker was repaired. The dedicated container passed its health check, and `prisma migrate deploy` confirmed there were no pending migrations. All 16 integration tests passed with no skips. The initial connection-refused attempt remains a historical infrastructure failure; current PostgreSQL integration verification is complete. No development or production database was reset or used for fixtures.

The frontend tests use controlled HTTP responses and browser-lock fixtures. The mounted React regression covers draft retention during refetches, account/book isolation, and now a failed review save: the draft survives, the form unlocks, and a successful retry clears the error. These are automated component/client checks, not real-browser end-to-end tests.

## Manual checks completed with the real API

Before the service interruption, `tests/browser-server.js` served the real Express/Prisma API on port 3001 against the dedicated PostgreSQL test database; Vite ran on port 5173. Only disposable harness identities and books were used.

| Journey | Observed result |
| --- | --- |
| Signup, login, invalid login, logout | Successful signup/login; useful invalid-credential error with enabled retry; logout cleared authenticated UI |
| Two tabs | Concurrent reload/restoration retained the session; logout propagated to the other tab; signing in as another reader replaced the editor's account data |
| Discovery | Title/author search, clickable genre filtering, publication-year sorting, pagination and page reset worked; browser back/forward restored the corresponding URL and results |
| Shelf and rating | Adding a book and changing status/rating succeeded; rating changes refreshed displayed data |
| My Books | All, Read and Currently reading filters; 13 entries across two pages; changing a Read entry's status removed it from that filter and updated the destination filter |
| Personal reviews | Created a review and edited the exact existing personal review while it was absent from the first public review page |
| Likes | Like/unlike reflected the current state; identical PUT requests and identical DELETE requests were repeated after failed follow-up reads and retained the intended state |
| Draft preservation | Unsaved review text survived likes, review pagination, shelf saves, failed background reads and a failed review save; retry succeeded |
| Account isolation | Logging out removed the draft; another reader's existing review appeared without the previous account's draft |

Read/write failure checks used the harness's explicit one-shot 503 controls. Other requests, including successful writes, used the real API and database. They did not substitute mocked success.

## Observed usability fix

At a 390px mobile viewport, genre, sign-out and like controls measured roughly 27–36px tall. Their mobile touch targets now have a 44px minimum height/width. Reinspection measured 44px targets without horizontal overflow. The book-detail mobile screenshot was inspected, and a desktop DOM measurement at 1440px also found no horizontal overflow. No redesign or production API changes were made.

The harness now provides two genres, 20 books, 13 shelf entries and an existing personal review behind 12 newer reviews. Local failure controls and graceful shutdown instructions are documented in `frontend/README.md`.

## Remaining verification and recovery

- Finish manual book-to-book draft isolation, the Want to read filter, narrow My Books layout, keyboard/focus inspection and the final desktop/mobile visual pass. Book/account isolation already has automated regression coverage; the unfinished manual book-switch check is not reported as passed.
- After Docker recovery, the exact fixtures from interrupted run `2147c0c2` were removed from the dedicated test database: 20 books, 14 users and 2 genres. No broad table cleanup was used.
- Docker recovery attempts backed up inactive runtime socket directories to `Docker/run.bookish-backup-20260907230259` and `docker-secrets-engine.bookish-backup-20260907230448` under Local AppData. This did not reset database volumes and did not restore engine availability.
- No Safari/Firefox or physical-device verification was performed. HTTPS, same-site API hosting, CORS and production configuration still need deployment-environment verification. Nothing was deployed or published.

The Docker/PostgreSQL blocker is resolved. The remaining manual browser checks above still need completion before this milestone is fully verified.
