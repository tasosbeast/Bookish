import { useEffect, useState, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { Cover, EmptyState, ErrorNotice, Loading } from '../components/shared.jsx';

function renderStars(rating) {
  if (!rating || rating < 1) return '';
  const filled = Math.min(5, Math.max(1, Math.round(rating)));
  return '★'.repeat(filled) + '☆'.repeat(5 - filled);
}

function formatRelativeTime(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diffSec = Math.floor((now - date) / 1000);

  if (diffSec < 60) return 'Just now';
  if (diffSec < 3600) {
    const mins = Math.floor(diffSec / 60);
    return `${mins}m ago`;
  }
  if (diffSec < 86400) {
    const hours = Math.floor(diffSec / 3600);
    return `${hours}h ago`;
  }
  if (diffSec < 7 * 86400) {
    const days = Math.floor(diffSec / 86400);
    return `${days}d ago`;
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function ActivityCard({ activity }) {
  const { actor, book, type, rating, review, createdAt } = activity;
  const initial = actor.username ? actor.username.slice(0, 1).toUpperCase() : '?';

  let actionText;
  if (type === 'started_reading') {
    actionText = (
      <>
        <strong>{actor.username}</strong> started reading <em>{book.title}</em>
      </>
    );
  } else if (type === 'finished_reading') {
    actionText = (
      <>
        <strong>{actor.username}</strong> finished reading <em>{book.title}</em>
      </>
    );
  } else if (type === 'rated_book') {
    actionText = (
      <>
        <strong>{actor.username}</strong> rated <em>{book.title}</em> <span className="feed-rating-stars" aria-label={`${rating} out of 5 stars`}>{renderStars(rating)}</span>
      </>
    );
  } else if (type === 'reviewed_book') {
    actionText = (
      <>
        <strong>{actor.username}</strong> reviewed <em>{book.title}</em>
      </>
    );
  }

  return (
    <article className="feed-card" id={`activity-${activity.id}`}>
      <div className="feed-card-header">
        {actor.profilePicture ? (
          <img src={actor.profilePicture} alt={`${actor.username}'s avatar`} className="reader-avatar" />
        ) : (
          <span className="reader-avatar-placeholder" aria-hidden="true">{initial}</span>
        )}
        <div className="feed-header-info">
          <p className="feed-action-line">{actionText}</p>
          <time dateTime={createdAt} className="muted small feed-timestamp">
            {formatRelativeTime(createdAt)}
          </time>
        </div>
      </div>

      {type === 'reviewed_book' && (
        <div className="feed-review-section">
          {rating && (
            <div className="feed-review-rating" aria-label={`${rating} out of 5 stars`}>
              <span className="feed-rating-stars">{renderStars(rating)}</span>
            </div>
          )}
          {review?.reviewText && (
            <p className="feed-review-text">{review.reviewText}</p>
          )}
        </div>
      )}

      <div className="feed-book-snippet">
        <Link to={`/books/${book.id}`} className="feed-book-cover-link" aria-label={`View ${book.title}`}>
          <Cover book={book} className="feed-book-cover" />
        </Link>
        <div className="feed-book-meta">
          <h2 className="feed-book-title">
            <Link to={`/books/${book.id}`}>{book.title}</Link>
          </h2>
          <p className="feed-book-author">by {book.author}</p>
        </div>
      </div>
    </article>
  );
}

export default function Feed() {
  const [activities, setActivities] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [loadMoreError, setLoadMoreError] = useState(null);

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api('/feed?limit=20', { auth: 'required' });
      if (isMounted.current) {
        setActivities(response.data ?? []);
        setNextCursor(response.meta?.nextCursor ?? null);
      }
    } catch (err) {
      if (isMounted.current) {
        setError(err);
      }
    } finally {
      if (isMounted.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  async function handleLoadMore() {
    if (loadingMore || !nextCursor) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const response = await api(`/feed?limit=20&cursor=${encodeURIComponent(nextCursor)}`, { auth: 'required' });
      if (isMounted.current) {
        setActivities(prev => {
          const existingIds = new Set(prev.map(item => item.id));
          const uniqueNew = (response.data ?? []).filter(item => !existingIds.has(item.id));
          return [...prev, ...uniqueNew];
        });
        setNextCursor(response.meta?.nextCursor ?? null);
      }
    } catch (err) {
      if (isMounted.current) {
        setLoadMoreError(err);
      }
    } finally {
      if (isMounted.current) {
        setLoadingMore(false);
      }
    }
  }

  return (
    <div className="container feed-page page-space">
      <div className="page-heading">
        <p className="eyebrow">Reader Network</p>
        <h1>Friends Activity</h1>
        <p className="muted">See what your friends are reading, rating, and reviewing.</p>
      </div>

      {loading && !activities.length && <Loading />}

      {error && !activities.length && (
        <ErrorNotice error={error} retry={loadInitial} />
      )}

      {!loading && !error && activities.length === 0 && (
        <EmptyState
          title="No activity yet."
          action={
            <Link to="/friends" className="button secondary">
              Find readers
            </Link>
          }
        >
          When your friends start, finish, rate, or review books, you'll see it here.
        </EmptyState>
      )}

      {activities.length > 0 && (
        <div className="feed-list">
          {activities.map(activity => (
            <ActivityCard key={activity.id} activity={activity} />
          ))}

          {loadMoreError && (
            <ErrorNotice error={loadMoreError} retry={handleLoadMore} />
          )}

          {nextCursor && (
            <div className="feed-load-more">
              <button
                type="button"
                className="button secondary load-more-button"
                disabled={loadingMore}
                onClick={handleLoadMore}
              >
                {loadingMore ? 'Loading more…' : 'Load more'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
