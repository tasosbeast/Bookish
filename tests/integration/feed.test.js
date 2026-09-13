import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import { signTokens, digest } from '../../src/services/tokens.js';
import { saveShelf, removeShelf, saveReview, removeReview } from '../../src/services/ratings.js';
import { canonicalPair } from '../../src/services/friendshipService.js';

test('PostgreSQL: Feed v1 lifecycle, event semantics, friendship privacy, cursor pagination, and serialization',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
    const tag = randomUUID().replaceAll('-', '').slice(0, 10);
    const userIds = [];
    const bookIds = [];

    t.after(async () => {
      if (userIds.length) {
        await prisma.activity.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.friendship.deleteMany({
          where: {
            OR: [
              { userAId: { in: userIds } },
              { userBId: { in: userIds } },
            ],
          },
        });
        await prisma.review.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.userBook.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.refreshSession.deleteMany({ where: { userId: { in: userIds } } });
      }
      if (bookIds.length) {
        await prisma.book.deleteMany({ where: { id: { in: bookIds } } });
      }
      if (userIds.length) {
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      }
      await prisma.$disconnect();
    });

    const signup = async suffix => {
      const user = await prisma.user.create({
        data: {
          username: `fd${tag}${suffix}`,
          email: `fd${tag}${suffix}@example.com`,
          passwordHash: 'feed-test-password-hash',
          bio: `Bio of ${suffix}`,
        },
      });
      userIds.push(user.id);
      const sessionId = randomUUID();
      const expiresAt = new Date(Date.now() + 86400000);
      const { accessToken } = signTokens(user.id, sessionId, expiresAt);
      await prisma.refreshSession.create({
        data: { id: sessionId, userId: user.id, expiresAt, tokenHash: digest(`dummy-${sessionId}`) },
      });
      return { token: accessToken, userId: user.id, username: user.username };
    };

    const createBook = async title => {
      const book = await prisma.book.create({
        data: {
          title: `${title} ${tag}`,
          author: `Author ${tag}`,
          isbn: `${Math.floor(1000000000000 + Math.random() * 9000000000000)}`.slice(0, 13),
        },
      });
      bookIds.push(book.id);
      return book;
    };

    const makeFriendship = async (u1, u2, status = 'accepted', acceptedAt = new Date()) => {
      const [userAId, userBId] = canonicalPair(u1.userId, u2.userId);
      return prisma.friendship.create({
        data: {
          userAId,
          userBId,
          requestedById: u1.userId,
          status,
          acceptedAt: status === 'accepted' ? acceptedAt : null,
        },
      });
    };

    const auth = (reader, method, path) => request(app)[method](path).auth(reader.token, { type: 'bearer' });

    // Create users: Alice, Bob, Charlie, Dana
    const [alice, bob, charlie, dana] = await Promise.all(['a', 'b', 'c', 'd'].map(signup));
    const [book1, book2, book3, book4, book5] = await Promise.all(['B1', 'B2', 'B3', 'B4', 'B5'].map(createBook));

    // 1. Auth required for /api/feed
    await request(app).get('/api/feed').expect(401);

    // 2. Cache-Control: no-store
    const cacheRes = await auth(alice, 'get', '/api/feed').expect(200);
    assert.match(cacheRes.headers['cache-control'] || '', /no-store/);

    // 3. User with no friends gets empty feed
    assert.deepEqual(cacheRes.body.data, []);
    assert.equal(cacheRes.body.meta.nextCursor, null);

    // ==========================================
    // Event Semantics: Activity Creation
    // ==========================================

    // Case 13: want_to_read creates NO activity
    await saveShelf(bob.userId, { bookId: book1.id, status: 'want_to_read' });
    const bobWantCount = await prisma.activity.count({ where: { userId: bob.userId } });
    assert.equal(bobWantCount, 0, 'want_to_read should create no activity');

    // Case 1: status -> currently_reading creates started_reading
    await saveShelf(bob.userId, { bookId: book1.id, status: 'currently_reading' });
    const bobStarted = await prisma.activity.findFirst({
      where: { userId: bob.userId, bookId: book1.id, type: 'started_reading' },
    });
    assert.ok(bobStarted, 'started_reading activity created');

    // Case 2: same currently_reading status twice creates no duplicate
    await saveShelf(bob.userId, { bookId: book1.id, status: 'currently_reading' });
    const bobStartedCount = await prisma.activity.count({
      where: { userId: bob.userId, bookId: book1.id, type: 'started_reading' },
    });
    assert.equal(bobStartedCount, 1, 'currently_reading repeated creates no duplicate');

    // Case 3: status -> read creates finished_reading
    await saveShelf(bob.userId, { bookId: book1.id, status: 'read' });
    const bobFinished = await prisma.activity.findFirst({
      where: { userId: bob.userId, bookId: book1.id, type: 'finished_reading' },
    });
    assert.ok(bobFinished, 'finished_reading activity created');

    // Case 4: same read status twice creates no duplicate
    await saveShelf(bob.userId, { bookId: book1.id, status: 'read' });
    const bobFinishedCount = await prisma.activity.count({
      where: { userId: bob.userId, bookId: book1.id, type: 'finished_reading' },
    });
    assert.equal(bobFinishedCount, 1, 'read repeated creates no duplicate');

    // Case 5: first standalone rating creates rated_book
    await saveShelf(bob.userId, { bookId: book2.id, userRating: 4 });
    const bobRated = await prisma.activity.findFirst({
      where: { userId: bob.userId, bookId: book2.id, type: 'rated_book' },
    });
    assert.ok(bobRated, 'rated_book activity created');
    assert.equal(bobRated.rating, 4);

    // Case 7: submitting identical rating again creates no duplicate
    await saveShelf(bob.userId, { bookId: book2.id, userRating: 4 });
    const bobRatedCount1 = await prisma.activity.count({
      where: { userId: bob.userId, bookId: book2.id, type: 'rated_book' },
    });
    assert.equal(bobRatedCount1, 1, 'identical rating creates no duplicate');

    // Case 6: changing standalone rating creates a new rated_book activity
    await saveShelf(bob.userId, { bookId: book2.id, userRating: 5 });
    const bobRatedCount2 = await prisma.activity.count({
      where: { userId: bob.userId, bookId: book2.id, type: 'rated_book' },
    });
    assert.equal(bobRatedCount2, 2, 'changing rating creates a new rated_book activity');

    // Case 8 & 9: new written review creates reviewed_book and does NOT create rated_book
    const bobActivityBeforeReview = await prisma.activity.count({ where: { userId: bob.userId, bookId: book3.id } });
    assert.equal(bobActivityBeforeReview, 0);

    const review = await saveReview(bob.userId, {
      bookId: book3.id,
      rating: 5,
      reviewText: 'Masterpiece of sci-fi!',
    });

    const bobReviewActivity = await prisma.activity.findFirst({
      where: { userId: bob.userId, bookId: book3.id, type: 'reviewed_book' },
    });
    assert.ok(bobReviewActivity, 'reviewed_book created');
    assert.equal(bobReviewActivity.rating, 5);
    assert.equal(bobReviewActivity.reviewId, review.id);

    const bobRatedOnReview = await prisma.activity.findFirst({
      where: { userId: bob.userId, bookId: book3.id, type: 'rated_book' },
    });
    assert.equal(bobRatedOnReview, null, 'saveReview does NOT create rated_book');

    // Case 10: review edit creates no new activity
    await saveReview(bob.userId, {
      bookId: book3.id,
      rating: 4,
      reviewText: 'Masterpiece of sci-fi! (Updated thoughts)',
    });
    const bobReviewCountAfterEdit = await prisma.activity.count({
      where: { userId: bob.userId, bookId: book3.id, type: 'reviewed_book' },
    });
    assert.equal(bobReviewCountAfterEdit, 1, 'review edit creates no duplicate activity');

    // Case 12: removing a book from shelf creates no activity
    const activityCountBeforeRemove = await prisma.activity.count({ where: { userId: bob.userId } });
    await removeShelf(bob.userId, book2.id);
    const activityCountAfterRemove = await prisma.activity.count({ where: { userId: bob.userId } });
    assert.equal(activityCountAfterRemove, activityCountBeforeRemove, 'removeShelf creates no activity');

    // ==========================================
    // Friendship Privacy Semantics
    // ==========================================

    // Alice and Bob become friends NOW
    const friendshipAcceptedAt = new Date();
    const friendship = await makeFriendship(alice, bob, 'accepted', friendshipAcceptedAt);

    // All existing Bob activities were created BEFORE friendshipAcceptedAt!
    // Case 18: pre-friendship activities do not appear
    const feed1 = await auth(alice, 'get', '/api/feed').expect(200);
    assert.equal(feed1.body.data.length, 0, 'Pre-friendship activities must not appear in feed');

    // Bob creates a new activity AFTER friendship was accepted
    // Manually ensure createdAt is at or after friendshipAcceptedAt
    const newActivityTime = new Date(friendshipAcceptedAt.getTime() + 1000);
    const freshReview = await saveReview(bob.userId, {
      bookId: book4.id,
      rating: 5,
      reviewText: 'Loved this post-friendship book!',
    });
    await prisma.activity.update({
      where: { reviewId: freshReview.id },
      data: { createdAt: newActivityTime },
    });

    // Also Alice creates an activity for herself on book5
    await saveShelf(alice.userId, { bookId: book5.id, status: 'currently_reading' });

    // Case 14 & 17: Bob's post-friendship activity appears in Alice's feed, but Alice's own activity does NOT
    const feed2 = await auth(alice, 'get', '/api/feed').expect(200);
    assert.equal(feed2.body.data.length, 1);
    assert.equal(feed2.body.data[0].book.id, book4.id);
    assert.equal(feed2.body.data[0].actor.id, bob.userId);
    assert.equal(feed2.body.data[0].actor.username, bob.username);
    assert.equal(feed2.body.data[0].type, 'reviewed_book');
    assert.equal(feed2.body.data[0].rating, 5);
    assert.equal(feed2.body.data[0].review.reviewText, 'Loved this post-friendship book!');

    // Case 25: No private fields exposed
    assert.equal(feed2.body.data[0].actor.email, undefined);
    assert.equal(feed2.body.data[0].actor.passwordHash, undefined);

    // Case 15: Pending friend does not appear
    // Charlie sends a request to Alice (pending)
    await makeFriendship(alice, charlie, 'pending');
    await saveShelf(charlie.userId, { bookId: book1.id, status: 'currently_reading' });
    const feed3 = await auth(alice, 'get', '/api/feed').expect(200);
    assert.equal(feed3.body.data.some(i => i.actor.id === charlie.userId), false, 'Pending friend must not appear');

    // Case 16: Non-friend does not appear
    await saveShelf(dana.userId, { bookId: book2.id, status: 'currently_reading' });
    const feed4 = await auth(alice, 'get', '/api/feed').expect(200);
    assert.equal(feed4.body.data.some(i => i.actor.id === dana.userId), false, 'Non-friend must not appear');

    // Case 11: Review deletion removes its reviewed_book activity
    await removeReview(bob.userId, freshReview.id);
    const bobFreshActivity = await prisma.activity.findFirst({
      where: { reviewId: freshReview.id },
    });
    assert.equal(bobFreshActivity, null, 'Activity deleted by review cascade');

    const feedAfterReviewDelete = await auth(alice, 'get', '/api/feed').expect(200);
    assert.equal(feedAfterReviewDelete.body.data.length, 0, 'Feed item disappeared after review deletion');

    // Case 19: Activity disappears from feed after friendship removal
    // Let Bob create an activity now
    await saveShelf(bob.userId, { bookId: book5.id, status: 'currently_reading' });
    const feedBeforeUnfriend = await auth(alice, 'get', '/api/feed').expect(200);
    assert.equal(feedBeforeUnfriend.body.data.length, 1);

    // Delete friendship between Alice and Bob
    await prisma.friendship.delete({ where: { id: friendship.id } });
    const feedAfterUnfriend = await auth(alice, 'get', '/api/feed').expect(200);
    assert.equal(feedAfterUnfriend.body.data.length, 0, 'Activity disappeared after unfriend');

    // ==========================================
    // Keyset / Cursor Pagination & Ordering
    // ==========================================

    // Accept friendship with Charlie for pagination tests
    const chFriendshipAcceptedAt = new Date(Date.now() - 60000);
    const [aliceCharlieA, aliceCharlieB] = canonicalPair(alice.userId, charlie.userId);
    await prisma.friendship.update({
      where: {
        userAId_userBId: { userAId: aliceCharlieA, userBId: aliceCharlieB },
      },
      data: {
        status: 'accepted',
        acceptedAt: chFriendshipAcceptedAt,
      },
    });

    // Clear any previous activities for Charlie so we have exactly 5
    await prisma.activity.deleteMany({ where: { userId: charlie.userId } });

    // Create 5 distinct activities for Charlie with distinct timestamps
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await prisma.activity.create({
        data: {
          userId: charlie.userId,
          bookId: book1.id,
          type: 'started_reading',
          createdAt: new Date(now + i * 1000),
        },
      });
    }

    // Query with limit=2
    const page1 = await auth(alice, 'get', '/api/feed?limit=2').expect(200);
    assert.equal(page1.body.data.length, 2);
    assert.ok(page1.body.meta.nextCursor, 'page1 has nextCursor');

    // Case 20: Newest-first ordering
    const d0 = new Date(page1.body.data[0].createdAt).getTime();
    const d1 = new Date(page1.body.data[1].createdAt).getTime();
    assert.ok(d0 >= d1, 'Activities sorted newest first');

    // Query page 2
    const page2 = await auth(alice, 'get', `/api/feed?limit=2&cursor=${encodeURIComponent(page1.body.meta.nextCursor)}`).expect(200);
    assert.equal(page2.body.data.length, 2);
    assert.ok(page2.body.meta.nextCursor, 'page2 has nextCursor');

    // Query page 3
    const page3 = await auth(alice, 'get', `/api/feed?limit=2&cursor=${encodeURIComponent(page2.body.meta.nextCursor)}`).expect(200);
    assert.equal(page3.body.data.length, 1);
    assert.equal(page3.body.meta.nextCursor, null, 'page3 is last page, nextCursor is null');

    // Case 21: Keyset pagination has no duplicates and no omissions across pages
    const allIds = [
      ...page1.body.data.map(i => i.id),
      ...page2.body.data.map(i => i.id),
      ...page3.body.data.map(i => i.id),
    ];
    assert.equal(allIds.length, 5);
    assert.equal(new Set(allIds).size, 5, 'No duplicate activity IDs across pages');

    // Case 22: Malformed cursor -> 400
    await auth(alice, 'get', '/api/feed?cursor=invalid-cursor-string').expect(400);
    await auth(alice, 'get', '/api/feed?cursor=12345').expect(400);

    // Case 23: Limit validation
    await auth(alice, 'get', '/api/feed?limit=0').expect(400);
    await auth(alice, 'get', '/api/feed?limit=51').expect(400);
    await auth(alice, 'get', '/api/feed?limit=abc').expect(400);
  }
);
