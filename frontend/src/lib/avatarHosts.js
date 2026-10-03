import { parseAvatarHosts } from './avatarUrl.js';

// Kept in sync with the API AVATAR_ALLOWED_HOSTS value. See the root README.
export const allowedAvatarHosts = parseAvatarHosts(import.meta.env.VITE_AVATAR_ALLOWED_HOSTS);
