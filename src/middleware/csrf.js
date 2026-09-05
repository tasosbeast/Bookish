import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';

// Non-simple header forces browser preflight. Only CLIENT_ORIGIN is allowed by CORS.
export function requireCsrf(req, res, next) {
  if (req.get('X-Bookish-CSRF') !== '1' || (req.get('Origin') && req.get('Origin') !== env.CLIENT_ORIGIN)) {
    throw new AppError(403, 'CSRF_REJECTED', 'Trusted origin and X-Bookish-CSRF: 1 header required');
  }
  next();
}
