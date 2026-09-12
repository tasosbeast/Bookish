import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';

export async function listNotifications(userId, { limit = 10 }) {
  const unreadCount = await prisma.notification.count({
    where: { recipientId: userId, readAt: null },
  });

  const notifications = await prisma.notification.findMany({
    where: { recipientId: userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      type: true,
      readAt: true,
      createdAt: true,
      friendshipId: true,
      actor: {
        select: {
          id: true,
          username: true,
          profilePicture: true,
        },
      },
      review: {
        select: {
          id: true,
          bookId: true,
          book: {
            select: {
              title: true,
            },
          },
        },
      },
    },
  });

  return { data: notifications, unreadCount };
}

export async function markNotificationRead(userId, notificationId) {
  const notification = await prisma.notification.findFirst({
    where: { id: notificationId, recipientId: userId },
  });

  if (!notification) {
    throw new AppError(404, 'NOTIFICATION_NOT_FOUND', 'Notification not found');
  }

  if (notification.readAt === null) {
    const updated = await prisma.notification.update({
      where: { id: notificationId },
      data: { readAt: new Date() },
    });
    return { id: updated.id, readAt: updated.readAt };
  }

  return { id: notification.id, readAt: notification.readAt };
}

export async function markAllNotificationsRead(userId) {
  const result = await prisma.notification.updateMany({
    where: { recipientId: userId, readAt: null },
    data: { readAt: new Date() },
  });

  return { updatedCount: result.count };
}
