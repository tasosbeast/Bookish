import { Router } from 'express';
import * as controller from '../controllers/reviews.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { reviewSchema, likeSchema } from '../validators/index.js';
export const reviewsRouter = Router();
reviewsRouter.use(requireAuth);
reviewsRouter.post('/', validate(reviewSchema), controller.save);
reviewsRouter.post('/:id/like', validate(likeSchema), controller.like);
