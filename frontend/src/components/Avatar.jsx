import { useEffect, useState } from 'react';
import { isAllowedAvatarUrl } from '../../../src/lib/avatarUrl.js';

export function Avatar({
  username,
  profilePicture,
  className = 'reader-avatar',
  placeholderClassName = 'reader-avatar-placeholder',
  alt,
}) {
  const [failed, setFailed] = useState(false);
  const src = typeof profilePicture === 'string' ? profilePicture.trim() : '';
  const showImage = src !== '' && isAllowedAvatarUrl(src) && !failed;

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (!showImage) {
    const initial = username ? String(username).slice(0, 1).toUpperCase() : '?';
    return <span className={placeholderClassName} aria-hidden="true">{initial}</span>;
  }

  return (
    <img
      className={className}
      src={src}
      alt={alt ?? (username ? `${username}'s avatar` : 'Reader avatar')}
      referrerPolicy="no-referrer"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
