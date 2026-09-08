import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';

test('PostgreSQL: review deletion is owner-only and preserves canonical ratings',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
    const tag = randomUUID().replaceAll('-', '').slice(0, 10), userIds = [], bookIds = [];
    t.after(async () => {
      await prisma.book.deleteMany({ where: { id: { in: bookIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.$disconnect();
    });
    const signup = async suffix => {
      const response = await request(app).post('/api/auth/signup').set('X-Bookish-CSRF', '1').send({
        username: `reviewdel${tag}${suffix}`, email: `reviewdel${tag}${suffix}@example.com`, password: 'review removal fixture',
      }).expect(201);
      userIds.push(response.body.user.id);
      return { token: response.body.accessToken, userId: response.body.user.id };
    };
    const [owner, other] = await Promise.all(['a', 'b'].map(signup));
    const book = await prisma.book.create({ data: { title: `Review removal ${tag}`, author: 'Fixture author' } });
    bookIds.push(book.id);
    const auth = (reader, method, path) => request(app)[method](path).auth(reader.token, { type: 'bearer' });
    await auth(owner, 'post', '/api/user-books').send({ bookId: book.id, status: 'read', userRating: 5 }).expect(200);
    const reviewResponse = await auth(owner, 'post', '/api/reviews').send({ bookId: book.id, rating: 5, reviewText: 'Delete these words only' }).expect(200);
    const reviewId = reviewResponse.body.data.id;
    await auth(other, 'post', '/api/user-books').send({ bookId: book.id, status: 'currently_reading', userRating: 3 }).expect(200);
    await auth(owner, 'put', `/api/reviews/${reviewId}/like`).expect(200);
    await auth(other, 'put', `/api/reviews/${reviewId}/like`).expect(200);
    const shelfBefore = await prisma.userBook.findUnique({ where: { userId_bookId: { userId: owner.userId, bookId: book.id } } });
    const bookBefore = await prisma.book.findUnique({ where: { id: book.id } });
    assert.equal(await prisma.reviewLike.count({ where: { reviewId } }), 2);

    await t.test('another reader receives not found and cannot delete the review', async () => {
      const response = await auth(other, 'delete', `/api/reviews/${reviewId}`).expect(404);
      assert.equal(response.body.error.code, 'REVIEW_NOT_FOUND');
      assert.ok(await prisma.review.findUnique({ where: { id: reviewId } }));
      assert.equal(await prisma.reviewLike.count({ where: { reviewId } }), 2);
    });

    await t.test('the owner deletes only the review and its likes', async () => {
      const response = await auth(owner, 'delete', `/api/reviews/${reviewId}`).expect(200);
      assert.deepEqual(response.body, { data: { reviewId, deleted: true } });
      assert.equal(await prisma.review.findUnique({ where: { id: reviewId } }), null);
      assert.equal(await prisma.reviewLike.count({ where: { reviewId } }), 0);
    });

    await t.test('shelf, user rating and book aggregate remain unchanged', async () => {
      assert.deepEqual(await prisma.userBook.findUnique({ where: { userId_bookId: { userId: owner.userId, bookId: book.id } } }), shelfBefore);
      assert.deepEqual(await prisma.book.findUnique({ where: { id: book.id } }), bookBefore);
      assert.equal(shelfBefore.userRating, 5);
      assert.equal(Number(bookBefore.averageRating), 4); assert.equal(bookBefore.ratingsCount, 2);
    });

    await t.test('deleting the now-missing review returns the domain not-found response', async () => {
      const response = await auth(owner, 'delete', `/api/reviews/${reviewId}`).expect(404);
      assert.equal(response.body.error.code, 'REVIEW_NOT_FOUND');
    });
  });
