import { useState } from 'react';
import { isAllowedAvatarUrl } from '../lib/avatarUrl.js';
import { allowedAvatarHosts } from '../lib/avatarHosts.js';

export function Avatar({
  username,
  profilePicture,
  className = 'reader-avatar',
  placeholderClassName = 'reader-avatar-placeholder',
  alt,
}) {
  const [failedSrc, setFailedSrc] = useState(null);
  const src = typeof profilePicture === 'string' ? profilePicture.trim() : '';
  const showImage = src !== '' && isAllowedAvatarUrl(src, allowedAvatarHosts) && failedSrc !== src;

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
      onError={() => setFailedSrc(src)}
    />
  );
}
