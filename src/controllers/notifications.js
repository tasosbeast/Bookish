import * as notificationsService from '../services/notifications.js';

export async function list(req, res) {
  const result = await notificationsService.listNotifications(req.auth.userId, req.validated.query);
  res.json(result);
}

export async function markRead(req, res) {
  const data = await notificationsService.markNotificationRead(req.auth.userId, req.validated.params.id);
  res.json({ data });
}

export async function markAllRead(req, res) {
  const data = await notificationsService.markAllNotificationsRead(req.auth.userId);
  res.json({ data });
}
