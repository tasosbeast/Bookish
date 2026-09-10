import { useId, useState } from 'react';
import { api } from '../lib/api.js';
import { ErrorNotice, Icon, statuses } from './shared.jsx';
import { useDraftValue } from '../hooks/useDraftValue.js';

export function ShelfForm({ personal, onSaved }) {
  const id = useId();
  const [status, setStatus] = useDraftValue(personal.shelf?.status ?? 'want_to_read');
  const [rating, setRating] = useDraftValue(personal.shelf?.userRating?.toString() ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save(event) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      await api('/user-books', { method: 'POST', auth: 'required', body: { bookId: personal.bookId, status, userRating: rating ? Number(rating) : null } });
      onSaved('Your bookshelf has been updated.');
    } catch (error) { setError(error); } finally { setBusy(false); }
  }
  async function remove() {
    let confirmMsg = 'Remove this book from My Books?';
    let url = `/user-books/${personal.bookId}`;
    if (personal.review) {
      confirmMsg = 'Removing this book will also delete your review and rating. Continue?';
      url += '?deleteReview=true';
    }
    if (!window.confirm(confirmMsg)) return;
    setBusy(true); setError(null);
    try {
      await api(url, { method: 'DELETE', auth: 'required' });
      onSaved('This book has been removed from My Books.', { shelf: true });
    } catch (error) { setError(error); } finally { setBusy(false); }
  }
  return <form onSubmit={save} className="reading-form"><fieldset disabled={busy}><legend className="form-title">Your reading journey</legend><div className="form-grid"><div><label htmlFor={`${id}-status`}>Reading status</label><select id={`${id}-status`} value={status} onChange={event => setStatus(event.target.value)}>{statuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div><div><label htmlFor={`${id}-rating`}>Your rating</label><select id={`${id}-rating`} value={rating} onChange={event => setRating(event.target.value)}><option value="" disabled={Boolean(personal.review)}>Not rated</option>{[1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value} {value === 1 ? 'star' : 'stars'}</option>)}</select></div></div>{personal.review && <p className="field-help">Your review needs a rating. You can change it, but can’t clear it while the review exists.</p>}<ErrorNotice error={error} /><div className="reading-actions"><button className="button" type="submit">{busy ? 'Saving…' : personal.shelf ? 'Save changes' : 'Add to my books'}<Icon name="check" size={17} /></button>{personal.shelf && <button className="text-button danger-button" type="button" onClick={remove}>Remove from My Books</button>}</div></fieldset></form>;
}

export function ReviewForm({ personal, onSaved }) {
  const id = useId();
  const [rating, setRating] = useDraftValue((personal.review?.rating ?? personal.shelf?.userRating)?.toString() ?? '');
  const [text, setText] = useDraftValue(personal.review?.reviewText ?? '');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  async function save(event) {
    event.preventDefault(); setBusy('save'); setError(null);
    try {
      const result = await api('/reviews', { method: 'POST', auth: 'required', body: { bookId: personal.bookId, rating: Number(rating), reviewText: text.trim() || null } });
      setText(result.data.reviewText ?? '');
      onSaved('Your review has been saved.');
    } catch (error) { setError(error); } finally { setBusy(null); }
  }
  async function remove() {
    if (!window.confirm('Delete your review? Your rating will stay in My Books.')) return;
    setBusy('delete'); setError(null);
    try {
      await api(`/reviews/${personal.review.id}`, { method: 'DELETE', auth: 'required' });
      setText('');
      onSaved('Your review has been deleted. Your rating remains in My Books.', { reviewId: personal.review.id });
    } catch (error) { setError(error); } finally { setBusy(null); }
  }
  return <form onSubmit={save} className="review-form"><fieldset disabled={Boolean(busy)}><legend className="form-title">{personal.review ? 'Your review' : 'What stayed with you?'}</legend><p className="muted small">Share a few words with the next reader.</p><label htmlFor={`${id}-stars`}>Review rating</label><select className="review-rating" id={`${id}-stars`} value={rating} required onChange={event => setRating(event.target.value)}><option value="" disabled>Choose a rating</option>{[1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value} {value === 1 ? 'star' : 'stars'}</option>)}</select><label htmlFor={`${id}-review`}>Your thoughts <span className="optional">(optional)</span></label><textarea id={`${id}-review`} value={text} maxLength={10000} rows={5} onChange={event => setText(event.target.value)} placeholder="A sentence, a feeling, a reason to read it…" /><ErrorNotice error={error} />{personal.review && <p className="field-help">Deleting your review keeps your rating in My Books.</p>}<div className="reading-actions"><button className="button secondary" type="submit">{busy === 'save' ? 'Saving…' : 'Save review'}</button>{personal.review && <button className="text-button danger-button" type="button" onClick={remove}>{busy === 'delete' ? 'Deleting…' : 'Delete review'}</button>}</div></fieldset></form>;
}
