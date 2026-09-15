import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import { signTokens, digest } from '../../src/services/tokens.js';

test('PostgreSQL: GET /api/calendar date bounds, release-only events, and validation',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
    const tag = randomUUID().replaceAll('-', '').slice(0, 10);
    const passwordHash = await bcrypt.hash('secretPassphrase123!', 10);

    let user;
    let token;
    const bookIds = [];
    let genreId;

    t.after(async () => {
      if (bookIds.length) {
        await prisma.releaseMetadataSource.deleteMany({ where: { bookId: { in: bookIds } } });
        await prisma.bookGenre.deleteMany({ where: { bookId: { in: bookIds } } });
        await prisma.book.deleteMany({ where: { id: { in: bookIds } } });
      }
      if (genreId) {
        await prisma.genre.delete({ where: { id: genreId } });
      }
      if (user) {
        await prisma.refreshSession.deleteMany({ where: { userId: user.id } });
        await prisma.user.deleteMany({ where: { id: user.id } });
      }
      await prisma.$disconnect();
    });

    // Create user
    user = await prisma.user.create({
      data: {
        username: `cal_user_${tag}`,
        email: `cal_user_${tag}@example.com`,
        passwordHash,
      },
    });

    // Create active session for user
    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + 86400000);
    const { accessToken } = signTokens(user.id, sessionId, expiresAt);
    token = accessToken;

    await prisma.refreshSession.create({
      data: {
        id: sessionId,
        userId: user.id,
        tokenHash: digest(`cal-${sessionId}`),
        expiresAt,
      },
    });

    // Create Genre
    const genre = await prisma.genre.create({
      data: { name: `CalGenre ${tag}`, slug: `cal-genre-${tag}` },
    });
    genreId = genre.id;

    // Helper to create test book
    async function createBook(title, publicationDate, publicationYear = null, verifiedPublicationDate = undefined) {
      const isbn = `978${Math.floor(1000000000 + Math.random() * 9000000000)}`;
      const book = await prisma.book.create({
        data: {
          title: `${title} ${tag}`,
          author: `Author ${tag}`,
          isbn,
          publicationYear: publicationYear ?? (publicationDate ? Number(publicationDate.slice(0, 4)) : 2026),
          publicationDate: publicationDate ? new Date(`${publicationDate}T00:00:00.000Z`) : null,
          bookGenres: { create: { genreId } },
        },
      });
      bookIds.push(book.id);

      if (verifiedPublicationDate !== undefined && verifiedPublicationDate !== null) {
        await prisma.releaseMetadataSource.create({
          data: {
            bookId: book.id,
            provider: 'prh',
            sourceUrl: `https://example.com/books/${isbn}`,
            sourceIsbn: isbn,
            verifiedPublicationDate: new Date(`${verifiedPublicationDate}T00:00:00.000Z`),
            lastVerifiedAt: new Date(),
          },
        });
      }

      return book;
    }

    const rangeFrom = '2026-08-31';
    const rangeTo = '2026-10-11';

    // 1. Release on first visible date (2026-08-31) with matching verified date
    const bRelFirst = await createBook('Release First Day', '2026-08-31', null, '2026-08-31');
    // 2. Release on last visible date (2026-10-11) with matching verified date
    const bRelLast = await createBook('Release Last Day', '2026-10-11', null, '2026-10-11');
    // 3. Release inside range (2026-09-15) with matching verified date
    const bRelMid = await createBook('Release Mid Range', '2026-09-15', null, '2026-09-15');
    // 4. Another release on same date (2026-09-15) to verify deterministic ID sorting
    const bRelMid2 = await createBook('Release Mid Range Two', '2026-09-15', null, '2026-09-15');
    // 5. Release before range (2026-08-30) - should NOT appear
    const bRelBefore = await createBook('Release Before', '2026-08-30', null, '2026-08-30');
    // 6. Release after range (2026-10-12) - should NOT appear
    const bRelAfter = await createBook('Release After', '2026-10-12', null, '2026-10-12');
    // 7. Book with publicationYear only (null publicationDate) - should NOT appear
    const bYearOnly = await createBook('Release Year Only', null, 2026, null);
    // 8. Book with publicationDate but NO ReleaseMetadataSource (unverified) - should NOT appear
    const bUnverified = await createBook('Release Unverified', '2026-09-20', null, null);
    // 9. Book with ReleaseMetadataSource verifiedPublicationDate that does NOT match publicationDate - should NOT appear
    const bMismatched = await createBook('Release Mismatched', '2026-09-20', null, '2026-09-25');

    // ============================================================
    // Test 1: Authentication required
    // ============================================================
    await request(app)
      .get('/api/calendar')
      .query({ from: rangeFrom, to: rangeTo })
      .expect(401);

    // ============================================================
    // Test 2: Validation errors
    // ============================================================
    // Missing params
    await request(app)
      .get('/api/calendar')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);

    // from > to
    await request(app)
      .get('/api/calendar')
      .set('Authorization', `Bearer ${token}`)
      .query({ from: '2026-09-15', to: '2026-09-10' })
      .expect(400);

    // Range > 42 days (43 days)
    await request(app)
      .get('/api/calendar')
      .set('Authorization', `Bearer ${token}`)
      .query({ from: '2026-08-31', to: '2026-10-12' })
      .expect(400);

    // Impossible calendar date (Feb 31)
    await request(app)
      .get('/api/calendar')
      .set('Authorization', `Bearer ${token}`)
      .query({ from: '2026-02-31', to: '2026-03-10' })
      .expect(400);

    // ============================================================
    // Test 3: Successful request & headers
    // ============================================================
    const res = await request(app)
      .get('/api/calendar')
      .set('Authorization', `Bearer ${token}`)
      .query({ from: rangeFrom, to: rangeTo })
      .expect(200);

    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(res.body.range, { from: rangeFrom, to: rangeTo });

    const events = res.body.events;
    const eventIds = events.map(e => e.id);

    // ============================================================
    // Test 4: Release events coverage
    // ============================================================
    assert.ok(eventIds.includes(`release:${bRelFirst.id}:2026-08-31`), 'Release on first visible date included');
    assert.ok(eventIds.includes(`release:${bRelLast.id}:2026-10-11`), 'Release on last visible date included');
    assert.ok(eventIds.includes(`release:${bRelMid.id}:2026-09-15`), 'Release in middle of range included');
    assert.ok(eventIds.includes(`release:${bRelMid2.id}:2026-09-15`), 'Second release on same date included');

    assert.ok(!eventIds.includes(`release:${bRelBefore.id}:2026-08-30`), 'Release before range excluded');
    assert.ok(!eventIds.includes(`release:${bRelAfter.id}:2026-10-12`), 'Release after range excluded');
    assert.ok(!eventIds.some(id => id.includes(bYearOnly.id)), 'publicationYear-only book excluded');
    assert.ok(!eventIds.some(id => id.includes(bUnverified.id)), 'Unverified publicationDate book excluded');
    assert.ok(!eventIds.some(id => id.includes(bMismatched.id)), 'Mismatched publicationDate vs verifiedPublicationDate excluded');

    // All events must have type: 'release'
    for (const e of events) {
      assert.equal(e.type, 'release');
      assert.ok(e.book.id);
      assert.ok(e.book.title);
      assert.ok(e.book.author);
    }

    // ============================================================
    // Test 5: Deterministic sorting (date ASC, id ASC)
    // ============================================================
    for (let i = 0; i < events.length - 1; i++) {
      const a = events[i];
      const b = events[i + 1];
      if (a.date === b.date) {
        assert.ok(a.id < b.id, 'Tie-breaking sorts by id asc');
      } else {
        assert.ok(a.date < b.date, 'Sorted by date asc');
      }
    }

    // ============================================================
    // Test 6: Exact YYYY-MM-DD string formatting
    // ============================================================
    for (const e of events) {
      assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/, 'Date matches exact YYYY-MM-DD pattern');
    }
  }
);

