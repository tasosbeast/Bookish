import { Router } from 'express';
import * as controller from '../controllers/calendar.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { calendarQuerySchema } from '../validators/index.js';

export const calendarRouter = Router();
calendarRouter.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
calendarRouter.use(requireAuth);
calendarRouter.get('/', validate(calendarQuerySchema), controller.getCalendar);
