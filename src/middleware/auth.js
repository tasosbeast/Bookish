import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../services/tokens.js';
import { AppError } from '../lib/errors.js';

export async function requireAuth(req, res, next) {
  const match = /^Bearer ([^\s]+)$/i.exec(req.get('Authorization') ?? '');
  if (!match) throw new AppError(401, 'AUTH_REQUIRED', 'A bearer access token is required');
  const payload = verifyToken(match[1], 'access');
  const session = await prisma.refreshSession.findUnique({ where: { id: payload.sid } });
  if (!session || session.userId !== payload.sub || session.revokedAt || session.expiresAt <= new Date()) {
    throw new AppError(401, 'SESSION_EXPIRED', 'Session is no longer active');
  }
  req.auth = { userId: payload.sub, sessionId: payload.sid };
  next();
}
