import { useState, useEffect } from 'react';
import { useAuth } from '../hooks/useAuth.js';
import { api, session } from '../lib/api.js';
import { ErrorNotice } from '../components/shared.jsx';
import {
  isPushSupported,
  getExistingSubscription,
  subscribeToPush,
  unsubscribeFromPush,
  checkSubscriptionStatus,
} from '../lib/push.js';

function formatTrophyDate(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export default function Account() {
  const { user } = useAuth();
  const [editing, setEditing] = useState(false);
  const [bio, setBio] = useState(user?.bio ?? '');
  const [profilePicture, setProfilePicture] = useState(user?.profilePicture ?? '');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  // Browser push notification state
  const [pushSupported, setPushSupported] = useState(false);
  const [pushPermission, setPushPermission] = useState('default');
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState(null);
  const [pushLoading, setPushLoading] = useState(true);

  // Challenges trophies state
  const [trophies, setTrophies] = useState([]);
  const [trophiesLoading, setTrophiesLoading] = useState(true);
  const [trophiesError, setTrophiesError] = useState(null);

  async function loadTrophies() {
    setTrophiesLoading(true);
    setTrophiesError(null);
    try {
      const res = await api('/challenges/trophies', { auth: 'required' });
      setTrophies(res.data || []);
    } catch (err) {
      setTrophiesError(err);
    } finally {
      setTrophiesLoading(false);
    }
  }

  useEffect(() => {
    loadTrophies();
  }, [user?.id]);

  useEffect(() => {
    setImageFailed(false);
  }, [user?.profilePicture]);

  useEffect(() => {
    let active = true;
    async function checkPush() {
      const supported = isPushSupported();
      if (!supported) {
        if (active) {
          setPushSupported(false);
          setPushLoading(false);
        }
        return;
      }
      if (active) {
        setPushSupported(true);
        setPushPermission(Notification.permission);
      }
      try {
        const sub = await getExistingSubscription();
        if (!sub) {
          if (active) setPushSubscribed(false);
        } else {
          const isOwned = await checkSubscriptionStatus(sub.endpoint);
          if (active) {
            setPushSubscribed(isOwned);
          }
        }
      } catch {
        // Ignore check errors so profile editing is never broken
        if (active) setPushSubscribed(false);
      } finally {
        if (active) setPushLoading(false);
      }
    }
    checkPush();
    return () => { active = false; };
  }, [user?.id]);

  async function handleEnablePush() {
    setPushBusy(true);
    setPushError(null);
    try {
      await subscribeToPush();
      setPushPermission('granted');
      setPushSubscribed(true);
    } catch (err) {
      if (typeof Notification !== 'undefined') {
        setPushPermission(Notification.permission);
      }
      setPushError(err.message || 'Could not enable notifications');
    } finally {
      setPushBusy(false);
    }
  }

  async function handleDisablePush() {
    setPushBusy(true);
    setPushError(null);
    try {
      await unsubscribeFromPush();
      setPushSubscribed(false);
    } catch (err) {
      setPushError(err.message || 'Could not disable notifications');
    } finally {
      setPushBusy(false);
    }
  }

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

      <section className="account-card" aria-labelledby="notifications-heading" style={{ marginTop: '24px' }}>
        <h2 id="notifications-heading" style={{ fontSize: '1.25rem', marginBottom: '8px' }}>
          Browser notifications
        </h2>
        {!pushLoading && (
          <>
            {!pushSupported ? (
              <p className="muted small">Browser notifications aren't supported on this device.</p>
            ) : pushPermission === 'denied' ? (
              <p className="muted small">Notifications are blocked in your browser settings.</p>
            ) : pushSubscribed ? (
              <div>
                <p className="muted small">Browser notifications are enabled on this device.</p>
                <div style={{ marginTop: '16px' }}>
                  <button
                    type="button"
                    className="button secondary compact"
                    disabled={pushBusy}
                    onClick={handleDisablePush}
                  >
                    {pushBusy ? 'Disabling…' : 'Disable notifications'}
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <p className="muted small">Get notified when someone sends you a friend request.</p>
                <div style={{ marginTop: '16px' }}>
                  <button
                    type="button"
                    className="button secondary compact"
                    disabled={pushBusy}
                    onClick={handleEnablePush}
                  >
                    {pushBusy ? 'Enabling…' : 'Enable notifications'}
                  </button>
                </div>
              </div>
            )}
            {pushError && (
              <p className="reader-error small-error" role="alert" style={{ marginTop: '8px' }}>
                {pushError}
              </p>
            )}
          </>
        )}
      </section>

      <section className="account-card" aria-labelledby="trophies-heading" style={{ marginTop: '24px' }}>
        <h2 id="trophies-heading" style={{ fontSize: '1.25rem', marginBottom: '8px' }}>
          My Bookish Trophies
        </h2>
        {trophiesLoading ? (
          <p className="muted small">Loading trophies…</p>
        ) : trophiesError ? (
          <div>
            <p className="reader-error small-error" role="alert">
              {trophiesError.message || 'Could not load trophies'}
            </p>
            <div style={{ marginTop: '8px' }}>
              <button type="button" className="button secondary compact" onClick={loadTrophies}>
                Retry
              </button>
            </div>
          </div>
        ) : trophies.length === 0 ? (
          <div>
            <p className="muted small">
              No trophies yet. Finish 3 different books in a month to earn your first one.
            </p>
            <div style={{ marginTop: '12px' }}>
              <a href="/challenges" className="button secondary compact">
                View challenges
              </a>
            </div>
          </div>
        ) : (
          <div className="trophies-grid" style={{ marginTop: '16px' }}>
            {trophies.map(trophy => (
              <article key={trophy.key} className="trophy-card">
                <span className="trophy-icon" aria-hidden="true">🏆</span>
                <div className="trophy-info">
                  <h3 className="trophy-title">{trophy.title}</h3>
                  <p className="trophy-completed muted small">
                    Completed {formatTrophyDate(trophy.completedAt)}
                  </p>
                  <p className="trophy-count small">
                    {trophy.booksRead} books finished
                  </p>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

