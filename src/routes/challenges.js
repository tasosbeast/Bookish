import { Router } from 'express';
import * as controller from '../controllers/challenges.js';
import { requireAuth } from '../middleware/auth.js';

export const challengesRouter = Router();
challengesRouter.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
challengesRouter.use(requireAuth);
challengesRouter.get('/current', controller.getCurrent);
challengesRouter.get('/trophies', controller.getTrophies);
