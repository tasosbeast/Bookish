import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useResource } from '../hooks/useResource.js';
import { ShelfForm } from '../components/ReadingForms.jsx';
import { Cover, Genres, Rating, EmptyState, ErrorNotice, Loading, Pagination, statuses, pageNumber } from '../components/shared.jsx';

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
  const status = statuses.some(([value]) => value === params.get('status')) ? params.get('status') : '';
  const query = new URLSearchParams({ page: pageNumber(params.get('page')), limit: 10 });
  if (status) query.set('status', status);
  const shelves = useResource(`/user-books?${query}`, 'required', 'my-books');
  const emptyPage = shelves.data?.pagination.total > 0 && !shelves.data?.data.length;
  const initialLoading = shelves.loading && !shelves.data;
  const shelfSummary = shelves.loading ? 'Updating shelf…' : shelves.error ? 'Showing previous shelf.' : `${shelves.data?.pagination.total} ${shelves.data?.pagination.total === 1 ? 'book' : 'books'} on this shelf`;
  function filter(status) { setEditing(null); setParams(status ? { status } : {}); }
  function saved(message) { setNotice(message); setEditing(null); shelves.reload(); }
  return <div className="container my-books-page"><div className="page-heading"><p className="eyebrow">Your own little library</p><h1>My books<span className="brand-dot">.</span></h1><p className="muted">The stories you’re saving, living in, and looking back on.</p></div><nav className="shelf-tabs" aria-label="Reading status">{[['', 'All books'], ...statuses].map(([value, label]) => <button type="button" key={value} aria-pressed={status === value} className={status === value ? 'selected' : ''} onClick={() => filter(value)}>{label}</button>)}</nav>{notice && <p className="success-notice" role="status">{notice}</p>}
    {shelves.error && <ErrorNotice error={shelves.error} retry={shelves.reload} />}
    {initialLoading ? <Loading /> : shelves.data && (shelves.data.data.length ? <><p className="muted small shelf-count" role="status" aria-live="polite">{shelfSummary}</p><div className="shelf-list" aria-busy={shelves.loading}>{shelves.data.data.map(entry => <article className="shelf-row" key={entry.bookId}><div className="shelf-row-main"><Link to={`/books/${entry.bookId}`} aria-label={`Read about ${entry.book.title}`}><Cover book={entry.book} className="shelf-cover" /></Link><div className="shelf-book-info"><Genres genres={entry.book.genres} /><h2><Link to={`/books/${entry.bookId}`}>{entry.book.title}</Link></h2><p className="muted">{entry.book.author}</p><Rating value={entry.book.averageRating} /></div><div className="shelf-personal"><span className="status-badge">{statuses.find(([value]) => value === entry.status)?.[1]}</span><span className="small muted">Your rating: {entry.userRating ? `${entry.userRating} / 5` : 'Not rated'}</span><button className="text-button" aria-expanded={editing === entry.bookId} onClick={() => setEditing(editing === entry.bookId ? null : entry.bookId)}>{editing === entry.bookId ? `Close editor for ${entry.book.title}` : `Update reading for ${entry.book.title}`}</button></div></div>{editing === entry.bookId && <div className="inline-editor"><ShelfEditor bookId={entry.bookId} onSaved={saved} /></div>}</article>)}</div></> : <EmptyState title={emptyPage ? 'No books on this page' : status ? 'A little room on this shelf' : 'Your reading story starts here'} action={emptyPage ? <button className="button" onClick={() => filter(status)}>Back to first page</button> : <Link className="button" to="/">Discover books</Link>}>{emptyPage ? 'Return to the first page to explore the books in these results.' : status ? 'No books on this page yet. Discover a book or choose another shelf.' : 'Find something that catches your eye and add it to your books.'}</EmptyState>)}
    {!initialLoading && shelves.data && <Pagination pagination={shelves.data.pagination} onPage={page => { setEditing(null); setParams({ ...(status && { status }), page }); }} />}
  </div>;
}
