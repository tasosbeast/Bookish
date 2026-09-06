import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';

test('PostgreSQL: personal book editing reads the exact authenticated reader',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
    const tag = randomUUID().replaceAll('-', '').slice(0, 10), users = [], books = [];
    t.after(async () => {
      await prisma.book.deleteMany({ where: { id: { in: books } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
      await prisma.$disconnect();
    });
    const signup = async suffix => {
      const response = await request(app).post('/api/auth/signup').set('X-Bookish-CSRF', '1')
        .send({ username: `edit${tag}${suffix}`, email: `edit${tag}${suffix}@example.com`, password: 'personal fixture password' }).expect(201);
      users.push(response.body.user.id); return response;
    };
    const first = await signup('a'), second = await signup('b');
    const book = await prisma.book.create({ data: { title: `Personal ${tag}`, author: 'Fixture author' } }); books.push(book.id);
    const extra = await prisma.book.create({ data: { title: `Extra ${tag}`, author: 'Fixture author' } }); books.push(extra.id);
    const auth = response => `Bearer ${response.body.accessToken}`;
    await request(app).post('/api/reviews').set('Authorization', auth(first))
      .send({ bookId: book.id, rating: 4, reviewText: 'My existing review' }).expect(200);
    await prisma.review.update({ where: { userId_bookId: { userId: users[0], bookId: book.id } }, data: { createdAt: new Date('2020-01-01') } });
    await request(app).post('/api/reviews').set('Authorization', auth(second))
      .send({ bookId: book.id, rating: 2, reviewText: 'Another reader' }).expect(200);
    await request(app).post('/api/user-books').set('Authorization', auth(first))
      .send({ bookId: extra.id, status: 'read' }).expect(200);

    await t.test('finds an existing review and shelf even when absent from their first pages', async () => {
      const publicPage = await request(app).get(`/api/books/${book.id}?limit=1`).expect(200);
      assert.equal(publicPage.body.data.reviews.data[0].user.id, users[1]);
      const shelfPage = await request(app).get('/api/user-books?limit=1').set('Authorization', auth(first)).expect(200);
      assert.equal(shelfPage.body.data[0].bookId, extra.id);
      const response = await request(app).get(`/api/user-books/${book.id}`).set('Authorization', auth(first)).expect(200);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.body.data.shelf.userRating, 4);
      assert.equal(response.body.data.review.reviewText, 'My existing review');
      assert.deepEqual(Object.keys(response.body.data.review).sort(), ['bookId', 'createdAt', 'id', 'likesCount', 'rating', 'reviewText', 'updatedAt']);
      assert.equal(JSON.stringify(response.body).includes('password'), false);
    });
    await t.test('isolates users and distinguishes missing personal data from a missing book', async () => {
      const own = await request(app).get(`/api/user-books/${book.id}`).set('Authorization', auth(second)).expect(200);
      assert.equal(own.body.data.review.rating, 2);
      const absent = await request(app).get(`/api/user-books/${extra.id}`).set('Authorization', auth(second)).expect(200);
      assert.deepEqual(absent.body.data, { bookId: extra.id, shelf: null, review: null });
      await request(app).get(`/api/user-books/${randomUUID()}`).set('Authorization', auth(first)).expect(404);
      await request(app).get('/api/user-books/invalid').set('Authorization', auth(first)).expect(400);
      await request(app).get(`/api/user-books/${book.id}?userId=${users[1]}`).set('Authorization', auth(first)).expect(400);
    });
    await t.test('requires a valid active session and accepts a refreshed access token', async () => {
      await request(app).get(`/api/user-books/${book.id}`).expect(401);
      await request(app).get(`/api/user-books/${book.id}`).set('Authorization', 'Bearer invalid').expect(401);
      const rotated = await request(app).post('/api/auth/refresh').set('X-Bookish-CSRF', '1')
        .set('Cookie', first.headers['set-cookie'].map(c => c.split(';')[0])).expect(200);
      await request(app).get(`/api/user-books/${book.id}`).set('Authorization', auth(rotated)).expect(200);
      await prisma.refreshSession.updateMany({ where: { userId: users[0] }, data: { revokedAt: new Date() } });
      await request(app).get(`/api/user-books/${book.id}`).set('Authorization', auth(rotated)).expect(401);
    });
  });
