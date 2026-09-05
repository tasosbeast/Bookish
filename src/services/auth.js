import bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';
import { digest, signTokens, verifyToken, REFRESH_SECONDS } from './tokens.js';

const safeUser = { id: true, username: true, email: true, profilePicture: true, bio: true };
export async function currentUser(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: safeUser });
  if (!user) throw new AppError(401, 'SESSION_EXPIRED', 'Session is no longer active');
  return user;
}
// Real cost-equivalent comparison for unknown accounts, without hashing on every failed request.
const dummyHash = await bcrypt.hash(randomUUID(), 12);

async function newSession(tx, userId) {
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + REFRESH_SECONDS * 1000);
  const tokens = signTokens(userId, id, expiresAt);
  await tx.refreshSession.create({ data: { id, userId, expiresAt, tokenHash: digest(tokens.refreshToken) } });
  return { ...tokens, expiresAt };
}

export async function signup(data) {
  const passwordHash = await bcrypt.hash(data.password, 12);
  return prisma.$transaction(async tx => {
    // Existing databases may contain mixed-case identities.
    const existing = await tx.user.findFirst({ where: { OR: [
      { email: { equals: data.email, mode: 'insensitive' } },
      { username: { equals: data.username, mode: 'insensitive' } },
    ] }, select: { id: true } });
    if (existing) throw new AppError(409, 'IDENTITY_EXISTS', 'Username or email is already registered');
    const user = await tx.user.create({ data: { username: data.username, email: data.email, passwordHash }, select: safeUser });
    return { user, ...await newSession(tx, user.id) };
  });
}

export async function login(data) {
  const user = await prisma.user.findFirst({ where: { email: { equals: data.email, mode: 'insensitive' } } });
  const valid = await bcrypt.compare(data.password, user?.passwordHash ?? dummyHash);
  if (!user || !valid) throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  const session = await newSession(prisma, user.id);
  return { user: Object.fromEntries(Object.keys(safeUser).map(key => [key, user[key]])), ...session };
}

export async function refresh(token) {
  const payload = verifyToken(token, 'refresh');
  // Return failures from the transaction so revocation is committed before throwing.
  const result = await prisma.$transaction(async tx => {
    const session = await tx.refreshSession.findUnique({ where: { id: payload.sid } });
    if (!session || session.userId !== payload.sub || session.revokedAt || session.expiresAt <= new Date()) return null;
    const tokens = signTokens(session.userId, session.id, session.expiresAt);
    const updated = await tx.refreshSession.updateMany({
      where: { id: session.id, tokenHash: digest(token), revokedAt: null, expiresAt: { gt: new Date() } },
      data: { tokenHash: digest(tokens.refreshToken) },
    });
    if (updated.count !== 1) {
      // Reuse of an old refresh token revokes this device's entire session.
      await tx.refreshSession.updateMany({ where: { id: session.id, revokedAt: null }, data: { revokedAt: new Date() } });
      return null;
    }
    return { ...tokens, expiresAt: session.expiresAt };
  });
  if (!result) throw new AppError(401, 'SESSION_EXPIRED', 'Session expired or refresh token reused; sign in again');
  return result;
}

export async function logout(token) {
  let payload;
  try { payload = verifyToken(token, 'refresh'); } catch { return; }
  await prisma.refreshSession.updateMany({ where: { id: payload.sid, userId: payload.sub, revokedAt: null }, data: { revokedAt: new Date() } });
}
