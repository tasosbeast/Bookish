import { Router } from 'express';
import * as controller from '../controllers/push.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  pushSubscriptionSchema,
  deletePushSubscriptionSchema,
  pushSubscriptionStatusSchema,
} from '../validators/index.js';

export const pushRouter = Router();
pushRouter.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

pushRouter.get('/public-key', controller.getPublicKey);
pushRouter.post('/subscriptions/status', requireAuth, validate(pushSubscriptionStatusSchema), controller.status);
pushRouter.post('/subscriptions', requireAuth, validate(pushSubscriptionSchema), controller.subscribe);
pushRouter.delete('/subscriptions', requireAuth, validate(deletePushSubscriptionSchema), controller.unsubscribe);
