import { Router } from 'express';
import { save } from '../controllers/user-books.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { shelfSchema } from '../validators/index.js';
export const userBooksRouter = Router();
userBooksRouter.post('/', requireAuth, validate(shelfSchema), save);
