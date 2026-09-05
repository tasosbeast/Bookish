import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { env } from './config/env.js';
import { AppError } from './lib/errors.js';
import { errorHandler } from './middleware/error-handler.js';
import { authRouter } from './routes/auth.js';
import { booksRouter } from './routes/books.js';
import { userBooksRouter } from './routes/user-books.js';
import { reviewsRouter } from './routes/reviews.js';

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', env.TRUST_PROXY_HOPS);
app.use((req, res, next) => { req.id = randomUUID(); res.set('X-Request-ID', req.id); next(); });
app.use(helmet());
app.use(cors({ origin: env.CLIENT_ORIGIN, credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization', 'X-Bookish-CSRF'] }));
app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests; try again later' } } }));
app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api/auth', authRouter);
app.use('/api/books', booksRouter);
app.use('/api/user-books', userBooksRouter);
app.use('/api/reviews', reviewsRouter);
app.use((req, res, next) => next(new AppError(404, 'NOT_FOUND', 'Route not found')));
app.use(errorHandler);
