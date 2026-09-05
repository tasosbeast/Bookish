import { Router } from 'express';
import * as controller from '../controllers/reviews.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { reviewSchema, likeSchema } from '../validators/index.js';
export const reviewsRouter = Router();
reviewsRouter.use(requireAuth);
reviewsRouter.post('/', validate(reviewSchema), controller.save);
reviewsRouter.put('/:id/like', validate(likeSchema), controller.like);
reviewsRouter.delete('/:id/like', validate(likeSchema), controller.unlike);
reviewsRouter.all('/:id/like', validate(likeSchema), (req, res) => {
  res.set('Allow', 'PUT, DELETE').status(405).json({ error: {
    code: 'METHOD_NOT_ALLOWED', message: 'Use PUT to like or DELETE to unlike',
  } });
});
