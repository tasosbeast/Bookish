import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';

test('PostgreSQL: Friends v1 lifecycle, validations, authorization, and similarity algorithm',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
    const tag = randomUUID().replaceAll('-', '').slice(0, 10);
    const userIds = [];
    const bookIds = [];
    const genreIds = [];

    t.after(async () => {
      await prisma.friendship.deleteMany({
        where: {
          OR: [
            { userAId: { in: userIds } },
            { userBId: { in: userIds } },
          ],
        },
      });
      if (bookIds.length) {
        await prisma.book.deleteMany({ where: { id: { in: bookIds } } });
      }
      if (userIds.length) {
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      }
      if (genreIds.length) {
        await prisma.genre.deleteMany({ where: { id: { in: genreIds } } });
      }
      await prisma.$disconnect();
    });

    const signup = async suffix => {
      const res = await request(app).post('/api/auth/signup').set('X-Bookish-CSRF', '1').send({
        username: `fr${tag}${suffix}`,
        email: `fr${tag}${suffix}@example.com`,
        password: 'friends test password',
      }).expect(201);
      userIds.push(res.body.user.id);
      return { token: res.body.accessToken, userId: res.body.user.id, username: res.body.user.username };
    };

    const auth = (reader, method, path) => request(app)[method](path).auth(reader.token, { type: 'bearer' });

    // Create test users
    const [userA, userB, userC, userD] = await Promise.all(['a', 'b', 'c', 'd'].map(signup));

    // 1. Auth required for all friends endpoints
    await request(app).get('/api/friends').expect(401);
    await request(app).get('/api/friends/suggestions').expect(401);
    await request(app).get('/api/friends/requests').expect(401);

    // 2. Cache-Control: no-store verified
    const resNoStore = await auth(userA, 'get', '/api/friends').expect(200);
    assert.equal(resNoStore.headers['cache-control'], 'no-store');

    // 3. Friend requests validations
    // Cannot friend self
    await auth(userA, 'post', '/api/friends/requests').send({ userId: userA.userId }).expect(400);

    // Cannot friend non-existent user
    const fakeUuid = randomUUID();
    await auth(userA, 'post', '/api/friends/requests').send({ userId: fakeUuid }).expect(404);

    // Send request from A to B
    const reqAB = await auth(userA, 'post', '/api/friends/requests').send({ userId: userB.userId }).expect(201);
    const requestId = reqAB.body.data.id;
    assert.ok(requestId);

    // Cannot duplicate pending request A -> B
    await auth(userA, 'post', '/api/friends/requests').send({ userId: userB.userId }).expect(409);

    // Cannot reverse duplicate pending request B -> A
    await auth(userB, 'post', '/api/friends/requests').send({ userId: userA.userId }).expect(409);

    // Check requests listing for A (sent) and B (incoming)
    const reqsA = await auth(userA, 'get', '/api/friends/requests').expect(200);
    assert.equal(reqsA.body.data.sent.length, 1);
    assert.equal(reqsA.body.data.sent[0].user.id, userB.userId);

    const reqsB = await auth(userB, 'get', '/api/friends/requests').expect(200);
    assert.equal(reqsB.body.data.incoming.length, 1);
    assert.equal(reqsB.body.data.incoming[0].user.id, userA.userId);

    // Only recipient (B) can accept
    await auth(userA, 'post', `/api/friends/requests/${requestId}/accept`).expect(403);
    await auth(userC, 'post', `/api/friends/requests/${requestId}/accept`).expect(403);

    // B accepts request from A
    await auth(userB, 'post', `/api/friends/requests/${requestId}/accept`).expect(200);

    // Cannot request an existing friend
    await auth(userA, 'post', '/api/friends/requests').send({ userId: userB.userId }).expect(409);

    // List friends for A and B returns each other
    const friendsA = await auth(userA, 'get', '/api/friends').expect(200);
    assert.equal(friendsA.body.data.length, 1);
    assert.equal(friendsA.body.data[0].friend.id, userB.userId);

    const friendsB = await auth(userB, 'get', '/api/friends').expect(200);
    assert.equal(friendsB.body.data.length, 1);
    assert.equal(friendsB.body.data[0].friend.id, userA.userId);

    // Either friend can remove accepted friendship (B removes friendship with A)
    await auth(userB, 'delete', `/api/friends/${friendsB.body.data[0].friendshipId}`).expect(200);

    const friendsAAfter = await auth(userA, 'get', '/api/friends').expect(200);
    assert.equal(friendsAAfter.body.data.length, 0);

    // Cancel sent request test: C sends request to D, then C cancels
    const reqCD = await auth(userC, 'post', '/api/friends/requests').send({ userId: userD.userId }).expect(201);
    await auth(userC, 'delete', `/api/friends/requests/${reqCD.body.data.id}`).expect(200);
    const reqsC = await auth(userC, 'get', '/api/friends/requests').expect(200);
    assert.equal(reqsC.body.data.sent.length, 0);

    // Decline incoming request test: C sends request to D, then D declines
    const reqCD2 = await auth(userC, 'post', '/api/friends/requests').send({ userId: userD.userId }).expect(201);
    await auth(userD, 'delete', `/api/friends/requests/${reqCD2.body.data.id}`).expect(200);
    const reqsD = await auth(userD, 'get', '/api/friends/requests').expect(200);
    assert.equal(reqsD.body.data.incoming.length, 0);

    // =========================================================
    // SIMILAR READER ALGORITHM & MANDATORY REGRESSION TEST
    // =========================================================

    // Create genres
    const thriller = await prisma.genre.create({ data: { name: `Thriller ${tag}`, slug: `thriller-${tag}` } });
    const mystery = await prisma.genre.create({ data: { name: `Mystery ${tag}`, slug: `mystery-${tag}` } });
    const romance = await prisma.genre.create({ data: { name: `Romance ${tag}`, slug: `romance-${tag}` } });
    genreIds.push(thriller.id, mystery.id, romance.id);

    const createBook = async (title, genreList) => {
      const b = await prisma.book.create({
        data: {
          title: `${title} ${tag}`,
          author: 'Algorithm Author',
          bookGenres: { create: genreList.map(g => ({ genreId: g.id })) },
        },
      });
      bookIds.push(b.id);
      return b;
    };

    // Create 5 Thriller/Mystery books for Reader A
    const booksA = await Promise.all([
      createBook('Book A1', [thriller]),
      createBook('Book A2', [thriller]),
      createBook('Book A3', [mystery]),
      createBook('Book A4', [mystery]),
      createBook('Book A5', [thriller, mystery]),
    ]);

    // Create 5 COMPLETELY DIFFERENT Thriller/Mystery books for Reader B (0 shared books!)
    const booksB = await Promise.all([
      createBook('Book B1', [thriller]),
      createBook('Book B2', [thriller]),
      createBook('Book B3', [mystery]),
      createBook('Book B4', [mystery]),
      createBook('Book B5', [thriller, mystery]),
    ]);

    // Create 5 Romance books for Reader C (plus 2 shared books with A)
    const booksC = await Promise.all([
      createBook('Book C1', [romance]),
      createBook('Book C2', [romance]),
      createBook('Book C3', [romance]),
    ]);

    // Add UserBooks for Reader A (5 read books)
    for (const b of booksA) {
      await auth(userA, 'post', '/api/user-books').send({ bookId: b.id, status: 'read' }).expect(200);
    }

    // Add UserBooks for Reader B (5 read books, 0 shared titles with A!)
    for (const b of booksB) {
      await auth(userB, 'post', '/api/user-books').send({ bookId: b.id, status: 'read' }).expect(200);
    }

    // Add UserBooks for Reader C (3 romance + 2 shared titles from A, but different genre profile)
    for (const b of [...booksC, booksA[0], booksA[1]]) {
      await auth(userC, 'post', '/api/user-books').send({ bookId: b.id, status: 'read' }).expect(200);
    }

    // 4. MANDATORY REGRESSION TEST ASSERTIONS:
    // Query suggestions for Reader A
    const suggRes = await auth(userA, 'get', '/api/friends/suggestions').expect(200);

    assert.equal(suggRes.body.meta.personalized, true);
    assert.equal(suggRes.body.meta.eligibleBooks, 5);

    const suggList = suggRes.body.data;
    assert.ok(suggList.length >= 2, 'Returns suggestions');

    // Reader B MUST be suggested even with ZERO shared titles
    const candB = suggList.find(s => s.user.id === userB.userId);
    assert.ok(candB, 'Reader B is eligible as similar reader with ZERO shared titles');
    assert.equal(candB.reason.type, 'genres');
    assert.ok(candB.reason.genres.includes(thriller.name) || candB.reason.genres.includes(mystery.name));
    assert.equal(candB.reason.sharedBooks, 0);

    // Reader B (matching genre profile) MUST rank HIGHER than Reader C (shared titles only, wrong genre profile)
    const indexB = suggList.findIndex(s => s.user.id === userB.userId);
    const indexC = suggList.findIndex(s => s.user.id === userC.userId);
    assert.ok(indexB < indexC, `Reader B (genre match) ranks higher (${indexB}) than Reader C (${indexC})`);

    // 5. Test Want to Read-only books do NOT count towards 5 eligible books
    const userE = await signup('e');
    for (let i = 1; i <= 6; i++) {
      const b = await createBook(`Want Book ${i}`, [thriller]);
      await auth(userE, 'post', '/api/user-books').send({ bookId: b.id, status: 'want_to_read' }).expect(200);
    }
    const suggE = await auth(userE, 'get', '/api/friends/suggestions').expect(200);
    assert.equal(suggE.body.meta.personalized, false);
    assert.equal(suggE.body.meta.eligibleBooks, 0);

    // 6. Test status=null + userRating DOES count
    for (let i = 1; i <= 5; i++) {
      const b = await createBook(`Rating Only Book ${i}`, [thriller]);
      await auth(userE, 'post', '/api/user-books').send({ bookId: b.id, userRating: 4 }).expect(200);
    }
    const suggE2 = await auth(userE, 'get', '/api/friends/suggestions').expect(200);
    assert.equal(suggE2.body.meta.personalized, true);
    assert.equal(suggE2.body.meta.eligibleBooks, 5);
  });
