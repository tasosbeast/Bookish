import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';

test('PostgreSQL: authentication, search, rating synchronization and concurrent likes',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
    const tag = randomUUID().replaceAll('-', '').slice(0, 12);
    const userIds = [];
    const bookIds = [];
    let genreId;
    t.after(async () => {
      // Only delete fixtures created by this run, never reset an existing database.
      await prisma.book.deleteMany({ where: { id: { in: bookIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      if (genreId) await prisma.genre.delete({ where: { id: genreId } });
      await prisma.$disconnect();
    });
    const auth = (path, body, cookie) => {
      let req = request(app).post(`/api/auth/${path}`).set('X-Bookish-CSRF', '1');
      if (cookie) req = req.set('Cookie', cookie);
      return req.send(body);
    };
    const cookieOf = response => response.headers['set-cookie'][0].split(';')[0];
    const users = [];
    for (let i = 0; i < 4; i++) {
      const body = { username: `reader_${tag}_${i}`, email: `${tag}_${i}@example.com`, password: 'correct horse battery staple' };
      const result = await auth('signup', body).expect(201);
      userIds.push(result.body.user.id);
      users.push({ body, token: result.body.accessToken, cookie: cookieOf(result) });
      assert.equal(result.body.user.passwordHash, undefined);
      assert.match(result.headers['set-cookie'][0], /HttpOnly/);
      assert.match(result.headers['set-cookie'][0], /SameSite=Strict/);
    }
    await auth('signup', users[0].body).expect(409);
    await auth('login', { email: users[0].body.email, password: 'wrong password value' }).expect(401);
    const loggedIn = await auth('login', { email: users[0].body.email.toUpperCase(), password: users[0].body.password }).expect(200);
    await auth('logout', {}, cookieOf(loggedIn)).expect(204);
    await request(app).post('/api/user-books').auth(loggedIn.body.accessToken, { type: 'bearer' }).send({}).expect(401);
    const genre = await prisma.genre.create({ data: { name: tag, slug: tag } });
    genreId = genre.id;
    for (const data of [{ title: `50%_Book ${tag}`, publicationYear: 2024 }, { title: `Other ${tag}`, publicationYear: null }]) {
      const book = await prisma.book.create({ data: { ...data, author: 'Test Author', bookGenres: { create: { genreId } } } });
      bookIds.push(book.id);
    }
    const post = (index, route, body) => request(app).post(`/api/${route}`).auth(users[index].token, { type: 'bearer' }).send(body);
    const bookId = bookIds[0];
    await Promise.all([post(0, 'user-books', { bookId, status: 'read', userRating: 5 }).expect(200),
      post(1, 'user-books', { bookId, userRating: 3 }).expect(200)]);
    let book = await prisma.book.findUnique({ where: { id: bookId } });
    assert.equal(Number(book.averageRating), 4);
    assert.equal(book.ratingsCount, 2);
    const review = await post(0, 'reviews', { bookId, rating: 4, reviewText: 'A good book' }).expect(200);
    const reviewId = review.body.data.id;
    await post(0, 'user-books', { bookId, userRating: 2 }).expect(200);
    await post(0, 'user-books', { bookId, status: 'currently_reading' }).expect(200);
    assert.equal((await prisma.review.findUnique({ where: { id: reviewId } })).rating, 2);
    await post(0, 'user-books', { bookId, userRating: null }).expect(409);
    await post(1, 'user-books', { bookId, userRating: null }).expect(200);
    book = await prisma.book.findUnique({ where: { id: bookId } });
    assert.equal(Number(book.averageRating), 2);
    assert.equal(book.ratingsCount, 1);
    await post(1, 'user-books', { bookId: bookIds[1], userRating: 5 }).expect(200);
    await post(1, 'user-books', { bookId: bookIds[1], userRating: null }).expect(200);
    assert.equal((await prisma.book.findUnique({ where: { id: bookIds[1] } })).averageRating, null);
    await Promise.all([post(1, `reviews/${reviewId}/like`, {}).expect(200), post(2, `reviews/${reviewId}/like`, {}).expect(200)]);
    assert.equal((await prisma.review.findUnique({ where: { id: reviewId } })).likesCount, 2);
    await Promise.all([post(3, `reviews/${reviewId}/like`, {}).expect(200), post(3, `reviews/${reviewId}/like`, {}).expect(200)]);
    assert.equal((await prisma.review.findUnique({ where: { id: reviewId } })).likesCount, 2);
    const search = await request(app).get('/api/books').query({ genre: tag, q: '50%_', limit: 1 }).expect(200);
    assert.equal(search.body.data[0].id, bookId);
    assert.equal(search.body.pagination.total, 1);
    const sorted = await request(app).get('/api/books').query({ genre: tag, sort: 'publicationYear', order: 'asc' }).expect(200);
    assert.deepEqual(sorted.body.data.map(row => row.id), bookIds);
    const details = await request(app).get(`/api/books/${bookId}?limit=1`).expect(200);
    assert.equal(details.body.data.reviews.data[0].user.email, undefined);
    await request(app).get(`/api/books/${randomUUID()}`).expect(404);
    // Rotation consumes the previous token; replay revokes the new token and all access tokens for this session.
    const rotated = await auth('refresh', {}, users[0].cookie).expect(200);
    await auth('refresh', {}, users[0].cookie).expect(401);
    await auth('refresh', {}, cookieOf(rotated)).expect(401);
    await post(0, 'user-books', { bookId, status: 'read' }).expect(401);
  });
