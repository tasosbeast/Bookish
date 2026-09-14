import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import { signTokens, digest } from '../../src/services/tokens.js';
import { saveShelf, saveReview, removeShelf } from '../../src/services/ratings.js';
import { getUtcMonthBounds } from '../../src/services/challenges.js';

test('PostgreSQL: Reading Challenges v1 and Trophies API, event counting, month boundaries, and user isolation',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
    const tag = randomUUID().replaceAll('-', '').slice(0, 10);
    const userIds = [];
    const bookIds = [];

    t.after(async () => {
      if (userIds.length) {
        await prisma.activity.deleteMany({ where: { userId: { in: userIds } } });
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
          username: `ch${tag}${suffix}`,
          email: `ch${tag}${suffix}@example.com`,
          passwordHash: 'challenge-test-hash',
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

    const auth = (reader, method, path) => request(app)[method](path).auth(reader.token, { type: 'bearer' });

    const [userA, userB] = await Promise.all(['a', 'b'].map(signup));
    const [book1, book2, book3, book4, book5, book6] = await Promise.all(
      ['B1', 'B2', 'B3', 'B4', 'B5', 'B6'].map(createBook)
    );

    // ====================================================
    // Case 19: Challenge and Trophy endpoints require auth
    // ====================================================
    await request(app).get('/api/challenges/current').expect(401);
    await request(app).get('/api/challenges/trophies').expect(401);

    // Cache-Control: no-store
    const cacheRes = await auth(userA, 'get', '/api/challenges/current').expect(200);
    assert.match(cacheRes.headers['cache-control'] || '', /no-store/);

    const cacheTrophiesRes = await auth(userA, 'get', '/api/challenges/trophies').expect(200);
    assert.match(cacheTrophiesRes.headers['cache-control'] || '', /no-store/);

    // ====================================================
    // Case 1: Zero finished books -> progress 0, completed false
    // ====================================================
    assert.equal(cacheRes.body.data.progress, 0);
    assert.equal(cacheRes.body.data.completed, false);
    assert.equal(cacheRes.body.data.completedAt, null);
    assert.deepEqual(cacheRes.body.data.books, []);
    assert.equal(cacheRes.body.data.goal, 3);
    assert.ok(cacheRes.body.data.periodStart);
    assert.ok(cacheRes.body.data.periodEnd);
    const expectedCurrentBounds = getUtcMonthBounds();
    assert.equal(cacheRes.body.data.key, expectedCurrentBounds.key);
    assert.equal(cacheRes.body.data.title, expectedCurrentBounds.title);
    assert.match(cacheRes.body.data.title, /^[A-Z][a-z]+ \d{4} Reading Challenge$/);
    assert.equal(cacheTrophiesRes.body.data.length, 0);

    // ====================================================
    // Case 7, 8, 9: started_reading, rated_book, reviewed_book do NOT count
    // ====================================================
    await saveShelf(userA.userId, { bookId: book1.id, status: 'currently_reading' }); // started_reading
    await saveShelf(userA.userId, { bookId: book2.id, userRating: 4 }); // rated_book
    await saveReview(userA.userId, { bookId: book3.id, rating: 5, reviewText: 'Nice book' }); // reviewed_book

    const nonFinishedRes = await auth(userA, 'get', '/api/challenges/current').expect(200);
    assert.equal(nonFinishedRes.body.data.progress, 0, 'Non-finished activities must not count');
    const nonFinishedTrophies = await auth(userA, 'get', '/api/challenges/trophies').expect(200);
    assert.equal(nonFinishedTrophies.body.data.length, 0);

    // ====================================================
    // Case 2: One distinct finished book -> progress 1
    // ====================================================
    await saveShelf(userA.userId, { bookId: book1.id, status: 'read' });
    const oneBookRes = await auth(userA, 'get', '/api/challenges/current').expect(200);
    assert.equal(oneBookRes.body.data.progress, 1);
    assert.equal(oneBookRes.body.data.completed, false);
    assert.equal(oneBookRes.body.data.completedAt, null);
    assert.equal(oneBookRes.body.data.books.length, 1);
    assert.equal(oneBookRes.body.data.books[0].id, book1.id);
    assert.equal(oneBookRes.body.data.books[0].title, book1.title);
    assert.ok(oneBookRes.body.data.books[0].finishedAt);

    // ====================================================
    // Case 5: Same book finished twice in same month counts once
    // ====================================================
    await saveShelf(userA.userId, { bookId: book1.id, status: 'currently_reading' });
    await saveShelf(userA.userId, { bookId: book1.id, status: 'read' }); // second finished_reading for book1
    const repeatBookRes = await auth(userA, 'get', '/api/challenges/current').expect(200);
    assert.equal(repeatBookRes.body.data.progress, 1, 'Same book finished twice in same month counts once');
    assert.equal(repeatBookRes.body.data.books.length, 1);

    // ====================================================
    // Case 3 & 13: Three distinct finished books -> completed = true, completedAt is 3rd book timestamp
    // ====================================================
    // Add book2 and book3
    await saveShelf(userA.userId, { bookId: book2.id, status: 'read' });
    await saveShelf(userA.userId, { bookId: book3.id, status: 'read' });

    const threeBooksRes = await auth(userA, 'get', '/api/challenges/current').expect(200);
    assert.equal(threeBooksRes.body.data.progress, 3);
    assert.equal(threeBooksRes.body.data.completed, true);
    assert.ok(threeBooksRes.body.data.completedAt, 'completedAt is set when 3 distinct books are finished');
    assert.equal(threeBooksRes.body.data.books.length, 3);

    // Check chronological completedAt: the 3rd distinct book finish at UTC midnight
    const act3 = await prisma.activity.findFirst({
      where: { userId: userA.userId, bookId: book3.id, type: 'finished_reading' },
    });
    const expectedCompletedAt = `${act3.finishedOn.toISOString().slice(0, 10)}T00:00:00.000Z`;
    assert.equal(threeBooksRes.body.data.completedAt, expectedCompletedAt);

    // ====================================================
    // Case 4: Four/five books -> progress continues above goal, completedAt remains unchanged
    // ====================================================
    await saveShelf(userA.userId, { bookId: book4.id, status: 'read' });
    const fourBooksRes = await auth(userA, 'get', '/api/challenges/current').expect(200);
    assert.equal(fourBooksRes.body.data.progress, 4);
    assert.equal(fourBooksRes.body.data.completed, true);
    assert.equal(fourBooksRes.body.data.completedAt, expectedCompletedAt, 'completedAt remains 3rd book timestamp');
    assert.equal(fourBooksRes.body.data.books.length, 4);
    // Books sorted newest first
    assert.equal(fourBooksRes.body.data.books[0].id, book4.id);

    // ====================================================
    // Case 10: Finishing a book and later changing its shelf status does not remove it
    // ====================================================
    await saveShelf(userA.userId, { bookId: book4.id, status: 'currently_reading' });
    await removeShelf(userA.userId, book3.id);

    const shelfChangeRes = await auth(userA, 'get', '/api/challenges/current').expect(200);
    assert.equal(shelfChangeRes.body.data.progress, 4, 'Changing shelf status does not remove historical activity');

    // ====================================================
    // Case 18: No other user's activity influences progress
    // ====================================================
    await saveShelf(userB.userId, { bookId: book5.id, status: 'read' });
    const userARes = await auth(userA, 'get', '/api/challenges/current').expect(200);
    assert.equal(userARes.body.data.progress, 4);
    const userBRes = await auth(userB, 'get', '/api/challenges/current').expect(200);
    assert.equal(userBRes.body.data.progress, 1);

    // ====================================================
    // Case 20: No private user data exposed
    // ====================================================
    assert.equal(userARes.body.data.email, undefined);
    assert.equal(userARes.body.data.passwordHash, undefined);

    // ====================================================
    // Case 11 & 12: Month boundaries (UTC calendar month)
    // ====================================================
    const { periodStart, periodEnd } = getUtcMonthBounds();
    // Test that activity created exactly at periodStart belongs to current month
    const edgeStartAct = await prisma.activity.create({
      data: {
        userId: userB.userId,
        bookId: book1.id,
        type: 'finished_reading',
        createdAt: periodStart,
        finishedOn: periodStart,
      },
    });
    // Activity exactly at periodEnd belongs to next month (not current)
    const edgeEndAct = await prisma.activity.create({
      data: {
        userId: userB.userId,
        bookId: book2.id,
        type: 'finished_reading',
        createdAt: periodEnd,
        finishedOn: periodEnd,
      },
    });

    const userBEdgeRes = await auth(userB, 'get', '/api/challenges/current').expect(200);
    // userB had book5, and now book1 at periodStart (distinct books = 2)
    // book2 at periodEnd must NOT be in current month
    assert.equal(userBEdgeRes.body.data.progress, 2);
    assert.ok(userBEdgeRes.body.data.books.some(b => b.id === book1.id), 'Activity at periodStart counts in current month');
    assert.ok(!userBEdgeRes.body.data.books.some(b => b.id === book2.id), 'Activity at periodEnd does NOT count in current month');

    // Clean up edge acts
    await prisma.activity.deleteMany({ where: { id: { in: [edgeStartAct.id, edgeEndAct.id] } } });

    // ====================================================
    // Case 6, 14, 15, 16, 17: Trophies API
    // - Month with 2 distinct books has no trophy
    // - Month with >= 3 distinct books gets 1 trophy
    // - booksRead includes books beyond 3
    // - Same book in different months counts in each month
    // - Sorted newest month first
    // ====================================================
    // Let's create historical activities for userA in past months:
    // July 2026: 4 distinct books (book1, book2, book3, book4) -> Trophy with booksRead: 4
    const july1 = new Date('2026-07-05T10:00:00.000Z');
    const july2 = new Date('2026-07-10T10:00:00.000Z');
    const july3 = new Date('2026-07-15T12:00:00.000Z'); // 3rd book finished
    const july4 = new Date('2026-07-20T14:00:00.000Z');

    await prisma.activity.createMany({
      data: [
        { userId: userA.userId, bookId: book1.id, type: 'finished_reading', createdAt: july1, finishedOn: july1 },
        { userId: userA.userId, bookId: book2.id, type: 'finished_reading', createdAt: july2, finishedOn: july2 },
        { userId: userA.userId, bookId: book3.id, type: 'finished_reading', createdAt: july3, finishedOn: july3 },
        { userId: userA.userId, bookId: book4.id, type: 'finished_reading', createdAt: july4, finishedOn: july4 },
      ],
    });

    // August 2026: only 2 distinct books (book1, book5) -> NO trophy
    const aug1 = new Date('2026-08-05T10:00:00.000Z');
    const aug2 = new Date('2026-08-10T10:00:00.000Z');
    await prisma.activity.createMany({
      data: [
        { userId: userA.userId, bookId: book1.id, type: 'finished_reading', createdAt: aug1, finishedOn: aug1 },
        { userId: userA.userId, bookId: book5.id, type: 'finished_reading', createdAt: aug2, finishedOn: aug2 },
      ],
    });

    const trophiesRes = await auth(userA, 'get', '/api/challenges/trophies').expect(200);
    const trophies = trophiesRes.body.data;

    // userA has 4 books in current month (Sept 2026) + 4 books in July 2026
    // August 2026 had only 2 books -> omitted
    assert.equal(trophies.length, 2, 'Exactly 2 trophies earned (current month + July)');

    // Newest month first
    assert.ok(trophies[0].key > trophies[1].key, 'Trophies are sorted newest month first');

    const julyTrophy = trophies.find(t => t.key === '2026-07');
    assert.ok(julyTrophy, 'July trophy exists');
    assert.equal(julyTrophy.title, 'July 2026 Reading Challenge');
    assert.equal(julyTrophy.goal, 3);
    assert.equal(julyTrophy.booksRead, 4, 'booksRead includes all 4 distinct books finished in July');
    assert.equal(julyTrophy.completedAt, '2026-07-15T00:00:00.000Z', 'completedAt is timestamp of 3rd distinct book finish at UTC midnight');

    // August has NO trophy
    const augTrophy = trophies.find(t => t.key === '2026-08');
    assert.equal(augTrophy, undefined, 'August with only 2 books must not produce a trophy');
  }
);
