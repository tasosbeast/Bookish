import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import * as controller from '../controllers/auth.js';
import { validate } from '../middleware/validate.js';
import { requireCsrf } from '../middleware/csrf.js';
import { signupSchema, loginSchema } from '../validators/index.js';

export const authRouter = Router();
const message = { error: { code: 'RATE_LIMITED', message: 'Too many attempts; try again later' } };
const credentialsLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message });
const sessionLimit = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, message });
authRouter.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
authRouter.post('/signup', credentialsLimit, requireCsrf, validate(signupSchema), controller.signup);
authRouter.post('/login', credentialsLimit, requireCsrf, validate(loginSchema), controller.login);
authRouter.post('/refresh', sessionLimit, requireCsrf, controller.refresh);
authRouter.post('/logout', sessionLimit, requireCsrf, controller.logout);
