import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth.js';
import { useResource } from '../hooks/useResource.js';
import { api } from '../lib/api.js';
import { ShelfForm, ReviewForm } from '../components/ReadingForms.jsx';
import { Cover, Rating, Genres, Icon, ErrorNotice, Loading, Pagination, pageNumber } from '../components/shared.jsx';

function Review({ review, canLike, onSaved, next }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function saveLike() {
    setBusy(true); setError(null);
    try { await api(`/reviews/${review.id}/like`, { method: review.likedByMe ? 'DELETE' : 'PUT', auth: 'required' }); onSaved(); }
    catch (error) { setError(error); } finally { setBusy(false); }
  }
  return <article className="review-card"><div className="review-heading"><div className="review-author"><span className="avatar">{review.user.username[0].toUpperCase()}</span><div><strong>{review.user.username}</strong><time dateTime={review.createdAt}>{new Date(review.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time></div></div><Rating value={review.rating} /></div>{review.reviewText ? <p className="review-text">{review.reviewText}</p> : <p className="muted small italic">This reader left a rating.</p>}<ErrorNotice error={error} />{canLike ? <button className={`like-button ${review.likedByMe ? 'is-liked' : ''}`} aria-pressed={review.likedByMe} disabled={busy} onClick={saveLike}><Icon name="heart" size={17} />{busy ? 'Saving…' : review.likedByMe ? 'Liked' : 'Like'}<span>{review.likesCount}</span></button> : <Link className="like-button" to={`/login?next=${encodeURIComponent(next)}`}><Icon name="heart" size={17} />Log in to like<span>{review.likesCount}</span></Link>}</article>;
}

export default function BookDetails() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const auth = useAuth();
  const [notice, setNotice] = useState('');
  useEffect(() => setNotice(''), [id, auth.user?.id]);
  const book = useResource(`/books/${id}?page=${pageNumber(params.get('page'))}&limit=10`);
  const personal = useResource(auth.user ? `/user-books/${id}` : null, 'required');
  const path = `/books/${id}`;
  function saved(message) { setNotice(message); book.reload(); personal.reload(); }
  if (book.loading) return <div className="container page-space"><Loading /></div>;
  if (book.error) return <div className="container page-space"><Link className="back-link" to="/">← Back to discover</Link><ErrorNotice error={book.error} retry={book.reload} /></div>;
  const data = book.data.data;
  return <div className="container details-page"><Link className="back-link" to="/">← Back to discover</Link><section className="book-detail-grid"><div className="detail-cover-wrap"><Cover book={data} className="detail-cover" /><span className="cover-caption">A place on your bookshelf.</span></div><div className="detail-copy"><p className="eyebrow">Between the covers</p><h1>{data.title}</h1><p className="detail-author">by {data.author}</p><Rating value={data.averageRating} count={data.ratingsCount} /><Genres genres={data.genres} /><p className="book-description">{data.description || 'There isn’t a description for this book yet.'}</p><dl className="book-facts">{data.publicationYear && <div><dt>Published</dt><dd>{data.publicationYear}</dd></div>}{data.isbn && <div><dt>ISBN</dt><dd>{data.isbn}</dd></div>}</dl>
      {notice && <p className="success-notice" role="status"><Icon name="check" size={18} />{notice}</p>}
      {auth.user ? personal.loading ? <Loading /> : personal.error ? <ErrorNotice error={personal.error} retry={personal.reload} /> : <ShelfForm key={`${id}-${personal.data.data.shelf?.updatedAt}`} personal={personal.data.data} onSaved={saved} /> : <div className="join-note"><h2>Make it part of your story.</h2><p>Keep track of your reading and share your thoughts.</p><Link className="button" to={`/login?next=${encodeURIComponent(path)}`}>Log in to add this book <Icon name="arrow" size={17} /></Link></div>}
    </div></section>
    <section className="reviews-layout" aria-labelledby="reviews-heading"><div><div className="section-heading"><div><p className="eyebrow">From one reader to another</p><h2 id="reviews-heading">Reader reviews</h2></div><span className="muted small">{data.reviews.pagination.total} total</span></div>{data.reviews.data.length ? data.reviews.data.map(review => <Review key={review.id} review={review} canLike={Boolean(auth.user)} onSaved={book.reload} next={path} />) : <div className="quiet-empty">{data.reviews.pagination.total ? 'No reviews on this page. Choose an earlier page to keep reading.' : 'No reviews yet. Your perspective could be the first.'}</div>}<Pagination pagination={data.reviews.pagination} onPage={page => setParams({ page })} /></div><aside className="review-editor">{auth.user && !personal.loading && !personal.error && personal.data ? <ReviewForm key={`${id}-${personal.data.data.review?.updatedAt}-${personal.data.data.shelf?.updatedAt}`} personal={personal.data.data} onSaved={saved} /> : <div className="reader-note"><Icon size={30} /><h3>Stories are better shared.</h3><p>Every reading experience is a little different. Yours belongs here, too.</p></div>}</aside></section>
  </div>;
}
