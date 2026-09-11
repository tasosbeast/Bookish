import { Router } from 'express';
import * as controller from '../controllers/genres.js';

export const genresRouter = Router();
genresRouter.get('/', controller.list);
