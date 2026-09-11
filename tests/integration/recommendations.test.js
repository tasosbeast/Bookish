import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';

test('PostgreSQL: Top Picks recommendations service and API endpoints',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
    const tag = randomUUID().replaceAll('-', '').slice(0, 10);
    const userIds = [];
    const bookIds = [];
    const genreIds = [];

    t.after(async () => {
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
        username: `rec${tag}${suffix}`, email: `rec${tag}${suffix}@example.com`, password: 'recommendation test pass',
      }).expect(201);
      userIds.push(res.body.user.id);
      return { token: res.body.accessToken, userId: res.body.user.id, username: res.body.user.username };
    };

    const userMain = await signup('main');

    // Create genres
    const thrillerGenre = await prisma.genre.create({ data: { name: `Thriller ${tag}`, slug: `thriller-${tag}` } });
    const sciFiGenre = await prisma.genre.create({ data: { name: `Sci-Fi ${tag}`, slug: `sci-fi-${tag}` } });
    genreIds.push(thrillerGenre.id, sciFiGenre.id);

    const createBook = async (title, author, genreList = [], opts = {}) => {
      const book = await prisma.book.create({
        data: {
          title: `${title} ${tag}`,
          author,
          publicationYear: opts.publicationYear ?? 2020,
          averageRating: opts.averageRating ?? 4.0,
          ratingsCount: opts.ratingsCount ?? 10,
          bookGenres: {
            create: genreList.map(g => ({ genreId: g.id })),
          },
        },
      });
      bookIds.push(book.id);
      return book;
    };

    // 1. Unauthenticated access returns 401
    await request(app).get('/api/recommendations/top-picks').expect(401);

    // 2. Strict query validation & Cache-Control: no-store
    await request(app).get('/api/recommendations/top-picks?limit=invalid')
      .auth(userMain.token, { type: 'bearer' }).expect(400);
    await request(app).get('/api/recommendations/top-picks?limit=0')
      .auth(userMain.token, { type: 'bearer' }).expect(400);
    await request(app).get('/api/recommendations/top-picks?limit=15')
      .auth(userMain.token, { type: 'bearer' }).expect(400);
    await request(app).get('/api/recommendations/top-picks?unknownParam=1')
      .auth(userMain.token, { type: 'bearer' }).expect(400);

    const resInit = await request(app).get('/api/recommendations/top-picks?limit=6')
      .auth(userMain.token, { type: 'bearer' }).expect(200);
    assert.equal(resInit.headers['cache-control'], 'no-store');
    assert.equal(resInit.body.meta.personalized, false);
    assert.equal(resInit.body.meta.ratedBooks, 0);
    assert.equal(resInit.body.data.length, 0);

    // 3. User with < 3 rated books gets personalized: false
    const bookT1 = await createBook('T1 Old Thriller', 'Stephen King', [thrillerGenre]);
    const bookT2 = await createBook('T2 Old Thriller', 'Stephen King', [thrillerGenre]);

    await request(app).post('/api/user-books').auth(userMain.token, { type: 'bearer' })
      .send({ bookId: bookT1.id, status: 'read', userRating: 5 }).expect(200);
    await request(app).post('/api/user-books').auth(userMain.token, { type: 'bearer' })
      .send({ bookId: bookT2.id, status: 'read', userRating: 4 }).expect(200);

    const resTwoRatings = await request(app).get('/api/recommendations/top-picks')
      .auth(userMain.token, { type: 'bearer' }).expect(200);
    assert.equal(resTwoRatings.body.meta.personalized, false);
    assert.equal(resTwoRatings.body.meta.ratedBooks, 2);

    // Add unrated Want to read book -> should NOT count as ratedBook signal
    const bookUnrated = await createBook('Unrated Want Book', 'Other Author', [sciFiGenre]);
    await request(app).post('/api/user-books').auth(userMain.token, { type: 'bearer' })
      .send({ bookId: bookUnrated.id, status: 'want_to_read' }).expect(200);

    const resUnratedCheck = await request(app).get('/api/recommendations/top-picks')
      .auth(userMain.token, { type: 'bearer' }).expect(200);
    assert.equal(resUnratedCheck.body.meta.personalized, false);
    assert.equal(resUnratedCheck.body.meta.ratedBooks, 2);

    // 4. VERY IMPORTANT REGRESSION CASE:
    // Add 3rd rated book (Old Thriller 3 rated 5) -> now ratedBooks = 3 >= 3
    const bookT3 = await createBook('T3 Old Thriller', 'Stephen King', [thrillerGenre]);
    await request(app).post('/api/user-books').auth(userMain.token, { type: 'bearer' })
      .send({ bookId: bookT3.id, status: 'read', userRating: 5 }).expect(200);

    // Add four newer Thriller books rated 2 stars by a bad author 'Bad Thriller Writer'
    for (let i = 1; i <= 4; i++) {
      const badBook = await createBook(`Bad Thriller ${i}`, 'Bad Thriller Writer', [thrillerGenre]);
      await request(app).post('/api/user-books').auth(userMain.token, { type: 'bearer' })
        .send({ bookId: badBook.id, status: 'read', userRating: 2 }).expect(200);
    }

    // Now ratedBooks = 7 (3 thrillers at 5, 4, 5 stars; 4 thrillers at 2 stars by Bad Thriller Writer).
    // Historical 5-star and 4-star thrillers give: +2 +1 +2 = +5 Thriller genre affinity points!
    // The four 2-star thrillers give 0 genre points (do NOT subtract from Thriller genre).
    // Stephen King author score: +3 +2 +3 = +8.
    // Bad Thriller Writer author score: 4 * (-2) = -8.

    // Create Candidate A: Thriller by Good Thriller Writer (not in UserBook)
    const candidateGood = await createBook('Good New Thriller', 'Good Thriller Writer', [thrillerGenre]);
    // Create Candidate B: Thriller by Bad Thriller Writer (not in UserBook)
    const candidateBad = await createBook('Bad New Thriller', 'Bad Thriller Writer', [thrillerGenre]);

    const resRegression = await request(app).get('/api/recommendations/top-picks')
      .auth(userMain.token, { type: 'bearer' }).expect(200);

    assert.equal(resRegression.body.meta.personalized, true);
    assert.equal(resRegression.body.meta.ratedBooks, 7);

    const recIds = resRegression.body.data.map(b => b.id);
    // Candidate Good MUST be recommended because Thriller genre affinity remains positive (+5)!
    assert.ok(recIds.includes(candidateGood.id), 'Good Thriller candidate is recommended despite recent 2-star Thrillers');

    const goodRec = resRegression.body.data.find(b => b.id === candidateGood.id);
    assert.equal(goodRec.reason.type, 'genre');
    assert.equal(goodRec.reason.label, thrillerGenre.name);

    // Candidate Bad has score: Thriller (+5) + Bad Thriller Writer (-8) = -3 <= 0 -> MUST BE EXCLUDED!
    assert.ok(!recIds.includes(candidateBad.id), 'Bad Thriller Writer candidate is excluded due to author penalty');

    // 5. Exclusions check: None of the books in UserBook (bookT1..T3, badBooks, bookUnrated) are recommended
    for (const id of [bookT1.id, bookT2.id, bookT3.id, bookUnrated.id]) {
      assert.ok(!recIds.includes(id), `UserBook item ${id} is excluded from Top Picks`);
    }

    // 6. Author diversity guard: Max 2 books per author
    // Create 3 candidates by 'Prolific Author' with Sci-Fi genre (give user Sci-Fi 5-star rating first)
    const sciFiRated = await createBook('SciFi Liked', 'SciFi Legend', [sciFiGenre]);
    await request(app).post('/api/user-books').auth(userMain.token, { type: 'bearer' })
      .send({ bookId: sciFiRated.id, status: 'read', userRating: 5 }).expect(200);

    const prolific1 = await createBook('Prolific SciFi 1', 'Prolific Author', [sciFiGenre], { ratingsCount: 100 });
    const prolific2 = await createBook('Prolific SciFi 2', 'Prolific Author', [sciFiGenre], { ratingsCount: 90 });
    const prolific3 = await createBook('Prolific SciFi 3', 'Prolific Author', [sciFiGenre], { ratingsCount: 80 });

    const resDiversity = await request(app).get('/api/recommendations/top-picks?limit=6')
      .auth(userMain.token, { type: 'bearer' }).expect(200);

    const prolificRecs = resDiversity.body.data.filter(b => b.author === 'Prolific Author');
    assert.ok(prolificRecs.length <= 2, `Max 2 books per author enforced (got ${prolificRecs.length})`);

    // 7. Reason priority: Author reason chosen when author score > 0
    const kingCandidate = await createBook('New King Book', 'Stephen King', [sciFiGenre]);
    const resKing = await request(app).get('/api/recommendations/top-picks?limit=6')
      .auth(userMain.token, { type: 'bearer' }).expect(200);

    const kingRec = resKing.body.data.find(b => b.id === kingCandidate.id);
    if (kingRec) {
      assert.equal(kingRec.reason.type, 'author');
      assert.equal(kingRec.reason.label, 'Stephen King');
    }
  });
