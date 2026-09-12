import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';

test('PostgreSQL: review like notifications lifecycle and isolation',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
    const tag = randomUUID().replaceAll('-', '').slice(0, 10), userIds = [], bookIds = [];
    t.after(async () => {
      await prisma.book.deleteMany({ where: { id: { in: bookIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.$disconnect();
    });

    const signup = async suffix => {
      const response = await request(app).post('/api/auth/signup').set('X-Bookish-CSRF', '1').send({
        username: `notif${tag}${suffix}`, email: `notif${tag}${suffix}@example.com`, password: 'notification test password',
      }).expect(201);
      userIds.push(response.body.user.id);
      return { token: response.body.accessToken, userId: response.body.user.id, username: response.body.user.username };
    };

    const [userA, userB] = await Promise.all(['a', 'b'].map(signup));
    const book = await prisma.book.create({ data: { title: `Notification Book ${tag}`, author: 'Test Author' } });
    bookIds.push(book.id);

    const auth = (reader, method, path) => request(app)[method](path).auth(reader.token, { type: 'bearer' });

    // User A writes a review
    await auth(userA, 'post', '/api/user-books').send({ bookId: book.id, status: 'read', userRating: 5 }).expect(200);
    const reviewRes = await auth(userA, 'post', '/api/reviews').send({ bookId: book.id, rating: 5, reviewText: 'Great book!' }).expect(200);
    const reviewId = reviewRes.body.data.id;

    // 1. Auth required for notifications endpoint
    await request(app).get('/api/notifications').expect(401);

    // 2. User A likes their own review -> No notification created
    await auth(userA, 'put', `/api/reviews/${reviewId}/like`).expect(200);
    const initialNotifs = await auth(userA, 'get', '/api/notifications').expect(200).expect('Cache-Control', 'no-store');
    assert.equal(initialNotifs.headers['cache-control'], 'no-store');
    assert.equal(initialNotifs.body.unreadCount, 0);
    assert.equal(initialNotifs.body.data.length, 0);

    // 3. User B likes User A's review -> User A gets review_like notification
    await auth(userB, 'put', `/api/reviews/${reviewId}/like`).expect(200);
    const notifsA = await auth(userA, 'get', '/api/notifications').expect(200);
    assert.equal(notifsA.body.unreadCount, 1);
    assert.equal(notifsA.body.data.length, 1);

    const notifItem = notifsA.body.data[0];
    assert.equal(notifItem.type, 'review_like');
    assert.equal(notifItem.readAt, null);
    assert.equal(notifItem.actor.username, userB.username);
    assert.equal(notifItem.review.id, reviewId);
    assert.equal(notifItem.review.book.title, book.title);

    // User B does NOT get a notification for their own action
    const notifsB = await auth(userB, 'get', '/api/notifications').expect(200);
    assert.equal(notifsB.body.unreadCount, 0);
    assert.equal(notifsB.body.data.length, 0);

    // 4. Idempotency: User B likes again -> No duplicate notification
    await auth(userB, 'put', `/api/reviews/${reviewId}/like`).expect(200);
    const notifsAIdempotent = await auth(userA, 'get', '/api/notifications').expect(200);
    assert.equal(notifsAIdempotent.body.unreadCount, 1);
    assert.equal(notifsAIdempotent.body.data.length, 1);

    // 5. User B cannot mark A's notification read
    await auth(userB, 'put', `/api/notifications/${notifItem.id}/read`).expect(404);

    // 6. User A marks their notification read
    const readRes = await auth(userA, 'put', `/api/notifications/${notifItem.id}/read`).expect(200);
    assert.ok(readRes.body.data.readAt);

    // Unread count is updated
    const notifsAAfterRead = await auth(userA, 'get', '/api/notifications').expect(200);
    assert.equal(notifsAAfterRead.body.unreadCount, 0);
    assert.ok(notifsAAfterRead.body.data[0].readAt);

    // Idempotent mark read
    await auth(userA, 'put', `/api/notifications/${notifItem.id}/read`).expect(200);

    // 7. Unlike removes the notification
    await auth(userB, 'delete', `/api/reviews/${reviewId}/like`).expect(200);
    const notifsAAfterUnlike = await auth(userA, 'get', '/api/notifications').expect(200);
    assert.equal(notifsAAfterUnlike.body.unreadCount, 0);
    assert.equal(notifsAAfterUnlike.body.data.length, 0);

    // Idempotent delete like
    await auth(userB, 'delete', `/api/reviews/${reviewId}/like`).expect(200);

    // 8. Re-like creates fresh notification and test read-all
    await auth(userB, 'put', `/api/reviews/${reviewId}/like`).expect(200);
    const freshNotifs = await auth(userA, 'get', '/api/notifications').expect(200);
    assert.equal(freshNotifs.body.unreadCount, 1);

    // Mark all as read
    const readAllRes = await auth(userA, 'put', '/api/notifications/read-all').expect(200);
    assert.equal(readAllRes.body.data.updatedCount, 1);

    const notifsAfterReadAll = await auth(userA, 'get', '/api/notifications').expect(200);
    assert.equal(notifsAfterReadAll.body.unreadCount, 0);

    // 9. Review deletion cascades notification rows
    const reviewToDeleteRes = await auth(userB, 'post', '/api/reviews').send({ bookId: book.id, rating: 4, reviewText: 'B review' }).expect(200);
    const bReviewId = reviewToDeleteRes.body.data.id;
    await auth(userA, 'put', `/api/reviews/${bReviewId}/like`).expect(200);
    
    // B has 1 notification
    const bNotifs = await auth(userB, 'get', '/api/notifications').expect(200);
    assert.equal(bNotifs.body.unreadCount, 1);

    // B deletes review
    await auth(userB, 'delete', `/api/reviews/${bReviewId}`).expect(200);
    const bNotifsAfterDelete = await auth(userB, 'get', '/api/notifications').expect(200);
    assert.equal(bNotifsAfterDelete.body.unreadCount, 0);
    assert.equal(bNotifsAfterDelete.body.data.length, 0);

    // 10. GET /api/books/:id reviewId query parameter effective page calculations and validation
    await request(app).get(`/api/books/${book.id}?reviewId=not-a-uuid`).expect(400);

    // Create a second book
    const book2 = await prisma.book.create({ data: { title: `Other Book ${tag}`, author: 'Other Author' } });
    bookIds.push(book2.id);
    const otherReviewRes = await auth(userB, 'post', '/api/reviews').send({ bookId: book2.id, rating: 5, reviewText: 'Other book review' }).expect(200);
    const otherReviewId = otherReviewRes.body.data.id;

    // reviewId for another book falls back to requested page safely
    const fallbackRes = await request(app).get(`/api/books/${book.id}?reviewId=${otherReviewId}`).expect(200);
    assert.equal(fallbackRes.body.data.reviews.pagination.page, 1);
    assert.equal(fallbackRes.body.data.reviews.data.some(r => r.id === otherReviewId), false);

    // Create 11 reviews for book2 so review on page 2 is calculated
    const reviewIdsBook2 = [otherReviewId];
    for (let i = 0; i < 11; i++) {
      const u = await signup(`bulk${i}`);
      const r = await prisma.review.create({
        data: {
          bookId: book2.id,
          userId: u.userId,
          rating: 4,
          reviewText: `Bulk review ${i}`,
          createdAt: new Date(Date.now() - (i + 1) * 1000),
        }
      });
      reviewIdsBook2.push(r.id);
    }

    const oldestReviewId = reviewIdsBook2[reviewIdsBook2.length - 1];
    // Request page 1 with reviewId pointing to oldest review (which falls on page 2 when limit=10)
    const page2Res = await request(app).get(`/api/books/${book2.id}?page=1&limit=10&reviewId=${oldestReviewId}`).expect(200);
    assert.equal(page2Res.body.data.reviews.pagination.page, 2);
    assert.ok(page2Res.body.data.reviews.data.some(r => r.id === oldestReviewId));

    // ==========================================
    // 11. Friend request notifications lifecycle
    // ==========================================
    const userC = await signup('c');
    const userD = await signup('d');

    // C sends friend request to D
    const reqRes = await auth(userC, 'post', '/api/friends/requests').send({ userId: userD.userId }).expect(201);
    const requestId = reqRes.body.data.id;

    // Recipient D receives friend_request notification
    const dNotifs = await auth(userD, 'get', '/api/notifications').expect(200);
    assert.equal(dNotifs.body.unreadCount, 1);
    assert.equal(dNotifs.body.data.length, 1);
    const friendReqNotif = dNotifs.body.data[0];
    assert.equal(friendReqNotif.type, 'friend_request');
    assert.equal(friendReqNotif.readAt, null);
    assert.equal(friendReqNotif.friendshipId, requestId);
    assert.equal(friendReqNotif.actor.id, userC.userId);
    assert.equal(friendReqNotif.actor.username, userC.username);
    assert.equal(friendReqNotif.review, null);

    // Sender C does NOT get a notification
    const cNotifs = await auth(userC, 'get', '/api/notifications').expect(200);
    assert.equal(cNotifs.body.unreadCount, 0);
    assert.equal(cNotifs.body.data.length, 0);

    // Recipient D marks the notification as read
    const markReadRes = await auth(userD, 'put', `/api/notifications/${friendReqNotif.id}/read`).expect(200);
    assert.ok(markReadRes.body.data.readAt);
    const dNotifsRead = await auth(userD, 'get', '/api/notifications').expect(200);
    assert.equal(dNotifsRead.body.unreadCount, 0);
    assert.ok(dNotifsRead.body.data[0].readAt);

    // Case: Sender cancels request -> notification is deleted (cascade)
    await auth(userC, 'delete', `/api/friends/requests/${requestId}`).expect(200);
    const dNotifsAfterCancel = await auth(userD, 'get', '/api/notifications').expect(200);
    assert.equal(dNotifsAfterCancel.body.unreadCount, 0);
    assert.equal(dNotifsAfterCancel.body.data.length, 0);

    // Case: Sender sends another request -> Recipient declines -> notification is deleted (cascade)
    const req2Res = await auth(userC, 'post', '/api/friends/requests').send({ userId: userD.userId }).expect(201);
    const requestId2 = req2Res.body.data.id;
    const dNotifs2 = await auth(userD, 'get', '/api/notifications').expect(200);
    assert.equal(dNotifs2.body.unreadCount, 1);
    assert.equal(dNotifs2.body.data[0].friendshipId, requestId2);

    // D declines
    await auth(userD, 'delete', `/api/friends/requests/${requestId2}`).expect(200);
    const dNotifsAfterDecline = await auth(userD, 'get', '/api/notifications').expect(200);
    assert.equal(dNotifsAfterDecline.body.unreadCount, 0);
    assert.equal(dNotifsAfterDecline.body.data.length, 0);

    // Case: Request is accepted -> notification is deleted
    // First, unfriend so they can send another request
    const userE = await signup('e');
    const req3Res = await auth(userC, 'post', '/api/friends/requests').send({ userId: userE.userId }).expect(201);
    const requestId3 = req3Res.body.data.id;
    const eNotifs = await auth(userE, 'get', '/api/notifications').expect(200);
    assert.equal(eNotifs.body.unreadCount, 1);
    assert.equal(eNotifs.body.data[0].type, 'friend_request');

    // E accepts request
    await auth(userE, 'post', `/api/friends/requests/${requestId3}/accept`).expect(200);
    const eNotifsAfterAccept = await auth(userE, 'get', '/api/notifications').expect(200);
    assert.equal(eNotifsAfterAccept.body.unreadCount, 0);
    assert.equal(eNotifsAfterAccept.body.data.length, 0);
  }
);

