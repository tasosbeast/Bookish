import { Router } from 'express';
import { list, save, detail } from '../controllers/user-books.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { shelfSchema, shelvesQuerySchema, personalBookSchema } from '../validators/index.js';
export const userBooksRouter = Router();
userBooksRouter.get('/', requireAuth, validate(shelvesQuerySchema), list);
userBooksRouter.get('/:bookId', requireAuth, validate(personalBookSchema), detail);
userBooksRouter.post('/', requireAuth, validate(shelfSchema), save);
