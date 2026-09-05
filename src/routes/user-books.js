import { Router } from 'express';
import { list, save } from '../controllers/user-books.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { shelfSchema, shelvesQuerySchema } from '../validators/index.js';
export const userBooksRouter = Router();
userBooksRouter.get('/', requireAuth, validate(shelvesQuerySchema), list);
userBooksRouter.post('/', requireAuth, validate(shelfSchema), save);
