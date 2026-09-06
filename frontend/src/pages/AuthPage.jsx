import { useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth.js';
import { session } from '../lib/api.js';
import { ApiError } from '../lib/http.js';
import { ErrorNotice, Icon, Loading } from '../components/shared.jsx';

export default function AuthPage({ signup = false }) {
  const auth = useAuth();
  const [params] = useSearchParams();
  const requested = params.get('next') || '/my-books';
  const next = /^\/(my-books|books\/[^/?#]+)(\?|$)/.test(requested) ? requested : '/my-books';
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  if (auth.status === 'restoring') return <div className="container page-space"><Loading /></div>;
  if (auth.user) return <Navigate to={next} replace />;
  async function submit(event) {
    event.preventDefault(); setError(null);
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    if (new TextEncoder().encode(fields.password).length > 72) { setError(new ApiError(400, 'PASSWORD_LENGTH', 'That password is too long. Try a shorter passphrase.')); return; }
    setBusy(true);
    try { await session.authenticate(signup ? 'signup' : 'login', fields); }
    catch (error) { setError(error); } finally { setBusy(false); }
  }
  return <div className="container auth-page"><aside className="auth-story"><p className="eyebrow">A place for book people</p><h1>{signup ? <>Your next chapter<br />starts <em>here.</em></> : <>Good books.<br /><em>Welcome back.</em></>}</h1><p>Keep your reading life in one lovely place.<br />One book, one thought, one chapter at a time.</p><div className="auth-book-mark" aria-hidden="true"><Icon size={100} /><span>Read. Remember. Repeat.</span></div></aside><section className="auth-card"><span className="eyebrow">{signup ? 'Make yourself at home' : 'Your bookshelf is waiting'}</span><h2>{signup ? 'Join Bookish' : 'Log in'}</h2><p className="muted small">{signup ? 'For the books you love. And the ones you haven’t met yet.' : 'Pick up right where you left off.'}</p><form onSubmit={submit}><fieldset disabled={busy}>{signup && <><label htmlFor="username">Username</label><input id="username" name="username" autoComplete="username" required minLength={3} maxLength={30} pattern="[A-Za-z0-9_]+" aria-describedby="username-help" /><p id="username-help" className="field-help">3–30 letters, numbers, or underscores.</p></>}<label htmlFor="email">Email address</label><input id="email" name="email" type="email" autoComplete={signup ? 'email' : 'username'} maxLength={254} required /><label htmlFor="password">Password</label><input id="password" name="password" type="password" autoComplete={signup ? 'new-password' : 'current-password'} minLength={12} required aria-describedby="password-help" /><p id="password-help" className="field-help">At least 12 characters.</p><ErrorNotice error={error} /><button className="button auth-submit" type="submit">{busy ? 'One moment…' : signup ? 'Create your account' : 'Log in'}<Icon name="arrow" size={18} /></button></fieldset></form><p className="auth-switch">{signup ? 'Already have a bookshelf?' : 'New to Bookish?'} <Link to={`/${signup ? 'login' : 'signup'}?next=${encodeURIComponent(next)}`}>{signup ? 'Log in' : 'Create an account'}</Link></p></section></div>;
}
