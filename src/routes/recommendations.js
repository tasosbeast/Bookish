import { Router } from 'express';
import * as controller from '../controllers/recommendations.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { topPicksSchema } from '../validators/index.js';

export const recommendationsRouter = Router();
recommendationsRouter.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
recommendationsRouter.use(requireAuth);
recommendationsRouter.get('/top-picks', validate(topPicksSchema), controller.getTopPicks);
