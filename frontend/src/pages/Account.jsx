import { useState, useEffect } from 'react';
import { useAuth } from '../hooks/useAuth.js';
import { api, session } from '../lib/api.js';
import { ErrorNotice } from '../components/shared.jsx';

export default function Account() {
  const { user } = useAuth();
  const [editing, setEditing] = useState(false);
  const [bio, setBio] = useState(user?.bio ?? '');
  const [profilePicture, setProfilePicture] = useState(user?.profilePicture ?? '');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [user?.profilePicture]);

  const hasPicture = user?.profilePicture && !imageFailed;

  function startEditing() {
    setBio(user?.bio ?? '');
    setProfilePicture(user?.profilePicture ?? '');
    setError(null);
    setEditing(true);
  }

  function cancelEditing() {
    setBio(user?.bio ?? '');
    setProfilePicture(user?.profilePicture ?? '');
    setError(null);
    setEditing(false);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await api('/auth/me', {
        method: 'PATCH',
        body: { bio, profilePicture },
        auth: 'required',
      });
      session.updateUser(result.user);
      setImageFailed(false);
      setEditing(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container account-page">
      <div className="page-heading">
        <p className="eyebrow">Your account</p>
        <h1>
          Reader profile<span className="brand-dot">.</span>
        </h1>
        <p className="muted">The details Bookish uses to recognize you.</p>
      </div>
      <section className="account-card" aria-labelledby="account-name">
        <div className="account-identity">
          {hasPicture ? (
            <img
              className="account-avatar"
              src={user.profilePicture}
              alt={`${user.username}'s profile picture`}
              onError={() => setImageFailed(true)}
            />
          ) : (
            <span className="account-avatar" aria-hidden="true">
              {user?.username?.slice(0, 1).toUpperCase()}
            </span>
          )}
          <div>
            <h2 id="account-name">{user?.username}</h2>
            <p className="muted">{user?.email}</p>
          </div>
        </div>

        {!editing ? (
          <>
            {user?.bio ? (
              <div className="account-bio">
                <h3>About</h3>
                <p>{user.bio}</p>
              </div>
            ) : (
              <p className="muted small">No bio added yet.</p>
            )}
            <div style={{ marginTop: '25px' }}>
              <button type="button" className="button secondary compact" onClick={startEditing}>
                Edit profile
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={handleSubmit} style={{ marginTop: '25px' }}>
            <fieldset disabled={busy}>
              <label htmlFor="bio">Bio</label>
              <textarea
                id="bio"
                name="bio"
                value={bio}
                onChange={e => setBio(e.target.value)}
                maxLength={500}
                rows={4}
              />

              <label htmlFor="profilePicture" style={{ marginTop: '16px' }}>
                Profile picture URL
              </label>
              <input
                id="profilePicture"
                name="profilePicture"
                type="url"
                value={profilePicture}
                onChange={e => setProfilePicture(e.target.value)}
                maxLength={2048}
              />

              <ErrorNotice error={error} />

              <div style={{ display: 'flex', gap: '12px', marginTop: '20px' }}>
                <button type="submit" className="button compact">
                  {busy ? 'Saving…' : 'Save'}
                </button>
                <button type="button" className="button secondary compact" onClick={cancelEditing}>
                  Cancel
                </button>
              </div>
            </fieldset>
          </form>
        )}
      </section>
    </div>
  );
}

