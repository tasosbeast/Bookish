import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useResource } from '../hooks/useResource.js';
import { Cover, Rating, Genres, Icon, EmptyState, ErrorNotice, Loading } from '../components/shared.jsx';

export function formatReleaseDate(dateString, type = 'new') {
  if (!dateString) return '';
  const [year, month, day] = dateString.slice(0, 10).split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthName = months[month - 1];
  const prefix = type === 'upcoming' ? 'Coming' : 'Released';
  return `${prefix} ${monthName} ${day}, ${year}`;
}

function ReleaseCard({ book, type }) {
  return (
    <article className="book-card" key={book.id}>
      <Link to={`/books/${book.id}`} className="cover-link" aria-label={`Read about ${book.title}`}>
        <Cover book={book} />
        <span className="cover-open"><Icon name="arrow" /></span>
      </Link>
      <div className="book-card-meta">
        <span className="release-date">{formatReleaseDate(book.publicationDate, type)}</span>
        <Rating value={book.averageRating} />
        <h3><Link to={`/books/${book.id}`}>{book.title}</Link></h3>
        <p className="author-name">{book.author}</p>
        <Genres genres={book.genres} />
      </div>
    </article>
  );
}

export default function Releases() {
  const [tab, setTab] = useState('all');
  const resource = useResource('/releases', 'none', 'releases');

  const newReleases = resource.data?.newReleases ?? [];
  const upcoming = resource.data?.upcoming ?? [];
  const initialLoading = resource.loading && !resource.data;

  return (
    <div className="container releases-page">
      <div className="page-heading">
        <p className="eyebrow">Fresh stories &amp; what’s next</p>
        <h1>
          Releases<span className="brand-dot">.</span>
        </h1>
        <p className="muted">Browse the newest additions and books on the horizon.</p>
      </div>

      <nav className="shelf-tabs release-tabs" aria-label="Release categories">
        <button
          type="button"
          aria-pressed={tab === 'all'}
          className={tab === 'all' ? 'selected' : ''}
          onClick={() => setTab('all')}
        >
          All Releases
        </button>
        <button
          type="button"
          aria-pressed={tab === 'new'}
          className={tab === 'new' ? 'selected' : ''}
          onClick={() => setTab('new')}
        >
          New Releases
        </button>
        <button
          type="button"
          aria-pressed={tab === 'upcoming'}
          className={tab === 'upcoming' ? 'selected' : ''}
          onClick={() => setTab('upcoming')}
        >
          Upcoming
        </button>
      </nav>

      {resource.error && <ErrorNotice error={resource.error} retry={resource.reload} />}

      {initialLoading ? (
        <Loading cards />
      ) : resource.data ? (
        <>
          {(tab === 'all' || tab === 'new') && (
            <section aria-labelledby="new-releases-heading" className="catalog-section">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Just arrived</p>
                  <h2 id="new-releases-heading">New Releases</h2>
                </div>
                <span className="muted small" role="status" aria-live="polite">
                  {resource.loading ? 'Updating…' : `${newReleases.length} ${newReleases.length === 1 ? 'book' : 'books'}`}
                </span>
              </div>
              {newReleases.length > 0 ? (
                <div className="book-grid">
                  {newReleases.map(book => (
                    <ReleaseCard key={book.id} book={book} type="new" />
                  ))}
                </div>
              ) : (
                <EmptyState title="No recent releases yet.">
                  Check back soon for freshly published books added to the catalog.
                </EmptyState>
              )}
            </section>
          )}

          {(tab === 'all' || tab === 'upcoming') && (
            <section aria-labelledby="upcoming-releases-heading" className="catalog-section">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">On the horizon</p>
                  <h2 id="upcoming-releases-heading">Upcoming</h2>
                </div>
                <span className="muted small" role="status" aria-live="polite">
                  {resource.loading ? 'Updating…' : `${upcoming.length} ${upcoming.length === 1 ? 'book' : 'books'}`}
                </span>
              </div>
              {upcoming.length > 0 ? (
                <div className="book-grid">
                  {upcoming.map(book => (
                    <ReleaseCard key={book.id} book={book} type="upcoming" />
                  ))}
                </div>
              ) : (
                <EmptyState title="No upcoming releases yet.">
                  Check back soon for upcoming titles arriving in the coming months.
                </EmptyState>
              )}
            </section>
          )}
        </>
      ) : null}
    </div>
  );
}
