# Frontend verification — 2026-09-06

## Executed checks

| Check | Result |
| --- | --- |
| `npm test` | 14 passed, 0 failed, 0 skipped |
| `npm run test:integration` | 16 passed (including parent tests), 0 failed, 0 skipped |
| `npm test --prefix frontend` | 8 passed, 0 failed, 0 skipped |
| `npm run build --prefix frontend` | Production bundle built successfully |
| `git diff --check` | No whitespace errors |

Integration verification used the separate PostgreSQL 17 container from `compose.test.yaml`, database `bookish_test` on port 55433. `prisma migrate deploy` confirmed all committed migrations were applied. The development database was not reset or changed for testing.

## Manual browser verification

The real Express API ran on port 3001 against the dedicated test database using `tests/browser-server.js`; Vite ran on port 5173. The Codex in-app browser was inspected at desktop (1440 × 1000) and mobile (390 × 844) viewport sizes.

Verified discovery search, genre links, sorting and page reset; catalog pagination; missing-cover fallback; empty search and empty catalog; anonymous book details; login and signup; exact prefilled personal review; shelf/rating update and synchronized review/average rating; review update and creation; like and unlike; My books status update/filtering; and visible keyboard focus. A narrow mobile shelf title was found and corrected during inspection.

Verified restoration in a second tab, simultaneous reload/restoration in both tabs, logout propagating to the other tab, and account isolation after another reader signed up. Browser console inspection found no errors or warnings during the checked flows. Temporary catalog and user fixtures were removed afterward.

## Scope and limitations

The browser checks are manual, not an automated end-to-end suite. Automated client tests use controlled network/lock fixtures to exercise expiration, retries, cancellation and account changes. Integration tests exercise actual PostgreSQL and authentication sessions. No Safari/Firefox or physical mobile-device run was performed. Sign-in requires Web Locks and localStorage on HTTPS or localhost; production deployment and hosting configuration were not part of this change.
