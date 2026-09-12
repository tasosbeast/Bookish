import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import { sendFriendRequestPush } from '../../src/services/pushService.js';

test('PostgreSQL: Web Push subscriptions and friend request push delivery',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
    const tag = randomUUID().replaceAll('-', '').slice(0, 10);
    const userIds = [];
    const endpoints = [];

    t.after(async () => {
      if (endpoints.length) {
        await prisma.pushSubscription.deleteMany({ where: { endpoint: { in: endpoints } } });
      }
      if (userIds.length) {
        await prisma.friendship.deleteMany({
          where: {
            OR: [
              { userAId: { in: userIds } },
              { userBId: { in: userIds } },
            ],
          },
        });
        await prisma.notification.deleteMany({ where: { recipientId: { in: userIds } } });
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      }
      await prisma.$disconnect();
    });

    const signup = async suffix => {
      const response = await request(app).post('/api/auth/signup').set('X-Bookish-CSRF', '1').send({
        username: `push${tag}${suffix}`,
        email: `push${tag}${suffix}@example.com`,
        password: 'push test password 1234',
      }).expect(201);
      userIds.push(response.body.user.id);
      return { token: response.body.accessToken, userId: response.body.user.id, username: response.body.user.username };
    };

    const auth = (reader, method, path) => request(app)[method](path).auth(reader.token, { type: 'bearer' });

    const [userA, userB] = await Promise.all(['a', 'b'].map(signup));

    const endpoint1 = `https://fcm.googleapis.com/fcm/send/${tag}-sub1`;
    const endpoint2 = `https://fcm.googleapis.com/fcm/send/${tag}-sub2`;
    endpoints.push(endpoint1, endpoint2);

    // 0. GET /api/push/public-key
    // Returns public key (or 503 if not configured)
    const keyRes = await request(app).get('/api/push/public-key');
    assert.ok(keyRes.status === 200 || keyRes.status === 503);
    assert.equal(keyRes.headers['cache-control'], 'no-store');

    // 1. Authenticated user can register a push subscription
    await request(app).post('/api/push/subscriptions').send({
      endpoint: endpoint1,
      keys: { p256dh: 'p256dh-key-1', auth: 'auth-key-1' },
    }).expect(401);

    await auth(userA, 'post', '/api/push/subscriptions').send({
      endpoint: endpoint1,
      keys: { p256dh: 'p256dh-key-1', auth: 'auth-key-1' },
    }).expect(201);

    const savedSub1 = await prisma.pushSubscription.findUnique({ where: { endpoint: endpoint1 } });
    assert.ok(savedSub1);
    assert.equal(savedSub1.userId, userA.userId);
    assert.equal(savedSub1.p256dh, 'p256dh-key-1');
    assert.equal(savedSub1.auth, 'auth-key-1');

    // 2. Same endpoint is idempotently updated
    await auth(userA, 'post', '/api/push/subscriptions').send({
      endpoint: endpoint1,
      keys: { p256dh: 'p256dh-updated', auth: 'auth-updated' },
    }).expect(201);

    const updatedSub1 = await prisma.pushSubscription.findUnique({ where: { endpoint: endpoint1 } });
    assert.equal(updatedSub1.id, savedSub1.id, 'Idempotent update preserves subscription ID');
    assert.equal(updatedSub1.p256dh, 'p256dh-updated');
    assert.equal(updatedSub1.auth, 'auth-updated');

    // 3. Same endpoint can be reassigned to current authenticated user (when browser switches accounts)
    await auth(userB, 'post', '/api/push/subscriptions').send({
      endpoint: endpoint1,
      keys: { p256dh: 'p256dh-userB', auth: 'auth-userB' },
    }).expect(201);

    const reassignedSub1 = await prisma.pushSubscription.findUnique({ where: { endpoint: endpoint1 } });
    assert.equal(reassignedSub1.userId, userB.userId, 'Reassigns endpoint to userB');
    assert.equal(reassignedSub1.p256dh, 'p256dh-userB');

    // 4. User cannot remove another user's subscription via endpoint ownership rules
    await auth(userA, 'delete', '/api/push/subscriptions').send({
      endpoint: endpoint1,
    }).expect(200);

    const stillExists = await prisma.pushSubscription.findUnique({ where: { endpoint: endpoint1 } });
    assert.ok(stillExists, 'Endpoint owned by User B was NOT deleted by User A');

    // 5. User can remove their own subscription
    await auth(userB, 'delete', '/api/push/subscriptions').send({
      endpoint: endpoint1,
    }).expect(200);

    const deletedSub = await prisma.pushSubscription.findUnique({ where: { endpoint: endpoint1 } });
    assert.equal(deletedSub, null, 'User B successfully removed their own subscription');

    // Also supports DELETE via query parameter
    await auth(userB, 'post', '/api/push/subscriptions').send({
      endpoint: endpoint2,
      keys: { p256dh: 'key2', auth: 'auth2' },
    }).expect(201);

    await auth(userB, 'delete', `/api/push/subscriptions?endpoint=${encodeURIComponent(endpoint2)}`).expect(200);
    const deletedByQuery = await prisma.pushSubscription.findUnique({ where: { endpoint: endpoint2 } });
    assert.equal(deletedByQuery, null, 'Subscription deleted via query param');

    // 6. Sending a friend request still creates the normal in-app friend_request notification
    // User A sends request to User B (who currently has NO push subscriptions)
    const reqRes = await auth(userA, 'post', '/api/friends/requests').send({ userId: userB.userId }).expect(201);
    const friendshipId = reqRes.body.data.id;

    const notifsB = await auth(userB, 'get', '/api/notifications').expect(200);
    assert.equal(notifsB.body.unreadCount, 1);
    assert.equal(notifsB.body.data.length, 1);
    assert.equal(notifsB.body.data[0].type, 'friend_request');
    assert.equal(notifsB.body.data[0].friendshipId, friendshipId);

    // 7. No subscription => friend request still succeeds (verified above, 201)

    // 8. Sending a friend request attempts push for recipient subscriptions with mock sender
    // Re-register endpoint for userB
    await auth(userB, 'post', '/api/push/subscriptions').send({
      endpoint: endpoint1,
      keys: { p256dh: 'keyB', auth: 'authB' },
    }).expect(201);

    const sentNotifications = [];
    const mockSender = {
      sendNotification: async (sub, payload) => {
        sentNotifications.push({ sub, payload: JSON.parse(payload) });
      },
    };

    await sendFriendRequestPush(userA.username, userB.userId, friendshipId, mockSender);
    assert.equal(sentNotifications.length, 1);
    assert.equal(sentNotifications[0].sub.endpoint, endpoint1);
    assert.equal(sentNotifications[0].payload.title, 'Bookish');
    assert.equal(sentNotifications[0].payload.body, `${userA.username} sent you a friend request`);
    assert.equal(sentNotifications[0].payload.url, '/friends?tab=requests');
    assert.equal(sentNotifications[0].payload.tag, `friend-request-${friendshipId}`);

    // 9. Push provider failure => friend request still succeeds, does not throw
    const errorSender = {
      sendNotification: async () => {
        const error = new Error('500 Internal Server Error from Push Service');
        error.statusCode = 500;
        throw error;
      },
    };

    await assert.doesNotReject(async () => {
      await sendFriendRequestPush(userA.username, userB.userId, friendshipId, errorSender);
    });
    const subStillThere = await prisma.pushSubscription.findUnique({ where: { endpoint: endpoint1 } });
    assert.ok(subStillThere, 'Transient push error (500) does not delete subscription');

    // 10. 404/410 push response removes stale subscription
    const expiredSender = {
      sendNotification: async () => {
        const error = new Error('410 Gone');
        error.statusCode = 410;
        throw error;
      },
    };

    await sendFriendRequestPush(userA.username, userB.userId, friendshipId, expiredSender);
    const cleanedUpSub = await prisma.pushSubscription.findUnique({ where: { endpoint: endpoint1 } });
    assert.equal(cleanedUpSub, null, 'Stale 410 subscription was automatically removed');
  });
