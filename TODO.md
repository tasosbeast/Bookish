# Current Task

No active task.

Avatar URL allowlist is done (PR #26): new profile pictures must be HTTPS on an allowlisted host, and a stored URL that fails those rules renders the default avatar.

Legacy profile-picture saves are done: the Account form sends `profilePicture` on `PATCH /api/auth/me` only when the reader changed it. Saving bio still works when a disallowed picture is stored. Clearing or replacing that picture still sends the field. An invalid new URL still fails validation and is shown on the form. The allowlist itself is unchanged.

Remove Web Push subscriptions on logout is done (PR #21).
Personal rating controls on ShelfForm are done (PR #19).
