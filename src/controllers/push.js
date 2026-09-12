import { parseVapid } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import * as pushService from '../services/pushService.js';

export async function getPublicKey(req, res) {
  const vapid = parseVapid(process.env);
  if (!vapid) {
    throw new AppError(503, 'PUSH_UNAVAILABLE', 'Web push notifications are not configured');
  }
  res.json({ data: { publicKey: vapid.publicKey } });
}

export async function subscribe(req, res) {
  const { endpoint, keys } = req.validated.body;
  await pushService.saveSubscription(req.auth.userId, {
    endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
  });
  res.status(201).json({ data: { status: 'subscribed' } });
}

export async function unsubscribe(req, res) {
  const endpoint = req.validated.body?.endpoint || req.validated.query?.endpoint;
  await pushService.removeSubscription(req.auth.userId, endpoint);
  res.json({ data: { status: 'unsubscribed' } });
}

export async function status(req, res) {
  const { endpoint } = req.validated.body;
  const subscribed = await pushService.hasSubscription(req.auth.userId, endpoint);
  res.json({ data: { subscribed } });
}
