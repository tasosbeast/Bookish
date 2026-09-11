import * as auth from '../services/auth.js';
import { ACCESS_SECONDS } from '../services/tokens.js';
import { env } from '../config/env.js';

const isProd = env.NODE_ENV === 'production';
const cookieName = 'bookish_refresh';
const cookieOptions = { httpOnly: true, secure: isProd, sameSite: isProd ? 'none' : 'strict', path: '/api/auth' };
function respond(res, result, status = 200) {
  res.cookie(cookieName, result.refreshToken, { ...cookieOptions, expires: result.expiresAt });
  return res.status(status).json({ accessToken: result.accessToken, tokenType: 'Bearer', expiresIn: ACCESS_SECONDS,
    ...(result.user && { user: result.user }) });
}
export async function signup(req, res) { respond(res, await auth.signup(req.validated.body), 201); }
export async function login(req, res) { respond(res, await auth.login(req.validated.body)); }
export async function me(req, res) { res.json({ user: await auth.currentUser(req.auth.userId) }); }
export async function updateProfile(req, res) { res.json({ user: await auth.updateProfile(req.auth.userId, req.validated.body) }); }
export async function refresh(req, res) {
  try { respond(res, await auth.refresh(req.cookies[cookieName])); }
  catch (error) {
    if (error.status === 401) res.clearCookie(cookieName, cookieOptions);
    throw error;
  }
}
export async function logout(req, res) {
  await auth.logout(req.cookies[cookieName]);
  res.clearCookie(cookieName, cookieOptions).status(204).end();
}
