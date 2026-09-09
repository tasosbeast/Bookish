# Bookish frontend

Requires Node.js 22.12+ and the existing Express API with a migrated PostgreSQL database. Install backend dependencies and configure its root `.env` as described in [the project README](../README.md).

```sh
# Terminal 1, project root
npm run dev

# Terminal 2, project root
npm ci --prefix frontend
npm run dev --prefix frontend
```

Open http://localhost:5173. The API defaults to http://localhost:3000/api. Copy `frontend/.env.example` to `frontend/.env` to override `VITE_API_BASE_URL` and restart Vite. This variable is public build configuration, never a secret. Set the backend's `CLIENT_ORIGIN` to the exact frontend origin. Keep localhost/127.0.0.1 consistent: the refresh cookie uses SameSite=Strict. Production requires HTTPS, compatible same-site API hosting, configured CORS, and SPA fallback to `index.html` for client routes.

Production builds fail when `VITE_API_BASE_URL` is missing, preventing a deployed bundle from silently using the localhost development API. Set it to the public HTTPS API URL including `/api` before running `npm run build --prefix frontend`.

## Behavior

- Discovery keeps `q`, `genre`, `sort`, `order` and `page` in the URL; search submits with Enter or the search button. Changing filters resets pagination. Genre labels come directly from API books and link to filtering; there is no fabricated genre catalog. Requests are cancelled and stale results discarded on navigation/filter changes.
- Details use the public paginated reviews and authenticated `GET /api/user-books/:bookId` for exact personal data. Missing entries on a list page never mean the reader has no review. Shelf and review writes refetch affected data; clearing a rating is disabled when a review exists. Likes use PUT and DELETE only.
- Detail forms remain mounted during likes, review pagination and refresh failures. Edited fields retain their drafts; untouched fields follow refreshed server values. Drafts are scoped to the current book and reader and are not persisted across leaving the page or reloading the browser.
- My books provides all three statuses and All, with bounded pagination and exact personal reads before editing. There is no unsupported delete-review or remove-book action.
- Empty catalogs and missing covers are represented honestly. No fixtures or sample success responses are embedded in the application.

## Authentication

Access tokens are kept only in memory. Restoration performs refresh followed by `/auth/me`. All cookie-changing auth requests include credentials and `X-Bookish-CSRF: 1`. A same-origin Web Lock serializes refresh, login, signup and logout across tabs; each tab also coalesces its refresh promise. Tabs obtain their own access token with sequential cookie rotation. A storage marker and BroadcastChannel communicate account changes/logout without persisting tokens or profile data. In-flight results from an old account are discarded. Local logout remains in effect if its network request fails; the error is shown because server revocation is then unconfirmed.

Current browsers on HTTPS or localhost with Web Locks and localStorage are required for sign-in; unavailable coordination fails closed. An expired access token may trigger one refresh and one request replay. Validation errors, network/server errors, revoked sessions and invalid unexpired tokens are never blindly refreshed. JWT expiration is used only for refresh scheduling; authorization remains server-verified. A lost refresh response cannot be retried indefinitely because the backend deliberately revokes reused refresh tokens; sign in again if restoration fails.

## Checks

```sh
npm test --prefix frontend
npm run build --prefix frontend
```

Tests cover within-tab coalescing, shared-lock serialization, cross-tab logout, memory-only credentials, refresh failures, one-retry limits, account changes and cancellation. The root integration suite covers real PostgreSQL, including the focused personal-book read addition. See the root README for the dedicated `_test` database commands; never run integration fixtures against development or production. CI runs both frontend checks and the backend suites.

The mounted React regression test also checks draft retention through delayed likes, review pagination, shelf writes, failed refreshes and retries, including field synchronization and account/book isolation. It uses jsdom with mocked HTTP responses and does not require or modify a database.

`npm run preview --prefix frontend` previews the production bundle at port 5173 after building (stop the dev server first). Vite's preview server is for local verification, not production hosting.

For manual browser checks, start the dedicated migrated test database, set `TEST_DATABASE_URL` to it, and run `node tests/browser-server.js` from the project root. The harness prints disposable reader credentials and a signup identity and serves the real API on port 3001. Launch Vite with `VITE_API_BASE_URL=http://localhost:3001/api` (stop an existing Vite server on 5173 first). Its 20 books span two genres; the reader has 13 shelf entries, and their existing review is behind 12 newer public reviews. All fixtures exist only in the dedicated test database.

In the harness terminal, enter `fail-next-read` to fail exactly one book-detail GET, or `fail-next-write` to fail one shelf/review POST. The injected response is an explicit 503, while other requests still use the real Express/Prisma API. Repeating a like command after its follow-up read fails also verifies idempotent PUT/DELETE behavior. These controls do not exist in the production API.

For a background process, write the same command to the temporary `controlFile` path printed at startup (for example, `Set-Content -LiteralPath '<printed path>' -Value 'fail-next-read'` in PowerShell). Use the printed path from the current run. To finish, enter or write `stop`, or use Ctrl+C; this removes only the harness's tracked fixtures and control file. Avoid force-killing the harness or shutting down Docker before cleanup completes. Restart Vite without the test API override to use the normal API afterward.
