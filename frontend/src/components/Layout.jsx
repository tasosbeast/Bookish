import { useState, useEffect } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth.js';
import { session } from '../lib/api.js';
import { Icon, ErrorNotice } from './shared.jsx';

export default function Layout() {
  const auth = useAuth();
  const location = useLocation();
  const [logoutError, setLogoutError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { window.scrollTo(0, 0); }, [location.pathname]);
  async function logout() {
    setBusy(true); setLogoutError(null);
    try { await session.logout(); } catch (error) { setLogoutError(error); } finally { setBusy(false); }
  }
  return <div className="app-shell">
    <a href="#main" className="skip-link">Skip to content</a>
    <header className="site-header"><div className="header-inner">
      <Link to="/" className="brand" aria-label="Bookish home"><Icon size={29} /><span>bookish<span className="brand-dot">.</span></span></Link>
      <nav className="main-nav" aria-label="Main navigation"><NavLink to="/" end>Discover</NavLink><NavLink to="/my-books">My books</NavLink></nav>
      <div className="account-nav">{auth.status === 'restoring' ? <span className="muted small">Opening your bookshelf…</span> : auth.user ? <>
        <span className="reader-name" title={auth.user.username}><span className="avatar">{auth.user.username.slice(0, 1).toUpperCase()}</span><span>{auth.user.username}</span></span>
        <button className="text-button" disabled={busy} onClick={logout}>Sign out</button>
      </> : <><Link className="login-link" to="/login">Log in</Link><Link className="button compact" to="/signup">Join Bookish</Link></>}</div>
    </div></header>
    {(auth.error || logoutError) && <div className="container pt-4"><ErrorNotice error={logoutError || auth.error} retry={auth.error ? () => session.refresh().catch(() => {}) : undefined} /></div>}
    <main id="main" tabIndex={-1}><Outlet /></main>
    <footer className="site-footer container"><Link to="/" className="footer-brand"><Icon size={20} /> bookish.</Link><span>A home for your next chapter.</span><span className="footer-note">Book metadata and covers: <a href="https://openlibrary.org/">Open Library</a></span></footer>
  </div>;
}
