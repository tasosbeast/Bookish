import { Router } from 'express';
import * as controller from '../controllers/notifications.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { notificationsQuerySchema, notificationIdSchema, readAllNotificationsSchema } from '../validators/index.js';

export const notificationsRouter = Router();
notificationsRouter.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
notificationsRouter.use(requireAuth);
notificationsRouter.get('/', validate(notificationsQuerySchema), controller.list);
notificationsRouter.put('/read-all', validate(readAllNotificationsSchema), controller.markAllRead);
notificationsRouter.put('/:id/read', validate(notificationIdSchema), controller.markRead);
