import { DEFAULT_AVATAR_HOSTS, parseAvatarHosts } from './avatarUrl.js';

export function avatarHostsFromEnv(value) {
  try {
    return parseAvatarHosts(value);
  } catch (error) {
    console.error('Invalid VITE_AVATAR_ALLOWED_HOSTS; using the default avatar hosts.', error);
    return [...DEFAULT_AVATAR_HOSTS];
  }
}

// Kept in sync with the API AVATAR_ALLOWED_HOSTS value. See the root README.
export const allowedAvatarHosts = avatarHostsFromEnv(import.meta.env?.VITE_AVATAR_ALLOWED_HOSTS);
