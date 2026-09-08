import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useResource } from '../hooks/useResource.js';
import { Cover, Rating, Genres, Icon, EmptyState, ErrorNotice, Loading, Pagination, pageNumber } from '../components/shared.jsx';

const genreOptions = [['fiction', 'Fiction'], ['fantasy', 'Fantasy'], ['science-fiction', 'Science Fiction'], ['mystery', 'Mystery'], ['romance', 'Romance'], ['history', 'History'], ['biography', 'Biography'], ['science', 'Science'], ['philosophy', 'Philosophy'], ['poetry', 'Poetry'], ['children', 'Children']];

export default function Discover() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const genre = params.get('genre') ?? '';
  const page = pageNumber(params.get('page'));
  const hasExplicitSort = params.has('sort') || params.has('order');
  const sort = params.get('sort') === 'publicationYear' ? 'publicationYear' : hasExplicitSort ? 'rating' : 'publicationYear';
  const order = params.get('order') === 'asc' ? 'asc' : 'desc';
  const genreName = genreOptions.find(([slug]) => slug === genre)?.[1] ?? genre;
  const [search, setSearch] = useState(q);
  useEffect(() => setSearch(q), [q]);
  const query = new URLSearchParams({ page, limit: 18, sort, order });
  if (q) query.set('q', q);
  if (genre) query.set('genre', genre);
  const resource = useResource(`/books?${query}`);
  function change(values, keepPage = false) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) value ? next.set(key, value) : next.delete(key);
    if (!keepPage) next.delete('page');
    setParams(next);
  }
  const hasFilters = q || genre;
  const emptyPage = resource.data?.pagination.total > 0 && !resource.data?.data.length;
  return <div className="container discover-page">
    <section className="discover-hero"><div><p className="eyebrow"><span /> A life between the pages</p><h1>There’s a world<br />in your <em>next read.</em></h1><p className="hero-copy">Follow your curiosity. Find a story to get lost in,<br className="desktop-break" /> and keep the books you love close.</p></div>
      <div className="hero-aside" aria-hidden="true"><span className="chapter-number">01 /</span><Icon size={56} /><span className="hero-aside-note">One more<br /><em>chapter.</em></span><div className="hero-line" /></div>
    </section>
    <section aria-label="Find books" className="discovery-controls">
      <form className="search-box" onSubmit={event => { event.preventDefault(); change({ q: search.trim() }); }} role="search"><Icon name="search" size={22} /><label className="sr-only" htmlFor="book-search">Search by title or author</label><input id="book-search" type="search" value={search} maxLength={200} onChange={event => setSearch(event.target.value)} placeholder="Search by title or author" /><button type="submit" className="button compact">Search</button></form>
      <div className="sort-box"><label htmlFor="book-sort">Sort by</label><select id="book-sort" value={`${sort}:${order}`} onChange={event => { const [sort, order] = event.target.value.split(':'); change({ sort, order }); }}><option value="rating:desc">Highest rated</option><option value="rating:asc">Lowest rated</option><option value="publicationYear:desc">Newest published</option><option value="publicationYear:asc">Oldest published</option></select></div>
    </section>
    <nav className="genre-filters" aria-label="Browse by genre"><span className="genre-filter-label">Browse genres</span>{[['', 'All'], ...genreOptions].map(([slug, name]) => <button type="button" className={`genre-filter${genre === slug ? ' active' : ''}`} aria-pressed={genre === slug} key={slug || 'all'} onClick={() => change({ genre: slug })}>{name}</button>)}</nav>
    <section aria-labelledby="discover-heading" className="catalog-section"><div className="section-heading"><div><p className="eyebrow">The bookshelf</p><h2 id="discover-heading">{q ? `Results for “${q}”` : 'Discover something good'}</h2></div>{resource.data && <span className="muted small">{resource.data.pagination.total} {resource.data.pagination.total === 1 ? 'book' : 'books'}</span>}</div>
      {q || genre ? <div className="filter-line">{q && <><span>Search</span><button className="active-filter" onClick={() => { setSearch(''); change({ q: null }); }}>{q}<Icon name="close" size={14} /><span className="sr-only">Clear search filter</span></button></>}{genre && <><span>Genre</span><button className="active-filter" onClick={() => change({ genre: null })}>{genreName}<Icon name="close" size={14} /><span className="sr-only">Clear genre filter</span></button></>}</div> : <p className="genre-hint">See something you like? Choose a genre label on a book to explore more.</p>}
      {resource.loading ? <Loading cards /> : resource.error ? <ErrorNotice error={resource.error} retry={resource.reload} /> : resource.data?.data.length ? <>
        <div className="book-grid">{resource.data.data.map(book => <article className="book-card" key={book.id}><Link to={`/books/${book.id}`} className="cover-link" aria-label={`Read about ${book.title}`}><Cover book={book} /><span className="cover-open"><Icon name="arrow" /></span></Link><div className="book-card-meta"><Rating value={book.averageRating} /><h3><Link to={`/books/${book.id}`}>{book.title}</Link></h3><p>{book.author}</p><Genres genres={book.genres} onSelect={slug => change({ genre: slug })} /></div></article>)}</div>
      </> : <EmptyState title={emptyPage ? 'No books on this page' : hasFilters ? 'No books found this time' : 'The first chapter is still to come'} action={emptyPage ? <button className="button secondary" onClick={() => change({ page: 1 }, true)}>Back to first page</button> : hasFilters && <button className="button secondary" onClick={() => { setSearch(''); setParams({}); }}>Clear filters</button>}>{emptyPage ? 'Return to the first page to explore the books in these results.' : hasFilters ? 'Try a different title, author, or genre. A good read may be just one search away.' : 'There aren’t any books in the catalog yet. When books are added, you’ll find them here.'}</EmptyState>}
      {!resource.loading && <Pagination pagination={resource.data?.pagination} onPage={page => change({ page }, true)} />}
    </section>
    <div className="reading-note"><Icon size={23} /><p>Every bookshelf starts with a little curiosity.</p><span>Make room for your next favorite.</span></div>
  </div>;
}
