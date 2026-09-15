import { Router } from 'express';
import * as controller from '../controllers/releases.js';
import { validate } from '../middleware/validate.js';
import { releasesSchema } from '../validators/index.js';

export const releasesRouter = Router();
releasesRouter.get('/', validate(releasesSchema), controller.list);
