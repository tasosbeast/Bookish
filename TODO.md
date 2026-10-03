# Current Task

## Task

Remove the current user's Web Push subscription on every logout path, so the next person on a shared browser does not keep receiving the previous user's notifications.

## Scope

`unsubscribeFromPush` currently runs only from the Account page notification toggle. Header sign-out (`Layout.jsx`) and `session.logout()` do not remove the subscription.

- On every logout, remove the subscription in the browser (`PushManager.unsubscribe`) and on the server (`DELETE /api/push/subscriptions`).
- Perform the server delete while the user is still authenticated, before the session is cleared or revoked.
- Logout must still finish if unsubscribing fails, there is no subscription, push is unsupported, or notification permission is not granted.
- Keep the Account page enable/disable toggle behavior unchanged.
- The delete endpoint already exists. No backend contract, schema, or deployment changes.

## Tests

- Logout with an active push subscription deletes it on the server and unsubscribes in the browser, then signs out.
- Logout with no subscription (including unsupported push and denied permission) still signs out.
- Logout still signs out when server delete and browser unsubscribe fail.
- Existing Account push toggle coverage stays in place.

## Out of Scope

- Notification preference redesign
- Push payload, service worker, or database changes
- Production deploys or Render configuration

## Acceptance Criteria

1. Every logout path removes the push subscription both in the browser (PushManager unsubscribe) and on the server (existing push-subscription delete endpoint).
2. Logout always completes, even if unsubscribing fails, there is no subscription, push isn't supported, or permission isn't granted. Unsubscribe must not block or break logout. The server-side delete happens while the user is still authenticated.
3. The existing Account.jsx push toggle keeps working as before.
4. Tests cover logout with an active subscription, without one, and when unsubscribe fails.
5. All existing backend and frontend tests and CI pass.

## Done

- Personal rating controls on ShelfForm (merged in PR #19).
