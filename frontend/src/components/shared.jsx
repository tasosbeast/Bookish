import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { messageFor } from '../lib/http.js';

export function Icon({ name = 'book', size = 20, ...props }) {
  const paths = {
    book: <><path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Z" /><path d="M12 5v15" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    arrow: <><path d="M4 12h16m-6-6 6 6-6 6" /></>,
    heart: <path d="M20 5a5 5 0 0 0-8 1 5 5 0 0 0-8-1c-5 5 3 11 8 15 5-4 13-10 8-15Z" />,
    star: <path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.3-5.7-3-5.7 3 1.1-6.3L2.8 9.7l6.4-.9Z" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    check: <path d="m5 12 4 4L19 6" />,
    bell: <><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}

export function Cover({ book, className = '' }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [book.coverImageUrl]);
  return <div className={`book-cover ${className}`}>
    {book.coverImageUrl && !failed ? <img src={book.coverImageUrl} alt={`Cover of ${book.title}`} loading="lazy" onError={() => setFailed(true)} /> :
      <div className="cover-placeholder"><Icon size={30} /><span>{book.title}</span><small>Cover unavailable</small></div>}
  </div>;
}

export function Rating({ value, count }) {
  return <span className="rating"><Icon name="star" size={15} /> {value == null ? 'Not yet rated' : Number(value).toFixed(1)}{count !== undefined && <span className="muted"> · {count} {count === 1 ? 'rating' : 'ratings'}</span>}</span>;
}

export function Genres({ genres = [], onSelect }) {
  return <div className="genres">{genres.map(genre => onSelect ?
    <button className="genre" key={genre.id} onClick={() => onSelect(genre.slug)}>{genre.name}</button> :
    <Link className="genre" key={genre.id} to={`/?genre=${encodeURIComponent(genre.slug)}`}>{genre.name}</Link>)}</div>;
}

export function ErrorNotice({ error, retry }) {
  if (!error) return null;
  return <div className="error-notice" role="alert"><p>{messageFor(error)}</p>{retry && <button className="text-button" onClick={retry}>Try again</button>}</div>;
}

export function EmptyState({ title, children, action }) {
  return <div className="empty-state"><span className="empty-icon"><Icon size={38} /></span><h2>{title}</h2><p>{children}</p>{action}</div>;
}

export function Loading({ cards = false }) {
  return <div role="status" aria-live="polite"><span className={cards ? 'sr-only' : 'loading-text'}>Finding your next chapter…</span>{cards && <div className="book-grid skeleton-grid" aria-hidden="true">{Array.from({ length: 6 }, (_, index) => <div key={index}><div className="skeleton skeleton-cover" /><div className="skeleton skeleton-line" /><div className="skeleton skeleton-line short" /></div>)}</div>}</div>;
}

export function Pagination({ pagination, onPage }) {
  if (!pagination || pagination.totalPages < 2 && pagination.page === 1) return null;
  return <nav className="pagination" aria-label="Pagination">
    <button className="button secondary" disabled={pagination.page <= 1} onClick={() => onPage(pagination.page - 1)}>Previous</button>
    <span>Page {pagination.page} of {Math.max(1, pagination.totalPages)}</span>
    <button className="button secondary" disabled={pagination.page >= pagination.totalPages || pagination.page >= 10000} onClick={() => onPage(pagination.page + 1)}>Next <Icon name="arrow" size={16} /></button>
  </nav>;
}

export const statuses = [['want_to_read', 'Want to read'], ['currently_reading', 'Currently reading'], ['read', 'Read']];
export const pageNumber = value => /^\d+$/.test(value ?? '') ? Math.min(10000, Math.max(1, Number(value))) : 1;
