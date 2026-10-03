# Current Task

## Task

Keep an open account-picture draft stable when the session user changes, fail lint on warnings, and avoid a one-frame avatar placeholder when the picture URL changes.

## Scope

- Snapshot the profile picture in `startEditing` and compare trimmed values with that baseline. Do not compare with the live session user. Omit `profilePicture` from `PATCH /api/auth/me` when the draft is untouched or only whitespace changed.
- In the Friends suggestions, friends, and requests tabs, destructure `reload` and depend on that callback so the three `exhaustive-deps` warnings clear without changing when the effects run.
- `npm run lint` uses `--max-warnings=0`. CI runs that script.
- Turn `react-hooks/refs` back on, with per-line disables at the two render-time ref writes (`NotificationBell.jsx`, `ReadingForms.jsx`).
- `react-hooks/set-state-in-effect` stays off. Warning mode reports 14 existing findings and would fail `--max-warnings=0`.
- `Avatar` stores the failed URL in `failedSrc`, so a later valid URL renders on the same commit.

## Tests

- The session user changes during editing and an untouched picture is not sent.
- Whitespace-only picture edits count as unchanged.
- After an image error, a new allowlisted URL renders the image before effects run.

## Out of Scope

- Avatar host allowlist changes
- Backend profile validation changes
- Rewriting effects that set state
- Production deploys or Render configuration

## Acceptance Criteria

1. An untouched picture is omitted even if the session user changes mid-edit.
2. Whitespace-only picture edits are omitted.
3. Lint exits with 0 errors and 0 warnings.
4. A valid new avatar URL does not render the placeholder for one frame.
5. Existing backend, integration, and frontend tests and both frontend builds pass.

## Verification

- `npm test`
- `npm run test:integration`
- `npm test --prefix frontend`
- `npm run lint`
- `npm run build --prefix frontend`
- `npm run build:frontend-only`

## Done When

- acceptance criteria are satisfied
- focused tests, the full suites, lint, and the frontend builds pass
- only task-required files changed
- implementation is ready for review

Plain `npm test` and ESLint are done (PR #28).
Avatar URL allowlist is done (PR #26).
Legacy profile-picture saves are done: the Account form sends `profilePicture` only when the reader changed it.
Remove Web Push subscriptions on logout is done (PR #21).
Personal rating controls on ShelfForm are done (PR #19).
