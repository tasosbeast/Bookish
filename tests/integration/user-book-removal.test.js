import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';

test('PostgreSQL: removing a shelf membership is non-destructive to ratings/reviews and filters correctly',
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
    const book = await prisma.book.create({ data: { title: `Removal Title ${tag}`, author: 'Fixture author' } });
    const unratedBook = await prisma.book.create({ data: { title: `Unrated Title ${tag}`, author: 'Fixture author' } });
    bookIds.push(book.id, unratedBook.id);
    const auth = (token, method, path) => request(app)[method](path).auth(token, { type: 'bearer' });
    const save = (token, body) => auth(token, 'post', '/api/user-books').send({ bookId: book.id, ...body });

    await save(first.token, { status: 'read', userRating: 5 }).expect(200);
    await save(second.token, { status: 'want_to_read', userRating: 3 }).expect(200);
    await auth(first.token, 'post', '/api/user-books').send({ bookId: unratedBook.id, status: 'want_to_read' }).expect(200);

    await t.test('remove unreviewed + unrated shelf entry deletes the UserBook row completely', async () => {
      const response = await auth(first.token, 'delete', `/api/user-books/${unratedBook.id}`).expect(200);
      assert.deepEqual(response.body, { data: { bookId: unratedBook.id, removed: true } });
      assert.equal(await prisma.userBook.findUnique({ where: { userId_bookId: { userId: first.userId, bookId: unratedBook.id } } }), null);
      assert.ok(await prisma.book.findUnique({ where: { id: unratedBook.id } }));
    });

    await t.test('remove rated shelf entry sets status to null and preserves userRating and book aggregates', async () => {
      const beforeBook = await prisma.book.findUnique({ where: { id: book.id } });
      const response = await auth(first.token, 'delete', `/api/user-books/${book.id}`).expect(200);
      assert.deepEqual(response.body, { data: { bookId: book.id, removed: true } });
      const userBook = await prisma.userBook.findUnique({ where: { userId_bookId: { userId: first.userId, bookId: book.id } } });
      assert.ok(userBook);
      assert.equal(userBook.status, null);
      assert.equal(userBook.userRating, 5);
      const afterBook = await prisma.book.findUnique({ where: { id: book.id } });
      assert.deepEqual(afterBook, beforeBook, 'removing shelf membership does not alter book aggregate ratings');
    });

    await t.test('another user shelf data remains isolated', async () => {
      const response = await auth(outsider.token, 'delete', `/api/user-books/${book.id}`).expect(404);
      assert.equal(response.body.error.code, 'SHELF_NOT_FOUND');
      const secondBook = await prisma.userBook.findUnique({ where: { userId_bookId: { userId: second.userId, bookId: book.id } } });
      assert.equal(secondBook.status, 'want_to_read');
      assert.equal(secondBook.userRating, 3);
    });

    await t.test('My Books listing, q search, and status filter exclude status=null rows', async () => {
      const listAll = await auth(first.token, 'get', '/api/user-books').expect(200);
      assert.equal(listAll.body.data.length, 0, 'status=null rows are excluded from My Books');

      const searchQ = await auth(first.token, 'get', `/api/user-books?q=${encodeURIComponent('Removal')}`).expect(200);
      assert.equal(searchQ.body.data.length, 0, 'q search excludes status=null rows');

      const filterStatus = await auth(first.token, 'get', '/api/user-books?status=read').expect(200);
      assert.equal(filterStatus.body.data.length, 0, 'status filter excludes status=null rows');
    });

    await t.test('personal book detail still returns status=null row with rating and review', async () => {
      await auth(first.token, 'post', '/api/reviews').send({ bookId: book.id, rating: 5, reviewText: 'Great book!' }).expect(200);
      const detail = await auth(first.token, 'get', `/api/user-books/${book.id}`).expect(200);
      assert.equal(detail.body.data.shelf.status, null);
      assert.equal(detail.body.data.shelf.userRating, 5);
      assert.equal(detail.body.data.review.reviewText, 'Great book!');
    });

    await t.test('remove reviewed shelf entry sets status to null and preserves review & review likes', async () => {
      const review = await prisma.review.findUnique({ where: { userId_bookId: { userId: first.userId, bookId: book.id } } });
      await auth(second.token, 'put', `/api/reviews/${review.id}/like`).expect(200);

      const response = await auth(first.token, 'delete', `/api/user-books/${book.id}`).expect(200);
      assert.deepEqual(response.body, { data: { bookId: book.id, removed: true } });

      const userBook = await prisma.userBook.findUnique({ where: { userId_bookId: { userId: first.userId, bookId: book.id } } });
      assert.ok(userBook);
      assert.equal(userBook.status, null);
      assert.equal(userBook.userRating, 5);

      const preservedReview = await prisma.review.findUnique({ where: { id: review.id } });
      assert.ok(preservedReview);
      assert.equal(preservedReview.likesCount, 1);
    });

    await t.test('rating-only write on a book not in My Books creates UserBook with status=null without setting want_to_read', async () => {
      const ratedBook = await prisma.book.create({ data: { title: `Rating Only ${tag}`, author: 'Fixture author' } });
      bookIds.push(ratedBook.id);
      await auth(first.token, 'post', '/api/user-books').send({ bookId: ratedBook.id, userRating: 4 }).expect(200);
      const ub = await prisma.userBook.findUnique({ where: { userId_bookId: { userId: first.userId, bookId: ratedBook.id } } });
      assert.ok(ub);
      assert.equal(ub.status, null);
      assert.equal(ub.userRating, 4);
    });

    await t.test('review creation on a book not in My Books creates UserBook with status=null', async () => {
      const reviewBook = await prisma.book.create({ data: { title: `Review Only ${tag}`, author: 'Fixture author' } });
      bookIds.push(reviewBook.id);
      await auth(first.token, 'post', '/api/reviews').send({ bookId: reviewBook.id, rating: 4, reviewText: 'Nice' }).expect(200);
      const ub = await prisma.userBook.findUnique({ where: { userId_bookId: { userId: first.userId, bookId: reviewBook.id } } });
      assert.ok(ub);
      assert.equal(ub.status, null);
      assert.equal(ub.userRating, 4);
    });

    await t.test('re-adding a book with status=null updates status while preserving rating and review', async () => {
      await auth(first.token, 'post', '/api/user-books').send({ bookId: book.id, status: 'currently_reading' }).expect(200);
      const ub = await prisma.userBook.findUnique({ where: { userId_bookId: { userId: first.userId, bookId: book.id } } });
      assert.equal(ub.status, 'currently_reading');
      assert.equal(ub.userRating, 5);
      const rev = await prisma.review.findUnique({ where: { userId_bookId: { userId: first.userId, bookId: book.id } } });
      assert.ok(rev);
      assert.equal(rev.reviewText, 'Great book!');
    });

    await t.test('standalone Delete review deletes only the review leaving userRating and status intact', async () => {
      const rev = await prisma.review.findUnique({ where: { userId_bookId: { userId: first.userId, bookId: book.id } } });
      await auth(first.token, 'delete', `/api/reviews/${rev.id}`).expect(200);
      assert.equal(await prisma.review.findUnique({ where: { id: rev.id } }), null);
      const ub = await prisma.userBook.findUnique({ where: { userId_bookId: { userId: first.userId, bookId: book.id } } });
      assert.equal(ub.status, 'currently_reading');
      assert.equal(ub.userRating, 5);
    });

    await t.test('DELETE /api/user-books/:bookId with unexpected query parameter returns 400', async () => {
      await auth(first.token, 'delete', `/api/user-books/${book.id}?deleteReview=true`).expect(400);
    });
  });
