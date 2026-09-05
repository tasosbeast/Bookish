import jwt from 'jsonwebtoken';
import { createHash, randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';

export const ACCESS_SECONDS = 15 * 60;
export const REFRESH_SECONDS = 7 * 24 * 60 * 60;
const common = { algorithm: 'HS256', issuer: 'bookish-api', audience: 'bookish-client' };
export const digest = token => createHash('sha256').update(token).digest('hex');

export function signTokens(userId, sessionId, expiresAt) {
  return {
    accessToken: jwt.sign({ type: 'access', sid: sessionId }, env.JWT_ACCESS_SECRET,
      { ...common, subject: userId, expiresIn: ACCESS_SECONDS, jwtid: randomUUID() }),
    refreshToken: jwt.sign({ type: 'refresh', sid: sessionId, exp: Math.floor(expiresAt.getTime() / 1000) },
      env.JWT_REFRESH_SECRET, { ...common, subject: userId, jwtid: randomUUID() }),
  };
}

export function verifyToken(token, type) {
  try {
    const payload = jwt.verify(token, type === 'access' ? env.JWT_ACCESS_SECRET : env.JWT_REFRESH_SECRET,
      { algorithms: ['HS256'], issuer: common.issuer, audience: common.audience });
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (payload.type !== type || !uuid.test(payload.sub) || !uuid.test(payload.sid) || !payload.jti || !payload.exp) throw new Error();
    return payload;
  } catch {
    throw new AppError(401, 'INVALID_TOKEN', 'Invalid or expired token');
  }
}
