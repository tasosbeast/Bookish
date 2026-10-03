// Profile pictures are loaded in other readers' browsers. Only HTTPS URLs on
// hosts the picture owner cannot use as a tracking pixel are accepted.
// Entries match that exact host. A "*.example.com" entry matches subdomains only.

export const DEFAULT_AVATAR_HOSTS = [
  'gravatar.com',
  'www.gravatar.com',
  'secure.gravatar.com',
  's.gravatar.com',
  '0.gravatar.com',
  '1.gravatar.com',
  '2.gravatar.com',
  'lh3.googleusercontent.com',
  'lh4.googleusercontent.com',
  'lh5.googleusercontent.com',
  'lh6.googleusercontent.com',
];

// Gravatar follows `d` / `default` to an arbitrary URL when it is not one of
// these built-in keywords, which would reveal the viewer's IP.
const GRAVATAR_DEFAULTS = new Set([
  '404', 'mp', 'identicon', 'monsterid', 'wavatar', 'retro', 'robohash', 'blank', 'initials', 'color',
]);

// Second labels of well-known multi-part public suffixes (co.uk, com.au, ...).
const PUBLIC_SUFFIX_LABELS = new Set(['ac', 'co', 'com', 'edu', 'gob', 'gov', 'govt', 'ne', 'net', 'or', 'org', 'sch']);

const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const GRAVATAR_PATH = /^\/avatar\/(?:[a-f0-9]{32}|[a-f0-9]{64})(?:\.[a-z0-9]+)?$/i;

function isIpLiteral(hostname) {
  if (hostname.startsWith('[') || hostname.includes(':')) return true;
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

function isPublicSuffix(hostname) {
  const labels = hostname.split('.');
  return labels.length === 2 && labels[1].length === 2 && PUBLIC_SUFFIX_LABELS.has(labels[0]);
}

export function parseAvatarHosts(value) {
  if (value == null || String(value).trim() === '') return [...DEFAULT_AVATAR_HOSTS];
  const entries = String(value).split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean);
  if (entries.length === 0) return [...DEFAULT_AVATAR_HOSTS];
  const hosts = [];
  for (const entry of entries) {
    const wildcard = entry.startsWith('*.');
    const host = wildcard ? entry.slice(2) : entry;
    if (!host || host.includes('*') || host.length > 253 || !HOSTNAME.test(host)) {
      throw new Error(`AVATAR_ALLOWED_HOSTS entry is not a valid hostname: ${entry}`);
    }
    if (isIpLiteral(host) || isPublicSuffix(host)) {
      throw new Error(`AVATAR_ALLOWED_HOSTS entry is a public suffix or IP address: ${entry}`);
    }
    hosts.push(wildcard ? `*.${host}` : host);
  }
  return [...new Set(hosts)];
}

function hostAllowed(hostname, allowedHosts) {
  return allowedHosts.some(allowed => {
    if (allowed.startsWith('*.')) {
      const suffix = allowed.slice(2);
      return hostname.length > suffix.length + 1 && hostname.endsWith(`.${suffix}`);
    }
    return hostname === allowed;
  });
}

function isGravatarHost(hostname) {
  return hostname === 'gravatar.com' || hostname.endsWith('.gravatar.com');
}

function paramName(name) {
  let current = name;
  for (let i = 0; i < 2; i += 1) {
    if (!current.includes('%')) break;
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch {
      break;
    }
  }
  return current.toLowerCase();
}

function gravatarUrlIsSafe(url) {
  if (!isGravatarHost(url.hostname)) return true;
  if (!GRAVATAR_PATH.test(url.pathname)) return false;
  for (const [key, value] of url.searchParams) {
    const name = paramName(key);
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
  return gravatarUrlIsSafe(url);
}
