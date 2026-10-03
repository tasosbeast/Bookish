// Profile pictures are loaded in other readers' browsers. Only HTTPS URLs on
// hosts the picture owner cannot use as a tracking pixel are accepted.
// Each allowlist entry also matches its subdomains.

export const DEFAULT_AVATAR_HOSTS = ['gravatar.com', 'googleusercontent.com'];

// Gravatar follows `d` / `default` to an arbitrary URL when it is not one of
// these built-in keywords, which would reveal the viewer's IP.
const GRAVATAR_DEFAULTS = new Set(['404', 'mp', 'identicon', 'monsterid', 'wavatar', 'retro', 'robohash', 'blank']);

const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function parseAvatarHosts(value) {
  if (value == null || String(value).trim() === '') return [...DEFAULT_AVATAR_HOSTS];
  const hosts = String(value).split(',').map(host => host.trim().toLowerCase()).filter(Boolean);
  if (hosts.length === 0) return [...DEFAULT_AVATAR_HOSTS];
  for (const host of hosts) {
    if (host.length > 253 || !HOSTNAME.test(host)) {
      throw new Error(`AVATAR_ALLOWED_HOSTS entry is not a valid hostname: ${host}`);
    }
  }
  return [...new Set(hosts)];
}

function hostAllowed(hostname, allowedHosts) {
  return allowedHosts.some(allowed => hostname === allowed || hostname.endsWith(`.${allowed}`));
}

function gravatarDefaultsAreSafe(url) {
  const host = url.hostname;
  if (host !== 'gravatar.com' && !host.endsWith('.gravatar.com')) return true;
  for (const [key, value] of url.searchParams) {
    const name = key.toLowerCase();
    if (name !== 'd' && name !== 'default') continue;
    if (!GRAVATAR_DEFAULTS.has(value.toLowerCase())) return false;
  }
  return true;
}

export function isAllowedAvatarUrl(value, allowedHosts = DEFAULT_AVATAR_HOSTS) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  if (/[\u0000-\u0020\\]/.test(value)) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (url.port) return false;
  const hostname = url.hostname;
  if (!hostname || hostname.includes(':') || hostname.endsWith('.')) return false;
  if (!hostAllowed(hostname, allowedHosts)) return false;
  return gravatarDefaultsAreSafe(url);
}
