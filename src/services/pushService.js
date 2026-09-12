import webpush from 'web-push';
import { prisma } from '../lib/prisma.js';
import { parseVapid } from '../config/env.js';

let configuredKey = null;

function ensureVapidConfigured() {
  const current = parseVapid(process.env);
  if (!current) return null;
  if (configuredKey !== current.publicKey) {
    webpush.setVapidDetails(current.subject, current.publicKey, current.privateKey);
    configuredKey = current.publicKey;
  }
  return current;
}

/**
 * Upsert a push subscription for the current user.
 * If the endpoint already belongs to another user, reassign it to this user.
 */
export async function saveSubscription(userId, { endpoint, p256dh, auth }) {
  await prisma.pushSubscription.upsert({
    where: { endpoint },
    update: { userId, p256dh, auth },
    create: { userId, endpoint, p256dh, auth },
  });
}

/**
 * Delete a push subscription that belongs to the current user.
 * Returns true if deleted, false if not found / not owned.
 */
export async function removeSubscription(userId, endpoint) {
  const deleted = await prisma.pushSubscription.deleteMany({
    where: { userId, endpoint },
  });
  return deleted.count > 0;
}

/**
 * Send a best-effort friend-request push to all of the target user's subscriptions.
 * Never throws — failures are logged but must not affect the caller.
 */
export async function sendFriendRequestPush(actorUsername, targetUserId, friendshipId, sender = webpush) {
  const vapid = ensureVapidConfigured();
  if (!vapid) return; // Push not configured.

  let subscriptions;
  try {
    subscriptions = await prisma.pushSubscription.findMany({
      where: { userId: targetUserId },
    });
  } catch (err) {
    console.warn('[push] Failed to fetch subscriptions for push:', err.message);
    return;
  }

  if (!subscriptions.length) return;

  const payload = JSON.stringify({
    title: 'Bookish',
    body: `${actorUsername} sent you a friend request`,
    url: '/friends?tab=requests',
    tag: `friend-request-${friendshipId}`,
  });

  await Promise.all(subscriptions.map(async sub => {
    try {
      await sender.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
      );
    } catch (err) {
      const status = err.statusCode ?? err.status;
      if (status === 404 || status === 410) {
        // Expired / gone subscription — clean it up.
        await prisma.pushSubscription.deleteMany({ where: { endpoint: sub.endpoint } }).catch(() => {});
      } else {
        console.warn(`[push] Delivery failed for subscription ${sub.id}: ${err.message}`);
      }
    }
  }));
}
