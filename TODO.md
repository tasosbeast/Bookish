# Current Task

## Task

Remove the current user's Web Push subscription on logout, so the next person on a shared browser does not keep receiving the previous user's notifications.

## Scope

Explicit sign-out (`session.logout()`, including the header control in `Layout.jsx`) removes the subscription in the browser (`PushManager.unsubscribe`) and on the server (`DELETE /api/push/subscriptions`).

- Perform the server delete while the user is still authenticated, before the session is cleared or revoked.
- Bound that cleanup to about three seconds. Abort the in-flight delete and any token refresh it started so sign-out still finishes.
- Become a guest before waiting on the auth lock, so a refresh already in flight cannot keep the reader signed in. Server revocation still runs when the lock is free.
- Logout must still finish if unsubscribing fails, there is no subscription, push is unsupported, or notification permission is not granted.
- Forced sign-out (`refresh` 401, including while restoring a reopened page, and `invalidate`) has no access token left for the server delete. Best-effort: drop only the browser subscription. Network and 5xx refresh errors do not.
- Keep the Account page enable/disable toggle behavior unchanged.
- The delete endpoint already exists. No backend contract, schema, or deployment changes.

## Tests

- Logout with an active push subscription deletes it on the server and unsubscribes in the browser, then signs out.
- Logout with no subscription (including unsupported push and denied permission) still signs out.
- Logout still signs out when server delete and browser unsubscribe fail.
- Logout still reaches guest and calls `/auth/logout` when cleanup never resolves.
- An expired access token is refreshed before the server delete. An in-flight refresh is not aborted before that cleanup.
- `getRegistration()` rejecting still signs out.
- A refresh that already holds the auth lock still yields guest status immediately. Logout also returns if another request keeps the lock, and the server revocation still runs when the lock is free.
- Aborting the request that started a shared refresh does not cancel it: a joiner with no signal still receives the new token, and only one `/auth/refresh` is sent. A 5xx refresh while authenticated does not drop the browser subscription. Another tab's sign-out drops it once. `SESSION_CHANGED` during the delete still signs out.
- A new subscription waits up to about five seconds for an in-flight unsubscribe. An unconfigured push client reads as off and warns once.
- Existing Account push toggle coverage stays in place.

## Out of Scope

- Notification preference redesign
- Push payload, service worker, or database changes
- Production deploys or Render configuration
- Server-side delete after the session is already gone

## Acceptance Criteria

1. Explicit logout removes the push subscription both in the browser (PushManager unsubscribe) and on the server (existing push-subscription delete endpoint).
2. Logout always completes, even if unsubscribing fails, hangs, there is no subscription, push isn't supported, or permission isn't granted. Cleanup cannot block sign-out past its deadline. The reader becomes a guest without waiting for an in-flight refresh to release the auth lock. The server-side delete happens while the user is still authenticated.
3. Forced sign-out drops the browser subscription without calling the authenticated delete.
4. The existing Account.jsx push toggle keeps working as before.
5. Tests cover logout with an active subscription, without one, when unsubscribe fails, when cleanup never resolves, when the access token must be refreshed, and when `getRegistration()` rejects.
6. All existing backend and frontend tests and CI pass.

## Verification

- focused `frontend/tests/logout-push.test.js` and `frontend/tests/auth.test.js`
- full frontend test suite
- frontend production build
- backend unit tests (no backend code changes are expected)

## Done When

- acceptance criteria are satisfied
- focused tests, the frontend suite, and the frontend build pass
- only task-required files changed
- implementation is ready for review

Personal rating controls on ShelfForm are done (PR #19).
