import { useState } from 'react';
import { useAuth } from '../hooks/useAuth.js';

export default function Account() {
  const { user } = useAuth();
  const [imageFailed, setImageFailed] = useState(false);
  const hasPicture = user.profilePicture && !imageFailed;
  return <div className="container account-page"><div className="page-heading"><p className="eyebrow">Your account</p><h1>Reader profile<span className="brand-dot">.</span></h1><p className="muted">The details Bookish uses to recognize you.</p></div>
    <section className="account-card" aria-labelledby="account-name"><div className="account-identity">{hasPicture ? <img className="account-avatar" src={user.profilePicture} alt={`${user.username}'s profile picture`} onError={() => setImageFailed(true)} /> : <span className="account-avatar" aria-hidden="true">{user.username.slice(0, 1).toUpperCase()}</span>}<div><h2 id="account-name">{user.username}</h2><p className="muted">{user.email}</p></div></div>
      {user.bio ? <div className="account-bio"><h3>About</h3><p>{user.bio}</p></div> : <p className="muted small">No bio added yet.</p>}</section>
  </div>;
}
