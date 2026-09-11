import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useResource } from '../hooks/useResource.js';
import { api } from '../lib/api.js';
import { messageFor } from '../lib/http.js';
import { EmptyState, ErrorNotice, Loading } from '../components/shared.jsx';

function ReaderSearchResult({ result, onRelationshipChange }) {
  const [relationship, setRelationship] = useState(result.relationship);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { user } = result;
  const initial = user.username ? user.username.slice(0, 1).toUpperCase() : '?';

  useEffect(() => setRelationship(result.relationship), [result.relationship]);

  async function changeRelationship(action) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (action === 'send') {
        const response = await api('/friends/requests', { method: 'POST', auth: 'required', body: { userId: user.id } });
        setRelationship({ status: 'pending', direction: 'outgoing', requestId: response.data.id });
      } else if (action === 'accept') {
        const response = await api(`/friends/requests/${relationship.requestId}/accept`, { method: 'POST', auth: 'required' });
        setRelationship({ status: 'accepted', friendshipId: response.data.id });
      } else {
        await api(`/friends/requests/${relationship.requestId}`, { method: 'DELETE', auth: 'required' });
        setRelationship({ status: 'none' });
      }
      onRelationshipChange?.();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  let actions;
  if (relationship.status === 'accepted') {
    actions = <span className="reader-relationship" aria-label={`${user.username} is already your friend`}>✓ Friends</span>;
  } else if (relationship.status === 'pending' && relationship.direction === 'outgoing') {
    actions = <><span className="reader-relationship">Request sent</span><button type="button" className="text-button" disabled={busy} onClick={() => changeRelationship('cancel')}>{busy ? 'Cancelling…' : 'Cancel'}</button></>;
  } else if (relationship.status === 'pending') {
    actions = <><span className="reader-relationship">Sent you a friend request</span><button type="button" className="button compact" disabled={busy} onClick={() => changeRelationship('accept')}>{busy ? 'Accepting…' : 'Accept'}</button><button type="button" className="button secondary compact" disabled={busy} onClick={() => changeRelationship('decline')}>{busy ? 'Declining…' : 'Decline'}</button></>;
  } else {
    actions = <button type="button" className="button secondary compact add-friend-button" disabled={busy} onClick={() => changeRelationship('send')}>{busy ? 'Sending…' : 'Add Friend'}</button>;
  }

  return <article className="reader-card reader-search-result">
    <div className="reader-card-header">
      {user.profilePicture ? <img src={user.profilePicture} alt={`${user.username}'s avatar`} className="reader-avatar" /> : <span className="reader-avatar-placeholder" aria-hidden="true">{initial}</span>}
      <div className="reader-info"><h3>{user.username}</h3>{user.bio && <p className="reader-bio">{user.bio}</p>}</div>
    </div>
    <div className="reader-card-actions">{actions}{error && <p className="reader-error small-error" role="alert">{error}</p>}</div>
  </article>;
}

function ReaderSearch({ onRelationshipChange }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);
  const requestId = useRef(0);
  const normalizedQuery = query.trim();
  const isValidQuery = normalizedQuery.length >= 2;

  useEffect(() => {
    if (!isValidQuery) {
      requestId.current++;
      setResults(null);
      setError(null);
      setLoading(false);
      return undefined;
    }
    const currentRequest = ++requestId.current;
    const controller = new AbortController();
    setResults(null);
    setError(null);
    const timeout = setTimeout(() => {
      setLoading(true);
      api(`/friends/search?q=${encodeURIComponent(normalizedQuery)}&limit=10`, { auth: 'required', signal: controller.signal })
        .then(response => {
          if (requestId.current === currentRequest) setResults(response.data);
        })
        .catch(err => {
          if (err.name !== 'AbortError' && requestId.current === currentRequest) setError(err);
        })
        .finally(() => {
          if (requestId.current === currentRequest) setLoading(false);
        });
    }, 275);
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [isValidQuery, normalizedQuery, retry]);

  return <section className="reader-search" aria-label="Find readers">
    <form role="search" onSubmit={event => event.preventDefault()}>
      <label className="sr-only" htmlFor="reader-search-input">Search readers by username</label>
      <input id="reader-search-input" type="search" value={query} maxLength={30} placeholder="Search readers by username..." aria-label="Search readers by username" onChange={event => setQuery(event.target.value)} />
    </form>
    {normalizedQuery && !isValidQuery && <p className="muted small reader-search-helper">Type at least 2 characters.</p>}
    {isValidQuery && <div className="reader-search-results" aria-live="polite">
      {loading && <p className="muted small" role="status">Searching readers…</p>}
      {error && <ErrorNotice error={error} retry={() => setRetry(value => value + 1)} />}
      {!loading && !error && results && !results.length && <p className="muted small">No readers found.</p>}
      {!loading && !error && results?.length > 0 && <div className="reader-cards-grid">{results.map(result => <ReaderSearchResult key={result.user.id} result={result} onRelationshipChange={onRelationshipChange} />)}</div>}
    </div>}
  </section>;
}

