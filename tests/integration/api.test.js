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
      users.push({ body, profile: result.body.user, token: result.body.accessToken, cookie: cookieOf(result) });
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
      const book = await prisma.book.create({ data: { ...data, author: 'Test Author', coverImageUrl: 'https://example.com/cover.jpg', bookGenres: { create: { genreId } } } });
      bookIds.push(book.id);
    }
    const post = (index, route, body) => request(app).post(`/api/${route}`).auth(users[index].token, { type: 'bearer' }).send(body);
    const bookId = bookIds[0];
    await Promise.all([post(0, 'user-books', { bookId, status: 'read', userRating: 5 }).expect(200),
      post(1, 'user-books', { bookId, status: 'want_to_read', userRating: 3 }).expect(200)]);
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
    await post(1, 'user-books', { bookId: bookIds[1], status: 'want_to_read', userRating: 5 }).expect(200);
    await post(1, 'user-books', { bookId: bookIds[1], userRating: null }).expect(200);
    assert.equal((await prisma.book.findUnique({ where: { id: bookIds[1] } })).averageRating, null);
    const likeRequest = (index, method, id = reviewId) => request(app)[method](`/api/reviews/${id}/like`)
      .auth(users[index].token, { type: 'bearer' });
    await Promise.all([likeRequest(1, 'put').expect(200), likeRequest(2, 'put').expect(200)]);
    assert.equal((await prisma.review.findUnique({ where: { id: reviewId } })).likesCount, 2);
    await t.test('like and unlike are idempotent under sequential and concurrent retries', async () => {
      const responseFor = (liked, likesCount) => ({ data: { reviewId, liked, likesCount } });
      const putResponses = await Promise.all([likeRequest(3, 'put').expect(200), likeRequest(3, 'put').expect(200)]);
      for (const result of putResponses) assert.deepEqual(result.body, responseFor(true, 3));
      assert.deepEqual((await likeRequest(3, 'put').expect(200)).body, responseFor(true, 3));
      assert.equal(await prisma.reviewLike.count({ where: { userId: userIds[3], reviewId } }), 1);
      assert.equal((await prisma.review.findUnique({ where: { id: reviewId } })).likesCount, 3);
      const detailPath = `/api/books/${bookId}`;
      const before = await request(app).get(detailPath).auth(users[3].token, { type: 'bearer' }).expect(200);
      assert.equal(before.body.data.reviews.data[0].likedByMe, true);
      const deleteResponses = await Promise.all([likeRequest(3, 'delete').expect(200), likeRequest(3, 'delete').expect(200)]);
      for (const result of deleteResponses) assert.deepEqual(result.body, responseFor(false, 2));
      assert.deepEqual((await likeRequest(3, 'delete').expect(200)).body, responseFor(false, 2));
      assert.equal(await prisma.reviewLike.count({ where: { userId: userIds[3], reviewId } }), 0);
      assert.equal(await prisma.reviewLike.count({ where: { reviewId } }), 2);
      assert.equal((await prisma.review.findUnique({ where: { id: reviewId } })).likesCount, 2);
      const after = await request(app).get(detailPath).auth(users[3].token, { type: 'bearer' }).expect(200);
      assert.equal(after.body.data.reviews.data[0].likedByMe, false);
      const legacy = await likeRequest(3, 'post').expect(405);
      assert.equal(legacy.headers.allow, 'PUT, DELETE');
      assert.equal(await prisma.reviewLike.count({ where: { userId: userIds[3], reviewId } }), 0);
      for (const method of ['put', 'delete']) {
        await likeRequest(3, method, randomUUID()).expect(404);
        await likeRequest(3, method, 'invalid-id').expect(400);
      }
    });
    const search = await request(app).get('/api/books').query({ genre: tag, q: '50%_', limit: 1 }).expect(200);
    assert.equal(search.body.data[0].id, bookId);
    assert.equal(search.body.pagination.total, 1);
    const author = await request(app).get('/api/books').query({ genre: tag, author: 'Test Author' }).expect(200);
    assert.equal(author.body.pagination.total, 2);
    assert.ok(author.body.data.every(row => row.author === 'Test Author'));
    const sorted = await request(app).get('/api/books').query({ genre: tag, sort: 'publicationYear', order: 'asc' }).expect(200);
    assert.deepEqual(sorted.body.data.map(row => row.id), bookIds);
    const details = await request(app).get(`/api/books/${bookId}?limit=1`).expect(200);
    assert.equal(details.body.data.reviews.data[0].user.email, undefined);
    await request(app).get(`/api/books/${randomUUID()}`).expect(404);

    const get = (index, path) => request(app).get(path).auth(users[index].token, { type: 'bearer' });
    await t.test('shelves filter all statuses, paginate tied timestamps and isolate users', async () => {
      await post(0, 'user-books', { bookId: bookIds[1], status: 'read' }).expect(200);
      const timestamp = new Date('2026-01-01T00:00:00Z');
      await prisma.userBook.updateMany({ where: { userId: userIds[0], bookId: { in: bookIds } }, data: { updatedAt: timestamp } });
      const first = await get(0, '/api/user-books?limit=1&page=1').expect(200);
      const second = await get(0, '/api/user-books?limit=1&page=2').expect(200);
      assert.deepEqual([first.body.data[0].bookId, second.body.data[0].bookId], [...bookIds].sort());
      assert.deepEqual(first.body.pagination, { page: 1, limit: 1, total: 2, totalPages: 2 });
      assert.equal(first.headers['cache-control'], 'no-store');
      for (const row of [first.body.data[0], second.body.data[0]]) {
        assert.equal(row.book.id, row.bookId);
        assert.equal(row.book.author, 'Test Author');
        assert.equal(row.book.coverImageUrl, 'https://example.com/cover.jpg');
        assert.deepEqual(row.book.genres, [{ id: genreId, name: tag, slug: tag }]);
        assert.equal(row.book.averageRating, row.bookId === bookId ? 2 : null);
        assert.equal(row.userRating, row.bookId === bookId ? 2 : null);
        assert.ok(row.createdAt);
        assert.equal(row.updatedAt, timestamp.toISOString());
      }
      assert.equal((await get(0, '/api/user-books?status=read').expect(200)).body.data[0].bookId, bookIds[1]);
      assert.equal((await get(0, '/api/user-books?status=currently_reading').expect(200)).body.data[0].bookId, bookId);
      assert.equal((await get(0, '/api/user-books?status=want_to_read').expect(200)).body.pagination.total, 0);
      const other = await get(1, '/api/user-books?status=want_to_read').expect(200);
      assert.equal(other.body.pagination.total, 2);
      assert.ok(other.body.data.every(row => row.status === 'want_to_read' && row.userRating === null));
      assert.equal((await get(2, '/api/user-books').expect(200)).body.pagination.total, 0);
      assert.deepEqual((await get(0, '/api/user-books?page=3&limit=1').expect(200)).body.data, []);
      for (const query of ['status=invalid', 'limit=101', 'page=0', `userId=${userIds[1]}`]) {
        await get(0, `/api/user-books?${query}`).expect(400);
      }
    });

    await t.test('review pages include only the requesting reader\'s like state', async () => {
      const secondReview = await post(2, 'reviews', { bookId, rating: 3 }).expect(200);
      const ids = [reviewId, secondReview.body.data.id].sort();
      await prisma.review.updateMany({ where: { id: { in: ids } }, data: { createdAt: new Date('2026-01-01T00:00:00Z') } });
      const anonymous = await request(app).get(`/api/books/${bookId}?limit=2`).expect(200);
      assert.ok(anonymous.body.data.reviews.data.every(row => row.likedByMe === false));
      const authenticated = await get(1, `/api/books/${bookId}?limit=2`).expect(200);
      assert.deepEqual(authenticated.body.data.reviews.data.map(row => row.id), ids);
      assert.equal(authenticated.body.data.reviews.pagination.total, 2);
      assert.equal(authenticated.headers['cache-control'], 'no-store');
      for (const row of authenticated.body.data.reviews.data) {
        assert.equal(row.likedByMe, row.id === reviewId);
        assert.deepEqual(Object.keys(row.user).sort(), ['id', 'profilePicture', 'username']);
        assert.equal(row.likes, undefined);
      }
      for (let page = 1; page <= 2; page++) {
        const result = await get(1, `/api/books/${bookId}?limit=1&page=${page}`).expect(200);
        assert.equal(result.body.data.reviews.data[0].id, ids[page - 1]);
        assert.equal(result.body.data.reviews.data[0].likedByMe, ids[page - 1] === reviewId);
        assert.deepEqual(result.body.data.reviews.pagination, { page, limit: 1, total: 2, totalPages: 2 });
      }
      assert.ok((await get(0, `/api/books/${bookId}`).expect(200)).body.data.reviews.data.every(row => !row.likedByMe));
      assert.deepEqual((await get(1, `/api/books/${bookId}?page=3&limit=1`).expect(200)).body.data.reviews.data, []);
    });

    await t.test('me returns exactly the signup/login safe profile', async () => {
      for (const index of [0, 1]) {
        const me = await get(index, '/api/auth/me').expect(200);
        assert.deepEqual(me.body, { user: users[index].profile });
        assert.equal(me.headers['cache-control'], 'no-store');
      }
    });
    // Rotation consumes the previous token; replay revokes the new token and all access tokens for this session.
    const rotated = await auth('refresh', {}, users[0].cookie).expect(200);
    const restored = await request(app).get('/api/auth/me').auth(rotated.body.accessToken, { type: 'bearer' }).expect(200);
    assert.deepEqual(restored.body, { user: users[0].profile });
    await auth('refresh', {}, users[0].cookie).expect(401);
    await auth('refresh', {}, cookieOf(rotated)).expect(401);
    await post(0, 'user-books', { bookId, status: 'read' }).expect(401);
    await t.test('read endpoints reject invalid, logged-out and replay-revoked access tokens', async () => {
      for (const path of ['/api/auth/me', '/api/user-books', '/api/books/', `/api/books/${bookId}`]) {
        for (const token of ['invalid', loggedIn.body.accessToken, rotated.body.accessToken]) {
          await request(app).get(path).auth(token, { type: 'bearer' }).expect(401);
        }
      }
      for (const method of ['put', 'delete']) await likeRequest(0, method).expect(401);
      await request(app).get('/api/auth/me').expect(401);
      await request(app).get('/api/user-books').expect(401);
      await request(app).get(`/api/books/${bookId}`).expect(200);
    });
  });
