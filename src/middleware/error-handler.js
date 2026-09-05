import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';

export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (error instanceof ZodError) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid input',
      details: error.issues.map(({ path, message }) => ({ field: path.join('.'), message })) } });
  }
  if (error instanceof AppError) {
    if (error.status === 503) res.set('Retry-After', '1');
    return res.status(error.status).json({ error: { code: error.code, message: error.message } });
  }
  const known = {
    P2002: [409, 'CONFLICT', 'Username, email, or record already exists'],
    P2003: [409, 'RELATION_CONFLICT', 'Related record no longer exists'],
    P2025: [404, 'NOT_FOUND', 'Record not found'],
  }[error.code];
  if (known) return res.status(known[0]).json({ error: { code: known[1], message: known[2] } });
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } });
  }
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'BODY_TOO_LARGE', message: 'Request body too large' } });
  }
  // Do not log headers, cookies, request bodies, or database query parameters.
  console.error({ requestId: req.id, type: error.name, code: error.code ?? 'UNEXPECTED' });
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', requestId: req.id } });
}
