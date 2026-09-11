import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useResource } from '../hooks/useResource.js';
import { ShelfForm } from '../components/ReadingForms.jsx';
import { Cover, Genres, Rating, EmptyState, ErrorNotice, Loading, Pagination, statuses, pageNumber, Icon } from '../components/shared.jsx';

function ShelfEditor({ bookId, onSaved }) {
  const personal = useResource(`/user-books/${bookId}`, 'required');
  if (personal.loading) return <Loading />;
  if (personal.error) return <ErrorNotice error={personal.error} retry={personal.reload} />;
  return <ShelfForm personal={personal.data.data} onSaved={onSaved} />;
}

export default function MyBooks() {
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState('');
  const [removedBookIds, setRemovedBookIds] = useState(() => new Set());
  const q = params.get('q') ?? '';
  const [search, setSearch] = useState(q);
  useEffect(() => setSearch(q), [q]);
  const status = statuses.some(([value]) => value === params.get('status')) ? params.get('status') : '';
  const query = new URLSearchParams({ page: pageNumber(params.get('page')), limit: 10 });
  if (status) query.set('status', status);
  if (q) query.set('q', q);
  const shelves = useResource(`/user-books?${query}`, 'required', 'my-books');
  const visibleEntries = shelves.data?.data.filter(entry => !removedBookIds.has(entry.bookId)) ?? [];
  const emptyPage = !removedBookIds.size && shelves.data?.pagination.total > 0 && !visibleEntries.length;
  const initialLoading = shelves.loading && !shelves.data;
  const shelfSummary = shelves.loading ? 'Updating shelf…' : shelves.error ? 'Showing previous shelf.' : `${shelves.data?.pagination.total} ${shelves.data?.pagination.total === 1 ? 'book' : 'books'} on this shelf`;
  useEffect(() => {
    if (!shelves.loading && !shelves.error && shelves.data && removedBookIds.size) setRemovedBookIds(new Set());
  }, [removedBookIds.size, shelves.data, shelves.error, shelves.loading]);

  function change(values, keepPage = false) {
    setEditing(null);
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    if (!keepPage) next.delete('page');
    setParams(next);
  }

  function saved(message, removedBookId) {
    setNotice(message);
    setEditing(null);
    if (removedBookId) setRemovedBookIds(current => new Set([...current, removedBookId]));
    shelves.reload();
  }

  const statusLabel = statuses.find(([val]) => val === status)?.[1];
  const hasFilters = Boolean(q || status);
  const noResultsTitle = emptyPage
    ? 'No books on this page'
    : q
    ? status
      ? `No ${statusLabel.toLowerCase()} books match “${q}”`
      : `No books match “${q}”`
    : status
    ? 'A little room on this shelf'
    : 'Your reading story starts here';

  const noResultsBody = emptyPage
    ? 'Return to the first page to explore the books in these results.'
    : q
    ? 'Try searching for a different title or author, or clear your search to see your books.'
    : status
    ? 'No books on this shelf yet. Discover a book or choose another shelf.'
    : 'Find something that catches your eye and add it to your books.';

  const emptyAction = emptyPage ? (
    <button className="button secondary" onClick={() => change({ page: 1 }, true)}>
      Back to first page
    </button>
  ) : hasFilters ? (
    <button className="button secondary" onClick={() => { setSearch(''); change({ q: null, status: null }); }}>
      Clear filters
    </button>
  ) : (
    <Link className="button" to="/">
      Discover books
    </Link>
  );

  return (
    <div className="container my-books-page">
      <div className="page-heading">
        <p className="eyebrow">Your own little library</p>
        <h1>
          My books<span className="brand-dot">.</span>
        </h1>
        <p className="muted">The stories you’re saving, living in, and looking back on.</p>
      </div>

      <section aria-label="Search your books" className="discovery-controls" style={{ marginTop: '24px' }}>
        <form
          className="search-box"
          onSubmit={event => {
            event.preventDefault();
            change({ q: search.trim() });
          }}
          role="search"
        >
          <Icon name="search" size={22} />
          <label className="sr-only" htmlFor="my-books-search">
            Search by title or author
          </label>
          <input
            id="my-books-search"
            type="search"
            value={search}
            maxLength={200}
            onChange={event => setSearch(event.target.value)}
            placeholder="Search your books by title or author"
          />
          <button type="submit" className="button compact">
            Search
          </button>
        </form>
      </section>

      <nav className="shelf-tabs" aria-label="Reading status">
        {[ ['', 'All books'], ...statuses ].map(([value, label]) => (
          <button
            type="button"
            key={value}
            aria-pressed={status === value}
            className={status === value ? 'selected' : ''}
            onClick={() => change({ status: value })}
          >
            {label}
          </button>
        ))}
      </nav>

      {q && (
        <div className="filter-line" style={{ marginBottom: '20px' }}>
          <div className="filter-item">
            <span>Search</span>
            <button
              type="button"
              className="active-filter"
              aria-label={`Clear search filter: ${q}`}
              onClick={() => {
                setSearch('');
                change({ q: null });
              }}
            >
              <span className="active-filter-label">{q}</span>
              <Icon name="close" size={14} />
            </button>
          </div>
        </div>
      )}

      {notice && <p className="success-notice" role="status">{notice}</p>}
      {shelves.error && <ErrorNotice error={shelves.error} retry={shelves.reload} />}

      {initialLoading ? (
        <Loading />
      ) : (
        shelves.data && (
          visibleEntries.length ? (
            <>
              <p className="muted small shelf-count" role="status" aria-live="polite">
                {shelfSummary}
              </p>
              <div className="shelf-list" aria-busy={shelves.loading}>
                {visibleEntries.map(entry => (
                  <article className="shelf-row" key={entry.bookId}>
                    <div className="shelf-row-main">
                      <Link to={`/books/${entry.bookId}`} aria-label={`Read about ${entry.book.title}`}>
                        <Cover book={entry.book} className="shelf-cover" />
                      </Link>
                      <div className="shelf-book-info">
                        <Genres genres={entry.book.genres} />
                        <h2>
                          <Link to={`/books/${entry.bookId}`}>{entry.book.title}</Link>
                        </h2>
                        <p className="muted">{entry.book.author}</p>
                        <Rating value={entry.book.averageRating} />
                      </div>
                      <div className="shelf-personal">
                        <span className="status-badge">
                          {statuses.find(([value]) => value === entry.status)?.[1]}
                        </span>
                        <span className="small muted">
                          Your rating: {entry.userRating ? `${entry.userRating} / 5` : 'Not rated'}
                        </span>
                        <button
                          className="text-button"
                          aria-expanded={editing === entry.bookId}
                          onClick={() => setEditing(editing === entry.bookId ? null : entry.bookId)}
                        >
                          {editing === entry.bookId
                            ? `Close editor for ${entry.book.title}`
                            : `Update reading for ${entry.book.title}`}
                        </button>
                        <Link className="text-button" to={`/books/${entry.bookId}#review`}>
                          Review
                        </Link>
                      </div>
                    </div>
                    {editing === entry.bookId && (
                      <div className="inline-editor">
                        <ShelfEditor
                          bookId={entry.bookId}
                          onSaved={(message, change) => saved(message, change?.shelf ? entry.bookId : null)}
                        />
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </>
          ) : (
            <EmptyState title={noResultsTitle} action={emptyAction}>
              {noResultsBody}
            </EmptyState>
          )
        )
      )}

      {!initialLoading && shelves.data && (
        <Pagination
          pagination={shelves.data.pagination}
          onPage={page => change({ page }, true)}
        />
      )}
    </div>
  );
}
