import { Router } from 'express';
import * as controller from '../controllers/books.js';
import { validate } from '../middleware/validate.js';
import { optionalAuth } from '../middleware/auth.js';
import { booksSchema, bookSchema } from '../validators/index.js';
export const booksRouter = Router();
booksRouter.use(optionalAuth);
booksRouter.get('/', validate(booksSchema), controller.list);
booksRouter.get('/:id', validate(bookSchema), controller.detail);
