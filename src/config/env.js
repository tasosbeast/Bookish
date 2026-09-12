import 'dotenv/config';
import { z } from 'zod';

export function parseEnv(source) {
  const config = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.string().url(),
    JWT_ACCESS_SECRET: z.string().min(48),
    JWT_REFRESH_SECRET: z.string().min(48),
    CLIENT_ORIGIN: z.string().url().default('http://localhost:5173'),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  }).refine(v => v.JWT_ACCESS_SECRET !== v.JWT_REFRESH_SECRET, {
    message: 'Access and refresh secrets must differ', path: ['JWT_REFRESH_SECRET'],
  }).parse(source);
  if (new URL(config.CLIENT_ORIGIN).origin !== config.CLIENT_ORIGIN) {
    throw new Error('CLIENT_ORIGIN must be an origin without a path or trailing slash');
  }
  if (config.NODE_ENV === 'production') {
    if (!source.CLIENT_ORIGIN) throw new Error('CLIENT_ORIGIN is required in production');
    if (new URL(config.CLIENT_ORIGIN).protocol !== 'https:') throw new Error('CLIENT_ORIGIN must use HTTPS in production');
  }
  return config;
}

export const env = parseEnv(process.env);

let warnedVapid = false;

// VAPID configuration is optional; missing vars disable push without crashing unrelated features.
export function parseVapid(source = process.env) {
  if (!source.VAPID_PUBLIC_KEY || !source.VAPID_PRIVATE_KEY || !source.VAPID_SUBJECT) {
    if (!warnedVapid && source.NODE_ENV !== 'test') {
      warnedVapid = true;
      console.warn('[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT not set — Web Push is disabled');
    }
    return null;
  }
  return {
    publicKey: source.VAPID_PUBLIC_KEY,
    privateKey: source.VAPID_PRIVATE_KEY,
    subject: source.VAPID_SUBJECT,
  };
}

export const vapid = parseVapid(process.env);
