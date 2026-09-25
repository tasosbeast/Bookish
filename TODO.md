# Current Task

## Task

Add personal rating controls to `ShelfForm` so users can set, change, or safely clear their rating from Book Details and My Books.

## Scope

Implement the smallest safe frontend-only vertical slice.

### Rating control

In `frontend/src/components/ReadingForms.jsx`:

- Add a 1–5 rating select to `ShelfForm`.
- Initialize it from `personal.shelf?.userRating`.
- Use the same simple select-style interaction already used by `ReviewForm`.
- Do not introduce a custom star-picker widget.

### Rating updates

When the user changes the rating to 1–5 and saves:

- send `userRating: Number(rating)` to the existing `POST /api/user-books` endpoint
- rely on the existing backend contract to update the canonical `UserBook.userRating`
- rely on existing backend behavior to synchronize an existing review rating and refresh rating aggregates

IMPORTANT:

If the rating has NOT changed, do not include `userRating` in the request payload.

Status/date-only shelf saves must preserve the existing behavior and must not trigger unnecessary rating writes.

### Rating clearing

When no review exists:

- show a `No rating` option
- if the user changes from an existing rating to `No rating`, send `userRating: null`

When a review exists:

- do not allow selecting `No rating`
- show short explanatory guidance that the rating cannot be removed while a review exists
- never submit `userRating: null`

The existing backend `REVIEW_REQUIRES_RATING` protection remains authoritative.

## Backend

No backend, validator, schema, migration, or database changes.

Use the existing:

- `shelfSchema`
- `POST /api/user-books`
- `saveShelf()`

contracts exactly as they exist.

## Tests

Update the focused frontend reading-flow tests to verify:

- ShelfForm renders the current personal rating
- an unrated book can receive a 1–5 rating
- an existing rating can be changed
- clearing sends `userRating: null` when no review exists
- clearing is unavailable when a review exists
- status-only/date-only saves do NOT send `userRating` when the rating was unchanged
- existing read-transition scrolling and shelf behavior remain intact

Do not weaken existing test assertions merely to make the new behavior pass.

## Out of Scope

- backend changes
- database/schema changes
- ReviewForm redesign
- custom graphical star widgets
- rating controls on Discover cards
- quick shelf actions
- review deletion controls inside ShelfForm
- any other UX audit findings

## Acceptance Criteria

1. ShelfForm on Book Details and My Books displays the current personal rating.
2. Users can set or change a rating from ShelfForm.
3. Rating changes are sent through the existing `/api/user-books` contract.
4. Existing reviews remain rating-consistent through the existing backend synchronization behavior.
5. Users without a review can clear an existing rating.
6. Users with a review cannot select or submit a cleared/null rating and see explanatory guidance.
7. Saving shelf status or finished date without changing the rating does not send `userRating`.
8. Existing shelf status, finished-date, removal, and read-transition scrolling behavior does not regress.
9. No backend or database changes are made.

## Verification

Run focused frontend verification first, then appropriate broader checks:

- focused `frontend/tests/reading-flow.test.js`
- full frontend test suite
- frontend production build

Run backend tests only if needed to verify an existing backend contract; no backend code is expected to change.

## Done When

- acceptance criteria are satisfied
- focused and relevant frontend tests pass
- frontend build passes
- only task-required files changed
- implementation is ready for QA