function SuggestionsTab({ onSentRequest }) {
  const suggestions = useResource('/friends/suggestions?limit=12', 'required');
  const [busyIds, setBusyIds] = useState(() => new Set());
  const [sentIds, setSentIds] = useState(() => new Set());
  const [errorMap, setErrorMap] = useState({});

  if (suggestions.loading && !suggestions.data) return <Loading />;
  if (suggestions.error) return <ErrorNotice error={suggestions.error} retry={suggestions.reload} />;

  if (suggestions.data?.meta?.personalized === false) {
    return (
      <EmptyState
        title="We need a little more reading history first."
        action={<Link to="/my-books" className="button secondary">My Books</Link>}
      >
        Add or rate at least 5 books you've actually read and we'll start finding readers with similar taste.
      </EmptyState>
    );
  }

  const list = (suggestions.data?.data ?? []).filter(item => !sentIds.has(item.user.id));

  if (!list.length) {
    return (
      <EmptyState title="No similar readers yet.">
        Suggestions will improve as more readers build their shelves.
      </EmptyState>
    );
  }

  async function handleAddFriend(userId) {
    if (busyIds.has(userId)) return;
    setBusyIds(prev => new Set([...prev, userId]));
    setErrorMap(prev => ({ ...prev, [userId]: null }));

    try {
      await api('/friends/requests', {
        method: 'POST',
        auth: 'required',
        body: { userId },
      });
      setSentIds(prev => new Set([...prev, userId]));
      if (onSentRequest) onSentRequest();
    } catch (err) {
      setErrorMap(prev => ({ ...prev, [userId]: messageFor(err) }));
    } finally {
      setBusyIds(prev => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
    }
  }

  return (
    <div className="reader-cards-grid">
      {list.map(({ user, reason }) => {
        const isBusy = busyIds.has(user.id);
        const err = errorMap[user.id];
        const initial = user.username ? user.username.slice(0, 1).toUpperCase() : '?';

        return (
          <article className="reader-card" key={user.id}>
            <div className="reader-card-header">
              {user.profilePicture ? (
                <img src={user.profilePicture} alt={`${user.username}'s avatar`} className="reader-avatar" />
              ) : (
                <span className="reader-avatar-placeholder">{initial}</span>
              )}
              <div className="reader-info">
                <h3>{user.username}</h3>
                {user.bio && <p className="reader-bio">{user.bio}</p>}
              </div>
            </div>
            <div className="reader-card-reason">
              <p className="reason-text">
                {reason.type === 'genres' ? (
                  <>You both read a lot of <strong>{reason.genres.join(' and ')}</strong></>
                ) : reason.type === 'ratings' ? (
                  <>You rated <strong>{reason.commonRatedBooks}</strong> of the same {reason.commonRatedBooks === 1 ? 'book' : 'books'} similarly</>
                ) : (
                  <>You have <strong>{reason.sharedBooks}</strong> {reason.sharedBooks === 1 ? 'book' : 'books'} in common</>
                )}
              </p>
              {reason.type === 'genres' && reason.sharedBooks > 0 && (
                <span className="secondary-overlap muted small">
                  {reason.sharedBooks} {reason.sharedBooks === 1 ? 'book' : 'books'} in common
                </span>
              )}
            </div>
            <div className="reader-card-actions">
              <button
                type="button"
                className="button secondary compact add-friend-button"
                disabled={isBusy}
                onClick={() => handleAddFriend(user.id)}
              >
                {isBusy ? 'Sending…' : 'Add Friend'}
              </button>
              {err && <p className="reader-error small-error" role="alert">{err}</p>}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function FriendsTab({ onExploreSuggestions }) {
  const friends = useResource('/friends', 'required');
  const [busyIds, setBusyIds] = useState(() => new Set());
  const [errorMap, setErrorMap] = useState({});

  if (friends.loading && !friends.data) return <Loading />;
  if (friends.error) return <ErrorNotice error={friends.error} retry={friends.reload} />;

  const list = friends.data?.data ?? [];

  if (!list.length) {
    return (
      <EmptyState
        title="Your reading circle starts here."
        action={
          <button type="button" className="button secondary" onClick={onExploreSuggestions}>
            Explore Suggestions
          </button>
        }
      >
        Connect with readers who share your taste.
      </EmptyState>
    );
  }

  async function handleRemoveFriend(friendshipId) {
    if (busyIds.has(friendshipId)) return;
    setBusyIds(prev => new Set([...prev, friendshipId]));
    setErrorMap(prev => ({ ...prev, [friendshipId]: null }));

    try {
      await api(`/friends/${friendshipId}`, {
        method: 'DELETE',
        auth: 'required',
      });
      friends.reload();
    } catch (err) {
      setErrorMap(prev => ({ ...prev, [friendshipId]: messageFor(err) }));
    } finally {
      setBusyIds(prev => {
        const next = new Set(prev);
        next.delete(friendshipId);
        return next;
      });
    }
  }

  return (
    <div className="reader-cards-grid">
      {list.map(({ friendshipId, friend, acceptedAt }) => {
        const isBusy = busyIds.has(friendshipId);
        const err = errorMap[friendshipId];
        const initial = friend.username ? friend.username.slice(0, 1).toUpperCase() : '?';

        return (
          <article className="reader-card" key={friendshipId}>
            <div className="reader-card-header">
              {friend.profilePicture ? (
                <img src={friend.profilePicture} alt={`${friend.username}'s avatar`} className="reader-avatar" />
              ) : (
                <span className="reader-avatar-placeholder">{initial}</span>
              )}
              <div className="reader-info">
                <h3>{friend.username}</h3>
                {friend.bio && <p className="reader-bio">{friend.bio}</p>}
                <span className="muted small">
                  Friends since {new Date(acceptedAt || Date.now()).toLocaleDateString()}
                </span>
              </div>
            </div>
            <div className="reader-card-actions">
              <button
                type="button"
                className="text-button danger-button remove-friend-button"
                disabled={isBusy}
                onClick={() => handleRemoveFriend(friendshipId)}
              >
                {isBusy ? 'Removing…' : 'Remove friend'}
              </button>
              {err && <p className="reader-error small-error" role="alert">{err}</p>}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function RequestsTab() {
  const requests = useResource('/friends/requests', 'required');
  const [busyIds, setBusyIds] = useState(() => new Set());
  const [errorMap, setErrorMap] = useState({});

  if (requests.loading && !requests.data) return <Loading />;
  if (requests.error) return <ErrorNotice error={requests.error} retry={requests.reload} />;

  const incoming = requests.data?.data?.incoming ?? [];
  const sent = requests.data?.data?.sent ?? [];

  async function handleAccept(id) {
    if (busyIds.has(id)) return;
    setBusyIds(prev => new Set([...prev, id]));
    setErrorMap(prev => ({ ...prev, [id]: null }));

    try {
      await api(`/friends/requests/${id}/accept`, {
        method: 'POST',
        auth: 'required',
      });
      requests.reload();
    } catch (err) {
      setErrorMap(prev => ({ ...prev, [id]: messageFor(err) }));
    } finally {
      setBusyIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  async function handleDelete(id) {
    if (busyIds.has(id)) return;
    setBusyIds(prev => new Set([...prev, id]));
    setErrorMap(prev => ({ ...prev, [id]: null }));

    try {
      await api(`/friends/requests/${id}`, {
        method: 'DELETE',
        auth: 'required',
      });
      requests.reload();
    } catch (err) {
      setErrorMap(prev => ({ ...prev, [id]: messageFor(err) }));
    } finally {
      setBusyIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  return (
    <div className="requests-tab-container">
      <section className="requests-section" aria-labelledby="incoming-requests-heading">
        <h2 id="incoming-requests-heading" className="section-title">
          Incoming ({incoming.length})
        </h2>
        {!incoming.length ? (
          <p className="muted small">No pending incoming friend requests.</p>
        ) : (
          <div className="reader-cards-grid">
            {incoming.map(req => {
              const isBusy = busyIds.has(req.id);
              const err = errorMap[req.id];
              const user = req.user;
              const initial = user.username ? user.username.slice(0, 1).toUpperCase() : '?';

              return (
                <article className="reader-card" key={req.id}>
                  <div className="reader-card-header">
                    {user.profilePicture ? (
                      <img src={user.profilePicture} alt={`${user.username}'s avatar`} className="reader-avatar" />
                    ) : (
                      <span className="reader-avatar-placeholder">{initial}</span>
                    )}
                    <div className="reader-info">
                      <h3>{user.username}</h3>
                      {user.bio && <p className="reader-bio">{user.bio}</p>}
                    </div>
                  </div>
                  <div className="reader-card-actions row-actions">
                    <button
                      type="button"
                      className="button compact accept-request-button"
                      disabled={isBusy}
                      onClick={() => handleAccept(req.id)}
                    >
                      {isBusy ? 'Saving…' : 'Accept'}
                    </button>
                    <button
                      type="button"
                      className="button secondary compact decline-request-button"
                      disabled={isBusy}
                      onClick={() => handleDelete(req.id)}
                    >
                      Decline
                    </button>
                  </div>
                  {err && <p className="reader-error small-error" role="alert">{err}</p>}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="requests-section" style={{ marginTop: '36px' }} aria-labelledby="sent-requests-heading">
        <h2 id="sent-requests-heading" className="section-title">
          Sent ({sent.length})
        </h2>
        {!sent.length ? (
          <p className="muted small">No pending sent friend requests.</p>
        ) : (
          <div className="reader-cards-grid">
            {sent.map(req => {
              const isBusy = busyIds.has(req.id);
              const err = errorMap[req.id];
              const user = req.user;
              const initial = user.username ? user.username.slice(0, 1).toUpperCase() : '?';

              return (
                <article className="reader-card" key={req.id}>
                  <div className="reader-card-header">
                    {user.profilePicture ? (
                      <img src={user.profilePicture} alt={`${user.username}'s avatar`} className="reader-avatar" />
                    ) : (
                      <span className="reader-avatar-placeholder">{initial}</span>
                    )}
                    <div className="reader-info">
                      <h3>{user.username}</h3>
                      <span className="status-badge" style={{ marginTop: '4px', display: 'inline-block' }}>Request sent</span>
                    </div>
                  </div>
                  <div className="reader-card-actions">
                    <button
                      type="button"
                      className="text-button danger-button cancel-request-button"
                      disabled={isBusy}
                      onClick={() => handleDelete(req.id)}
                    >
                      {isBusy ? 'Cancelling…' : 'Cancel'}
                    </button>
                    {err && <p className="reader-error small-error" role="alert">{err}</p>}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

export default function Friends() {
  const [params, setParams] = useSearchParams();
  const activeTab = ['suggestions', 'friends', 'requests'].includes(params.get('tab'))
    ? params.get('tab')
    : 'suggestions';

  const requestsResource = useResource('/friends/requests', 'required');
  const incomingCount = requestsResource.data?.data?.incoming?.length ?? 0;

  function setTab(tab) {
    const next = new URLSearchParams(params);
    if (tab === 'suggestions') {
      next.delete('tab');
    } else {
      next.set('tab', tab);
    }
    setParams(next);
  }

  return (
    <div className="container friends-page page-space">
      <div className="page-heading">
        <p className="eyebrow">Reader Network</p>
        <h1>Friends</h1>
        <p className="muted">Find readers who live between the same kinds of pages.</p>
      </div>

      <ReaderSearch onRelationshipChange={requestsResource.reload} />

      <nav className="shelf-tabs friends-tabs" role="tablist" aria-label="Friends tabs">
        <button
          type="button"
          role="tab"
          id="tab-suggestions"
          aria-selected={activeTab === 'suggestions'}
          aria-controls="panel-suggestions"
          className={activeTab === 'suggestions' ? 'selected' : ''}
          onClick={() => setTab('suggestions')}
        >
          Suggestions
        </button>
        <button
          type="button"
          role="tab"
          id="tab-friends"
          aria-selected={activeTab === 'friends'}
          aria-controls="panel-friends"
          className={activeTab === 'friends' ? 'selected' : ''}
          onClick={() => setTab('friends')}
        >
          Friends
        </button>
        <button
          type="button"
          role="tab"
          id="tab-requests"
          aria-selected={activeTab === 'requests'}
          aria-controls="panel-requests"
          className={activeTab === 'requests' ? 'selected' : ''}
          onClick={() => setTab('requests')}
        >
          Requests {incomingCount > 0 ? `(${incomingCount})` : ''}
        </button>
      </nav>

      <div
        role="tabpanel"
        id={`panel-${activeTab}`}
        aria-labelledby={`tab-${activeTab}`}
        className="friends-tab-panel"
      >
        {activeTab === 'suggestions' && <SuggestionsTab onSentRequest={requestsResource.reload} />}
        {activeTab === 'friends' && <FriendsTab onExploreSuggestions={() => setTab('suggestions')} />}
        {activeTab === 'requests' && <RequestsTab />}
      </div>
    </div>
  );
}
