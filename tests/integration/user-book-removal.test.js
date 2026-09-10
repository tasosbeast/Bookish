import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';

test('PostgreSQL: removing a shelf is isolated, review-safe and refreshes ratings',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
    const tag = randomUUID().replaceAll('-', '').slice(0, 10), userIds = [], bookIds = [];
    t.after(async () => {
      await prisma.book.deleteMany({ where: { id: { in: bookIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.$disconnect();
    });
    const signup = async suffix => {
      const response = await request(app).post('/api/auth/signup').set('X-Bookish-CSRF', '1').send({
        username: `remove${tag}${suffix}`, email: `remove${tag}${suffix}@example.com`, password: 'removal fixture password',
      }).expect(201);
      userIds.push(response.body.user.id);
      return { token: response.body.accessToken, userId: response.body.user.id };
    };
    const [first, second, outsider] = await Promise.all(['a', 'b', 'c'].map(signup));
    const book = await prisma.book.create({ data: { title: `Removal ${tag}`, author: 'Fixture author' } });
    const unratedBook = await prisma.book.create({ data: { title: `Unrated removal ${tag}`, author: 'Fixture author' } });
    bookIds.push(book.id, unratedBook.id);
    const auth = (token, method, path) => request(app)[method](path).auth(token, { type: 'bearer' });
    const save = (token, body) => auth(token, 'post', '/api/user-books').send({ bookId: book.id, ...body });
    await save(first.token, { status: 'read', userRating: 5 }).expect(200);
    await save(second.token, { status: 'want_to_read', userRating: 3 }).expect(200);
    await auth(first.token, 'post', '/api/user-books').send({ bookId: unratedBook.id, status: 'want_to_read' }).expect(200);

    await t.test('successfully removes the current reader shelf and keeps the book', async () => {
      const response = await auth(first.token, 'delete', `/api/user-books/${unratedBook.id}`).expect(200);
      assert.deepEqual(response.body, { data: { bookId: unratedBook.id, removed: true } });
      assert.equal(await prisma.userBook.findUnique({ where: { userId_bookId: { userId: first.userId, bookId: unratedBook.id } } }), null);
      assert.ok(await prisma.book.findUnique({ where: { id: unratedBook.id } }));
    });

    await t.test('removing a rating recomputes the affected book aggregate', async () => {
      await auth(first.token, 'delete', `/api/user-books/${book.id}`).expect(200);
      const updated = await prisma.book.findUnique({ where: { id: book.id } });
      assert.equal(Number(updated.averageRating), 3); assert.equal(updated.ratingsCount, 1);
    });

    await t.test('a reader cannot remove another reader shelf', async () => {
      const response = await auth(outsider.token, 'delete', `/api/user-books/${book.id}`).expect(404);
      assert.equal(response.body.error.code, 'SHELF_NOT_FOUND');
      assert.equal((await prisma.userBook.findUnique({ where: { userId_bookId: { userId: second.userId, bookId: book.id } } })).userRating, 3);
    });

    await t.test('an existing review blocks removal without changing data', async () => {
      await auth(first.token, 'post', '/api/reviews').send({ bookId: book.id, rating: 4, reviewText: 'Keep this review' }).expect(200);
      const before = await prisma.book.findUnique({ where: { id: book.id } });
      const response = await auth(first.token, 'delete', `/api/user-books/${book.id}`).expect(409);
      assert.equal(response.body.error.code, 'REVIEW_BLOCKS_SHELF_REMOVAL');
      assert.match(response.body.error.message, /review/i);
      assert.ok(await prisma.userBook.findUnique({ where: { userId_bookId: { userId: first.userId, bookId: book.id } } }));
      assert.ok(await prisma.review.findUnique({ where: { userId_bookId: { userId: first.userId, bookId: book.id } } }));
      assert.deepEqual(await prisma.book.findUnique({ where: { id: book.id } }), before);
    });

    await t.test('a transaction failure during cascade removal rolls back both deletions', async () => {
      const failingBook = await prisma.book.create({ data: { title: `Fail ${tag}`, author: 'Fail author' } });
      bookIds.push(failingBook.id);
      await auth(first.token, 'post', '/api/user-books').send({ bookId: failingBook.id, status: 'want_to_read' }).expect(200);
      await auth(first.token, 'post', '/api/reviews').send({ bookId: failingBook.id, rating: 4, reviewText: 'Keep this review' }).expect(200);

      const originalTransaction = prisma.$transaction;
      let deleteCalled = false;
      prisma.$transaction = async (work, options) => {
        return originalTransaction.bind(prisma)(async tx => {
          const originalDelete = tx.userBook.delete;
          tx.userBook.delete = async (args) => {
            deleteCalled = true;
            throw new Error('Simulated transaction failure');
          };
          return work(tx);
        }, options);
      };

      try {
        await auth(first.token, 'delete', `/api/user-books/${failingBook.id}?deleteReview=true`).expect(500);
      } finally {
        prisma.$transaction = originalTransaction;
      }

      assert.ok(deleteCalled);
      assert.ok(await prisma.userBook.findUnique({ where: { userId_bookId: { userId: first.userId, bookId: failingBook.id } } }));
      assert.ok(await prisma.review.findUnique({ where: { userId_bookId: { userId: first.userId, bookId: failingBook.id } } }));
    });

    await t.test('adding deleteReview=true removes both review and shelf and updates aggregates', async () => {
      const response = await auth(first.token, 'delete', `/api/user-books/${book.id}?deleteReview=true`).expect(200);
      assert.deepEqual(response.body, { data: { bookId: book.id, removed: true } });
      assert.equal(await prisma.userBook.findUnique({ where: { userId_bookId: { userId: first.userId, bookId: book.id } } }), null);
      assert.equal(await prisma.review.findUnique({ where: { userId_bookId: { userId: first.userId, bookId: book.id } } }), null);
      const updated = await prisma.book.findUnique({ where: { id: book.id } });
      assert.equal(Number(updated.averageRating), 3); // since second user had rating 3
      assert.equal(updated.ratingsCount, 1);
    });

    await t.test('GET /api/user-books/:bookId rejects deleteReview parameter', async () => {
      await auth(second.token, 'get', `/api/user-books/${book.id}?deleteReview=true`).expect(400);
      await auth(second.token, 'get', `/api/user-books/${book.id}`).expect(200);
    });
  });
