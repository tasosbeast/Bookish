import { Router } from 'express';
import * as controller from '../controllers/feed.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { feedQuerySchema } from '../validators/index.js';

export const feedRouter = Router();
feedRouter.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
feedRouter.use(requireAuth);
feedRouter.get('/', validate(feedQuerySchema), controller.list);
