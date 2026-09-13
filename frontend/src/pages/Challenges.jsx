import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { Cover, ErrorNotice, Loading } from '../components/shared.jsx';

function formatFinishedDate(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export default function Challenges() {
  const [challenge, setChallenge] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadChallenge = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api('/challenges/current', { auth: 'required' });
      setChallenge(res.data);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadChallenge();
  }, [loadChallenge]);

  if (loading) {
    return (
      <div className="container page-space">
        <Loading />
      </div>
    );
  }

  if (error) {
    return (
      <div className="container page-space">
        <div className="page-heading">
          <p className="eyebrow">Monthly Challenge</p>
          <h1>
            Reading Challenges<span className="brand-dot">.</span>
          </h1>
        </div>
        <ErrorNotice error={error} retry={loadChallenge} />
      </div>
    );
  }

  const { title, description, goal = 3, progress = 0, completed, books = [] } = challenge || {};
  const percentage = Math.min(100, Math.round((progress / goal) * 100));

  return (
    <div className="container challenges-page">
      <div className="page-heading">
        <p className="eyebrow">Monthly Challenge</p>
        <h1>
          Reading Challenges<span className="brand-dot">.</span>
        </h1>
        <p className="muted">Finish books and track your monthly reading progress.</p>
      </div>

      <section className="challenge-card" aria-labelledby="challenge-title">
        <div className="challenge-header">
          <div>
            <h2 id="challenge-title" className="challenge-title">{title}</h2>
            <p className="challenge-desc muted">{description}</p>
          </div>
          {completed && (
            <div className="challenge-completed-badge" aria-label="Monthly challenge complete">
              <span aria-hidden="true">🏆</span> Challenge complete
            </div>
          )}
        </div>

        <div className="challenge-progress-section">
          <div className="challenge-progress-header">
            <span className="challenge-progress-count">
              <strong>{progress}</strong> of {goal} books
            </span>
            <span className="challenge-progress-percent muted small">{percentage}%</span>
          </div>

          <div
            className="challenge-progress-bar-track"
            role="progressbar"
            aria-valuenow={Math.min(progress, goal)}
            aria-valuemin={0}
            aria-valuemax={goal}
            aria-valuetext={completed ? `${progress} of ${goal} books — challenge complete` : `${progress} of ${goal} books`}
          >
            <div
              className="challenge-progress-bar-fill"
              style={{ width: `${percentage}%` }}
            />
          </div>

          {completed ? (
            <div className="challenge-status-message completed-msg">
              <span className="status-icon" aria-hidden="true">🏆</span>
              <div>
                <strong>Monthly challenge complete</strong>
                <p className="muted small">{progress} books finished — trophy earned.</p>
              </div>
            </div>
          ) : progress === 0 ? (
            <div className="challenge-status-message empty-msg">
              <p className="muted">Your next finished book starts the challenge.</p>
              <div style={{ marginTop: '12px' }}>
                <Link to="/" className="button compact">
                  Find a book
                </Link>
              </div>
            </div>
          ) : (
            <p className="muted small challenge-hint">
              {goal - progress} more {goal - progress === 1 ? 'book' : 'books'} to earn this month's trophy!
            </p>
          )}
        </div>

        {books && books.length > 0 && (
          <div className="challenge-books-section">
            <h3 className="challenge-books-title">Completed this month</h3>
            <div className="challenge-books-grid">
              {books.map(book => (
                <article key={book.id} className="challenge-book-item">
                  <Link
                    to={`/books/${book.id}`}
                    className="challenge-book-cover-link"
                    aria-label={`View ${book.title}`}
                  >
                    <Cover book={book} className="challenge-book-cover" />
                  </Link>
                  <div className="challenge-book-info">
                    <h4 className="challenge-book-name">
                      <Link to={`/books/${book.id}`}>{book.title}</Link>
                    </h4>
                    <p className="challenge-book-author muted small">{book.author}</p>
                    {book.finishedAt && (
                      <time dateTime={book.finishedAt} className="challenge-book-date muted small">
                        Finished {formatFinishedDate(book.finishedAt)}
                      </time>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
