# Current Task

## Task

Restrict new profile picture URLs to HTTPS on an allowlisted set of hosts, and render the default avatar when a stored URL does not meet those rules.

## Scope

Users set a profile picture by pasting a URL on the account page (`PATCH /api/auth/me`). There is no upload or identity-provider avatar sync. Those URLs are rendered as images to other readers.

- Accept only `https` URLs. Reject `http` and every other scheme.
- Accept only allowlisted hosts, configured with `AVATAR_ALLOWED_HOSTS` in `src/config/env.js`. When unset, allow exact Gravatar hosts (`gravatar.com`, `www.gravatar.com`, `secure.gravatar.com`, `s.gravatar.com`, `0.gravatar.com`, `1.gravatar.com`, `2.gravatar.com`) and `lh3.googleusercontent.com` through `lh6.googleusercontent.com`. An entry matches that host only. A `*.example.com` entry is what allows subdomains. The web build's `VITE_AVATAR_ALLOWED_HOSTS` must match.
- Reject Gravatar `d` / `default` values that are not a built-in keyword, because Gravatar would redirect the image request to an arbitrary URL. Gravatar paths must be `/avatar/` plus an MD5 or SHA-256 hex hash and an optional extension.
- An invalid `VITE_AVATAR_ALLOWED_HOSTS` fails the web build. If a bad value still loads, the browser falls back to the default hosts.
- Do not migrate or delete stored pictures that fail the new rules. The frontend `Avatar` component renders the initial placeholder instead, with `referrerpolicy="no-referrer"` and `loading="lazy"` on real images.
- Use that component for the account page, the feed, and every friends avatar.

## Tests

- Backend validator accepts allowlisted HTTPS URLs and rejects `http`, other schemes, non-allowlisted hosts, credentialed URLs, and Gravatar open redirects.
- Frontend falls back to the default avatar for stored URLs that fail those rules, including on the feed and friends pages.
- Existing account, feed, and friends behavior stays intact.

## Out of Scope

- Destructive data migration
- File upload or OAuth avatar import
- Production deploys or Render configuration

## Acceptance Criteria

1. New avatar URLs must be https only.
2. Only allowlisted hosts are accepted, with the default list configured in one place.
3. Existing stored avatars that fail the new rules render the default avatar.
4. Avatar images set `referrerpolicy="no-referrer"`.
5. Validator and frontend fallback tests cover accepted and rejected URLs.
6. Existing backend, integration, and frontend tests pass.

## Verification

- `node --test tests/validation.test.js`
- `npm test`
- `npm run test:integration`
- `npm test --prefix frontend`
- `npm run build --prefix frontend`

## Done When

- acceptance criteria are satisfied
- focused tests, the full suites, and the frontend build pass
- only task-required files changed
- implementation is ready for review

Remove Web Push subscriptions on logout is done (PR #21).
Personal rating controls on ShelfForm are done (PR #19).
